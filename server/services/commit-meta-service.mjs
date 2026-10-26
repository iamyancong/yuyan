/**
 * GitLab 提交元信息服务
 * @description 负责查询提交标题与提交人展示名，内置请求超时、进程内 TTL 缓存、同 Key 并发合并与后台限流队列，
 * 保证发布历史等读接口永远不会被 GitLab 网络 IO 阻塞，多人同时访问时也不会放大对 GitLab 的请求量。
 */

import { GITLAB_HOST, GITLAB_TOKEN } from '../config/constants.mjs';

/** 单次 GitLab 请求超时（毫秒） */
const GITLAB_REQUEST_TIMEOUT_MS = Number(process.env.YUYAN_GITLAB_REQUEST_TIMEOUT_MS || 3000);

/** 单条提交元信息解析总预算（毫秒），包含提交人中文名搜索的多次串行请求 */
const COMMIT_META_RESOLVE_BUDGET_MS = Number(process.env.YUYAN_COMMIT_META_BUDGET_MS || 8000);

/** 完整结果缓存时长：提交内容不可变，可长期缓存 */
const COMMIT_META_TTL_MS = 24 * 60 * 60 * 1000;

/** 临时失败（超时、5xx、鉴权失败）退避时长，期间不再重复请求 GitLab */
const TRANSIENT_FAILURE_TTL_MS = 10 * 60 * 1000;

/** 提交人展示名缓存时长 */
const USER_NAME_TTL_MS = 6 * 60 * 60 * 1000;

/** 缓存最大条目数，超出按最久未使用淘汰 */
const MAX_CACHE_ENTRIES = 2000;

/** 后台补全并发数，避免多人同时访问时压垮 GitLab */
const HYDRATION_CONCURRENCY = 2;

/** 后台补全队列最大长度，超出直接丢弃（下次访问会重新入队） */
const HYDRATION_MAX_QUEUE = 500;

/**
 * 带 TTL 与容量上限的轻量 LRU 缓存。
 */
class TtlCache {
  /**
   * @param {number} maxEntries 最大条目数
   */
  constructor(maxEntries) {
    this.maxEntries = maxEntries;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.store = new Map();
  }

  /**
   * 读取缓存，过期返回 undefined。
   * @param {string} key 缓存 Key
   * @returns {any} 缓存值
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * 写入缓存。
   * @param {string} key 缓存 Key
   * @param {any} value 缓存值
   * @param {number} ttlMs 存活时长
   */
  set(key, value, ttlMs) {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
  }

  /** 清空缓存 */
  clear() {
    this.store.clear();
  }
}

/** 提交元信息缓存：`host|projectId|sha` → `{ message, author, transient }` */
const commitMetaCache = new TtlCache(MAX_CACHE_ENTRIES);

/** 提交人展示名缓存：`host|projectId|keyword` → `name` */
const userNameCache = new TtlCache(MAX_CACHE_ENTRIES);

/** 同一提交的并发请求合并 */
const inflightCommitMeta = new Map();

/** 后台补全队列 */
const hydrationQueue = [];

/** 已在队列或执行中的任务 Key，防止重复入队 */
const pendingHydrationKeys = new Set();

/** 当前运行中的后台 Worker 数 */
let activeHydrationWorkers = 0;

/**
 * 规范化 GitLab 服务地址。
 * @param {string} host - GitLab 原始地址
 * @returns {string} GitLab 基础地址
 */
export function normalizeGitlabHost(host) {
  try {
    const url = new URL(host);
    return `${url.protocol}//${url.host}`;
  } catch {
    return String(host || '').replace(/\/$/, '');
  }
}

/**
 * 判断文本是否包含中文。
 * @param {string} value - 原始文本
 * @returns {boolean} 是否包含中文
 */
export function hasChineseText(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ''));
}

/**
 * 解析实际使用的 GitLab 访问令牌。
 * @param {string} [gitlabToken] - 请求携带的令牌
 * @returns {string} 访问令牌
 */
export function resolveGitlabToken(gitlabToken = '') {
  return String(gitlabToken || GITLAB_TOKEN || '').trim();
}

/**
 * 判断 HTTP 状态是否属于临时失败（可在退避后重试）。
 * @param {number} status - HTTP 状态码
 * @returns {boolean} 是否临时失败
 */
function isTransientStatus(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/**
 * 组合单请求超时与整体预算的取消信号。
 * @param {AbortSignal} [budgetSignal] - 整体预算信号
 * @returns {AbortSignal} 组合后的信号
 */
function createRequestSignal(budgetSignal) {
  const timeoutSignal = AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS);
  return budgetSignal ? AbortSignal.any([timeoutSignal, budgetSignal]) : timeoutSignal;
}

/**
 * 请求 GitLab JSON 接口，统一超时与错误归类，永不抛出。
 * @param {string} url - 请求地址
 * @param {Record<string, string>} headers - 请求头
 * @param {AbortSignal} [budgetSignal] - 整体预算信号
 * @returns {Promise<{ ok: boolean, transient: boolean, data: any }>} 请求结果
 */
async function fetchGitlabJson(url, headers, budgetSignal) {
  try {
    const response = await fetch(url, { headers, signal: createRequestSignal(budgetSignal) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, transient: isTransientStatus(response.status), data: null };
    }
    const data = await response.json().catch(() => null);
    return { ok: true, transient: false, data };
  } catch {
    return { ok: false, transient: true, data: null };
  }
}

/**
 * 从 GitLab 用户列表里选择更适合展示的用户名。
 * @param {Object[]} users - GitLab 用户列表
 * @param {string} fallbackName - 兜底名称
 * @returns {string} 展示名称
 */
function pickGitlabUserDisplayName(users, fallbackName) {
  const list = Array.isArray(users) ? users : [];
  const chineseUser = list.find((user) => hasChineseText(user?.name));
  if (chineseUser?.name) return String(chineseUser.name).trim();
  const firstName = String(list[0]?.name || '').trim();
  return firstName || fallbackName;
}

/**
 * 搜索 GitLab 用户展示名（结果按关键字缓存，命中中文名即短路）。
 * @param {string} base - GitLab 基础地址
 * @param {Record<string, string>} headers - 请求头
 * @param {number|string} projectId - GitLab 项目 ID
 * @param {string} keyword - 搜索关键字
 * @param {string} fallbackName - 兜底名称
 * @param {AbortSignal} [budgetSignal] - 整体预算信号
 * @returns {Promise<{ name: string, transient: boolean }>} 用户展示名
 */
async function searchGitlabUserDisplayName(base, headers, projectId, keyword, fallbackName, budgetSignal) {
  const searchText = String(keyword || '').trim();
  if (!searchText) return { name: fallbackName, transient: false };
  const cacheKey = `${base}|${projectId}|${searchText}`;
  const cached = userNameCache.get(cacheKey);
  if (cached !== undefined) return { name: cached || fallbackName, transient: false };

  const usernameLikeText = searchText.includes('@') ? searchText.split('@')[0] : searchText;
  const searchUrls = [
    `${base}/api/v4/users?username=${encodeURIComponent(usernameLikeText)}`,
    `${base}/api/v4/projects/${encodeURIComponent(projectId)}/members/all?query=${encodeURIComponent(usernameLikeText)}`,
    `${base}/api/v4/projects/${encodeURIComponent(projectId)}/users?search=${encodeURIComponent(usernameLikeText)}`,
    `${base}/api/v4/users?search=${encodeURIComponent(usernameLikeText)}`,
  ];
  if (searchText !== usernameLikeText) {
    searchUrls.push(
      `${base}/api/v4/projects/${encodeURIComponent(projectId)}/members/all?query=${encodeURIComponent(searchText)}`,
      `${base}/api/v4/projects/${encodeURIComponent(projectId)}/users?search=${encodeURIComponent(searchText)}`,
      `${base}/api/v4/users?search=${encodeURIComponent(searchText)}`
    );
  }

  let bestName = '';
  let transient = false;
  for (const url of searchUrls) {
    if (budgetSignal?.aborted) {
      transient = true;
      break;
    }
    const result = await fetchGitlabJson(url, headers, budgetSignal);
    if (result.transient) transient = true;
    if (!result.ok) continue;
    const displayName = pickGitlabUserDisplayName(result.data, '');
    if (hasChineseText(displayName)) {
      userNameCache.set(cacheKey, displayName, USER_NAME_TTL_MS);
      return { name: displayName, transient: false };
    }
    if (displayName && displayName !== fallbackName) bestName = displayName;
  }
  if (!transient) userNameCache.set(cacheKey, bestName, USER_NAME_TTL_MS);
  return { name: bestName || fallbackName, transient };
}

/**
 * 实际请求 GitLab 解析提交元信息。
 * @param {string} base - GitLab 基础地址
 * @param {string} token - 访问令牌
 * @param {number} projectId - 项目 ID
 * @param {string} commitSha - 提交 SHA
 * @returns {Promise<{ message: string, author: string, transient: boolean }>} 提交元信息
 */
async function requestCommitMeta(base, token, projectId, commitSha) {
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  const budgetSignal = AbortSignal.timeout(COMMIT_META_RESOLVE_BUDGET_MS);
  const url = `${base}/api/v4/projects/${encodeURIComponent(projectId)}/repository/commits/${encodeURIComponent(commitSha)}`;
  const result = await fetchGitlabJson(url, headers, budgetSignal);
  if (!result.ok) return { message: '', author: '', transient: result.transient };

  const commit = result.data;
  const title = String(commit?.title || '').trim();
  const message = title || String(commit?.message || '').split(/\r?\n/)[0]?.trim() || '';
  const rawAuthor = String(commit?.author_name || commit?.committer_name || '').trim();
  const authorEmail = String(commit?.author_email || commit?.committer_email || '').trim();
  if (hasChineseText(rawAuthor)) return { message, author: rawAuthor, transient: false };

  const byEmail = await searchGitlabUserDisplayName(base, headers, projectId, authorEmail, rawAuthor, budgetSignal);
  if (hasChineseText(byEmail.name) || !rawAuthor) {
    return { message, author: byEmail.name, transient: byEmail.transient };
  }
  const byName = await searchGitlabUserDisplayName(base, headers, projectId, rawAuthor, byEmail.name || rawAuthor, budgetSignal);
  return { message, author: byName.name, transient: byEmail.transient || byName.transient };
}

/**
 * 获取 GitLab 提交元信息（带缓存、并发合并与超时）。
 * @param {number|string} projectId - GitLab 项目 ID
 * @param {string} commitSha - Commit SHA
 * @param {string} [gitlabToken] - GitLab 访问令牌
 * @param {string} [gitlabHost] - GitLab 服务地址
 * @returns {Promise<{ message: string, author: string, transient: boolean }>} 提交元信息；transient 表示结果因临时故障不完整
 */
export async function resolveCommitMeta(projectId, commitSha, gitlabToken = '', gitlabHost = '') {
  const safeProjectId = Number(projectId || 0);
  const safeCommitSha = String(commitSha || '').trim();
  if (!safeProjectId || !safeCommitSha) return { message: '', author: '', transient: false };

  const base = normalizeGitlabHost(gitlabHost || GITLAB_HOST);
  const cacheKey = `${base}|${safeProjectId}|${safeCommitSha}`;
  const cached = commitMetaCache.get(cacheKey);
  if (cached) return cached;

  const inflight = inflightCommitMeta.get(cacheKey);
  if (inflight) return inflight;

  const task = requestCommitMeta(base, resolveGitlabToken(gitlabToken), safeProjectId, safeCommitSha)
    .catch(() => ({ message: '', author: '', transient: true }))
    .then((meta) => {
      commitMetaCache.set(cacheKey, meta, meta.transient ? TRANSIENT_FAILURE_TTL_MS : COMMIT_META_TTL_MS);
      return meta;
    })
    .finally(() => {
      inflightCommitMeta.delete(cacheKey);
    });
  inflightCommitMeta.set(cacheKey, task);
  return task;
}

/**
 * 获取 GitLab 提交元信息（兼容旧签名）。
 * @param {number|string} projectId - GitLab 项目 ID
 * @param {string} commitSha - Commit SHA
 * @param {string} [gitlabToken] - GitLab 访问令牌
 * @param {string} [gitlabHost] - GitLab 服务地址
 * @returns {Promise<{message: string, author: string}>} 提交元信息
 */
export async function fetchGitlabCommitMeta(projectId, commitSha, gitlabToken = '', gitlabHost = '') {
  const { message, author } = await resolveCommitMeta(projectId, commitSha, gitlabToken, gitlabHost);
  return { message, author };
}

/**
 * 后台补全任务
 * @typedef {Object} CommitHydrationJob
 * @property {string} key - 去重 Key（通常为发布记录 ID）
 * @property {number} projectId - GitLab 项目 ID
 * @property {string} commitSha - 提交 SHA
 * @property {string} gitlabToken - 访问令牌（仅驻留内存，任务结束即释放）
 * @property {string} gitlabHost - GitLab 地址
 * @property {(meta: { message: string, author: string, transient: boolean }) => (void|Promise<void>)} onResolved - 结果回调
 */

/** 拉起后台 Worker，直到队列清空 */
function drainHydrationQueue() {
  while (activeHydrationWorkers < HYDRATION_CONCURRENCY && hydrationQueue.length) {
    const job = hydrationQueue.shift();
    activeHydrationWorkers += 1;
    resolveCommitMeta(job.projectId, job.commitSha, job.gitlabToken, job.gitlabHost)
      .then((meta) => job.onResolved(meta))
      .catch((error) => {
        console.warn('[commit-meta] 后台补全提交信息失败:', error?.message || error);
      })
      .finally(() => {
        pendingHydrationKeys.delete(job.key);
        activeHydrationWorkers -= 1;
        drainHydrationQueue();
      });
  }
}

/**
 * 将提交元信息补全任务放入后台队列，立即返回不阻塞调用方。
 * @param {CommitHydrationJob[]} jobs - 补全任务
 * @returns {number} 实际入队数量
 */
export function enqueueCommitMetaHydration(jobs) {
  let enqueued = 0;
  for (const job of jobs || []) {
    if (!job?.key || pendingHydrationKeys.has(job.key)) continue;
    if (hydrationQueue.length >= HYDRATION_MAX_QUEUE) break;
    pendingHydrationKeys.add(job.key);
    hydrationQueue.push(job);
    enqueued += 1;
  }
  if (enqueued) setImmediate(drainHydrationQueue);
  return enqueued;
}

/**
 * 获取后台补全队列状态（用于测试与诊断）。
 * @returns {{ queued: number, active: number, pending: number }} 队列状态
 */
export function getCommitMetaHydrationStats() {
  return { queued: hydrationQueue.length, active: activeHydrationWorkers, pending: pendingHydrationKeys.size };
}

/** 清空缓存（用于测试） */
export function resetCommitMetaCaches() {
  commitMetaCache.clear();
  userNameCache.clear();
  inflightCommitMeta.clear();
}
