/**
 * 中央服务运行指标
 * @description 进程内轻量指标采集（无第三方依赖、内存有界），用于定位多人使用时的卡顿来源：
 * - HTTP：按路由模板统计次数、错误数、p50/p95/max 耗时，慢请求打印告警；
 * - 外部依赖：GitLab 请求、SSH 状态探测的次数、失败、超时与耗时；
 * - 计数器：缓存命中等离散事件。
 * 路由按 Express 模板聚合（如 /targets/:id），不记录具体 ID、参数或正文，避免泄露业务数据。
 */

/** 每个指标保留的最近耗时样本数，用于计算分位数 */
const SAMPLE_SIZE = 200;

/** 指标条目上限，防止异常路由撑爆内存 */
const MAX_SERIES = 300;

/** 慢请求告警阈值（毫秒） */
export const SLOW_REQUEST_THRESHOLD_MS = Number(process.env.YUYAN_SLOW_REQUEST_MS || 1500);

/** 进程启动时间 */
const startedAt = new Date().toISOString();

/**
 * 耗时序列
 * @typedef {Object} TimingSeries
 * @property {number} count 总次数
 * @property {number} errors 失败次数
 * @property {number} timeouts 超时次数
 * @property {number} totalMs 累计耗时
 * @property {number} maxMs 最大耗时
 * @property {number[]} samples 最近耗时样本（环形）
 * @property {number} cursor 环形写入位置
 */

/** @type {Map<string, TimingSeries>} */
const timings = new Map();

/** @type {Map<string, number>} */
const counters = new Map();

/**
 * 获取或创建耗时序列。
 * @param {string} name 指标名称
 * @returns {TimingSeries|null} 序列；超过上限返回 null
 */
function getSeries(name) {
  let series = timings.get(name);
  if (series) return series;
  if (timings.size >= MAX_SERIES) return null;
  series = { count: 0, errors: 0, timeouts: 0, totalMs: 0, maxMs: 0, samples: [], cursor: 0 };
  timings.set(name, series);
  return series;
}

/**
 * 记录一次耗时。
 * @param {string} name 指标名称，如 `http GET /targets`、`gitlab`、`ssh.status_probe`
 * @param {number} durationMs 耗时
 * @param {{ error?: boolean, timeout?: boolean }} [outcome] 结果
 */
export function recordTiming(name, durationMs, outcome = {}) {
  const series = getSeries(name);
  if (!series) return;
  const duration = Math.max(0, Number(durationMs) || 0);
  series.count += 1;
  series.totalMs += duration;
  series.maxMs = Math.max(series.maxMs, duration);
  if (outcome.error) series.errors += 1;
  if (outcome.timeout) series.timeouts += 1;
  if (series.samples.length < SAMPLE_SIZE) {
    series.samples.push(duration);
  } else {
    series.samples[series.cursor] = duration;
    series.cursor = (series.cursor + 1) % SAMPLE_SIZE;
  }
}

/**
 * 计数器自增。
 * @param {string} name 计数器名称
 * @param {number} [value] 增量
 */
export function incrementCounter(name, value = 1) {
  if (!counters.has(name) && counters.size >= MAX_SERIES) return;
  counters.set(name, (counters.get(name) || 0) + value);
}

/**
 * 计算分位数。
 * @param {number[]} sorted 升序样本
 * @param {number} ratio 分位（0-1）
 * @returns {number} 分位值
 */
function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * 生成 HTTP 指标名称（按路由模板聚合）。
 * @param {import('express').Request} req Express 请求
 * @returns {string} 指标名称
 */
function resolveHttpSeriesName(req) {
  const routePath = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
  return `http ${req.method} ${routePath}`;
}

/**
 * HTTP 指标中间件：响应结束时按路由模板记录耗时与状态，慢请求打印告警。
 * @param {import('express').Request} req Express 请求
 * @param {import('express').Response} res Express 响应
 * @param {import('express').NextFunction} next 后续中间件
 */
export function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const name = resolveHttpSeriesName(req);
    recordTiming(name, durationMs, { error: res.statusCode >= 500 });
    /** 流式发布、日志等长连接接口天然耗时较长，不计入慢请求告警 */
    const isStream = String(res.getHeader('Content-Type') || '').includes('ndjson') || String(res.getHeader('Content-Type') || '').includes('event-stream');
    if (!isStream && durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      console.warn(`[metrics] 慢请求 ${name} ${res.statusCode} ${durationMs.toFixed(0)}ms`);
    }
  });
  next();
}

/**
 * 包装异步任务并记录耗时与结果。
 * @template T
 * @param {string} name 指标名称
 * @param {() => Promise<T>} task 异步任务
 * @returns {Promise<T>} 任务结果
 */
export async function measure(name, task) {
  const start = process.hrtime.bigint();
  try {
    const result = await task();
    recordTiming(name, Number(process.hrtime.bigint() - start) / 1e6);
    return result;
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || /timeout|超时/i.test(String(error?.message || ''));
    recordTiming(name, Number(process.hrtime.bigint() - start) / 1e6, { error: true, timeout });
    throw error;
  }
}

/**
 * 导出指标快照。
 * @param {Record<string, unknown>} [extra] 额外的运行时状态（队列长度、缓存大小等）
 * @returns {Object} 指标快照，耗时按 p95 降序排列
 */
export function getMetricsSnapshot(extra = {}) {
  const series = Array.from(timings.entries()).map(([name, item]) => {
    const sorted = [...item.samples].sort((left, right) => left - right);
    return {
      name,
      count: item.count,
      errors: item.errors,
      timeouts: item.timeouts,
      avgMs: item.count ? Math.round(item.totalMs / item.count) : 0,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
      maxMs: Math.round(item.maxMs),
    };
  });
  series.sort((left, right) => right.p95Ms - left.p95Ms);
  const memory = process.memoryUsage();
  return {
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
    timings: series,
    counters: Object.fromEntries(counters),
    ...extra,
  };
}

/** 重置全部指标（测试使用） */
export function resetMetrics() {
  timings.clear();
  counters.clear();
}
