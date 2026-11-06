/** 切换 Tab 时的刷新方式：force 展示 loading 真刷新；silent 保留缓存后台静默刷新；none 直接用缓存。 */
export type TabRefreshDecision = 'force' | 'silent' | 'none';

/** 同一 Tab 缓存在该时长内被再次切回时不再静默刷新，避免来回切换反复请求和重绘大表格。 */
export const TAB_SILENT_REFRESH_MIN_INTERVAL_MS = 10_000;

/** Tab 刷新决策入参 */
export interface TabRefreshDecisionInput {
  /** 该 Tab 是否已成功加载过（筛选变更、身份切换会把它重置为 false） */
  loaded: boolean;
  /** 该 Tab 上次成功加载时的查询 key */
  snapshotKey?: string;
  /** 当前查询 key（Tab + 全部筛选条件） */
  currentKey: string;
  /** 该 Tab 上次成功加载的时间戳（毫秒）；0 / 缺省表示已被其他操作标记过期 */
  loadedAt?: number;
  /** 当前时间戳（毫秒） */
  now: number;
  /** 用户主动点击刷新 */
  manual?: boolean;
  /** 静默刷新最小间隔，默认 TAB_SILENT_REFRESH_MIN_INTERVAL_MS */
  minIntervalMs?: number;
}

/**
 * 决定切换到某个 Tab 时如何刷新。
 * 1. 首次进入、筛选条件变化、用户主动刷新：force；
 * 2. 已加载且筛选未变：直接用缓存，缓存较旧（或被其他 Tab 的写操作标记过期）时后台静默刷新一次。
 * @param input 决策入参
 * @returns 刷新方式
 */
export function decideTabRefresh(input: TabRefreshDecisionInput): TabRefreshDecision {
  if (input.manual) return 'force';
  if (!input.loaded || input.snapshotKey === undefined) return 'force';
  if (input.snapshotKey !== input.currentKey) return 'force';
  const minInterval = input.minIntervalMs ?? TAB_SILENT_REFRESH_MIN_INTERVAL_MS;
  const loadedAt = input.loadedAt ?? 0;
  if (loadedAt > 0 && input.now - loadedAt >= 0 && input.now - loadedAt < minInterval) return 'none';
  return 'silent';
}
