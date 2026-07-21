/**
 * 雨燕中央账号、设备与短期会话服务。
 * @description GitLab PAT 仅用于实时验证，不写入中央数据库。
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { DEPLOY_SECRET_KEY } from '../config/constants.mjs';
import { getDeployDb } from './deploy-store.mjs';
import { runRequestContext } from './request-context.mjs';
import { abortCentralOperationsForDevice } from './central-operation-runtime.mjs';

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const SIGNATURE_CLOCK_SKEW_MS = 5 * 60_000;
const ROLES = new Set(['viewer', 'operator', 'admin']);
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
  return db;
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
  const user = await fetchGitlabUser(gitlabHost, parsed.gitlabToken);
  return { gitlabHost, user };
}

/**
 * 为账号创建不可见的数据隔离空间。
 * @description 继续复用 team_id 数据列以兼容旧库，但产品模型只暴露账号与设备。
 */
function ensureAccountScope(db, userId) {
  const personalScopeId = `account-${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
  const personalScope = db.prepare(`
    SELECT t.id, tm.role FROM teams t
    INNER JOIN team_members tm ON tm.team_id = t.id
    WHERE t.id = ? AND tm.user_id = ? AND tm.status = 'active'
  `).get(personalScopeId, userId);
  if (personalScope) return { id: personalScope.id, role: 'admin' };

  const teamCount = Number(db.prepare('SELECT COUNT(*) AS count FROM teams').get()?.count || 0);
  const memberCount = Number(db.prepare('SELECT COUNT(*) AS count FROM team_members').get()?.count || 0);
  const timestamp = now();
  if (teamCount === 0 && memberCount === 0) {
    db.prepare("INSERT INTO teams (id, name, status, migration_state, created_at, updated_at) VALUES ('legacy-team', '账号空间', 'active', 'bound', ?, ?)")
      .run(timestamp, timestamp);
    db.prepare("INSERT INTO team_members (team_id, user_id, role, status, created_at, updated_at) VALUES ('legacy-team', ?, 'admin', 'active', ?, ?)")
      .run(userId, timestamp, timestamp);
    return { id: 'legacy-team', role: 'admin' };
  }

  const legacyOwner = db.prepare(`
    SELECT user_id FROM team_members
    WHERE team_id = 'legacy-team' AND status = 'active'
    ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1
  `).get();
  if (legacyOwner?.user_id === userId) {
    const legacyState = db.prepare(`
      SELECT t.migration_state AS migrationState, tm.role,
        (SELECT COUNT(*) FROM team_members WHERE team_id = 'legacy-team' AND status = 'active') AS activeMembers,
        (SELECT COUNT(*) FROM team_gitlab_bindings WHERE team_id = 'legacy-team') AS bindings
      FROM teams t INNER JOIN team_members tm ON tm.team_id = t.id
      WHERE t.id = 'legacy-team' AND tm.user_id = ? AND tm.status = 'active'
    `).get(userId);
    if (legacyState?.migrationState === 'bound' && legacyState.role === 'admin' && Number(legacyState.activeMembers) === 1 && Number(legacyState.bindings) === 0) {
      return { id: 'legacy-team', role: 'admin' };
    }
    db.prepare("UPDATE teams SET name = '账号空间', migration_state = 'bound', updated_at = ? WHERE id = 'legacy-team'").run(timestamp);
    db.prepare("UPDATE team_members SET role = 'admin', status = 'active', updated_at = ? WHERE team_id = 'legacy-team' AND user_id = ?")
      .run(timestamp, userId);
    db.prepare("UPDATE team_members SET status = 'removed', updated_at = ? WHERE team_id = 'legacy-team' AND user_id <> ?")
      .run(timestamp, userId);
    db.prepare("DELETE FROM team_gitlab_bindings WHERE team_id = 'legacy-team'").run();
    return { id: 'legacy-team', role: 'admin' };
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
  const gitlabUser = await fetchGitlabUser(gitlabHost, parsed.gitlabToken);
  const userId = buildAccountId(gitlabHost, gitlabUser.id);
  const db = await ensureCentralIdentitySchema();
  const timestamp = now();
  db.prepare(`
    INSERT INTO users (id, display_name, username, avatar_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, username = excluded.username,
      avatar_url = excluded.avatar_url, status = 'active', updated_at = excluded.updated_at
  `).run(userId, String(gitlabUser.name || gitlabUser.username || userId), String(gitlabUser.username || ''), String(gitlabUser.avatar_url || ''), timestamp, timestamp);
  db.prepare(`
    INSERT INTO identity_links (user_id, provider, provider_host, external_user_id, external_username, created_at, updated_at)
    VALUES (?, 'gitlab', ?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_host, external_user_id) DO UPDATE SET external_username = excluded.external_username, updated_at = excluded.updated_at
  `).run(userId, gitlabHost, String(gitlabUser.id), String(gitlabUser.username || ''), timestamp, timestamp);
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
