/**
 * 发布进度流（NDJSON）合并写入。
 * @description 构建期间 vite / pnpm 每秒可输出上千行日志，原实现每行对每个订阅者各调用一次 res.write，
 * 多构建并发时会产生大量小块写入与系统调用，挤占中央事件循环，导致列表接口排队超时。
 * 这里按响应维度缓冲日志行，在短窗口内合并为一次写入：
 * - 顺序不变：同一响应只有一个缓冲区，非日志事件（阶段、结果、错误）先刷出缓冲再立即写出；
 * - 不丢行：响应 end 前、关闭时、进程退出前均会刷出缓冲；
 * - 有界：缓冲超过字节上限立即刷出。
 */

/** 日志行合并窗口（毫秒），对用户几乎无感知。 */
export const PROGRESS_STREAM_FLUSH_MS = Math.max(0, Number(process.env.YUYAN_PROGRESS_STREAM_FLUSH_MS ?? 100));

/** 单个响应缓冲上限（字节），超过立即刷出。 */
export const PROGRESS_STREAM_MAX_BUFFER_BYTES = 256 * 1024;

/** @type {WeakMap<object, { chunks: string[], bytes: number, timer: ReturnType<typeof setTimeout>|null }>} */
const buffers = new WeakMap();

/** 仍持有缓冲的响应，用于进程退出前统一刷出。 */
const pendingResponses = new Set();

const stats = { lines: 0, writes: 0 };

/** 响应是否仍可写。 */
const isWritable = (res) => !res.writableEnded && !res.destroyed;

/** 直接写出，吞掉单个客户端的写入异常。 */
function safeWrite(res, text) {
  try {
    if (isWritable(res)) {
      res.write(text);
      stats.writes += 1;
    }
  } catch {
    /** 单个客户端写入异常不影响其他订阅者 */
  }
}

/**
 * 立即刷出某个响应的缓冲日志。
 * @param {object} res Express 响应
 */
export function flushProgressStream(res) {
  const state = buffers.get(res);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  pendingResponses.delete(res);
  if (!state.chunks.length) return;
  const text = state.chunks.join('');
  state.chunks = [];
  state.bytes = 0;
  safeWrite(res, text);
}

/** 首次缓冲时接管 res.end 与关闭事件，保证结束前刷出。 */
function getState(res) {
  let state = buffers.get(res);
  if (state) return state;
  state = { chunks: [], bytes: 0, timer: null };
  buffers.set(res, state);
  const originalEnd = typeof res.end === 'function' ? res.end.bind(res) : null;
  if (originalEnd) {
    res.end = (...args) => {
      flushProgressStream(res);
      return originalEnd(...args);
    };
  }
  res.once?.('close', () => {
    const current = buffers.get(res);
    if (current?.timer) clearTimeout(current.timer);
    pendingResponses.delete(res);
  });
  return state;
}

/**
 * 写出一个进度事件。
 * @param {object} res Express 响应
 * @param {object} event 进度事件
 * @param {{ flushMs?: number }} [options] 合并窗口（测试使用）
 */
export function writeProgressStreamEvent(res, event, options = {}) {
  if (!res || !isWritable(res)) return;
  let line;
  try {
    line = `${JSON.stringify(event)}\n`;
  } catch {
    return;
  }
  stats.lines += 1;
  const flushMs = options.flushMs ?? PROGRESS_STREAM_FLUSH_MS;
  const state = getState(res);
  if (event?.type !== 'log' || flushMs <= 0) {
    state.chunks.push(line);
    flushProgressStream(res);
    return;
  }
  state.chunks.push(line);
  state.bytes += line.length;
  if (state.bytes >= PROGRESS_STREAM_MAX_BUFFER_BYTES) {
    flushProgressStream(res);
    return;
  }
  if (!state.timer) {
    pendingResponses.add(res);
    state.timer = setTimeout(() => flushProgressStream(res), flushMs);
    state.timer.unref?.();
  }
}

/** 刷出全部缓冲（进程退出前调用）。 */
export function flushAllProgressStreams() {
  [...pendingResponses].forEach((res) => flushProgressStream(res));
}

/** 合并写入统计：行数与实际 write 次数。 */
export function getProgressStreamStats() {
  return { ...stats, pendingResponses: pendingResponses.size, flushMs: PROGRESS_STREAM_FLUSH_MS };
}

process.once('beforeExit', flushAllProgressStreams);
