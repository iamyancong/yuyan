/**
 * 独立服务器部署（NginxDeploy）实时变更事件总线（SSE）。
 * @description 按 teamId 隔离广播部署运行态快照与资源变更域（runtime / targets / records / backend-status），
 * 在 150ms 窗口内合并高频进度事件；仅在存在活跃订阅者时计算一次聚合快照并扇出给同团队所有在线客户端。
 */

import { getRequestTeamId, runRequestContext } from './request-context.mjs';

/** 允许广播的部署变更域。 */
export const DEPLOY_CHANGE_DOMAINS = Object.freeze(['runtime', 'targets', 'records', 'backend-status']);

const VALID_DOMAINS = new Set(DEPLOY_CHANGE_DOMAINS);

/** 单团队最大并发 SSE 连接数。 */
const MAX_DEPLOY_SSE_PER_TEAM = Math.max(4, Number(process.env.YUYAN_MAX_DEPLOY_SSE_PER_TEAM || 64));

/** 全进程最大并发 SSE 连接数。 */
const MAX_DEPLOY_SSE_TOTAL = Math.max(8, Number(process.env.YUYAN_MAX_DEPLOY_SSE_TOTAL || 128));

/** 同一团队高频事件的合并窗口（毫秒）。 */
const DEFAULT_COALESCE_MS = Math.max(20, Number(process.env.YUYAN_DEPLOY_SSE_COALESCE_MS || 150));

/**
 * @typedef {Object} TeamEventBucket
 * @property {number} revision 递增事件版本号
 * @property {Set<{onEvent: (eventName: string, payload: Object) => void, close?: () => void}>} subscribers 活跃订阅者
 * @property {Set<string>} pendingDomains 待刷新的变更域
 * @property {Set<number>} pendingTargetIds 待刷新的目标 ID
 * @property {ReturnType<typeof setTimeout>|null} flushTimer 节流定时器
 */

/** @type {Map<string, TeamEventBucket>} */
const teamBuckets = new Map();

let totalSubscribers = 0;
let totalPublishedEvents = 0;
let runtimeSnapshotResolver = null;

/**
 * 获取或初始化指定团队的事件桶。
 * @param {string} teamId 团队空间标识
 * @returns {TeamEventBucket} 团队事件桶
 */
function getOrCreateBucket(teamId) {
  const key = String(teamId || 'legacy-team');
  let bucket = teamBuckets.get(key);
  if (!bucket) {
    bucket = {
      revision: 0,
      subscribers: new Set(),
      pendingDomains: new Set(),
      pendingTargetIds: new Set(),
      flushTimer: null,
    };
    teamBuckets.set(key, bucket);
  }
  return bucket;
}

/**
 * 注册团队运行态快照构建器，供 runtime 事件合并广播时按需调用一次。
 * @param {(teamId: string) => Promise<{items: Object[], checkedAt: string}>} resolver 快照构建函数
 */
export function setDeployRuntimeSnapshotResolver(resolver) {
  runtimeSnapshotResolver = typeof resolver === 'function' ? resolver : null;
}

/**
 * 解析指定团队当前的运行态聚合快照。
 * @param {string} teamId 团队空间标识
 * @returns {Promise<{items: Object[], checkedAt: string}|null>} 运行态快照批次
 */
export async function resolveDeployRuntimeSnapshotForTeam(teamId) {
  if (!runtimeSnapshotResolver) return null;
  try {
    return await runRequestContext(
      { teamId: String(teamId || 'legacy-team'), role: 'viewer', client: 'sse' },
      () => runtimeSnapshotResolver(teamId)
    );
  } catch {
    return null;
  }
}

/**
 * 读取指定团队当前的事件修订号。
 * @param {string} [teamId] 团队空间标识
 * @returns {number} 当前修订号
 */
export function getDeployEventRevision(teamId = getRequestTeamId()) {
  return teamBuckets.get(String(teamId || 'legacy-team'))?.revision || 0;
}

/**
 * 立即刷出指定团队累积的变更事件。
 * @param {string} teamId 团队空间标识
 * @returns {Promise<void>}
 */
async function flushTeamEvents(teamId) {
  const bucket = teamBuckets.get(teamId);
  if (!bucket || !bucket.pendingDomains.size) return;

  const domains = [...bucket.pendingDomains];
  const targetIds = [...bucket.pendingTargetIds];
  bucket.pendingDomains.clear();
  bucket.pendingTargetIds.clear();
  bucket.revision += 1;
  totalPublishedEvents += 1;

  if (!bucket.subscribers.size) return;

  const currentRevision = bucket.revision;
  let runtime = null;
  if (domains.includes('runtime') && runtimeSnapshotResolver) {
    runtime = await resolveDeployRuntimeSnapshotForTeam(teamId);
  }

  const payload = Object.freeze({
    revision: currentRevision,
    domains,
    targetIds,
    ...(runtime ? { runtime } : {}),
    timestamp: new Date().toISOString(),
  });

  bucket.subscribers.forEach((subscriber) => {
    try {
      subscriber.onEvent('change', payload);
    } catch {
      /** 单个客户端写入异常不影响其他订阅者 */
    }
  });
}

/**
 * 发布部署模块变更事件，在合并窗口内自动聚合相同团队的多次触发。
 * @param {Object} [options] 发布选项
 * @param {string} [options.teamId] 团队空间标识，默认取当前请求上下文
 * @param {string|string[]} [options.domains] 变更域（'runtime' | 'targets' | 'records' | 'backend-status'）
 * @param {number|number[]} [options.targetIds] 关联的部署目标 ID
 * @param {number} [options.coalesceMs] 合并窗口毫秒数
 */
export function publishDeployEvent(options = {}) {
  const teamId = String(options.teamId || getRequestTeamId() || 'legacy-team');
  const rawDomains = Array.isArray(options.domains) ? options.domains : [options.domains || 'runtime'];
  const validDomains = rawDomains.filter((domain) => VALID_DOMAINS.has(domain));
  if (!validDomains.length) return;

  const bucket = getOrCreateBucket(teamId);
  validDomains.forEach((domain) => bucket.pendingDomains.add(domain));

  const rawTargetIds = Array.isArray(options.targetIds)
    ? options.targetIds
    : options.targetIds !== undefined && options.targetIds !== null
      ? [options.targetIds]
      : [];
  rawTargetIds.forEach((id) => {
    const num = Number(id);
    if (Number.isInteger(num) && num > 0) bucket.pendingTargetIds.add(num);
  });

  if (bucket.flushTimer) return;
  const delay = Number.isFinite(options.coalesceMs) ? Math.max(0, Number(options.coalesceMs)) : DEFAULT_COALESCE_MS;
  bucket.flushTimer = setTimeout(() => {
    bucket.flushTimer = null;
    void flushTeamEvents(teamId);
  }, delay);
  bucket.flushTimer.unref?.();
}

/**
 * 订阅指定团队的部署实时事件。
 * @param {Object} subscriber 订阅配置
 * @param {string} [subscriber.teamId] 团队空间标识
 * @param {(eventName: 'ready'|'change', payload: Object) => void} subscriber.onEvent 事件回调
 * @param {() => void} [subscriber.close] 服务端主动关闭回调
 * @returns {() => void} 取消订阅函数
 */
export function subscribeDeployEvents(subscriber) {
  const teamId = String(subscriber?.teamId || getRequestTeamId() || 'legacy-team');
  const bucket = getOrCreateBucket(teamId);

  if (totalSubscribers >= MAX_DEPLOY_SSE_TOTAL || bucket.subscribers.size >= MAX_DEPLOY_SSE_PER_TEAM) {
    const error = new Error('当前实时事件连接数已达上限，客户端将自动退回轮询');
    error.status = 503;
    error.code = 'deploy_sse_limit_exceeded';
    throw error;
  }

  const entry = {
    onEvent: subscriber.onEvent,
    close: subscriber.close,
  };
  bucket.subscribers.add(entry);
  totalSubscribers += 1;

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    if (bucket.subscribers.delete(entry)) {
      totalSubscribers = Math.max(0, totalSubscribers - 1);
    }
    if (!bucket.subscribers.size && !bucket.pendingDomains.size && !bucket.flushTimer) {
      teamBuckets.delete(teamId);
    }
  };
}

/**
 * 获取部署 SSE 运行统计指标，供 /deploy-api/v2/metrics 暴露。
 * @returns {{activeConnections: number, activeTeams: number, maxConnections: number, totalPublishedEvents: number}}
 */
export function getDeployEventStats() {
  let activeTeams = 0;
  for (const bucket of teamBuckets.values()) {
    if (bucket.subscribers.size > 0) activeTeams += 1;
  }
  return {
    activeConnections: totalSubscribers,
    activeTeams,
    maxConnections: MAX_DEPLOY_SSE_TOTAL,
    totalPublishedEvents,
  };
}

/**
 * 关闭所有活跃的部署 SSE 连接，供服务优雅退出或测试清理使用。
 */
export function closeAllDeployEventStreams() {
  for (const bucket of teamBuckets.values()) {
    if (bucket.flushTimer) {
      clearTimeout(bucket.flushTimer);
      bucket.flushTimer = null;
    }
    bucket.pendingDomains.clear();
    bucket.pendingTargetIds.clear();
    for (const subscriber of bucket.subscribers) {
      try {
        subscriber.close?.();
      } catch {}
    }
    bucket.subscribers.clear();
  }
  totalSubscribers = 0;
}

/**
 * 重置所有事件状态（仅供单测使用）。
 */
export function resetDeployEventState() {
  closeAllDeployEventStreams();
  teamBuckets.clear();
  totalPublishedEvents = 0;
}
