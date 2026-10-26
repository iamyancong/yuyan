/**
 * 后端服务状态探测缓存与限流
 * @description 状态探测需要 SSH 到目标服务器，成本高且会被多人、多次刷新放大。本模块提供：
 * 1. 按目标的 TTL 缓存：同一目标在有效期内直接复用结果，与在线人数无关；
 * 2. 同目标并发合并：多个用户同时刷新只发起一次 SSH；
 * 3. 失败短期缓存：服务器不可达时退避，避免每次刷新都卡满 SSH 连接超时；
 * 4. 服务器级与全局并发上限：防止瞬时打满目标机 sshd 的 MaxStartups；
 * 5. 主动失效：部署、启停、回滚等会改变服务状态的操作完成后立即失效缓存。
 */

/** 成功结果缓存时长（毫秒） */
export const BACKEND_STATUS_TTL_MS = Number(process.env.YUYAN_BACKEND_STATUS_TTL_MS || 20_000);

/** 失败结果缓存时长（毫秒） */
export const BACKEND_STATUS_ERROR_TTL_MS = Number(process.env.YUYAN_BACKEND_STATUS_ERROR_TTL_MS || 10_000);

/** 单台服务器同时进行的探测 SSH 上限 */
export const BACKEND_STATUS_PER_SERVER_CONCURRENCY = Number(process.env.YUYAN_BACKEND_STATUS_PER_SERVER || 2);

/** 全局同时进行的探测 SSH 上限 */
export const BACKEND_STATUS_GLOBAL_CONCURRENCY = Number(process.env.YUYAN_BACKEND_STATUS_GLOBAL || 6);

/** 缓存最大条目数 */
const MAX_ENTRIES = 1000;

/** @type {Map<string, { value?: any, error?: unknown, expiresAt: number }>} */
const statusCache = new Map();

/** @type {Map<string, { generation: number, task: Promise<any> }>} */
const inflightProbes = new Map();

/** 目标缓存版本号：失效时递增，用于丢弃失效前发起、失效后才返回的旧探测结果 */
const cacheGenerations = new Map();

/**
 * 简单并发闸门。
 */
class ConcurrencyGate {
  /**
   * @param {number} limit 并发上限
   */
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    /** @type {Array<() => void>} */
    this.waiters = [];
  }

  /** 获取执行许可 */
  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  /** 释放执行许可 */
  release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 是否空闲 */
  get idle() {
    return this.active === 0 && this.waiters.length === 0;
  }
}

const globalGate = new ConcurrencyGate(BACKEND_STATUS_GLOBAL_CONCURRENCY);

/** @type {Map<string, ConcurrencyGate>} */
const serverGates = new Map();

/**
 * 生成缓存 Key。
 * @param {string} scope 数据隔离域（团队 ID）
 * @param {number|string} targetId 部署目标 ID
 * @returns {string} 缓存 Key
 */
function buildKey(scope, targetId) {
  return `${scope || 'default'}:${Number(targetId)}`;
}

/**
 * 读取目标的缓存版本号。
 * @param {string} key 缓存 Key
 * @returns {number} 版本号
 */
function getGeneration(key) {
  return cacheGenerations.get(key) || 0;
}

/**
 * 写入缓存并控制容量。
 * @param {string} key 缓存 Key
 * @param {{ value?: any, error?: unknown, expiresAt: number }} entry 缓存条目
 */
function writeCache(key, entry) {
  statusCache.delete(key);
  statusCache.set(key, entry);
  while (statusCache.size > MAX_ENTRIES) {
    statusCache.delete(statusCache.keys().next().value);
  }
}

/**
 * 在服务器级与全局并发上限内执行探测任务。
 * @template T
 * @param {number|string} serverId 服务器 ID
 * @param {() => Promise<T>} task 探测任务
 * @returns {Promise<T>} 任务结果
 */
export async function runWithProbeLimit(serverId, task) {
  const serverKey = String(serverId || 'unknown');
  let serverGate = serverGates.get(serverKey);
  if (!serverGate) {
    serverGate = new ConcurrencyGate(BACKEND_STATUS_PER_SERVER_CONCURRENCY);
    serverGates.set(serverKey, serverGate);
  }
  await serverGate.acquire();
  try {
    await globalGate.acquire();
    try {
      return await task();
    } finally {
      globalGate.release();
    }
  } finally {
    serverGate.release();
    if (serverGate.idle) serverGates.delete(serverKey);
  }
}

/**
 * 读取缓存的后端状态，未命中时执行探测（同目标并发合并）。
 * @template T
 * @param {{ scope: string, targetId: number|string, fresh?: boolean }} options 读取选项；fresh 为 true 时绕过 TTL 缓存
 * @param {() => Promise<T>} loader 实际探测函数
 * @returns {Promise<T & { cached?: boolean }>} 状态结果；命中缓存时 cached 为 true
 */
export async function getOrProbeBackendStatus(options, loader) {
  const key = buildKey(options.scope, options.targetId);
  if (!options.fresh) {
    const entry = statusCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      if (entry.error) throw entry.error;
      return { ...entry.value, cached: true };
    }
  }

  const generation = getGeneration(key);
  const inflight = inflightProbes.get(key);
  /** 只合并同一缓存版本的探测；失效后发起的请求需要拿到失效后的真实状态 */
  if (inflight && inflight.generation === generation) return inflight.task;

  const task = (async () => {
    try {
      /** 异步调用 loader，保证同步抛错时也先完成 inflight 登记，再由 finally 清理 */
      const value = await Promise.resolve().then(loader);
      if (getGeneration(key) === generation) {
        writeCache(key, { value, expiresAt: Date.now() + BACKEND_STATUS_TTL_MS });
      }
      return { ...value, cached: false };
    } catch (error) {
      if (getGeneration(key) === generation) {
        writeCache(key, { error, expiresAt: Date.now() + BACKEND_STATUS_ERROR_TTL_MS });
      }
      throw error;
    } finally {
      if (inflightProbes.get(key)?.generation === generation) inflightProbes.delete(key);
    }
  })();
  inflightProbes.set(key, { generation, task });
  return task;
}

/**
 * 主动失效目标状态缓存（部署、启停、回滚后调用）。
 * @param {string} scope 数据隔离域
 * @param {number|string} targetId 部署目标 ID
 */
export function invalidateBackendStatus(scope, targetId) {
  const key = buildKey(scope, targetId);
  statusCache.delete(key);
  cacheGenerations.set(key, getGeneration(key) + 1);
}

/**
 * 获取诊断信息（测试与指标使用）。
 * @returns {{ cached: number, inflight: number, globalActive: number, serverGates: number }} 诊断数据
 */
export function getBackendStatusCacheStats() {
  return {
    cached: statusCache.size,
    inflight: inflightProbes.size,
    globalActive: globalGate.active,
    serverGates: serverGates.size,
  };
}

/** 清空全部缓存（测试使用） */
export function resetBackendStatusCache() {
  statusCache.clear();
  inflightProbes.clear();
  cacheGenerations.clear();
}
