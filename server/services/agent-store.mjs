/**
 * Agent 控制平面多账号、多设备持久化存储。
 * @description 项目授权、策略、计划和任务均按账号/设备隔离，旧授权不会自动继承。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_AUDIT_KEY, AGENT_DB_PATH } from '../config/constants.mjs';
import { getAgentRuntimeSettings } from './agent-runtime-service.mjs';
import { redactAgentValue, stableStringify } from './agent-security.mjs';
import { publishAgentChange } from './agent-event-service.mjs';

const AGENT_SCHEMA_VERSION = 2;
const LEGACY_ACCOUNT_ID = 'legacy-disabled';
const LEGACY_DEVICE_ID = 'legacy-device';
const LEGACY_TEAM_ID = 'legacy-team';
let agentDb = null;
const auditVerificationCache = new Map();
const MAX_AUDIT_VERIFICATION_CACHE_SIZE = 32;
const AGENT_APPROVAL_MAX_AGE_MS = 30 * 60_000;
const AGENT_OPERATION_RETENTION_SETTING_KEY = 'operation_retention';
const TERMINAL_AGENT_OPERATION_STATUSES = Object.freeze(['succeeded', 'failed', 'rejected', 'cancelled', 'expired']);
const VALID_AGENT_OPERATION_RETENTION_DAYS = new Set([0, 7, 30, 90]);
let pendingExpiryTimer = null;

/** Agent 审批策略默认值。 */
export const DEFAULT_AGENT_APPROVAL_POLICY = Object.freeze({ autoApproveGrantedProjects: true });

/** Agent 已结束任务默认保留 30 天，0 表示永久保留。 */
export const DEFAULT_AGENT_OPERATION_RETENTION_POLICY = Object.freeze({ retentionDays: 30 });

/** 获取 ISO 时间。 */
const now = () => new Date().toISOString();

/** 安全解析 JSON 列。 */
const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

/** 将任务保留天数收敛到产品支持的固定选项。 */
const normalizeAgentOperationRetentionDays = (value) => {
  const days = Number(value);
  return VALID_AGENT_OPERATION_RETENTION_DAYS.has(days)
    ? days
    : DEFAULT_AGENT_OPERATION_RETENTION_POLICY.retentionDays;
};

/** 读取指定账号和设备的任务保留策略。 */
function getAgentOperationRetentionPolicyForIdentity(db, accountId, deviceId) {
  const row = db.prepare(`
    SELECT value_json FROM agent_settings
    WHERE account_id = ? AND device_id = ? AND key = ?
  `).get(accountId, deviceId, AGENT_OPERATION_RETENTION_SETTING_KEY);
  const saved = parseJson(row?.value_json, {});
  return { retentionDays: normalizeAgentOperationRetentionDays(saved.retentionDays) };
}

/** 按各账号设备的保留策略清理已结束任务。 */
function cleanupExpiredAgentOperationsWithDb(db, { identities, publish = true } = {}) {
  const targetIdentities = identities || db.prepare(`
    SELECT DISTINCT account_id, device_id FROM agent_operations
  `).all();
  const deleteStatement = db.prepare(`
    DELETE FROM agent_operations
    WHERE account_id = ? AND device_id = ?
      AND status IN (${TERMINAL_AGENT_OPERATION_STATUSES.map(() => '?').join(', ')})
      AND updated_at <= ?
  `);
  let deletedCount = 0;
  for (const identity of targetIdentities) {
    const policy = getAgentOperationRetentionPolicyForIdentity(db, identity.account_id, identity.device_id);
    if (policy.retentionDays === 0) continue;
    const expiresBefore = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60_000).toISOString();
    deletedCount += deleteStatement.run(
      identity.account_id,
      identity.device_id,
      ...TERMINAL_AGENT_OPERATION_STATUSES,
      expiresBefore,
    ).changes;
  }
  if (deletedCount > 0 && publish) publishAgentChange('operations');
  return deletedCount;
}

/** 判断数据表是否存在。 */
const hasTable = (db, tableName) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));

/** 读取表字段。 */
const getColumns = (db, tableName) => hasTable(db, tableName)
  ? db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name)
  : [];

/** 读取当前活动账号、设备和内部隔离上下文；未登录数据只进入不可继承的 legacy 身份。 */
export function getAgentStoreContext(overrides = {}) {
  const runtime = getAgentRuntimeSettings();
  return {
    accountId: String(overrides.accountId || runtime.accountId || LEGACY_ACCOUNT_ID),
    deviceId: String(overrides.deviceId || runtime.deviceId || LEGACY_DEVICE_ID),
    teamId: String(overrides.teamId || runtime.teamId || LEGACY_TEAM_ID),
  };
}

/** 创建 v2 表结构。 */
function createAgentV2Tables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_schema_metadata (
      schema_version INTEGER NOT NULL,
      migrated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_project_grants (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      client TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      remote_url TEXT NOT NULL DEFAULT '',
      permissions_json TEXT NOT NULL DEFAULT '["read","config_write","external_effect"]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, device_id, client, workspace_path, remote_url)
    );
    CREATE TABLE IF NOT EXISTS agent_plans (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      client TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      commit_sha TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_operations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      client TEXT NOT NULL,
      workspace_path TEXT NOT NULL DEFAULT '',
      risk_level TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      execution_scope TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      progress_json TEXT,
      result_json TEXT,
      error_json TEXT,
      logs_json TEXT NOT NULL DEFAULT '[]',
      approval_summary_json TEXT,
      approved_by TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, device_id, client, tool_name, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS agent_settings (
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(account_id, device_id, key)
    );
    CREATE TABLE IF NOT EXISTS agent_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_openapi_artifacts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      project_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      generated_at TEXT NOT NULL,
      UNIQUE(account_id, device_id, team_id, target_id, branch, commit_sha)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_grants_identity ON agent_project_grants(account_id, device_id, client, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_operations_identity_status ON agent_operations(account_id, device_id, team_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_audit_identity ON agent_audit(account_id, device_id, id ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_openapi_identity ON agent_openapi_artifacts(account_id, device_id, team_id, target_id, generated_at DESC);
  `);
}

/** 把 v1 数据迁入禁用身份；旧授权绝不绑定到首次登录账号。 */
function migrateAgentV1(db) {
  const tableNames = ['agent_project_grants', 'agent_plans', 'agent_operations', 'agent_settings', 'agent_audit'];
  const hasV1 = tableNames.some((name) => hasTable(db, name) && !getColumns(db, name).includes('account_id'));
  if (!hasV1) {
    createAgentV2Tables(db);
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const name of tableNames) {
      if (hasTable(db, name) && !getColumns(db, name).includes('account_id')) db.exec(`ALTER TABLE ${name} RENAME TO ${name}_legacy_v1`);
    }
    db.exec('DROP INDEX IF EXISTS idx_agent_operations_status; DROP INDEX IF EXISTS idx_agent_grants_identity; DROP INDEX IF EXISTS idx_agent_operations_identity_status; DROP INDEX IF EXISTS idx_agent_audit_identity;');
    createAgentV2Tables(db);
    if (hasTable(db, 'agent_project_grants_legacy_v1')) {
      db.exec(`
        INSERT INTO agent_project_grants
        (id, account_id, device_id, team_id, client, workspace_path, remote_url, permissions_json, status, created_at, updated_at)
        SELECT id, '${LEGACY_ACCOUNT_ID}', '${LEGACY_DEVICE_ID}', '${LEGACY_TEAM_ID}', client, workspace_path, remote_url,
          permissions_json, 'legacy-disabled', created_at, updated_at FROM agent_project_grants_legacy_v1
      `);
    }
    if (hasTable(db, 'agent_plans_legacy_v1')) {
      db.exec(`
        INSERT INTO agent_plans
        (id, account_id, device_id, team_id, client, workspace_path, tool_name, payload_hash, commit_sha, data_json, expires_at, created_at)
        SELECT id, '${LEGACY_ACCOUNT_ID}', '${LEGACY_DEVICE_ID}', '${LEGACY_TEAM_ID}', client, workspace_path, tool_name,
          payload_hash, '', data_json, expires_at, created_at FROM agent_plans_legacy_v1
      `);
    }
    if (hasTable(db, 'agent_operations_legacy_v1')) {
      db.exec(`
        INSERT INTO agent_operations
        (id, account_id, device_id, team_id, tool_name, client, workspace_path, risk_level, payload_hash, execution_scope,
         status, idempotency_key, payload_json, progress_json, result_json, error_json, logs_json, approval_summary_json,
         approved_by, approved_at, created_at, updated_at)
        SELECT id, '${LEGACY_ACCOUNT_ID}', '${LEGACY_DEVICE_ID}', '${LEGACY_TEAM_ID}', tool_name, client, workspace_path,
          risk_level, payload_hash, execution_scope,
          CASE WHEN status IN ('pending_approval','queued','running') THEN 'expired' ELSE status END,
          idempotency_key, payload_json, progress_json, result_json,
          CASE WHEN status IN ('pending_approval','queued','running') THEN '{"code":"legacy_identity_disabled","message":"旧版本任务已禁用，请重新登录并授权"}' ELSE error_json END,
          logs_json, approval_summary_json, approved_by, approved_at, created_at, updated_at
        FROM agent_operations_legacy_v1
      `);
    }
    if (hasTable(db, 'agent_settings_legacy_v1')) {
      db.exec(`
        INSERT INTO agent_settings (account_id, device_id, key, value_json, updated_at)
        SELECT '${LEGACY_ACCOUNT_ID}', '${LEGACY_DEVICE_ID}', key, value_json, updated_at FROM agent_settings_legacy_v1
      `);
    }
    if (hasTable(db, 'agent_audit_legacy_v1')) {
      db.exec(`
        INSERT INTO agent_audit (id, event_id, account_id, device_id, team_id, previous_hash, entry_hash, body_json, created_at)
        SELECT id, event_id, '${LEGACY_ACCOUNT_ID}', '${LEGACY_DEVICE_ID}', '${LEGACY_TEAM_ID}', previous_hash, entry_hash, body_json, created_at
        FROM agent_audit_legacy_v1
      `);
    }
    db.prepare('DELETE FROM agent_schema_metadata').run();
    db.prepare('INSERT INTO agent_schema_metadata (schema_version, migrated_at) VALUES (?, ?)').run(AGENT_SCHEMA_VERSION, now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 将数据库 operation 行映射为公共结构。 */
const mapOperation = (row) => row ? {
  id: row.id,
  toolName: row.tool_name,
  client: row.client,
  workspacePath: row.workspace_path || undefined,
  riskLevel: row.risk_level,
  payloadHash: row.payload_hash,
  idempotencyKey: row.idempotency_key,
  executionScope: row.execution_scope,
  status: row.status,
  actor: { accountId: row.account_id, deviceId: row.device_id, teamId: row.team_id, client: row.client },
  progress: parseJson(row.progress_json, undefined),
  result: parseJson(row.result_json, undefined),
  error: parseJson(row.error_json, undefined),
  logs: parseJson(row.logs_json, []),
  approvalSummary: parseJson(row.approval_summary_json, undefined),
  approvedBy: row.approved_by || undefined,
  approvedAt: row.approved_at || undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
} : null;

/** 初始化并返回 Agent SQLite 数据库。 */
export function getAgentDb() {
  if (agentDb) return agentDb;
  fs.mkdirSync(path.dirname(AGENT_DB_PATH), { recursive: true });
  agentDb = new DatabaseSync(AGENT_DB_PATH);
  agentDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrateAgentV1(agentDb);
  createAgentV2Tables(agentDb);
  agentDb.prepare(`
    UPDATE agent_operations SET status = 'failed', error_json = ?, updated_at = ?
    WHERE status IN ('queued', 'running')
  `).run(JSON.stringify({ code: 'app_restarted', message: '雨燕重启，未完成任务已安全终止', retryable: true }), now());
  cleanupExpiredAgentOperationsWithDb(agentDb, { publish: false });
  scheduleNextPendingAgentExpiry();
  return agentDb;
}

/** 按数据库中最早待审批任务安排一次性过期检查。 */
function scheduleNextPendingAgentExpiry() {
  if (pendingExpiryTimer) clearTimeout(pendingExpiryTimer);
  pendingExpiryTimer = null;
  const row = agentDb?.prepare("SELECT created_at FROM agent_operations WHERE status = 'pending_approval' ORDER BY created_at ASC LIMIT 1").get();
  if (!row?.created_at) return;
  const expiresAt = Date.parse(row.created_at) + AGENT_APPROVAL_MAX_AGE_MS;
  if (!Number.isFinite(expiresAt)) return;
  const delay = Math.max(0, expiresAt - Date.now());
  pendingExpiryTimer = setTimeout(expireAllPendingAgentOperations, delay);
  pendingExpiryTimer.unref?.();
}

/** 过期所有身份中达到默认审批时限的任务，并广播轻量变更。 */
function expireAllPendingAgentOperations() {
  pendingExpiryTimer = null;
  if (!agentDb) return;
  const expiresBefore = new Date(Date.now() - AGENT_APPROVAL_MAX_AGE_MS).toISOString();
  const changes = agentDb.prepare(`
    UPDATE agent_operations SET status = 'expired', error_json = ?, updated_at = ?
    WHERE status = 'pending_approval' AND created_at <= ?
  `).run(JSON.stringify({ code: 'approval_expired', message: '审批已过期，请重新发起操作', retryable: true }), now(), expiresBefore).changes;
  if (changes > 0) {
    publishAgentChange(['approvals', 'operations']);
  }
  scheduleNextPendingAgentExpiry();
}

/** 读取当前账号与设备的审批策略。 */
export function getAgentApprovalPolicy() {
  const context = getAgentStoreContext();
  const row = getAgentDb().prepare("SELECT value_json FROM agent_settings WHERE account_id = ? AND device_id = ? AND key = 'approval_policy'")
    .get(context.accountId, context.deviceId);
  const saved = parseJson(row?.value_json, {});
  return {
    autoApproveGrantedProjects: typeof saved.autoApproveGrantedProjects === 'boolean'
      ? saved.autoApproveGrantedProjects
      : DEFAULT_AGENT_APPROVAL_POLICY.autoApproveGrantedProjects,
  };
}

/** 更新当前账号与设备的审批策略。 */
export function updateAgentApprovalPolicy(patch = {}) {
  const context = getAgentStoreContext();
  const current = getAgentApprovalPolicy();
  const next = { autoApproveGrantedProjects: typeof patch.autoApproveGrantedProjects === 'boolean' ? patch.autoApproveGrantedProjects : current.autoApproveGrantedProjects };
  getAgentDb().prepare(`
    INSERT INTO agent_settings (account_id, device_id, key, value_json, updated_at)
    VALUES (?, ?, 'approval_policy', ?, ?)
    ON CONFLICT(account_id, device_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(context.accountId, context.deviceId, JSON.stringify(next), now());
  publishAgentChange('policy');
  return next;
}

/** 读取当前账号与设备的已结束任务保留策略。 */
export function getAgentOperationRetentionPolicy() {
  const context = getAgentStoreContext();
  return getAgentOperationRetentionPolicyForIdentity(getAgentDb(), context.accountId, context.deviceId);
}

/**
 * 更新当前账号与设备的任务保留策略，并立即清理已过期记录。
 * @param {{retentionDays?: number}} patch 保留天数，0 表示永久保留
 * @returns {{retentionDays: number, deletedCount: number}} 生效策略与本次清理数量
 */
export function updateAgentOperationRetentionPolicy(patch = {}) {
  const context = getAgentStoreContext();
  const retentionDays = Number(patch.retentionDays);
  if (!VALID_AGENT_OPERATION_RETENTION_DAYS.has(retentionDays)) {
    const error = new Error('任务保留期限仅支持 7、30、90 天或永久保留');
    error.code = 'operation_retention_invalid';
    throw error;
  }
  const db = getAgentDb();
  const policy = { retentionDays };
  db.prepare(`
    INSERT INTO agent_settings (account_id, device_id, key, value_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, device_id, key)
    DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(context.accountId, context.deviceId, AGENT_OPERATION_RETENTION_SETTING_KEY, JSON.stringify(policy), now());
  const deletedCount = cleanupExpiredAgentOperationsWithDb(db, {
    identities: [{ account_id: context.accountId, device_id: context.deviceId }],
  });
  publishAgentChange('policy');
  return { ...policy, deletedCount };
}

/** 按所有账号设备的保留策略执行定时清理。 */
export function cleanupExpiredAgentOperations() {
  return cleanupExpiredAgentOperationsWithDb(getAgentDb());
}

/** 关闭 Agent SQLite 连接。 */
export function closeAgentDb() {
  if (pendingExpiryTimer) clearTimeout(pendingExpiryTimer);
  pendingExpiryTimer = null;
  agentDb?.close();
  agentDb = null;
  auditVerificationCache.clear();
}

/** 保存当前账号/设备生成的 OpenAPI 产物索引，不向中央暴露绝对路径。 */
export function saveDeviceOpenApiArtifact(artifact) {
  const context = getAgentStoreContext();
  getAgentDb().prepare(`
    INSERT INTO agent_openapi_artifacts
    (id, account_id, device_id, team_id, target_id, project_name, branch, commit_sha, file_name, file_path, sha256, size_bytes, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, device_id, team_id, target_id, branch, commit_sha)
    DO UPDATE SET id = excluded.id, project_name = excluded.project_name, file_name = excluded.file_name,
      file_path = excluded.file_path, sha256 = excluded.sha256, size_bytes = excluded.size_bytes, generated_at = excluded.generated_at
  `).run(
    String(artifact.id), context.accountId, context.deviceId, context.teamId, Number(artifact.targetId), String(artifact.projectName || ''),
    String(artifact.branch), String(artifact.commitSha), String(artifact.fileName), String(artifact.filePath), String(artifact.sha256),
    Number(artifact.sizeBytes), String(artifact.generatedAt || now()),
  );
  return getDeviceOpenApiArtifact(String(artifact.id));
}

/** 映射当前设备 OpenAPI 索引。 */
function mapDeviceOpenApiArtifact(row, includePath = false) {
  if (!row) return null;
  return {
    id: row.id, targetId: row.target_id, projectName: row.project_name, branch: row.branch, commitSha: row.commit_sha,
    fileName: row.file_name, sha256: row.sha256, sizeBytes: row.size_bytes, status: 'success', generatedAt: row.generated_at,
    ...(includePath ? { filePath: row.file_path } : {}),
  };
}

/** 读取当前账号/设备的指定 OpenAPI 产物。 */
export function getDeviceOpenApiArtifact(id, { includePath = false } = {}) {
  const context = getAgentStoreContext();
  const row = getAgentDb().prepare(`
    SELECT * FROM agent_openapi_artifacts WHERE id = ? AND account_id = ? AND device_id = ? AND team_id = ?
  `).get(String(id), context.accountId, context.deviceId, context.teamId);
  return mapDeviceOpenApiArtifact(row, includePath);
}

/** 读取当前账号/设备目标的最新 OpenAPI 产物。 */
export function getLatestDeviceOpenApiArtifact(targetId, branch = '', { includePath = false } = {}) {
  const context = getAgentStoreContext();
  const params = [context.accountId, context.deviceId, context.teamId, Number(targetId)];
  const branchCondition = branch ? 'AND branch = ?' : '';
  if (branch) params.push(String(branch));
  const row = getAgentDb().prepare(`
    SELECT * FROM agent_openapi_artifacts
    WHERE account_id = ? AND device_id = ? AND team_id = ? AND target_id = ? ${branchCondition}
    ORDER BY generated_at DESC LIMIT 1
  `).get(...params);
  return mapDeviceOpenApiArtifact(row, includePath);
}

/** 写入当前账号/设备的 HMAC 审计事件。 */
export function appendAgentAudit(event) {
  const db = getAgentDb();
  const context = getAgentStoreContext(event?.actor || {});
  const createdAt = now();
  const eventId = crypto.randomUUID();
  const previousHash = String(db.prepare(`
    SELECT entry_hash FROM agent_audit WHERE account_id = ? AND device_id = ? ORDER BY id DESC LIMIT 1
  `).get(context.accountId, context.deviceId)?.entry_hash || 'GENESIS');
  const body = redactAgentValue({ ...event, actor: context, eventId, createdAt });
  const bodyJson = stableStringify(body);
  const entryHash = crypto.createHmac('sha256', AGENT_AUDIT_KEY).update(`${context.accountId}\n${context.deviceId}\n${previousHash}\n${bodyJson}`).digest('hex');
  db.prepare(`
    INSERT INTO agent_audit (event_id, account_id, device_id, team_id, previous_hash, entry_hash, body_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, context.accountId, context.deviceId, context.teamId, previousHash, entryHash, bodyJson, createdAt);
  publishAgentChange('audit');
  return { ...body, previousHash, entryHash };
}

/** 读取可同时感知当前连接和其他连接写入的 SQLite 变更标记。 */
function getAgentDbChangeMarkers(db) {
  const totalChangesRow = db.prepare('SELECT total_changes() AS value').get();
  const dataVersionRow = db.prepare('PRAGMA data_version').get();
  return {
    totalChanges: Number(totalChangesRow?.value || 0),
    dataVersion: Number(dataVersionRow?.data_version ?? Object.values(dataVersionRow || {})[0] ?? 0),
  };
}

/** 写入有界审计校验缓存。 */
function setAuditVerificationCache(key, value) {
  auditVerificationCache.delete(key);
  auditVerificationCache.set(key, value);
  while (auditVerificationCache.size > MAX_AUDIT_VERIFICATION_CACHE_SIZE) {
    auditVerificationCache.delete(auditVerificationCache.keys().next().value);
  }
}

/** 校验当前账号/设备审计哈希链。 */
export function verifyAgentAuditChain() {
  const context = getAgentStoreContext();
  const db = getAgentDb();
  const cacheKey = `${context.accountId}\u0000${context.deviceId}`;
  const markers = getAgentDbChangeMarkers(db);
  const cached = auditVerificationCache.get(cacheKey);
  if (cached?.totalChanges === markers.totalChanges && cached?.dataVersion === markers.dataVersion) {
    return cached.result;
  }
  const rows = db.prepare('SELECT * FROM agent_audit WHERE account_id = ? AND device_id = ? ORDER BY id ASC')
    .all(context.accountId, context.deviceId);
  let previousHash = 'GENESIS';
  let result = { valid: true, count: rows.length };
  for (const row of rows) {
    const body = parseJson(row.body_json, {});
    const payload = body?.actor
      ? `${context.accountId}\n${context.deviceId}\n${previousHash}\n${row.body_json}`
      : `${previousHash}\n${row.body_json}`;
    const expected = crypto.createHmac('sha256', AGENT_AUDIT_KEY).update(payload).digest('hex');
    if (row.previous_hash !== previousHash || row.entry_hash !== expected) {
      result = { valid: false, count: rows.length, brokenAt: row.event_id };
      break;
    }
    previousHash = row.entry_hash;
  }
  setAuditVerificationCache(cacheKey, { ...markers, result });
  return result;
}

/** 列出当前账号/设备审计记录。 */
export function listAgentAudit(query = {}) {
  const db = getAgentDb();
  const context = getAgentStoreContext();
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const offset = Math.max(0, Number(query.offset || 0));
  const total = Number(db.prepare('SELECT COUNT(*) AS total FROM agent_audit WHERE account_id = ? AND device_id = ?')
    .get(context.accountId, context.deviceId)?.total || 0);
  const items = db.prepare('SELECT * FROM agent_audit WHERE account_id = ? AND device_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(context.accountId, context.deviceId, limit, offset)
    .map((row) => ({ ...parseJson(row.body_json, {}), previousHash: row.previous_hash, entryHash: row.entry_hash }));
  return { items, total };
}

/** 新增或刷新当前账号/设备项目授权。 */
export function upsertProjectGrant({ client, workspacePath, remoteUrl = '', permissions = ['read', 'config_write', 'external_effect'] }) {
  const db = getAgentDb();
  const context = getAgentStoreContext();
  const timestamp = now();
  const existing = db.prepare(`
    SELECT id FROM agent_project_grants WHERE account_id = ? AND device_id = ? AND client = ? AND workspace_path = ? AND remote_url = ?
  `).get(context.accountId, context.deviceId, client, workspacePath, remoteUrl);
  const id = existing?.id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO agent_project_grants
    (id, account_id, device_id, team_id, client, workspace_path, remote_url, permissions_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(account_id, device_id, client, workspace_path, remote_url)
    DO UPDATE SET team_id = excluded.team_id, permissions_json = excluded.permissions_json, status = 'active', updated_at = excluded.updated_at
  `).run(id, context.accountId, context.deviceId, context.teamId, client, workspacePath, remoteUrl, JSON.stringify(permissions), timestamp, timestamp);
  publishAgentChange('grants');
  return getProjectGrant(client, workspacePath, remoteUrl);
}

/** 查询当前账号/设备的精确项目授权。 */
export function getProjectGrant(client, workspacePath, remoteUrl = '') {
  const context = getAgentStoreContext();
  const row = getAgentDb().prepare(`
    SELECT * FROM agent_project_grants
    WHERE account_id = ? AND device_id = ? AND client = ? AND workspace_path = ? AND remote_url = ? AND status = 'active'
  `).get(context.accountId, context.deviceId, client, workspacePath, remoteUrl);
  return row ? {
    id: row.id, accountId: row.account_id, deviceId: row.device_id, teamId: row.team_id, client: row.client,
    workspacePath: row.workspace_path, remoteUrl: row.remote_url, permissions: parseJson(row.permissions_json, []),
    createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}

/** 列出当前账号/设备项目授权。 */
export function listProjectGrants({ client = '', keyword = '', limit = 50, offset = 0 } = {}) {
  const db = getAgentDb();
  const context = getAgentStoreContext();
  const conditions = ["account_id = ?", "device_id = ?", "status = 'active'"];
  const params = [context.accountId, context.deviceId];
  if (client) { conditions.push('client = ?'); params.push(client); }
  if (keyword) { conditions.push('(workspace_path LIKE ? OR remote_url LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const where = ` WHERE ${conditions.join(' AND ')}`;
  const safeLimit = Math.min(100, Math.max(1, Number(limit)));
  const safeOffset = Math.max(0, Number(offset));
  const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM agent_project_grants${where}`).get(...params)?.total || 0);
  const items = db.prepare(`SELECT * FROM agent_project_grants${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset).map((row) => ({
      id: row.id, accountId: row.account_id, deviceId: row.device_id, teamId: row.team_id, client: row.client,
      workspacePath: row.workspace_path, remoteUrl: row.remote_url, permissions: parseJson(row.permissions_json, []),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  return { items, total };
}

/** 撤销当前账号/设备项目授权。 */
export function revokeProjectGrant(id) {
  const context = getAgentStoreContext();
  const result = getAgentDb().prepare('DELETE FROM agent_project_grants WHERE id = ? AND account_id = ? AND device_id = ?')
    .run(String(id), context.accountId, context.deviceId);
  if (result.changes > 0) publishAgentChange('grants');
  return { revoked: result.changes > 0 };
}

/** 保存绑定账号、设备、内部隔离空间与 Commit 的短期配置计划。 */
export function createAgentPlan({ client, workspacePath, toolName, payloadHash, data, ttlMs = 15 * 60_000 }) {
  const context = getAgentStoreContext();
  const id = crypto.randomUUID();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const commitSha = String(data?.workspaceCommitSha || '');
  getAgentDb().prepare(`
    INSERT INTO agent_plans
    (id, account_id, device_id, team_id, client, workspace_path, tool_name, payload_hash, commit_sha, data_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, context.accountId, context.deviceId, context.teamId, client, workspacePath, toolName, payloadHash, commitSha, JSON.stringify(redactAgentValue(data)), expiresAt, createdAt);
  return { id, ...context, client, workspacePath, toolName, payloadHash, commitSha, data: redactAgentValue(data), expiresAt, createdAt };
}

/** 读取当前账号与设备的未过期计划。 */
export function getAgentPlan(id, client = '') {
  const context = getAgentStoreContext();
  const row = getAgentDb().prepare(`
    SELECT * FROM agent_plans WHERE id = ? AND account_id = ? AND device_id = ? AND team_id = ?
  `).get(String(id), context.accountId, context.deviceId, context.teamId);
  if (!row || (client && row.client !== client) || Date.parse(row.expires_at) <= Date.now()) return null;
  return {
    id: row.id, accountId: row.account_id, deviceId: row.device_id, teamId: row.team_id, client: row.client,
    workspacePath: row.workspace_path, toolName: row.tool_name, payloadHash: row.payload_hash, commitSha: row.commit_sha,
    data: parseJson(row.data_json, {}), expiresAt: row.expires_at, createdAt: row.created_at,
  };
}

/** 创建当前身份的幂等异步操作，重复调用返回原操作。 */
export function createAgentOperation(payload) {
  const db = getAgentDb();
  const context = getAgentStoreContext();
  const duplicate = db.prepare(`
    SELECT * FROM agent_operations WHERE account_id = ? AND device_id = ? AND client = ? AND tool_name = ? AND idempotency_key = ?
  `).get(context.accountId, context.deviceId, payload.client, payload.toolName, payload.idempotencyKey);
  if (duplicate) return mapOperation(duplicate);
  const id = crypto.randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO agent_operations
    (id, account_id, device_id, team_id, tool_name, client, workspace_path, risk_level, payload_hash, execution_scope,
     status, idempotency_key, payload_json, approval_summary_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?)
  `).run(id, context.accountId, context.deviceId, context.teamId, payload.toolName, payload.client, payload.workspacePath || '', payload.riskLevel,
    payload.payloadHash, payload.executionScope, payload.idempotencyKey, JSON.stringify(redactAgentValue(payload.payload)),
    JSON.stringify(redactAgentValue(payload.approvalSummary || {})), timestamp, timestamp);
  publishAgentChange(['approvals', 'operations']);
  scheduleNextPendingAgentExpiry();
  return getAgentOperation(id);
}

/** 获取当前身份的操作与可选内部负载。 */
export function getAgentOperation(id, { includePayload = false } = {}) {
  expirePendingAgentOperations();
  const context = getAgentStoreContext();
  const row = getAgentDb().prepare(`
    SELECT * FROM agent_operations WHERE id = ? AND account_id = ? AND device_id = ? AND team_id = ?
  `).get(String(id), context.accountId, context.deviceId, context.teamId);
  const operation = mapOperation(row);
  if (operation && includePayload) operation.payload = parseJson(row.payload_json, {});
  return operation;
}

/** 仅供已完成入口鉴权的后台执行器按全局 UUID 读取任务。 */
export function getAgentOperationInternal(id, { includePayload = false } = {}) {
  const row = getAgentDb().prepare('SELECT * FROM agent_operations WHERE id = ?').get(String(id));
  const operation = mapOperation(row);
  if (operation && includePayload) operation.payload = parseJson(row.payload_json, {});
  return operation;
}

/** 按当前身份分页列出操作。 */
export function listAgentOperations({ status = '', client = '', limit = 50, offset = 0 } = {}) {
  expirePendingAgentOperations();
  const db = getAgentDb();
  const context = getAgentStoreContext();
  const conditions = ['account_id = ?', 'device_id = ?', 'team_id = ?'];
  const params = [context.accountId, context.deviceId, context.teamId];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (client) { conditions.push('client = ?'); params.push(client); }
  const where = ` WHERE ${conditions.join(' AND ')}`;
  const safeLimit = Math.min(100, Math.max(1, Number(limit)));
  const safeOffset = Math.max(0, Number(offset));
  const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM agent_operations${where}`).get(...params)?.total || 0);
  const completedTotal = Number(db.prepare(`
    SELECT COUNT(*) AS total FROM agent_operations
    WHERE account_id = ? AND device_id = ? AND team_id = ?
      AND status IN (${TERMINAL_AGENT_OPERATION_STATUSES.map(() => '?').join(', ')})
  `).get(context.accountId, context.deviceId, context.teamId, ...TERMINAL_AGENT_OPERATION_STATUSES)?.total || 0);
  const items = db.prepare(`SELECT * FROM agent_operations${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset).map(mapOperation);
  return { items, total, completedTotal };
}

/**
 * 删除当前身份的一条已结束任务记录。
 * @param {string} id 任务 ID
 * @returns {{deleted: boolean, reason?: 'not_found' | 'active'}} 删除结果
 */
export function deleteAgentOperationRecord(id) {
  const db = getAgentDb();
  const context = getAgentStoreContext();
  const row = db.prepare(`
    SELECT status FROM agent_operations
    WHERE id = ? AND account_id = ? AND device_id = ? AND team_id = ?
  `).get(String(id), context.accountId, context.deviceId, context.teamId);
  if (!row) return { deleted: false, reason: 'not_found' };
  if (!TERMINAL_AGENT_OPERATION_STATUSES.includes(row.status)) return { deleted: false, reason: 'active' };
  const result = db.prepare(`
    DELETE FROM agent_operations
    WHERE id = ? AND account_id = ? AND device_id = ? AND team_id = ?
  `).run(String(id), context.accountId, context.deviceId, context.teamId);
  if (result.changes > 0) publishAgentChange('operations');
  return { deleted: result.changes > 0 };
}

/** 清空当前身份的全部已结束任务，待审批和执行中任务不受影响。 */
export function clearCompletedAgentOperationRecords() {
  const context = getAgentStoreContext();
  const result = getAgentDb().prepare(`
    DELETE FROM agent_operations
    WHERE account_id = ? AND device_id = ? AND team_id = ?
      AND status IN (${TERMINAL_AGENT_OPERATION_STATUSES.map(() => '?').join(', ')})
  `).run(context.accountId, context.deviceId, context.teamId, ...TERMINAL_AGENT_OPERATION_STATUSES);
  if (result.changes > 0) publishAgentChange('operations');
  return { deletedCount: result.changes };
}

/** 轻量列出当前身份待审批任务，不解析日志、进度或结果。 */
export function listPendingAgentApprovals(limit = 100) {
  expirePendingAgentOperations();
  const db = getAgentDb();
  const context = getAgentStoreContext();
  const safeLimit = Math.min(100, Math.max(1, Number(limit || 100)));
  const rows = db.prepare(`
    SELECT id, tool_name, client, risk_level, payload_hash, execution_scope,
           approval_summary_json, created_at, updated_at
    FROM agent_operations
    WHERE account_id = ? AND device_id = ? AND team_id = ? AND status = 'pending_approval'
    ORDER BY created_at ASC LIMIT ?
  `).all(context.accountId, context.deviceId, context.teamId, safeLimit);
  return {
    items: rows.map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      client: row.client,
      riskLevel: row.risk_level,
      payloadHash: row.payload_hash,
      executionScope: row.execution_scope,
      approvalSummary: parseJson(row.approval_summary_json, undefined),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    total: rows.length,
  };
}

/** 将当前身份超过审批有效期的任务标记过期。 */
export function expirePendingAgentOperations(maxAgeMs = 30 * 60_000) {
  const context = getAgentStoreContext();
  const expiresBefore = new Date(Date.now() - maxAgeMs).toISOString();
  const changes = getAgentDb().prepare(`
    UPDATE agent_operations SET status = 'expired', error_json = ?, updated_at = ?
    WHERE account_id = ? AND device_id = ? AND team_id = ? AND status = 'pending_approval' AND created_at <= ?
  `).run(JSON.stringify({ code: 'approval_expired', message: '审批已过期，请重新发起操作', retryable: true }), now(),
    context.accountId, context.deviceId, context.teamId, expiresBefore).changes;
  if (changes > 0) {
    publishAgentChange(['approvals', 'operations']);
    scheduleNextPendingAgentExpiry();
  }
  return changes;
}

/** 账号退出、切换或设备撤销时使未开始任务失效。 */
export function expireAgentOperationsForIdentity(identity, reason = 'identity_changed') {
  if (!identity?.accountId || !identity?.deviceId) return 0;
  const changes = getAgentDb().prepare(`
    UPDATE agent_operations SET status = 'expired', error_json = ?, updated_at = ?
    WHERE account_id = ? AND device_id = ? AND status IN ('pending_approval', 'queued')
  `).run(JSON.stringify({ code: reason, message: '账号或设备状态已变化，任务已失效', retryable: true }), now(),
    identity.accountId, identity.deviceId).changes;
  if (changes > 0) {
    publishAgentChange(['approvals', 'operations']);
    scheduleNextPendingAgentExpiry();
  }
  return changes;
}

/** 原子更新当前身份操作状态与公共字段。 */
export function updateAgentOperation(id, patch) {
  const context = getAgentStoreContext();
  const allowed = { status: 'status', progress: 'progress_json', result: 'result_json', error: 'error_json', logs: 'logs_json', approvedBy: 'approved_by', approvedAt: 'approved_at' };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    params.push(['progress', 'result', 'error', 'logs'].includes(key) ? JSON.stringify(redactAgentValue(patch[key])) : patch[key]);
  }
  if (!sets.length) return getAgentOperation(id);
  sets.push('updated_at = ?');
  params.push(now(), String(id), context.accountId, context.deviceId, context.teamId);
  const result = getAgentDb().prepare(`
    UPDATE agent_operations SET ${sets.join(', ')} WHERE id = ? AND account_id = ? AND device_id = ? AND team_id = ?
  `).run(...params);
  if (result.changes > 0) {
    publishAgentChange('status' in patch ? ['approvals', 'operations'] : 'operations');
    if ('status' in patch) scheduleNextPendingAgentExpiry();
  }
  return getAgentOperation(id);
}

/** 仅供后台执行器在账号切换后收敛原任务状态。 */
export function updateAgentOperationInternal(id, patch) {
  const allowed = { status: 'status', progress: 'progress_json', result: 'result_json', error: 'error_json', logs: 'logs_json', approvedBy: 'approved_by', approvedAt: 'approved_at' };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    params.push(['progress', 'result', 'error', 'logs'].includes(key) ? JSON.stringify(redactAgentValue(patch[key])) : patch[key]);
  }
  if (!sets.length) return getAgentOperationInternal(id);
  sets.push('updated_at = ?');
  params.push(now(), String(id));
  const result = getAgentDb().prepare(`UPDATE agent_operations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes > 0) {
    publishAgentChange('status' in patch ? ['approvals', 'operations'] : 'operations');
    if ('status' in patch) scheduleNextPendingAgentExpiry();
  }
  return getAgentOperationInternal(id);
}

/** 获取当前身份操作内部负载。 */
export function getAgentOperationPayload(id) {
  const context = getAgentStoreContext();
  const row = getAgentDb().prepare(`
    SELECT payload_json FROM agent_operations WHERE id = ? AND account_id = ? AND device_id = ? AND team_id = ?
  `).get(String(id), context.accountId, context.deviceId, context.teamId);
  return parseJson(row?.payload_json, null);
}

/** 仅供后台执行器按全局 UUID 读取任务负载。 */
export function getAgentOperationPayloadInternal(id) {
  const row = getAgentDb().prepare('SELECT payload_json FROM agent_operations WHERE id = ?').get(String(id));
  return parseJson(row?.payload_json, null);
}
