/** 后端设备产物分块上传与中央部署任务。 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DEPLOY_DATA_DIR } from '../config/constants.mjs';
import { deployBackendArtifact } from './backend-runtime-service.mjs';
import { appendCentralAudit, ensureCentralIdentitySchema } from './central-identity-service.mjs';
import { getDeployDb, getTarget } from './deploy-store.mjs';
import { getRequestContext, runRequestContext } from './request-context.mjs';
import {
  abortCentralOperation,
  registerCentralOperationController,
  unregisterCentralOperationController,
} from './central-operation-runtime.mjs';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const ARTIFACT_TTL_MS = 24 * 60 * 60_000;

const createJobSchema = z.object({
  targetId: z.coerce.number().int().positive(),
  fileName: z.string().trim().regex(/^[^\\/\0\r\n]+\.jar$/i).max(240),
  sizeBytes: z.coerce.number().int().positive().max(MAX_ARTIFACT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/i),
  branch: z.string().trim().min(1).max(240),
  commitMessage: z.string().max(1000).optional(),
  commitAuthor: z.string().max(240).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

/** 产物任务目录。 */
const artifactRoot = path.join(DEPLOY_DATA_DIR, 'artifact-jobs');

/** 初始化产物任务表与同目标运行锁。 */
async function ensureArtifactSchema() {
  await ensureCentralIdentitySchema();
  const db = await getDeployDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_jobs (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      team_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      client TEXT NOT NULL,
      request_id TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      expected_size INTEGER NOT NULL,
      uploaded_size INTEGER NOT NULL DEFAULT 0,
      expected_sha256 TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      commit_message TEXT,
      commit_author TEXT,
      branch TEXT NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(team_id, device_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_jobs_target_active
      ON artifact_jobs(team_id, target_id) WHERE status IN ('uploading', 'ready', 'queued', 'running');
    CREATE INDEX IF NOT EXISTS idx_artifact_jobs_expiry ON artifact_jobs(status, expires_at);
  `);
  return db;
}

/** 映射任务，不返回中央文件路径。 */
function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    operationId: row.operation_id,
    targetId: row.target_id,
    fileName: row.file_name,
    expectedSize: row.expected_size,
    uploadedSize: row.uploaded_size,
    sha256: row.expected_sha256,
    commitSha: row.commit_sha,
    branch: row.branch,
    status: row.status,
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 清理过期且未运行的产物。 */
async function cleanupExpiredJobs(db) {
  const rows = db.prepare("SELECT id, file_path FROM artifact_jobs WHERE expires_at < ? AND status IN ('uploading','ready','failed','cancelled')").all(new Date().toISOString());
  for (const row of rows) {
    await fs.rm(row.file_path, { force: true }).catch(() => undefined);
    db.prepare("UPDATE artifact_jobs SET status = 'expired', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  }
}

/** 创建可断点续传的产物任务。 */
export async function createArtifactJob(input) {
  const payload = createJobSchema.parse(input);
  const context = getRequestContext();
  const target = await getTarget(payload.targetId);
  if (!target || target.projectType !== 'backend') throw Object.assign(new Error('后端部署目标不存在或不属于当前账号'), { status: 404, code: 'target_not_found' });
  const db = await ensureArtifactSchema();
  await cleanupExpiredJobs(db);
  const duplicate = db.prepare('SELECT * FROM artifact_jobs WHERE team_id = ? AND device_id = ? AND idempotency_key = ?').get(context.teamId, context.deviceId, payload.idempotencyKey);
  if (duplicate) return mapJob(duplicate);
  const id = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ARTIFACT_TTL_MS).toISOString();
  await fs.mkdir(artifactRoot, { recursive: true });
  const filePath = path.join(artifactRoot, `${id}.part`);
  await fs.writeFile(filePath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  try {
    db.prepare(`
      INSERT INTO artifact_jobs
      (id, operation_id, team_id, actor_user_id, device_id, client, request_id, target_id, idempotency_key,
       file_name, file_path, expected_size, uploaded_size, expected_sha256, commit_sha, commit_message, commit_author,
       branch, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)
    `).run(id, operationId, context.teamId, context.userId, context.deviceId, context.client, context.requestId, payload.targetId,
      payload.idempotencyKey, payload.fileName, filePath, payload.sizeBytes, payload.sha256.toLowerCase(), payload.commitSha,
      payload.commitMessage || '', payload.commitAuthor || '', payload.branch, expiresAt, timestamp, timestamp);
    db.prepare(`
      INSERT INTO central_agent_operations
      (id, team_id, actor_user_id, device_id, client, request_id, tool_name, resource_type, resource_id, status, payload_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'yuyan_deploy_target', 'deploy_target', ?, 'uploading', ?, ?, ?)
    `).run(operationId, context.teamId, context.userId, context.deviceId, context.client, context.requestId, String(payload.targetId),
      crypto.createHash('sha256').update(JSON.stringify({ targetId: payload.targetId, sha256: payload.sha256, commitSha: payload.commitSha })).digest('hex'), timestamp, timestamp);
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    throw /idx_artifact_jobs_target_active|artifact_jobs\.team_id, artifact_jobs\.target_id/.test(String(error?.message || ''))
      ? Object.assign(new Error('同一部署目标已有上传或发布任务，请等待完成'), { status: 409, code: 'target_locked' })
      : error;
  }
  return mapJob(db.prepare('SELECT * FROM artifact_jobs WHERE id = ?').get(id));
}

/** 解析并校验 Content-Range。 */
function parseContentRange(value, contentLength) {
  const match = String(value || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) throw Object.assign(new Error('必须提供 Content-Range: bytes start-end/total'), { status: 400, code: 'content_range_required' });
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (end < start || end - start + 1 !== contentLength) throw Object.assign(new Error('Content-Range 与分块大小不一致'), { status: 400, code: 'content_range_invalid' });
  return { start, end, total };
}

/** 顺序追加一个上传分块，已上传分块可幂等重试。 */
export async function appendArtifactChunk(jobId, contentRange, chunk) {
  const db = await ensureArtifactSchema();
  const context = getRequestContext();
  const row = db.prepare('SELECT * FROM artifact_jobs WHERE id = ? AND team_id = ? AND device_id = ?').get(jobId, context.teamId, context.deviceId);
  if (!row) throw Object.assign(new Error('产物任务不存在'), { status: 404, code: 'artifact_job_not_found' });
  if (row.status !== 'uploading') throw Object.assign(new Error(`当前任务状态 ${row.status} 不允许上传`), { status: 409, code: 'artifact_job_state_invalid' });
  const range = parseContentRange(contentRange, chunk.length);
  if (range.total !== row.expected_size) throw Object.assign(new Error('上传总大小与创建任务时不一致'), { status: 409, code: 'artifact_size_changed' });
  if (range.end < row.uploaded_size) return mapJob(row);
  if (range.start !== row.uploaded_size) throw Object.assign(new Error(`分块偏移不连续，应从 ${row.uploaded_size} 开始`), { status: 409, code: 'chunk_offset_mismatch', expectedOffset: row.uploaded_size });
  if (range.end + 1 > row.expected_size) throw Object.assign(new Error('分块超出产物大小'), { status: 400, code: 'chunk_out_of_range' });
  await fs.appendFile(row.file_path, chunk);
  const uploadedSize = range.end + 1;
  const timestamp = new Date().toISOString();
  db.prepare('UPDATE artifact_jobs SET uploaded_size = ?, updated_at = ? WHERE id = ?').run(uploadedSize, timestamp, row.id);
  return mapJob(db.prepare('SELECT * FROM artifact_jobs WHERE id = ?').get(row.id));
}

/** 读取文件 SHA-256。 */
async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/** 完成哈希校验并在中央后台执行 SSH 部署。 */
export async function finalizeArtifactJob(jobId) {
  const db = await ensureArtifactSchema();
  const context = getRequestContext();
  const row = db.prepare('SELECT * FROM artifact_jobs WHERE id = ? AND team_id = ? AND device_id = ?').get(jobId, context.teamId, context.deviceId);
  if (!row) throw Object.assign(new Error('产物任务不存在'), { status: 404, code: 'artifact_job_not_found' });
  if (row.uploaded_size !== row.expected_size) throw Object.assign(new Error(`产物尚未上传完整，当前 ${row.uploaded_size}/${row.expected_size}`), { status: 409, code: 'artifact_incomplete' });
  const actualHash = await hashFile(row.file_path);
  if (actualHash !== row.expected_sha256) {
    const error = { code: 'artifact_hash_mismatch', message: 'Jar SHA-256 校验失败' };
    const failedAt = new Date().toISOString();
    db.prepare("UPDATE artifact_jobs SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), failedAt, row.id);
    db.prepare("UPDATE central_agent_operations SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(error), failedAt, row.operation_id);
    await fs.rm(row.file_path, { force: true }).catch(() => undefined);
    throw Object.assign(new Error(error.message), { status: 422, code: error.code });
  }
  const finalPath = row.file_path.replace(/\.part$/, '.jar');
  await fs.rename(row.file_path, finalPath);
  const timestamp = new Date().toISOString();
  db.prepare("UPDATE artifact_jobs SET file_path = ?, status = 'queued', updated_at = ? WHERE id = ?").run(finalPath, timestamp, row.id);
  db.prepare("UPDATE central_agent_operations SET status = 'queued', updated_at = ? WHERE id = ?").run(timestamp, row.operation_id);
  const capturedContext = { ...context };
  setImmediate(() => runRequestContext(capturedContext, () => void runArtifactDeployment(row.id)));
  return getCentralOperation(row.operation_id);
}

/** 执行中央部署并持久化标准回执。 */
async function runArtifactDeployment(jobId) {
  const db = await ensureArtifactSchema();
  const row = db.prepare('SELECT * FROM artifact_jobs WHERE id = ?').get(jobId);
  if (!row || row.status !== 'queued') return;
  const timestamp = new Date().toISOString();
  db.prepare("UPDATE artifact_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(timestamp, row.id);
  db.prepare("UPDATE central_agent_operations SET status = 'running', updated_at = ? WHERE id = ?").run(timestamp, row.operation_id);
  const progress = { stage: 'central_deploy', percent: 5, message: '中央部署已开始' };
  const controller = new AbortController();
  registerCentralOperationController(row.operation_id, {
    userId: row.actor_user_id,
    deviceId: row.device_id,
    teamId: row.team_id,
  }, controller);
  const emit = {
    stage(stage, percent, message) {
      progress.stage = stage; progress.percent = percent; progress.message = message;
      db.prepare('UPDATE central_agent_operations SET result_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ progress }), new Date().toISOString(), row.operation_id);
    },
    log() {},
    result() {},
    error() {},
  };
  try {
    const record = await deployBackendArtifact(row.target_id, {
      artifactPath: row.file_path,
      artifactSha256: row.expected_sha256,
      artifactName: row.file_name,
      commitSha: row.commit_sha,
      commitMessage: row.commit_message,
      commitAuthor: row.commit_author,
      branch: row.branch,
      operator: `mcp:${row.client}:${row.actor_user_id}`,
      signal: controller.signal,
    }, emit);
    const completedAt = new Date().toISOString();
    const report = {
      summary: `已由中央部署后端目标 ${row.target_id}`,
      action: 'yuyan_deploy_target',
      executionScope: 'central',
      actor: { accountId: row.actor_user_id, deviceId: row.device_id, teamId: row.team_id, client: row.client },
      object: { type: 'deploy_target', id: row.target_id },
      changes: [`部署分支 ${row.branch}`, `绑定 Commit ${row.commit_sha}`, `Jar SHA-256 ${row.expected_sha256}`],
      verification: [`发布记录 ${record.id}`, `最终状态 ${record.status}`],
      completedAt,
    };
    db.prepare("UPDATE artifact_jobs SET status = 'succeeded', updated_at = ? WHERE id = ?").run(completedAt, row.id);
    db.prepare("UPDATE central_agent_operations SET status = 'succeeded', result_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ record, executionReport: report }), completedAt, row.operation_id);
    await appendCentralAudit({
      userId: row.actor_user_id, accountId: row.actor_user_id, deviceId: row.device_id,
      teamId: row.team_id, client: row.client, requestId: row.request_id,
    }, { action: 'central_deploy_succeeded', operationId: row.operation_id, targetId: row.target_id, recordId: record.id });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const cancelled = controller.signal.aborted;
    const status = cancelled ? 'cancelled' : 'failed';
    const safeError = cancelled
      ? { code: 'cancelled', message: '中央部署已请求安全停止', retryable: true }
      : { code: error?.code || 'central_deploy_failed', message: String(error?.message || '中央部署失败'), retryable: false };
    db.prepare('UPDATE artifact_jobs SET status = ?, error_json = ?, updated_at = ? WHERE id = ?').run(status, JSON.stringify(safeError), failedAt, row.id);
    db.prepare('UPDATE central_agent_operations SET status = ?, error_json = ?, updated_at = ? WHERE id = ?')
      .run(status, JSON.stringify(safeError), failedAt, row.operation_id);
    await appendCentralAudit({
      userId: row.actor_user_id, accountId: row.actor_user_id, deviceId: row.device_id,
      teamId: row.team_id, client: row.client, requestId: row.request_id,
    }, { action: cancelled ? 'central_deploy_cancelled' : 'central_deploy_failed', operationId: row.operation_id, targetId: row.target_id, error: safeError });
  } finally {
    unregisterCentralOperationController(row.operation_id);
    await fs.rm(row.file_path, { force: true }).catch(() => undefined);
  }
}

/** 取消当前账号的上传、排队或可安全停止的中央部署任务。 */
export async function cancelCentralOperation(operationId) {
  const db = await ensureArtifactSchema();
  const context = getRequestContext();
  const row = db.prepare(`
    SELECT j.* FROM artifact_jobs j
    WHERE j.operation_id = ? AND j.team_id = ?
  `).get(operationId, context.teamId);
  if (!row) throw Object.assign(new Error('中央操作不存在'), { status: 404, code: 'operation_not_found' });
  if (row.actor_user_id !== context.userId && context.role !== 'admin') {
    throw Object.assign(new Error('只能取消当前账号发起的任务'), { status: 403, code: 'operation_cancel_forbidden' });
  }
  if (['succeeded', 'failed', 'cancelled', 'expired'].includes(row.status)) return getCentralOperation(operationId);
  const timestamp = new Date().toISOString();
  const error = { code: 'cancelled', message: row.status === 'running' ? '已请求安全停止中央部署' : '中央任务已取消', retryable: true };
  if (row.status === 'running') {
    abortCentralOperation(operationId);
    db.prepare("UPDATE central_agent_operations SET error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), timestamp, operationId);
  } else {
    db.prepare("UPDATE artifact_jobs SET status = 'cancelled', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), timestamp, row.id);
    db.prepare("UPDATE central_agent_operations SET status = 'cancelled', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), timestamp, operationId);
    await fs.rm(row.file_path, { force: true }).catch(() => undefined);
  }
  return getCentralOperation(operationId);
}

/** 查询当前账号的中央操作。 */
export async function getCentralOperation(operationId) {
  const db = await ensureArtifactSchema();
  const context = getRequestContext();
  const row = db.prepare('SELECT * FROM central_agent_operations WHERE id = ? AND team_id = ?').get(operationId, context.teamId);
  if (!row) throw Object.assign(new Error('中央操作不存在'), { status: 404, code: 'operation_not_found' });
  return {
    id: row.id,
    toolName: row.tool_name,
    status: row.status,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    actor: { accountId: row.actor_user_id, deviceId: row.device_id, teamId: row.team_id, client: row.client },
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 按账号列出中央操作，供其他设备查看共享任务状态。 */
export async function listCentralOperations(query = {}) {
  const db = await ensureArtifactSchema();
  const context = getRequestContext();
  const conditions = ['team_id = ?'];
  const params = [context.teamId];
  if (query.targetId) {
    conditions.push("resource_type = 'deploy_target' AND resource_id = ?");
    params.push(String(Number(query.targetId)));
  }
  if (query.status) {
    const statuses = String(query.status).split(',').map((item) => item.trim()).filter((item) => /^(?:uploading|queued|running|succeeded|failed|cancelled|expired)$/.test(item));
    if (statuses.length) {
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const rows = db.prepare(`SELECT id FROM central_agent_operations WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit);
  const items = [];
  for (const row of rows) items.push(await getCentralOperation(row.id));
  return { items };
}
