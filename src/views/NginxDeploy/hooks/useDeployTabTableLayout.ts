import { getCurrentInstance, onBeforeUnmount, watch } from 'vue';

/** 只读布尔 Ref（兼容 ref / computed / toRef） */
type ReadonlyBooleanRef = { readonly value: boolean };

/** Tab 表格布局同步入参 */
export interface UseDeployTabTableLayoutOptions {
  /** 当前 Tab 是否激活（支持 computed / toRef） */
  active: ReadonlyBooleanRef;
  /** useTableHeight 返回的高度重算方法 */
  recalculateHeight: () => void;
  /** 激活后额外回调（如拖拽残影清理） */
  onActivated?: () => void;
  /** 延迟重算时间（ms），默认 220ms 避开 a-tabs inkBar 动画与过渡期 */
  delayMs?: number;
}

/**
 * 在 Tab 重新激活后安全同步表格高度。
 * @description Tab 从 display:none 恢复可见后，需要等待 a-tabs 动画（180ms）和 DOM flex 布局完全稳定后再重新测量高度。
 * 严禁在过渡期强行触发底层表格 recalculate()，避免把表体与横向滚动条锁死在折叠高度。
 * @param options 布局同步配置
 */
export function useDeployTabTableLayout(options: UseDeployTabTableLayoutOptions) {
  const { delayMs = 220 } = options;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
  };

  const scheduleSync = () => {
    clearTimer();
    activeTimer = setTimeout(() => {
      activeTimer = null;
      if (!options.active.value) return;
      options.recalculateHeight();
      options.onActivated?.();
    }, delayMs);
  };

  watch(
    () => options.active.value,
    (isActive) => {
      if (isActive) {
        scheduleSync();
      } else {
        clearTimer();
      }
    },
    // 表格实例会保留，切回时容器从 display:none 恢复，需要再量一次高度
    { immediate: true }
  );

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      clearTimer();
    });
  }

  return {
    clearTimer,
  };
}
