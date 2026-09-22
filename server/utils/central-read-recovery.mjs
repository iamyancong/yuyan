/** 仅重试中央只读请求，等待窗口覆盖 20 秒连接抖动。 */
export async function recoverCentralOperationRead(
  read,
  { signal, delays = [1000, 2000, 4000, 6000, 8000], timeoutMs = 5000, budgetMs = 30000 } = {}
) {
  let deadline = Infinity;
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = await read(requestSignal);
      if (!result || typeof result.status !== 'string') {
        throw Object.assign(new Error('中央未返回有效任务状态'), { code: 'central_unavailable' });
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const status = error.status || error.details?.status;
      const retryable = timeout.aborted || (status ? [408, 500, 502, 503, 504].includes(status) : error.code === 'central_unavailable');
      if (!retryable) throw error;
      if (!Number.isFinite(deadline)) deadline = Date.now() + budgetMs;
      const delay = delays[attempt];
      if (delay === undefined || Date.now() + delay >= deadline) {
        throw Object.assign(new Error('中央任务结果暂时无法确认，请恢复连接后按任务 ID 核实'), {
          code: 'central_result_unconfirmed',
          retryable: true,
        });
      }
      await new Promise((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', cancel);
          resolve();
        }, delay);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    }
  }
}
