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

/** 后端服务状态探测的前端并发上限，避免一次刷新瞬间打出大量 SSH 探测请求 */
export const BACKEND_SERVICE_STATUS_CONCURRENCY = 3;

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

/** 判断部署实时事件流（SSE）是否在当前服务端或代理环境不受支持。 */
export function isTargetRuntimeSseUnsupported(error: unknown): boolean {
  const candidate = error as { response?: { status?: number }; status?: number } | null;
  const status = Number(candidate?.response?.status || candidate?.status || 0);
  return [404, 405, 501].includes(status);
}

/**
 * 判断当前是否需要启动定时器轮询（当 SSE 实时连接已就绪时暂停定时轮询，实现零轮询开销）。
 * @param state 当前运行态控制状态
 * @returns 是否应当安排下一次定时轮询
 */
export function shouldScheduleRuntimePoll(state: {
  pollingEnabled: boolean;
  pageHidden: boolean;
  targetCount: number;
  sseConnected: boolean;
}): boolean {
  if (!state.pollingEnabled || state.pageHidden || state.targetCount <= 0) return false;
  if (state.sseConnected) return false;
  return true;
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

/**
 * 解析发布任务停止态（手动取消 vs 排队超时）的标题与说明文案。
 * @param options 停止态上下文
 * @returns 标题与说明文案
 */
export function resolveStoppedDeployProgressPresentation(options: {
  stopReason?: string;
  message?: string;
  stageMessage?: string;
  currentTitle?: string;
  defaultStoppedDetail?: string;
}): { isQueueTimeout: boolean; title: '排队超时' | '已停止'; detail: string } {
  const isQueueTimeout =
    options.stopReason === 'timeout' ||
    options.stageMessage === '排队超时已停止' ||
    options.currentTitle === '排队超时';
  const rawDetail = String(options.message || '').trim();
  const fallbackDetail = isQueueTimeout
    ? '排队超时，未产生任何变更'
    : options.defaultStoppedDetail || '发布任务已停止，未进入上传产物阶段。';
  return {
    isQueueTimeout,
    title: isQueueTimeout ? '排队超时' : '已停止',
    detail: rawDetail || fallbackDetail,
  };
}
