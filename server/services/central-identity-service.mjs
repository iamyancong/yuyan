/**
 * 雨燕中央账号、设备与短期会话服务。
 * @description GitLab PAT 仅用于实时验证，不写入中央数据库。
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { DEPLOY_SECRET_KEY } from '../config/constants.mjs';
import { getDeployDb } from './deploy-store.mjs';
import { assertGitlabHostAllowed } from './gitlab-host-policy.mjs';
import { runRequestContext, SHARED_DEPLOY_WORKSPACE_ID } from './request-context.mjs';
import { abortCentralOperationsForDevice } from './central-operation-runtime.mjs';

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const SIGNATURE_CLOCK_SKEW_MS = 5 * 60_000;
const ROLES = new Set(['viewer', 'operator', 'admin']);
const LEGACY_SCOPE_ID = 'legacy-team';
const BUSINESS_SCOPE_TABLES = ['deploy_servers', 'deploy_targets', 'deploy_records', 'deploy_environments'];
const APPROVAL_TOOL_NAMES = new Set([
  'yuyan_apply_project_config',
  'yuyan_create_microapp',
  'yuyan_deploy_target',
  'yuyan_rollback_deployment',
  'yuyan_control_service',
  'yuyan_generate_openapi',
  'desktop_backend_deploy',
  'desktop_generate_openapi',
]);

const deviceSchema = z.object({
  deviceId: z.string().uuid(),
  publicKey: z.string().min(40).max(256),
  deviceName: z.string().trim().min(1).max(120),
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android']).or(z.string().trim().min(1).max(32)),
});

export const gitlabCredentialSchema = z.object({
  gitlabHost: z.string().url().max(512),
  gitlabToken: z.string().min(8).max(4096),
});

export const gitlabExchangeSchema = gitlabCredentialSchema.extend({
  device: deviceSchema,
});

export const refreshSessionSchema = z.object({
  deviceId: z.string().uuid(),
  refreshToken: z.string().min(32).max(512),
  timestamp: z.coerce.number().int().positive(),
  nonce: z.string().min(16).max(128),
  signature: z.string().min(40).max(256),
});

/** 返回 ISO 时间。 */
const now = () => new Date().toISOString();

/** 规范化 GitLab Host，禁止路径、查询和凭据。 */
export function normalizeGitlabHost(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('GitLab 地址必须使用 HTTP 或 HTTPS');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/api\/v4\/?$/i, '') || '/';
  return url.toString().replace(/\/$/, '').toLowerCase();
}

/** 生成不可预测的会话令牌。 */
const randomToken = () => crypto.randomBytes(32).toString('base64url');

/** 会话令牌只以 SHA-256 摘要保存。 */
const tokenHash = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');

/**
 * 列出已有账号登录过的 GitLab 地址（用于未显式配置白名单时推导默认值，#62）。
 * @returns {Promise<string[]>}
 */
export async function listLinkedGitlabHosts() {
  const db = await ensureCentralIdentitySchema();
  return db.prepare("SELECT DISTINCT provider_host AS host FROM identity_links WHERE provider = 'gitlab'").all().map((row) => String(row.host || ''));
}

/** 生成稳定 GitLab 账号 ID。 */
export function buildAccountId(gitlabHost, gitlabUserId) {
  const hostHash = crypto.createHash('sha256').update(normalizeGitlabHost(gitlabHost)).digest('hex').slice(0, 16);
  return `gitlab:${hostHash}:${Number(gitlabUserId)}`;
}

/** 初始化中央多租户身份表。 */
export async function ensureCentralIdentitySchema() {
  const db = await getDeployDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_host TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      external_username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, provider_host, external_user_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      device_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(device_id, user_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      migration_state TEXT NOT NULL DEFAULT 'unbound',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(team_id, user_id),
      FOREIGN KEY(team_id) REFERENCES teams(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS team_gitlab_bindings (
      team_id TEXT PRIMARY KEY,
      gitlab_host TEXT NOT NULL,
      gitlab_group_id TEXT NOT NULL,
      gitlab_group_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(team_id) REFERENCES teams(id)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      team_id TEXT,
      access_token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      refresh_expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS auth_refresh_nonces (
      session_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, nonce),
      FOREIGN KEY(session_id) REFERENCES auth_sessions(id)
    );
    CREATE TABLE IF NOT EXISTS team_secrets (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      secret_type TEXT NOT NULL,
      resource_id TEXT,
      encrypted_value TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(team_id, secret_type, resource_id),
      FOREIGN KEY(team_id) REFERENCES teams(id)
    );
    CREATE TABLE IF NOT EXISTS team_approval_policies (
      team_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      require_approval INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(team_id, tool_name),
      FOREIGN KEY(team_id) REFERENCES teams(id)
    );
    CREATE TABLE IF NOT EXISTS central_agent_operations (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      client TEXT NOT NULL,
      request_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      status TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS central_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      team_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      client TEXT NOT NULL,
      request_id TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_access ON auth_sessions(access_token_hash, status, access_expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh ON auth_sessions(refresh_token_hash, status, refresh_expires_at);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id, status, team_id);
    CREATE INDEX IF NOT EXISTS idx_central_audit_team ON central_audit(team_id, id DESC);
  `);
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((row) => row.name);
  if (!userColumns.includes('email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }
  const linkColumns = db.prepare('PRAGMA table_info(identity_links)').all().map((row) => row.name);
  if (!linkColumns.includes('external_web_url')) {
    db.exec('ALTER TABLE identity_links ADD COLUMN external_web_url TEXT');
  }
  if (!linkColumns.includes('external_created_at')) {
    db.exec('ALTER TABLE identity_links ADD COLUMN external_created_at TEXT');
  }
  return db;
}

/** 从 GitLab 用户对象提取可持久化的邮箱（优先 email，其次 public_email / commit_email）。 */
function resolveGitlabEmail(user) {
  return String(user?.email || user?.public_email || user?.commit_email || '').trim();
}

/** 请求 GitLab 当前用户，PAT 不进入日志与数据库。 */
async function fetchGitlabUser(gitlabHost, gitlabToken) {
  const response = await fetch(`${gitlabHost}/api/v4/user`, {
    headers: { 'PRIVATE-TOKEN': gitlabToken, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'GitLab Token 无效或已过期' : `GitLab 身份验证失败（HTTP ${response.status}）`);
    error.code = response.status === 401 ? 'gitlab_token_invalid' : 'gitlab_unavailable';
    error.status = response.status === 401 ? 401 : 502;
    throw error;
  }
  const user = await response.json();
  if (!Number(user?.id)) throw new Error('GitLab 未返回有效数字用户 ID');
  return user;
}

/** 使用 GitLab PAT 校验网页账号，但不创建雨燕设备或中央会话。 */
export async function verifyGitlabCredential(input) {
  const parsed = gitlabCredentialSchema.parse(input);
  const gitlabHost = normalizeGitlabHost(parsed.gitlabHost);
  // 向 GitLab 发请求之前校验白名单，假地址直接拒绝（#62）
  assertGitlabHostAllowed(gitlabHost, { scene: '网页端 GitLab 鉴权' });
  const user = await fetchGitlabUser(gitlabHost, parsed.gitlabToken);
  return { gitlabHost, user };
}

/**
 * 统计账号空间中的根业务资源数量。
 * @description 仅统计能够代表部署数据归属的根表；子表均继承服务器或目标的 team_id。
 * @param {import('node:sqlite').DatabaseSync} db 数据库连接
 * @param {string} scopeId 账号空间 ID
 * @returns {number} 业务资源总数
 */
function countBusinessScopeResources(db, scopeId) {
  return BUSINESS_SCOPE_TABLES.reduce((total, tableName) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE team_id = ?`).get(scopeId);
    return total + Number(row?.count || 0);
  }, 0);
}

/**
 * 将已验证账号加入旧数据空间。
 * @description 保留已有成员、GitLab 绑定和业务表 team_id，避免破坏共享协作与历史凭据的 AES-GCM AAD。
 * @param {import('node:sqlite').DatabaseSync} db 数据库连接
 * @param {string} userId 当前已验证账号 ID
 * @param {string} timestamp 更新时间
 * @returns {{ id: string, role: 'admin' }} 旧数据账号空间
 */
function bindLegacyAccountScope(db, userId, timestamp) {
  db.prepare(`
    INSERT INTO teams (id, name, status, migration_state, created_at, updated_at)
    VALUES (?, '账号空间', 'active', 'bound', ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = '账号空间', status = 'active', migration_state = 'bound', updated_at = excluded.updated_at
  `).run(LEGACY_SCOPE_ID, timestamp, timestamp);
  db.prepare(`
    INSERT INTO team_members (team_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, 'admin', 'active', ?, ?)
    ON CONFLICT(team_id, user_id) DO UPDATE SET role = 'admin', status = 'active', updated_at = excluded.updated_at
  `).run(LEGACY_SCOPE_ID, userId, timestamp, timestamp);
  return { id: LEGACY_SCOPE_ID, role: 'admin' };
}

/**
 * 判断账号是否有旧发布记录的明确归属证据。
 * @description 只接受早于中央账号创建时间的历史记录，防止新记录伪造认领证据。
 * @param {import('node:sqlite').DatabaseSync} db 数据库连接
 * @param {string} userId 当前已验证账号 ID
 * @returns {boolean} 是否命中历史操作人
 */
function hasLegacyOperatorEvidence(db, userId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM users u
    INNER JOIN deploy_records r ON r.team_id = ?
    WHERE u.id = ?
      AND TRIM(COALESCE(r.operator, '')) <> ''
      AND r.created_at < u.created_at
      AND LOWER(TRIM(r.operator)) IN (LOWER(TRIM(u.display_name)), LOWER(TRIM(u.username)))
    LIMIT 1
  `).get(LEGACY_SCOPE_ID, userId));
}

/**
 * 判断当前账号能否安全加入旧数据空间。
 * @param {import('node:sqlite').DatabaseSync} db 数据库连接
 * @param {string} userId 当前已验证账号 ID
 * @param {string} personalScopeId 当前账号的个人空间 ID
 * @returns {boolean} 是否允许自动加入
 */
function canAutoJoinLegacyAccountScope(db, userId, personalScopeId) {
  if (countBusinessScopeResources(db, LEGACY_SCOPE_ID) === 0) return false;
  if (countBusinessScopeResources(db, personalScopeId) > 0) return false;
  if (hasLegacyOperatorEvidence(db, userId)) return true;
  const activeUsers = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").get()?.count || 0);
  const activeLegacyMembers = Number(db.prepare("SELECT COUNT(*) AS count FROM team_members WHERE team_id = ? AND status = 'active'").get(LEGACY_SCOPE_ID)?.count || 0);
  const legacyBindings = Number(db.prepare('SELECT COUNT(*) AS count FROM team_gitlab_bindings WHERE team_id = ?').get(LEGACY_SCOPE_ID)?.count || 0);
  return activeUsers === 1 && activeLegacyMembers === 0 && legacyBindings === 0;
}

/**
 * 为账号创建不可见的数据隔离空间。
 * @description 继续复用 team_id 数据列以兼容旧库，但产品模型只暴露账号与设备。
 */
function ensureAccountScope(db, userId) {
  const personalScopeId = `account-${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
  const timestamp = now();
  const legacyMembership = db.prepare(`
    SELECT tm.role, t.status AS teamStatus
    FROM team_members tm INNER JOIN teams t ON t.id = tm.team_id
    WHERE tm.team_id = ? AND tm.user_id = ? AND tm.status = 'active'
  `).get(LEGACY_SCOPE_ID, userId);
  if (legacyMembership) {
    if (legacyMembership.teamStatus !== 'active' || !ROLES.has(legacyMembership.role)) {
      return bindLegacyAccountScope(db, userId, timestamp);
    }
    return { id: LEGACY_SCOPE_ID, role: legacyMembership.role };
  }

  const personalScope = db.prepare(`
    SELECT t.id, tm.role FROM teams t
    INNER JOIN team_members tm ON tm.team_id = t.id
    WHERE t.id = ? AND tm.user_id = ? AND tm.status = 'active'
  `).get(personalScopeId, userId);
  if (canAutoJoinLegacyAccountScope(db, userId, personalScopeId)) {
    return bindLegacyAccountScope(db, userId, timestamp);
  }
  if (personalScope) return { id: personalScope.id, role: 'admin' };

  const teamCount = Number(db.prepare('SELECT COUNT(*) AS count FROM teams').get()?.count || 0);
  const memberCount = Number(db.prepare('SELECT COUNT(*) AS count FROM team_members').get()?.count || 0);
  if (teamCount === 0 && memberCount === 0) {
    return bindLegacyAccountScope(db, userId, timestamp);
  }

  db.prepare(`
    INSERT INTO teams (id, name, status, migration_state, created_at, updated_at)
    VALUES (?, '账号空间', 'active', 'bound', ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'active', migration_state = 'bound', updated_at = excluded.updated_at
  `).run(personalScopeId, timestamp, timestamp);
  db.prepare(`
    INSERT INTO team_members (team_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, 'admin', 'active', ?, ?)
    ON CONFLICT(team_id, user_id) DO UPDATE SET role = 'admin', status = 'active', updated_at = excluded.updated_at
  `).run(personalScopeId, userId, timestamp, timestamp);
  return { id: personalScopeId, role: 'admin' };
}

/** 创建访问/刷新令牌并只保存摘要。 */
function issueSession(db, { userId, deviceId, teamId }) {
  const timestamp = now();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const accessExpiresAt = new Date(Date.now() + ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  const sessionId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO auth_sessions
    (id, user_id, device_id, team_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, status, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(sessionId, userId, deviceId, teamId || null, tokenHash(accessToken), tokenHash(refreshToken), accessExpiresAt, refreshExpiresAt, timestamp, timestamp, timestamp);
  return { sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

/** GitLab PAT 换取雨燕设备会话。 */
export async function exchangeGitlabIdentity(input) {
  const parsed = gitlabExchangeSchema.parse(input);
  const gitlabHost = normalizeGitlabHost(parsed.gitlabHost);
  // 向 GitLab 发请求之前校验白名单，假地址直接拒绝（#62）
  assertGitlabHostAllowed(gitlabHost, { scene: 'App GitLab 换票' });
  const gitlabUser = await fetchGitlabUser(gitlabHost, parsed.gitlabToken);
  const userId = buildAccountId(gitlabHost, gitlabUser.id);
  const db = await ensureCentralIdentitySchema();
  const timestamp = now();
  const gitlabEmail = resolveGitlabEmail(gitlabUser);
  db.prepare(`
    INSERT INTO users (id, display_name, username, avatar_url, email, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, username = excluded.username,
      avatar_url = excluded.avatar_url,
      email = COALESCE(NULLIF(excluded.email, ''), users.email),
      status = 'active', updated_at = excluded.updated_at
  `).run(userId, String(gitlabUser.name || gitlabUser.username || userId), String(gitlabUser.username || ''), String(gitlabUser.avatar_url || ''), gitlabEmail, timestamp, timestamp);
  const gitlabWebUrl = String(gitlabUser.web_url || '').trim();
  const gitlabCreatedAt = String(gitlabUser.created_at || '').trim();
  db.prepare(`
    INSERT INTO identity_links (user_id, provider, provider_host, external_user_id, external_username, external_web_url, external_created_at, created_at, updated_at)
    VALUES (?, 'gitlab', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_host, external_user_id) DO UPDATE SET
      external_username = excluded.external_username,
      external_web_url = COALESCE(NULLIF(excluded.external_web_url, ''), identity_links.external_web_url),
      external_created_at = COALESCE(NULLIF(excluded.external_created_at, ''), identity_links.external_created_at),
      updated_at = excluded.updated_at
  `).run(userId, gitlabHost, String(gitlabUser.id), String(gitlabUser.username || ''), gitlabWebUrl, gitlabCreatedAt, timestamp, timestamp);
  const existingDevice = db.prepare('SELECT public_key, status FROM devices WHERE device_id = ? AND user_id = ?')
    .get(parsed.device.deviceId, userId);
  if (existingDevice?.status === 'revoked') {
    const error = new Error('该设备已被撤销，不能静默重新注册；请在可信设备上重新登记新设备身份');
    error.code = 'device_revoked';
    error.status = 403;
    throw error;
  }
  if (existingDevice?.public_key && existingDevice.public_key !== parsed.device.publicKey) {
    const error = new Error('设备 ID 与已登记公钥不一致');
    error.code = 'device_key_mismatch';
    error.status = 403;
    throw error;
  }
  db.prepare(`
    INSERT INTO devices (device_id, user_id, public_key, device_name, platform, status, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(device_id, user_id) DO UPDATE SET public_key = excluded.public_key, device_name = excluded.device_name,
      platform = excluded.platform, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at
  `).run(parsed.device.deviceId, userId, parsed.device.publicKey, parsed.device.deviceName, parsed.device.platform, timestamp, timestamp, timestamp);

  const accountScope = ensureAccountScope(db, userId);
  db.prepare("UPDATE auth_sessions SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE user_id = ? AND device_id = ? AND status = 'active'")
    .run(timestamp, timestamp, userId, parsed.device.deviceId);
  const session = issueSession(db, { userId, deviceId: parsed.device.deviceId, teamId: accountScope.id });
  return {
    accountId: userId,
    user: { id: gitlabUser.id, username: gitlabUser.username, name: gitlabUser.name, avatarUrl: gitlabUser.avatar_url },
    deviceId: parsed.device.deviceId,
    teamId: accountScope.id,
    role: accountScope.role,
    ...session,
  };
}

/** 将 Ed25519 原始公钥转换为 Node 可验证的 SPKI KeyObject。 */
function createEd25519PublicKey(rawBase64) {
  const raw = Buffer.from(String(rawBase64 || ''), 'base64');
  if (raw.length !== 32) throw new Error('设备公钥长度无效');
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

/** 使用设备签名轮换刷新令牌。 */
export async function refreshDeviceSession(input) {
  const parsed = refreshSessionSchema.parse(input);
  if (Math.abs(Date.now() - parsed.timestamp) > SIGNATURE_CLOCK_SKEW_MS) {
    const error = new Error('设备签名时间已过期，请校准系统时间后重试');
    error.code = 'device_signature_expired';
    error.status = 401;
    throw error;
  }
  const db = await ensureCentralIdentitySchema();
  const session = db.prepare(`
    SELECT s.*, d.public_key, d.status AS device_status, tm.role, tm.status AS member_status
    FROM auth_sessions s
    INNER JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
    LEFT JOIN team_members tm ON tm.team_id = s.team_id AND tm.user_id = s.user_id
    WHERE s.refresh_token_hash = ? AND s.device_id = ? AND s.status = 'active'
  `).get(tokenHash(parsed.refreshToken), parsed.deviceId);
  if (!session || session.device_status !== 'active' || (session.team_id && session.member_status !== 'active') || Date.parse(session.refresh_expires_at) <= Date.now()) {
    const error = new Error('刷新会话已失效，请重新登录雨燕');
    error.code = 'session_expired';
    error.status = 401;
    throw error;
  }
  const signedPayload = `${parsed.deviceId}.${parsed.timestamp}.${parsed.nonce}.${parsed.refreshToken}`;
  const valid = crypto.verify(null, Buffer.from(signedPayload), createEd25519PublicKey(session.public_key), Buffer.from(parsed.signature, 'base64'));
  if (!valid) {
    const error = new Error('设备签名验证失败');
    error.code = 'device_signature_invalid';
    error.status = 401;
    throw error;
  }
  try {
    db.prepare('INSERT INTO auth_refresh_nonces (session_id, nonce, created_at) VALUES (?, ?, ?)').run(session.id, parsed.nonce, now());
  } catch {
    const error = new Error('刷新请求已被使用，请重新发起');
    error.code = 'refresh_replay_detected';
    error.status = 409;
    throw error;
  }
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const accessExpiresAt = new Date(Date.now() + ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  const timestamp = now();
  const accountScope = ensureAccountScope(db, session.user_id);
  db.prepare(`
    UPDATE auth_sessions SET access_token_hash = ?, refresh_token_hash = ?, access_expires_at = ?, refresh_expires_at = ?,
      team_id = ?, last_seen_at = ?, updated_at = ? WHERE id = ?
  `).run(tokenHash(accessToken), tokenHash(refreshToken), accessExpiresAt, refreshExpiresAt, accountScope.id, timestamp, timestamp, session.id);
  db.prepare('UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ? AND user_id = ?')
    .run(timestamp, timestamp, session.device_id, session.user_id);
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, accountId: session.user_id, teamId: accountScope.id, role: accountScope.role };
}

/** 解析访问令牌并验证账号、设备与内部隔离空间状态。 */
export async function resolveAccessPrincipal(accessToken) {
  const db = await ensureCentralIdentitySchema();
  const session = db.prepare(`
    SELECT s.*, d.status AS device_status, u.status AS user_status
    FROM auth_sessions s
    INNER JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.access_token_hash = ? AND s.status = 'active'
  `).get(tokenHash(accessToken));
  if (!session || session.device_status !== 'active' || session.user_status !== 'active' || Date.parse(session.access_expires_at) <= Date.now()) return null;
  const accountScope = ensureAccountScope(db, session.user_id);
  if (session.team_id !== accountScope.id) {
    db.prepare("UPDATE auth_sessions SET team_id = ?, updated_at = ? WHERE user_id = ? AND status = 'active'")
      .run(accountScope.id, now(), session.user_id);
  }
  const teamId = accountScope.id;
  if (!teamId) return { accountId: session.user_id, userId: session.user_id, deviceId: session.device_id, teamId: '', role: 'viewer', sessionId: session.id };
  const membership = db.prepare(`
    SELECT tm.role, tm.status, t.status AS team_status, t.migration_state
    FROM team_members tm INNER JOIN teams t ON t.id = tm.team_id
    WHERE tm.team_id = ? AND tm.user_id = ?
  `).get(teamId, session.user_id);
  if (!membership || membership.status !== 'active' || membership.team_status !== 'active' || !ROLES.has(membership.role)) return null;
  return {
    accountId: session.user_id,
    userId: session.user_id,
    deviceId: session.device_id,
    teamId,
    role: membership.role,
    sessionId: session.id,
  };
}

/** Express v2 鉴权中间件。 */
export async function authorizeCentralV2(req, res, next) {
  try {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const principal = await resolveAccessPrincipal(bearer);
    if (!principal) {
      res.status(401).json({ success: false, error: { code: 'session_invalid', message: '雨燕账号或设备会话已失效', retryable: true } });
      return;
    }
    const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
    runRequestContext({ ...principal, client: String(req.headers['x-yuyan-client'] || 'desktop').slice(0, 32), requestId }, next);
  } catch (error) {
    next(error);
  }
}

/** 撤销当前访问令牌对应的会话。 */
export async function logoutCentralSession(accessToken) {
  const db = await ensureCentralIdentitySchema();
  const timestamp = now();
  const result = db.prepare("UPDATE auth_sessions SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE access_token_hash = ? AND status = 'active'")
    .run(timestamp, timestamp, tokenHash(accessToken));
  return { revoked: result.changes > 0 };
}

/** 列出当前账号的设备，不返回公钥。 */
export async function listUserDevices(userId) {
  const db = await ensureCentralIdentitySchema();
  return db.prepare(`
    SELECT device_id AS deviceId, device_name AS deviceName, platform, status, last_seen_at AS lastSeenAt,
      revoked_at AS revokedAt, created_at AS createdAt
    FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC
  `).all(userId);
}

/** 撤销设备并使该设备的全部会话和未执行中央任务失效。 */
export async function revokeUserDevice(userId, deviceId) {
  const db = await ensureCentralIdentitySchema();
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE user_id = ? AND device_id = ? AND status = 'active'")
      .run(timestamp, timestamp, userId, deviceId);
    db.prepare("UPDATE auth_sessions SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE user_id = ? AND device_id = ? AND status = 'active'")
      .run(timestamp, timestamp, userId, deviceId);
    db.prepare(`
      UPDATE central_agent_operations SET status = 'cancelled', error_json = ?, updated_at = ?
      WHERE actor_user_id = ? AND device_id = ? AND status IN ('pending_approval', 'queued')
    `).run(JSON.stringify({ code: 'device_revoked', message: '设备已撤销' }), timestamp, userId, deviceId);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_jobs'").get()) {
      db.prepare("UPDATE artifact_jobs SET status = 'cancelled', error_json = ?, updated_at = ? WHERE actor_user_id = ? AND device_id = ? AND status IN ('uploading','ready','queued')")
        .run(JSON.stringify({ code: 'device_revoked', message: '设备已撤销' }), timestamp, userId, deviceId);
    }
    db.exec('COMMIT');
    abortCentralOperationsForDevice(userId, deviceId);
    return { revoked: result.changes > 0 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 读取账号跨设备强制审批工具列表。 */
export async function getAccountApprovalPolicy(context) {
  const db = await ensureCentralIdentitySchema();
  const forcedTools = db.prepare(`
    SELECT tool_name AS toolName
    FROM team_approval_policies
    WHERE team_id = ? AND require_approval = 1
    ORDER BY tool_name ASC
  `).all(context.teamId).map((row) => row.toolName);
  return { accountId: context.userId, forcedTools };
}

/** 原子替换账号跨设备强制审批工具列表。 */
export async function replaceAccountApprovalPolicy(context, input = {}) {
  const requested = Array.isArray(input.forcedTools) ? [...new Set(input.forcedTools.map((item) => String(item || '').trim()))] : [];
  const invalid = requested.filter((toolName) => !APPROVAL_TOOL_NAMES.has(toolName));
  if (invalid.length) {
    const error = new Error(`不支持的审批工具：${invalid.join('、')}`);
    error.code = 'approval_policy_invalid';
    error.status = 400;
    throw error;
  }
  const db = await ensureCentralIdentitySchema();
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM team_approval_policies WHERE team_id = ?').run(context.teamId);
    const insert = db.prepare(`
      INSERT INTO team_approval_policies (team_id, tool_name, require_approval, updated_by, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `);
    for (const toolName of requested) insert.run(context.teamId, toolName, context.userId, timestamp, timestamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  await appendCentralAudit(context, { action: 'account_approval_policy_updated', forcedTools: requested });
  return { accountId: context.userId, forcedTools: requested.sort() };
}

/** 写入按账号隔离空间串联的中央审计事件。 */
export async function appendCentralAudit(context, body) {
  const db = await ensureCentralIdentitySchema();
  const timestamp = now();
  const eventId = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const previousHash = String(db.prepare('SELECT entry_hash FROM central_audit WHERE team_id = ? ORDER BY id DESC LIMIT 1').get(context.teamId)?.entry_hash || 'GENESIS');
    const safeBody = JSON.stringify({ ...body, eventId, teamId: context.teamId, actorUserId: context.userId, deviceId: context.deviceId, client: context.client, requestId: context.requestId, createdAt: timestamp });
    const entryHash = crypto.createHmac('sha256', DEPLOY_SECRET_KEY).update(`${context.teamId}\n${previousHash}\n${safeBody}`).digest('hex');
    db.prepare(`
      INSERT INTO central_audit (event_id, team_id, actor_user_id, device_id, client, request_id, previous_hash, entry_hash, body_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, context.teamId, context.userId, context.deviceId, context.client, context.requestId, previousHash, entryHash, safeBody, timestamp);
    db.exec('COMMIT');
    return { eventId, previousHash, entryHash };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 列出并校验当前账号的中央 HMAC 审计链。 */
export async function getCentralAuditSnapshot(context, query = {}) {
  const db = await ensureCentralIdentitySchema();
  const rows = db.prepare('SELECT * FROM central_audit WHERE team_id = ? ORDER BY id ASC').all(context.teamId);
  let previousHash = 'GENESIS';
  let brokenAt = '';
  for (const row of rows) {
    const expected = crypto.createHmac('sha256', DEPLOY_SECRET_KEY).update(`${context.teamId}\n${previousHash}\n${row.body_json}`).digest('hex');
    if (row.previous_hash !== previousHash || row.entry_hash !== expected) {
      brokenAt = row.event_id;
      break;
    }
    previousHash = row.entry_hash;
  }
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const items = rows.slice(-limit).reverse().map((row) => {
    let body;
    try {
      body = JSON.parse(row.body_json);
    } catch {
      body = { eventId: row.event_id, action: 'unreadable_audit_entry' };
    }
    return { ...body, previousHash: row.previous_hash, entryHash: row.entry_hash };
  });
  return { items, total: rows.length, chain: { valid: !brokenAt, count: rows.length, ...(brokenAt ? { brokenAt } : {}) } };
}

/** 构造用于匹配部署记录 operator 的当前用户标识集合（忽略大小写与空白）。 */
export function buildUserOperatorIdentifiers(values = []) {
  const excluded = new Set(['', '未知操作人', 'legacy-disabled', 'system', 'legacy-device']);
  const seen = new Set();
  for (const raw of values) {
    const normalized = String(raw || '').trim().toLowerCase();
    if (!normalized || excluded.has(normalized)) continue;
    seen.add(normalized);
  }
  return [...seen];
}

/** 读取指定账号已有的工作区与角色归属（只读，不自动创建新空间）。 */
function findExistingMembership(db, userId, preferredTeamId = '') {
  if (!userId) return null;
  if (preferredTeamId) {
    const row = db.prepare(`
      SELECT t.id AS teamId, t.name AS teamName, tm.role AS role
      FROM team_members tm
      INNER JOIN teams t ON t.id = tm.team_id
      WHERE tm.team_id = ? AND tm.user_id = ? AND tm.status = 'active' AND t.status = 'active'
      LIMIT 1
    `).get(preferredTeamId, userId);
    if (row && ROLES.has(row.role)) return row;
  }
  const legacyRow = db.prepare(`
    SELECT t.id AS teamId, t.name AS teamName, tm.role AS role
    FROM team_members tm
    INNER JOIN teams t ON t.id = tm.team_id
    WHERE tm.team_id = ? AND tm.user_id = ? AND tm.status = 'active' AND t.status = 'active'
    LIMIT 1
  `).get(LEGACY_SCOPE_ID, userId);
  if (legacyRow && ROLES.has(legacyRow.role)) return legacyRow;
  const anyRow = db.prepare(`
    SELECT t.id AS teamId, t.name AS teamName, tm.role AS role
    FROM team_members tm
    INNER JOIN teams t ON t.id = tm.team_id
    WHERE tm.user_id = ? AND tm.status = 'active' AND t.status = 'active'
    ORDER BY tm.updated_at DESC
    LIMIT 1
  `).get(userId);
  return anyRow && ROLES.has(anyRow.role) ? anyRow : null;
}

/**
 * 鉴权 /api/v2 个人资料与会话管理请求：支持桌面端中央 Bearer 会话及网页端 GitLab PAT。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function authorizeProfileRequest(req, res, next) {
  try {
    const authHeader = String(req.headers.authorization || '').trim();
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer) {
      const principal = await resolveAccessPrincipal(bearer);
      if (!principal) {
        res.status(401).json({ success: false, error: { code: 'session_invalid', message: '雨燕账号或设备会话已失效', retryable: true } });
        return;
      }
      const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
      runRequestContext(
        {
          ...principal,
          authMode: 'central',
          client: String(req.headers['x-yuyan-client'] || 'desktop').slice(0, 32),
          requestId,
        },
        next,
      );
      return;
    }

    const gitlabHost = String(req.headers['x-gitlab-host'] || '').trim();
    const gitlabToken = String(req.headers['x-gitlab-token'] || '').trim();
    if (gitlabHost && gitlabToken) {
      let verified;
      try {
        verified = await verifyGitlabCredential({ gitlabHost, gitlabToken });
      } catch (error) {
        const status = Number(error?.status) === 502 ? 502 : 401;
        res.status(status).json({
          success: false,
          error: {
            code: String(error?.code || 'web_gitlab_auth_failed'),
            message: String(error?.message || 'GitLab 会话验证失败'),
            retryable: status >= 500,
          },
        });
        return;
      }
      const userId = buildAccountId(verified.gitlabHost, verified.user.id);
      const db = await ensureCentralIdentitySchema();
      const membership = findExistingMembership(db, userId);
      req.webGitlabUser = verified.user;
      req.webGitlabHost = verified.gitlabHost;
      const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
      runRequestContext(
        {
          accountId: userId,
          userId,
          deviceId: '',
          teamId: membership?.teamId || '',
          role: membership?.role || '',
          sessionId: '',
          authMode: 'web_gitlab',
          client: 'web',
          requestId,
        },
        next,
      );
      return;
    }

    res.status(401).json({
      success: false,
      error: { code: 'session_invalid', message: '请先登录雨燕账号', retryable: true },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 列出当前账号的活跃会话（按当前会话优先、最近活跃倒序），不返回任何令牌摘要或设备公钥。
 * @param {string} userId - 中央账号 ID
 * @param {string} [currentSessionId] - 当前请求对应的会话 ID
 */
export async function listUserSessions(userId, currentSessionId = '') {
  const db = await ensureCentralIdentitySchema();
  const currentTime = Date.now();
  const rows = db.prepare(`
    SELECT s.id AS sessionId, s.device_id AS deviceId, s.status, s.last_seen_at AS lastSeenAt,
      s.created_at AS createdAt, s.access_expires_at AS accessExpiresAt, s.refresh_expires_at AS refreshExpiresAt,
      d.device_name AS deviceName, d.platform AS platform
    FROM auth_sessions s
    INNER JOIN devices d ON d.device_id = s.device_id AND d.user_id = s.user_id
    WHERE s.user_id = ? AND s.status = 'active' AND d.status = 'active'
    ORDER BY s.last_seen_at DESC, s.created_at DESC
  `).all(userId);
  return rows
    .filter((row) => !row.refreshExpiresAt || Date.parse(row.refreshExpiresAt) > currentTime)
    .map((row) => ({
      sessionId: row.sessionId,
      deviceId: row.deviceId,
      deviceName: row.deviceName || row.platform || '未命名设备',
      platform: row.platform || 'unknown',
      status: row.status,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
      accessExpiresAt: row.accessExpiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      isCurrent: Boolean(currentSessionId && row.sessionId === currentSessionId),
    }))
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
}

/**
 * 注销当前账号名下的其他活跃会话；禁止注销当前会话，也不可跨账号操作。
 * @param {string} userId - 当前已鉴权账号 ID
 * @param {string} sessionId - 待注销会话 ID
 * @param {string} [currentSessionId] - 当前会话 ID
 */
export async function revokeUserSession(userId, sessionId, currentSessionId = '') {
  const targetSessionId = String(sessionId || '').trim();
  if (!targetSessionId) {
    const error = new Error('会话 ID 不能为空');
    error.code = 'invalid_request';
    error.status = 400;
    throw error;
  }
  if (currentSessionId && targetSessionId === currentSessionId) {
    const error = new Error('不能注销当前正在使用的会话');
    error.code = 'cannot_revoke_current_session';
    error.status = 400;
    throw error;
  }
  const db = await ensureCentralIdentitySchema();
  const timestamp = now();
  const result = db.prepare(`
    UPDATE auth_sessions
    SET status = 'revoked', revoked_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'active'
  `).run(timestamp, timestamp, targetSessionId, userId);
  if (result.changes === 0) {
    const error = new Error('会话不存在或已注销');
    error.code = 'session_not_found';
    error.status = 404;
    throw error;
  }
  return { revoked: true, sessionId: targetSessionId };
}

/**
 * 读取当前登录用户的完整个人资料（GitLab 信息、雨燕身份与会话、近 30 天发布活动）。
 * @description 严格按 principal.userId 隔离，不泄露其他用户数据，不新增秘密持久化。
 */
export async function getUserProfile(principal, options = {}) {
  const db = await ensureCentralIdentitySchema();
  const userId = String(principal?.userId || '').trim();
  const dbUser = userId
    ? db.prepare(`
        SELECT id, display_name, username, avatar_url, email, status, created_at, updated_at
        FROM users WHERE id = ?
      `).get(userId)
    : null;
  const link = userId
    ? db.prepare(`
        SELECT provider_host, external_user_id, external_username, external_web_url, external_created_at
        FROM identity_links
        WHERE user_id = ? AND provider = 'gitlab'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(userId)
    : null;

  let liveUser = options.webGitlabUser && typeof options.webGitlabUser === 'object' ? options.webGitlabUser : null;
  let resolvedHost = String(options.webGitlabHost || link?.provider_host || '').trim();

  // 若本地尚未缓存 GitLab 创建时间或主页链接，且请求自带当前会话的 GitLab Token，则只读拉取一次并回填非敏感元数据
  if (
    !liveUser
    && (!link?.external_created_at || !link?.external_web_url || !dbUser?.email)
    && options.gitlabHost
    && options.gitlabToken
  ) {
    try {
      const normalizedHost = normalizeGitlabHost(options.gitlabHost);
      assertGitlabHostAllowed(normalizedHost, { scene: '补充用户资料' });
      const fetched = await fetchGitlabUser(normalizedHost, options.gitlabToken);
      if (buildAccountId(normalizedHost, fetched.id) === userId) {
        liveUser = fetched;
        resolvedHost = normalizedHost;
        const ts = now();
        const email = resolveGitlabEmail(fetched);
        if (dbUser) {
          db.prepare(`
            UPDATE users
            SET display_name = ?, username = ?, avatar_url = ?,
                email = COALESCE(NULLIF(?, ''), email), updated_at = ?
            WHERE id = ?
          `).run(
            String(fetched.name || fetched.username || dbUser.display_name),
            String(fetched.username || dbUser.username),
            String(fetched.avatar_url || dbUser.avatar_url || ''),
            email,
            ts,
            userId,
          );
        }
        if (link) {
          db.prepare(`
            UPDATE identity_links
            SET external_username = ?,
                external_web_url = COALESCE(NULLIF(?, ''), external_web_url),
                external_created_at = COALESCE(NULLIF(?, ''), external_created_at),
                updated_at = ?
            WHERE user_id = ? AND provider = 'gitlab' AND provider_host = ?
          `).run(
            String(fetched.username || link.external_username || ''),
            String(fetched.web_url || '').trim(),
            String(fetched.created_at || '').trim(),
            ts,
            userId,
            link.provider_host,
          );
        }
      }
    } catch {
      // GitLab 临时不可达或可选令牌过期时降级为已有本地字段
    }
  }

  const gitlab = {
    id: Number(liveUser?.id || link?.external_user_id || 0) || null,
    host: resolvedHost,
    username: String(liveUser?.username || dbUser?.username || link?.external_username || ''),
    displayName: String(liveUser?.name || dbUser?.display_name || liveUser?.username || dbUser?.username || ''),
    avatarUrl: String(liveUser?.avatar_url || dbUser?.avatar_url || ''),
    email: resolveGitlabEmail(liveUser) || String(dbUser?.email || ''),
    createdAt: String(liveUser?.created_at || link?.external_created_at || '').trim(),
    webUrl: String(liveUser?.web_url || link?.external_web_url || '').trim(),
  };

  const membership = findExistingMembership(db, userId, principal?.teamId || '');
  const sessions = userId ? await listUserSessions(userId, principal?.sessionId || '') : [];

  const operatorCandidates = buildUserOperatorIdentifiers([
    userId,
    gitlab.username,
    gitlab.displayName,
    dbUser?.username,
    dbUser?.display_name,
    link?.external_username,
  ]);
  const teamIds = [...new Set([SHARED_DEPLOY_WORKSPACE_ID, membership?.teamId, principal?.teamId].filter(Boolean))];
  const windowDays = 30;
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  let stats30d = {
    totalCount: 0,
    successCount: 0,
    failedCount: 0,
    stoppedCount: 0,
    runningCount: 0,
    finishedCount: 0,
    successRate: null,
  };
  let recentDeploys = [];

  if (operatorCandidates.length > 0 && teamIds.length > 0) {
    const teamPlaceholders = teamIds.map(() => '?').join(', ');
    const opPlaceholders = operatorCandidates.map(() => '?').join(', ');
    const baseWhere = `
      r.team_id IN (${teamPlaceholders})
      AND TRIM(COALESCE(r.operator, '')) <> ''
      AND LOWER(TRIM(r.operator)) IN (${opPlaceholders})
    `;
    const baseParams = [...teamIds, ...operatorCandidates];

    const summary = db.prepare(`
      SELECT
        COUNT(*) AS totalCount,
        SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS successCount,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
        SUM(CASE WHEN r.status = 'stopped' THEN 1 ELSE 0 END) AS stoppedCount,
        SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) AS runningCount
      FROM deploy_records r
      WHERE ${baseWhere}
        AND COALESCE(NULLIF(r.started_at, ''), r.created_at) >= ?
    `).get(...baseParams, sinceIso);

    const totalCount = Number(summary?.totalCount || 0);
    const successCount = Number(summary?.successCount || 0);
    const failedCount = Number(summary?.failedCount || 0);
    const stoppedCount = Number(summary?.stoppedCount || 0);
    const runningCount = Number(summary?.runningCount || 0);
    const finishedCount = successCount + failedCount + stoppedCount;
    stats30d = {
      totalCount,
      successCount,
      failedCount,
      stoppedCount,
      runningCount,
      finishedCount,
      successRate: finishedCount > 0 ? Math.round((successCount / finishedCount) * 1000) / 10 : null,
    };

    recentDeploys = db.prepare(`
      SELECT r.id, r.target_id AS targetId, r.project_id AS projectId, r.project_name AS projectName,
        r.env_name AS envName, r.branch, r.commit_sha AS commitSha, r.commit_message AS commitMessage,
        r.status, r.action, r.operator, r.started_at AS startedAt, r.finished_at AS finishedAt,
        r.created_at AS createdAt, s.name AS serverName
      FROM deploy_records r
      LEFT JOIN deploy_targets t ON t.id = r.target_id
      LEFT JOIN deploy_servers s ON s.id = t.server_id
      WHERE ${baseWhere}
      ORDER BY COALESCE(NULLIF(r.started_at, ''), r.created_at) DESC, r.id DESC
      LIMIT 10
    `).all(...baseParams).map((row) => ({
      id: row.id,
      targetId: row.targetId,
      projectId: row.projectId,
      projectName: row.projectName || '',
      envName: row.envName || '',
      branch: row.branch || '',
      commitSha: row.commitSha || '',
      commitMessage: row.commitMessage || '',
      status: row.status || '',
      action: row.action || 'deploy',
      operator: row.operator || '',
      startedAt: row.startedAt || row.createdAt || '',
      finishedAt: row.finishedAt || '',
      createdAt: row.createdAt || '',
      serverName: row.serverName || '',
    }));
  }

  return {
    accountId: userId,
    gitlab,
    identity: {
      team: membership ? { id: membership.teamId, name: membership.teamName } : null,
      role: membership?.role || '',
      isSystemAdmin: Boolean(options.systemAdminAccess?.isSystemAdmin),
      currentDeviceId: principal?.deviceId || '',
      currentSessionId: principal?.sessionId || '',
      authMode: principal?.authMode || 'central',
      sessions,
      sessionCapabilities: {
        canList: true,
        canRevokeOthers: true,
      },
    },
    activity: {
      windowDays,
      stats30d,
      recentDeploys,
    },
  };
}
