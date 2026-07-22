/** 部署运行态无活动任务时的轮询间隔。 */
export const TARGET_RUNTIME_IDLE_INTERVAL = 15_000;

/** 部署运行态存在活动任务时的轮询间隔。 */
export const TARGET_RUNTIME_ACTIVE_INTERVAL = 3_000;

/** 部署运行态失败退避初始间隔。 */
export const TARGET_RUNTIME_ERROR_BASE_INTERVAL = 5_000;

/** 部署运行态失败退避最大间隔。 */
export const TARGET_RUNTIME_ERROR_MAX_INTERVAL = 30_000;

/** 旧服务端逐目标回退模式最大并发数。 */
export const TARGET_RUNTIME_FALLBACK_CONCURRENCY = 4;

/**
 * 计算下一次部署运行态刷新间隔。
 * @param hasRunningTask 是否存在运行任务
 * @param consecutiveFailures 连续失败次数
 * @param legacyFallback 是否处于旧服务端逐目标回退模式
 * @returns 下一次刷新间隔毫秒数
 */
export function getTargetRuntimePollDelay(
  hasRunningTask: boolean,
  consecutiveFailures: number,
  legacyFallback = false,
): number {
  if (consecutiveFailures > 0) {
    return Math.min(
      TARGET_RUNTIME_ERROR_MAX_INTERVAL,
      TARGET_RUNTIME_ERROR_BASE_INTERVAL * 2 ** Math.max(0, consecutiveFailures - 1),
    );
  }
  if (legacyFallback) return TARGET_RUNTIME_IDLE_INTERVAL;
  return hasRunningTask ? TARGET_RUNTIME_ACTIVE_INTERVAL : TARGET_RUNTIME_IDLE_INTERVAL;
}

/** 判断聚合运行态接口是否尚未在旧服务端实现。 */
export function isTargetRuntimeBatchUnsupported(error: unknown): boolean {
  const candidate = error as { response?: { status?: number }; status?: number } | null;
  const status = Number(candidate?.response?.status || candidate?.status || 0);
  return [404, 501].includes(status);
}

/**
 * 以固定并发数映射数组并保持结果顺序。
 * @param items 输入数组
 * @param concurrency 最大并发数
 * @param worker 单项异步处理器
 * @returns 与输入顺序一致的结果
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, runWorker));
  return results;
}
