/**
 * 存储治理异步清理任务管理器
 * @description 将耗时不确定的 Nginx 实例备份清理、三维策略裁剪与 CAS 对象池 GC 从同步长 HTTP 请求解耦为
 * 后台异步任务，提供实时阶段进度查询、物理机级互斥与精确范围复用、即时取消及持久化审计落库（#63）。
 */

import crypto from 'node:crypto';
import { appendCentralAudit } from './central-identity-service.mjs';
import { publishDeployEvent } from './deploy-event-service.mjs';
import { getDeployDb } from './deploy-store.mjs';
import { normalizePosixAbsPath } from './deploy-state-layout.mjs';
import { getRequestContext, getRequestTeamId, runRequestContext } from './request-context.mjs';
import { pruneNginxInstanceBackups } from './storage-governance-service.mjs';

/** 已结束任务保留时长（毫秒，默认 30 分钟） */
const FINISHED_JOB_TTL_MS = 30 * 60_000;

/** 打开抽屉时回显最近已完成任务的最大窗口（毫秒，默认 2 分钟） */
const RECENT_FINISHED_WINDOW_MS = 2 * 60_000;

/** 内存态任务存储（jobId -> 内部任务对象） */
const pruneJobsById = new Map();

/** 实例最新任务索引（`${teamId}:${instanceId}` -> jobId） */
const latestJobIdByInstance = new Map();

/** 物理机状态仓维度活跃任务索引（physicalKey -> jobId，防跨团队同物理机并发治理） */
const activeJobIdByPhysicalKey = new Map();

/**
 * 构建实例维度索引键。
 * @param {string} teamId - 团队/工作区 ID
 * @param {number} instanceId - Nginx 实例 ID
 * @returns {string}
 */
function buildInstanceKey(teamId, instanceId) {
  return `${String(teamId || 'legacy-team')}:${Number(instanceId)}`;
}

/**
 * 构建物理服务器 + Nginx 实例根目录的跨团队互斥键。
 * @param {Object|null} server - 服务器对象
 * @param {Object|null} instance - Nginx 实例对象
 * @returns {string}
 */
export function buildPhysicalPruneKey(server, instance) {
  if (!server) return '';
  const host = String(server.host || '').trim().toLowerCase();
  const port = Number(server.port || 22);
  const serverPart = host ? `${host}:${port}` : `server#${Number(server.id || 0)}`;
  const rootPart = normalizePosixAbsPath(instance?.baseRoot || instance?.htmlRoot || '') || `inst#${Number(instance?.id || 0)}`;
  return `${serverPart}|${rootPart}`;
}

/**
 * 规范化并排序目标目录列表，用于准确判断两次请求范围是否完全一致。
 * @param {string[]} roots - 目录列表
 * @returns {string[]}
 */
function normalizeScopeRoots(roots) {
  return [...new Set((roots || []).map((r) => normalizePosixAbsPath(r) || String(r || '').trim()).filter(Boolean))].sort();
}

/**
 * 判断运行中任务与新请求的范围及核心策略是否完全一致（仅一致才允许复用，防止 single/all 或不同策略误复用，#63）。
 * @param {Object} job - 运行中任务
 * @param {'single'|'all'} scope - 新请求范围
 * @param {string[]} normalizedRoots - 规范化并排序后的新请求目标目录
 * @param {{ inlineAction: string, applyRetentionPolicy: boolean, runCasGc: boolean }} policy - 核心策略
 * @returns {boolean}
 */
function isSamePruneJobScope(job, scope, normalizedRoots, policy) {
  if (job.scope !== scope) return false;
  if (job.inlineAction !== policy.inlineAction) return false;
  if (Boolean(job.applyRetentionPolicy) !== Boolean(policy.applyRetentionPolicy)) return false;
  if (Boolean(job.runCasGc) !== Boolean(policy.runCasGc)) return false;
  if (scope === 'all') return true;
  const existing = normalizeScopeRoots(job.targetRoots);
  if (existing.length !== normalizedRoots.length) return false;
  return existing.every((val, idx) => val === normalizedRoots[idx]);
}

/**
 * 将存储清理终态与实际删除统计持久化写入本地 SQLite 审计表，并在中央模式下补充终态审计记录（#63）。
 * @param {Object} job - 已终态任务
 * @param {Object|null} requestContext - 请求上下文
 */
async function persistPruneJobAudit(job, requestContext) {
  try {
    const db = await getDeployDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS storage_prune_audit_logs (
        job_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        instance_id INTEGER NOT NULL,
        scope TEXT NOT NULL,
        target_roots_json TEXT NOT NULL,
        inline_action TEXT NOT NULL,
        operator TEXT NOT NULL,
        status TEXT NOT NULL,
        deleted_backups INTEGER NOT NULL DEFAULT 0,
        freed_bytes INTEGER NOT NULL DEFAULT 0,
        cleared_db_records INTEGER NOT NULL DEFAULT 0,
        deleted_paths_json TEXT NOT NULL DEFAULT '[]',
        cas_gc_json TEXT,
        error TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_storage_prune_audit_team_inst
        ON storage_prune_audit_logs(team_id, instance_id, finished_at DESC);
    `);
    const deletedPaths = Array.isArray(job.result?.deletedPaths) ? job.result.deletedPaths : [];
    db.prepare(`
      INSERT OR REPLACE INTO storage_prune_audit_logs (
        job_id, team_id, instance_id, scope, target_roots_json, inline_action, operator,
        status, deleted_backups, freed_bytes, cleared_db_records, deleted_paths_json,
        cas_gc_json, error, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.jobId,
      String(job.teamId || 'legacy-team'),
      Number(job.instanceId),
      String(job.scope || 'all'),
      JSON.stringify(job.targetRoots || []),
      String(job.inlineAction || 'keep_latest_1'),
      String(job.operator || ''),
      String(job.status || 'failed'),
      Number(job.deletedBackups || 0),
      Number(job.freedBytes || 0),
      Number(job.clearedDbRecords || 0),
      JSON.stringify(deletedPaths.slice(0, 500)),
      job.casGc ? JSON.stringify(job.casGc) : null,
      String(job.error || ''),
      String(job.startedAt || new Date().toISOString()),
      String(job.finishedAt || new Date().toISOString())
    );
  } catch {
    // 审计落库异常绝不影响清理主流程
  }

  if (requestContext?.userId) {
    try {
      await appendCentralAudit(requestContext, {
        action: 'STORAGE_PRUNE_COMPLETED',
        resourceType: 'nginx_instance',
        resourceId: Number(job.instanceId),
        result: job.status,
        extra: {
          jobId: job.jobId,
          scope: job.scope,
          inlineAction: job.inlineAction,
          deletedBackups: Number(job.deletedBackups || 0),
          freedBytes: Number(job.freedBytes || 0),
          clearedDbRecords: Number(job.clearedDbRecords || 0),
          casDeletedObjects: Number(job.casGc?.deletedObjects || 0),
          error: job.error || '',
        },
      });
    } catch {
      // 忽略中央审计异常
    }
  }
}

/**
 * 清理已过期的历史完成任务，避免内存增长。
 */
function purgeExpiredJobs() {
  const now = Date.now();
  for (const [jobId, job] of pruneJobsById.entries()) {
    if (job.status === 'running') continue;
    if (job.finishedAtMs && now - job.finishedAtMs > FINISHED_JOB_TTL_MS) {
      pruneJobsById.delete(jobId);
      const instKey = buildInstanceKey(job.teamId, job.instanceId);
      if (latestJobIdByInstance.get(instKey) === jobId) {
        latestJobIdByInstance.delete(instKey);
      }
      if (job.physicalKey && activeJobIdByPhysicalKey.get(job.physicalKey) === jobId) {
        activeJobIdByPhysicalKey.delete(job.physicalKey);
      }
    }
  }
}

/**
 * 将内部任务对象转换为对外只读快照。
 * @param {Object} job - 内部任务对象
 * @param {boolean} [reused=false] - 是否复用了正在运行中的任务
 * @returns {Object} 任务快照
 */
function toJobSnapshot(job, reused = false) {
  return {
    jobId: job.jobId,
    instanceId: job.instanceId,
    scope: job.scope,
    targetRoots: [...job.targetRoots],
    status: job.status,
    cancelling: job.cancelling,
    phase: job.phase,
    phaseLabel: job.phaseLabel,
    percent: job.percent,
    totalApps: job.totalApps,
    completedApps: job.completedApps,
    currentAppName: job.currentAppName,
    deletedBackups: job.deletedBackups,
    freedBytes: job.freedBytes,
    clearedDbRecords: job.clearedDbRecords,
    casGc: job.casGc,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    ...(reused ? { reused: true } : {}),
  };
}

/**
 * 创建并登记一个清理任务（执行同实例范围冲突校验与物理机跨团队互斥）。
 * @param {number} instanceId - 实例 ID
 * @param {Object} options - 清理参数
 * @param {Object} deps - 依赖与物理机键
 * @returns {{ job: Object, reused: boolean }}
 */
function registerPruneJob(instanceId, options = {}, deps = {}) {
  purgeExpiredJobs();
  const numericInstanceId = Number(instanceId);
  if (!Number.isFinite(numericInstanceId) || numericInstanceId <= 0) {
    throw Object.assign(new Error('无效的 Nginx 实例 ID'), { statusCode: 400 });
  }

  const teamId = getRequestTeamId();
  const instKey = buildInstanceKey(teamId, numericInstanceId);
  const physicalKey = String(deps.physicalKey || options.physicalKey || '').trim();
  const targetRoots = Array.isArray(options.targetRoots)
    ? options.targetRoots.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const normalizedRoots = normalizeScopeRoots(targetRoots);
  const scope = targetRoots.length > 0 ? 'single' : 'all';
  const reqInlineAction = String(options.inlineAction || 'keep_latest_1');
  const reqApplyRetention = options.applyRetentionPolicy !== false;
  const reqRunCasGc = options.runCasGc !== false;

  const existingId = latestJobIdByInstance.get(instKey);
  const existingJob = existingId ? pruneJobsById.get(existingId) : null;
  if (existingJob && existingJob.status === 'running') {
    if (
      isSamePruneJobScope(existingJob, scope, normalizedRoots, {
        inlineAction: reqInlineAction,
        applyRetentionPolicy: reqApplyRetention,
        runCasGc: reqRunCasGc,
      })
    ) {
      return { job: existingJob, reused: true };
    }
    const runningDesc = existingJob.scope === 'all' ? '全实例瘦身' : '单目录清理';
    throw Object.assign(
      new Error(`当前实例已有正在运行的${runningDesc}任务，范围或策略与本次请求不一致，请等待完成或先停止后再发起`),
      { statusCode: 409, code: 'PRUNE_JOB_CONFLICT' }
    );
  }

  if (physicalKey) {
    const activePhysId = activeJobIdByPhysicalKey.get(physicalKey);
    const activePhysJob = activePhysId ? pruneJobsById.get(activePhysId) : null;
    if (activePhysJob && activePhysJob.status === 'running') {
      throw Object.assign(
        new Error('同一物理服务器的该 Nginx 实例目录正在执行存储清理任务，请稍后再试'),
        { statusCode: 409, code: 'PRUNE_JOB_CONFLICT' }
      );
    }
  }

  const nowIso = new Date().toISOString();
  const controller = new AbortController();
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    teamId,
    instanceId: numericInstanceId,
    physicalKey,
    inlineAction: reqInlineAction,
    applyRetentionPolicy: reqApplyRetention,
    runCasGc: reqRunCasGc,
    operator: String(options.operator || ''),
    scope,
    targetRoots,
    status: 'running',
    cancelling: false,
    phase: 'scanning',
    phaseLabel: targetRoots.length > 0 ? '正在定向扫描待清理目录…' : '正在准备清理任务…',
    percent: 2,
    totalApps: targetRoots.length,
    completedApps: 0,
    currentAppName: '',
    deletedBackups: 0,
    freedBytes: 0,
    clearedDbRecords: 0,
    casGc: null,
    result: null,
    error: '',
    startedAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
    finishedAtMs: 0,
    controller,
  };

  pruneJobsById.set(jobId, job);
  latestJobIdByInstance.set(instKey, jobId);
  if (physicalKey) activeJobIdByPhysicalKey.set(physicalKey, jobId);
  return { job, reused: false };
}

/**
 * 执行已登记任务的实际清理逻辑并维护终态、事件广播与审计落库。
 * @param {Object} job - 任务对象
 * @param {Object} options - 清理选项
 * @param {Object} deps - 可注入依赖
 * @param {Object|null} requestContext - 请求上下文
 * @returns {Promise<Object>} 清理结果
 */
async function executeRegisteredPruneJob(job, options, deps, requestContext) {
  const runner = deps.pruneRunner || pruneNginxInstanceBackups;
  const eventPublisher = deps.publishEvent || publishDeployEvent;
  const shouldPersistAudit = deps.persistAudit ?? !deps.pruneRunner;

  const externalSignal = options.signal;
  const onExternalAbort = () => {
    if (!job.controller.signal.aborted) {
      job.cancelling = true;
      job.phaseLabel = '正在停止清理并释放锁…';
      job.updatedAt = new Date().toISOString();
      job.controller.abort(externalSignal?.reason || Object.assign(new Error('清理任务已取消'), { name: 'AbortError', code: 'ERR_CANCELED' }));
    }
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const result = await runner(job.instanceId, {
      inlineAction: options.inlineAction,
      applyRetentionPolicy: options.applyRetentionPolicy,
      runCasGc: options.runCasGc,
      gcGraceMinutes: options.gcGraceMinutes,
      targetRoots: job.targetRoots,
      operator: options.operator || '',
      signal: job.controller.signal,
      onProgress: (patch) => {
        if (job.status !== 'running') return;
        const ts = new Date().toISOString();
        if (patch.phase) job.phase = patch.phase;
        if (patch.phaseLabel) job.phaseLabel = job.cancelling ? '正在停止清理并释放锁…' : patch.phaseLabel;
        if (Number.isFinite(patch.percent)) job.percent = Math.max(0, Math.min(99, Number(patch.percent)));
        if (Number.isFinite(patch.totalApps)) job.totalApps = Number(patch.totalApps);
        if (Number.isFinite(patch.completedApps)) job.completedApps = Number(patch.completedApps);
        if (typeof patch.currentAppName === 'string') job.currentAppName = patch.currentAppName;
        if (Number.isFinite(patch.deletedBackups)) job.deletedBackups = Number(patch.deletedBackups);
        if (Number.isFinite(patch.freedBytes)) job.freedBytes = Number(patch.freedBytes);
        if (Number.isFinite(patch.clearedDbRecords)) job.clearedDbRecords = Number(patch.clearedDbRecords);
        job.updatedAt = ts;
      },
    });

    const doneIso = new Date().toISOString();
    job.status = 'succeeded';
    job.cancelling = false;
    job.phase = 'done';
    job.phaseLabel = '清理完成';
    job.percent = 100;
    job.completedApps = job.totalApps;
    job.deletedBackups = Number(result?.deletedBackups || 0);
    job.freedBytes = Number(result?.freedBytes || 0);
    job.clearedDbRecords = Number(result?.clearedDbRecords || 0);
    job.casGc = result?.casGc || null;
    job.result = result || null;
    job.updatedAt = doneIso;
    job.finishedAt = doneIso;
    job.finishedAtMs = Date.now();

    if (shouldPersistAudit) {
      await persistPruneJobAudit(job, requestContext);
    }
    if (job.deletedBackups > 0 || job.clearedDbRecords > 0) {
      try {
        eventPublisher({ teamId: job.teamId, domains: ['records'] });
      } catch {}
    }
    return result;
  } catch (error) {
    const doneIso = new Date().toISOString();
    const isCancelled = Boolean(
      job.controller.signal.aborted ||
      error?.code === 'ERR_CANCELED' ||
      error?.code === 'DEPLOY_STOPPED' ||
      error?.name === 'AbortError' ||
      error?.name === 'DeployStoppedError'
    );
    job.status = isCancelled ? 'cancelled' : 'failed';
    job.cancelling = false;
    job.phaseLabel = isCancelled ? '已停止清理' : '清理失败';
    job.error = isCancelled ? '' : (error instanceof Error ? error.message : String(error || '执行存储清理失败'));
    job.updatedAt = doneIso;
    job.finishedAt = doneIso;
    job.finishedAtMs = Date.now();

    if (shouldPersistAudit) {
      await persistPruneJobAudit(job, requestContext);
    }
    if (job.deletedBackups > 0 || job.clearedDbRecords > 0) {
      try {
        eventPublisher({ teamId: job.teamId, domains: ['records'] });
      } catch {}
    }
    throw error;
  } finally {
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    if (job.physicalKey && activeJobIdByPhysicalKey.get(job.physicalKey) === job.jobId) {
      activeJobIdByPhysicalKey.delete(job.physicalKey);
    }
  }
}

/**
 * 启动一个后台异步存储清理任务（仅范围完全一致时复用，不同范围或跨团队同物理机冲突抛出 409）。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} [options={}] - 清理选项
 * @param {Object} [deps={}] - 可注入依赖（含 physicalKey）
 * @returns {Object} 初始任务快照
 */
export function startNginxStoragePruneJob(instanceId, options = {}, deps = {}) {
  const requestContext = getRequestContext();
  const { job, reused } = registerPruneJob(instanceId, options, deps);
  if (reused) {
    return toJobSnapshot(job, true);
  }

  queueMicrotask(() => {
    runRequestContext(requestContext, async () => {
      try {
        await executeRegisteredPruneJob(job, options, deps, requestContext);
      } catch {
        // 错误已记录于 job.status / job.error 并落审计，不抛出未捕获微任务异常
      }
    });
  });

  return toJobSnapshot(job, false);
}

/**
 * 同步执行一次存储清理，同时纳入统一单实例/物理机协调与审计落库（防同步兼容接口绕过去重，#63）。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} [options={}] - 清理选项（可含 signal）
 * @param {Object} [deps={}] - 可注入依赖（含 physicalKey）
 * @returns {Promise<Object>} 清理统计结果
 */
export async function runNginxStoragePruneSynchronously(instanceId, options = {}, deps = {}) {
  const requestContext = getRequestContext();
  const { job, reused } = registerPruneJob(instanceId, options, deps);
  if (reused) {
    throw Object.assign(
      new Error('当前实例已有进行中的存储清理任务，请等待其完成或通过异步任务查看实时进度'),
      { statusCode: 409, code: 'PRUNE_JOB_CONFLICT' }
    );
  }
  return executeRegisteredPruneJob(job, options, deps, requestContext);
}

/**
 * 查询指定存储清理任务的最新快照。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {string} jobId - 任务 ID
 * @returns {Object} 任务快照
 */
export function getNginxStoragePruneJob(instanceId, jobId) {
  purgeExpiredJobs();
  const teamId = getRequestTeamId();
  const job = pruneJobsById.get(String(jobId || '').trim());
  if (!job || job.teamId !== teamId || Number(job.instanceId) !== Number(instanceId)) {
    throw Object.assign(new Error('存储清理任务不存在或已过期'), { statusCode: 404 });
  }
  return toJobSnapshot(job, false);
}

/**
 * 获取某 Nginx 实例当前运行中（或极近期刚结束）的清理任务快照，用于重新打开抽屉无缝续看进度。
 * @param {number} instanceId - Nginx 实例 ID
 * @returns {Object|null} 任务快照（无进行中/近期任务时返回 null）
 */
export function getLatestNginxStoragePruneJob(instanceId) {
  purgeExpiredJobs();
  const teamId = getRequestTeamId();
  const instKey = buildInstanceKey(teamId, Number(instanceId));
  const jobId = latestJobIdByInstance.get(instKey);
  if (!jobId) return null;
  const job = pruneJobsById.get(jobId);
  if (!job) return null;
  if (job.status === 'running') {
    return toJobSnapshot(job, false);
  }
  if (job.finishedAtMs && Date.now() - job.finishedAtMs <= RECENT_FINISHED_WINDOW_MS) {
    return toJobSnapshot(job, false);
  }
  return null;
}

/**
 * 取消正在运行中的存储清理任务（触发 AbortSignal 中断等锁并尽快释放目录锁）。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {string} jobId - 任务 ID
 * @returns {Object} 更新后的任务快照
 */
export function cancelNginxStoragePruneJob(instanceId, jobId) {
  const teamId = getRequestTeamId();
  const job = pruneJobsById.get(String(jobId || '').trim());
  if (!job || job.teamId !== teamId || Number(job.instanceId) !== Number(instanceId)) {
    throw Object.assign(new Error('存储清理任务不存在或已过期'), { statusCode: 404 });
  }
  if (job.status === 'running' && !job.controller.signal.aborted) {
    job.cancelling = true;
    job.phaseLabel = '正在停止清理并释放锁…';
    job.updatedAt = new Date().toISOString();
    job.controller.abort(Object.assign(new Error('用户已停止存储清理任务'), { name: 'AbortError', code: 'ERR_CANCELED' }));
  }
  return toJobSnapshot(job, false);
}

/**
 * 仅供单元测试使用的内存状态重置函数。
 */
export function resetStoragePruneJobsForTest() {
  for (const job of pruneJobsById.values()) {
    try {
      if (job.status === 'running' && !job.controller.signal.aborted) {
        job.controller.abort(new Error('test reset'));
      }
    } catch {}
  }
  pruneJobsById.clear();
  latestJobIdByInstance.clear();
  activeJobIdByPhysicalKey.clear();
}
