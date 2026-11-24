/**
 * 存储治理异步清理任务管理器
 * @description 将耗时不确定的 Nginx 实例备份清理、三维策略裁剪与 CAS 对象池 GC 从同步长 HTTP 请求解耦为
 * 后台异步任务，提供实时阶段进度查询、单实例并发复用与即时取消（中止等锁/释放目录锁）能力，彻底消除 120s HTTP 超时问题。
 */

import crypto from 'node:crypto';
import { publishDeployEvent } from './deploy-event-service.mjs';
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
 * 启动一个后台异步存储清理任务（同一实例已有运行中任务时直接复用其快照，避免并发抢锁）。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} [options={}] - 清理选项
 * @param {'none'|'keep_latest_1'|'purge_unreferenced'|'purge_all'} [options.inlineAction='keep_latest_1'] - 内嵌备份清理策略
 * @param {boolean} [options.applyRetentionPolicy=true] - 是否执行三维保留策略裁剪
 * @param {boolean} [options.runCasGc=true] - 是否运行外置仓 CAS 对象池 GC
 * @param {number} [options.gcGraceMinutes] - 对象池 GC 宽限期（分钟）
 * @param {string[]} [options.targetRoots=[]] - 限定处理的应用目录（为空表示全实例）
 * @param {string} [options.operator=''] - 操作人
 * @param {Object} [deps={}] - 可注入依赖（便于单元测试）
 * @returns {Object} 初始任务快照
 */
export function startNginxStoragePruneJob(instanceId, options = {}, deps = {}) {
  purgeExpiredJobs();
  const numericInstanceId = Number(instanceId);
  if (!Number.isFinite(numericInstanceId) || numericInstanceId <= 0) {
    throw Object.assign(new Error('无效的 Nginx 实例 ID'), { statusCode: 400 });
  }

  const requestContext = getRequestContext();
  const teamId = getRequestTeamId();
  const instKey = buildInstanceKey(teamId, numericInstanceId);
  const existingId = latestJobIdByInstance.get(instKey);
  const existingJob = existingId ? pruneJobsById.get(existingId) : null;
  if (existingJob && existingJob.status === 'running') {
    return toJobSnapshot(existingJob, true);
  }

  const targetRoots = Array.isArray(options.targetRoots)
    ? options.targetRoots.map((r) => String(r || '').trim()).filter(Boolean)
    : [];
  const nowIso = new Date().toISOString();
  const controller = new AbortController();
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    teamId,
    instanceId: numericInstanceId,
    scope: targetRoots.length > 0 ? 'single' : 'all',
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

  const runner = deps.pruneRunner || pruneNginxInstanceBackups;
  const eventPublisher = deps.publishEvent || publishDeployEvent;

  // 在完整继承当前请求上下文的异步链路中后台执行
  queueMicrotask(() => {
    runRequestContext(requestContext, async () => {
      try {
        const result = await runner(numericInstanceId, {
          inlineAction: options.inlineAction,
          applyRetentionPolicy: options.applyRetentionPolicy,
          runCasGc: options.runCasGc,
          gcGraceMinutes: options.gcGraceMinutes,
          targetRoots,
          operator: options.operator || '',
          signal: controller.signal,
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

        if (job.deletedBackups > 0 || job.clearedDbRecords > 0) {
          try {
            eventPublisher({ teamId, domains: ['records'] });
          } catch {}
        }
      } catch (error) {
        const doneIso = new Date().toISOString();
        const isCancelled = Boolean(
          controller.signal.aborted ||
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

        if (job.deletedBackups > 0 || job.clearedDbRecords > 0) {
          try {
            eventPublisher({ teamId, domains: ['records'] });
          } catch {}
        }
      }
    });
  });

  return toJobSnapshot(job, false);
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
}
