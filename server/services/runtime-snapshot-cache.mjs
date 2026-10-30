/**
 * 运行态聚合快照短缓存。
 * @description SSE 断线重连风暴时，每个连接都会现算一次团队运行态快照（查库 + 遍历进程内任务）。
 * 以「团队 + 事件修订号」为键缓存 1.5 秒并合并进行中的计算：修订号变化（有新的运行态变更）立即失效，
 * 因此不会返回已知过期的数据。
 */

/** 默认缓存时长（毫秒）。 */
export const RUNTIME_SNAPSHOT_CACHE_TTL_MS = Math.max(0, Number(process.env.YUYAN_RUNTIME_SNAPSHOT_CACHE_MS ?? 1500));

/**
 * 创建快照缓存。
 * @param {{ ttlMs?: number, now?: () => number, maxEntries?: number }} [options] 选项
 */
export function createRuntimeSnapshotCache(options = {}) {
  const ttlMs = options.ttlMs ?? RUNTIME_SNAPSHOT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 64;
  /** @type {Map<string, { revision: number, expiresAt: number, value?: any, pending?: Promise<any> }>} */
  const entries = new Map();
  const stats = { hits: 0, misses: 0, joined: 0 };

  /**
   * 读取或计算快照。
   * @param {string} teamId 团队
   * @param {number} revision 当前事件修订号
   * @param {() => Promise<any>} compute 计算函数
   */
  const get = async (teamId, revision, compute) => {
    const key = String(teamId || 'legacy-team');
    const entry = entries.get(key);
    if (entry && entry.revision === revision) {
      if (entry.pending) {
        stats.joined += 1;
        return entry.pending;
      }
      if (entry.expiresAt > now()) {
        stats.hits += 1;
        return entry.value;
      }
    }
    stats.misses += 1;
    if (ttlMs <= 0) return compute();
    const next = { revision, expiresAt: 0, pending: null };
    next.pending = Promise.resolve()
      .then(compute)
      .then((value) => {
        if (entries.get(key) === next) {
          next.value = value;
          next.expiresAt = now() + ttlMs;
          next.pending = null;
        }
        return value;
      })
      .catch((error) => {
        if (entries.get(key) === next) entries.delete(key);
        throw error;
      });
    entries.delete(key);
    entries.set(key, next);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return next.pending;
  };

  return { get, clear: () => entries.clear(), getStats: () => ({ ...stats, size: entries.size, ttlMs }) };
}
