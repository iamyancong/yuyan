/** 中央读取恢复的默认退避间隔，快速失败时也覆盖 20 秒停机窗口。 */
export const CENTRAL_RETRY_DELAYS = [1000, 2000, 4000, 6000, 8000];

/** 判断是否为主动取消，取消不应被展示为服务故障。 */
export const isReadCancelled = (error: unknown): boolean => {
  const value = error as { name?: string; code?: string } | null;
  return value?.name === 'AbortError' || value?.code === 'ERR_CANCELED';
};

/** 仅识别可恢复的连接和读取错误，不重试认证、权限或业务错误。 */
export const isRecoverableReadError = (error: unknown): boolean => {
  if (isReadCancelled(error)) return false;
  const value = error as { response?: { status?: number }; status?: number; code?: string; name?: string; message?: string } | null;
  const status = value?.response?.status ?? value?.status;
  if (status) return [408, 500, 502, 503, 504].includes(status);
  return (
    ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'central_unavailable', 'READ_TIMEOUT'].includes(value?.code || '') ||
    (value?.name === 'TypeError' && /fetch|network|load failed|terminated/i.test(value.message || ''))
  );
};

/** 可取消的退避等待；结束后清理监听器。 */
export const waitForReadRetry = (delay: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delay);
    signal.addEventListener('abort', cancel, { once: true });
  });

/** 读取恢复参数；仅允许传入无副作用的查询。 */
export interface ReadRecoveryOptions {
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number) => void;
  delays?: number[];
  budgetMs?: number;
  requestTimeoutMs?: number;
}

/** 单次读取使用独立超时信号，避免请求悬挂使恢复预算失效。 */
const readWithTimeout = async <T>(read: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeout: number): Promise<T> => {
  parent.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  parent.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('中央读取超时'), { code: 'READ_TIMEOUT' })), timeout);
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([read(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
};

/** 在有限预算内恢复中央只读请求，绝不重放发布或上传操作。 */
export async function recoverCentralRead<T>(read: (signal: AbortSignal) => Promise<T>, options: ReadRecoveryOptions = {}): Promise<T> {
  const signal = options.signal ?? new AbortController().signal;
  const delays = options.delays ?? CENTRAL_RETRY_DELAYS;
  let deadline = Infinity;
  let attempt = 0;
  while (true) {
    signal.throwIfAborted();
    try {
      return await readWithTimeout(read, signal, Math.min(options.requestTimeoutMs ?? 5000, deadline - Date.now()));
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (!isRecoverableReadError(error)) throw error;
      if (!Number.isFinite(deadline)) deadline = Date.now() + (options.budgetMs ?? 30000);
      const delay = delays[attempt];
      if (delay === undefined || Date.now() + delay >= deadline) throw error;
      attempt += 1;
      options.onRetry?.(error, attempt);
      await waitForReadRetry(delay, signal);
    }
  }
}
