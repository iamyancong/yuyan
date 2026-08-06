/** 当前页面中央数据刷新处理器。 */
export type CentralDataRefreshHandler = () => Promise<void>;

/** 中央数据刷新结果。 */
export interface CentralDataRefreshResult {
  /** 本次实际执行的页面处理器数量。 */
  handlerCount: number;
}

const refreshHandlers = new Set<CentralDataRefreshHandler>();
let activeRefreshPromise: Promise<CentralDataRefreshResult> | null = null;

/**
 * 注册当前页面的中央数据刷新方法。
 * @param handler 页面刷新处理器
 * @returns 注销方法
 */
export function registerCentralDataRefreshHandler(handler: CentralDataRefreshHandler): () => void {
  refreshHandlers.add(handler);
  return () => refreshHandlers.delete(handler);
}

/**
 * 刷新当前页面已注册的中央数据，并等待全部真实请求完成。
 * @description 并发调用共享同一轮执行结果，避免重复点击产生重复请求。
 * @returns 刷新结果
 */
export async function refreshCentralData(): Promise<CentralDataRefreshResult> {
  if (activeRefreshPromise) return activeRefreshPromise;
  const handlers = [...refreshHandlers];
  const refreshPromise = Promise.all(handlers.map((handler) => handler()))
    .then(() => ({ handlerCount: handlers.length }));
  activeRefreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (activeRefreshPromise === refreshPromise) {
      activeRefreshPromise = null;
    }
  }
}
