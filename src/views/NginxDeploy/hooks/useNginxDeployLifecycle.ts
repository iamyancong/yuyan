import { computed, onActivated, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue';
import { registerCentralDataRefreshHandler } from '@/services/centralDataRefresh';
import type { NginxDeployTabKey, RefreshActiveTabOptions } from '../types';
import { getErrorMessage } from '../utils';

import { useCentralRefreshRecovery } from './useCentralRefreshRecovery';
import { useNginxDeployContext } from './useNginxDeployContext';

/** 部署中心生命周期 Hook 参数 */
interface UseNginxDeployLifecycleParams {
  authState?: Readonly<Ref<{ accountId?: string; teamId?: string; isAuthenticated?: boolean }>>;
  isLoggedIn?: Ref<boolean>;
  isAuthReady?: () => boolean;
  ensureLoggedIn?: () => boolean;
  initAuthCheck?: () => Promise<boolean>;
  openLoginModal?: () => void;
  refreshTargetList?: (signal?: AbortSignal) => Promise<void>;
  refreshServerList?: (signal?: AbortSignal) => Promise<void>;
  refreshRecordList?: (options?: RefreshActiveTabOptions) => Promise<void>;
  getRefreshKey?: () => string;
  resetRecordPage?: () => void;
  clearDataHandlers?: Array<() => void>;
  startTargetRuntimePolling?: () => void;
  stopTargetRuntimePolling?: () => void;
}

/**
 * 管理部署中心 Tab、全局刷新和登录状态联动。
 * @description 支持零传参的依赖注入，解耦原本扁平化的数据传递网络。
 * @param params 可选生命周期依赖
 * @returns 当前 Tab、loading 和页面初始化/刷新方法
 */
export function useNginxDeployLifecycle(params?: UseNginxDeployLifecycleParams) {
  const fallbackContext = useNginxDeployContext;
  const getContext = () => {
    try {
      return fallbackContext();
    } catch {
      return null;
    }
  };
  const context = getContext();

  const authState = params?.authState ?? context?.authState;
  const isLoggedIn = params?.isLoggedIn ?? context?.isLoggedIn!;
  const isAuthReady = () => {
    if (params?.isAuthReady) return params.isAuthReady();
    if (context?.isAuthReady) return context.isAuthReady();
    return false;
  };
  const ensureLoggedIn = params?.ensureLoggedIn ?? context?.ensureLoggedIn!;
  const initAuthCheck = async () => {
    if (params?.initAuthCheck) return params.initAuthCheck();
    if (context?.initAuthCheck) {
      await context.initAuthCheck();
      return context.isLoggedIn.value;
    }
    return false;
  };
  const openLoginModal = params?.openLoginModal ?? context?.openLoginModal!;
  const refreshTargetList = params?.refreshTargetList ?? context?.refreshTargetList!;
  const refreshServerList = params?.refreshServerList ?? context?.refreshServerList!;
  const refreshRecordList = params?.refreshRecordList ?? context?.refreshRecordList!;
  const resetRecordPage = params?.resetRecordPage ?? context?.resetRecordPage!;
  const clearDataHandlers = params?.clearDataHandlers ?? [];

  const recovery = useCentralRefreshRecovery();
  let pageActive = true;
  let refreshOnActivation = false;
  const showLoading = ref(false);
  const refreshError = computed(() => (recovery.error.value ? getErrorMessage(recovery.error.value) : ''));
  const activeTabKey = ref<NginxDeployTabKey>('targets');
  const tabLoadedFlags = ref<Record<NginxDeployTabKey, boolean>>({
    targets: false,
    servers: false,
    records: false,
  });
  const snapshotKeys = ref<Partial<Record<NginxDeployTabKey, string>>>({});
  const queryKey = () => `${activeTabKey.value}:${params?.getRefreshKey?.() || ''}`;
  const hasSnapshot = computed(() => snapshotKeys.value[activeTabKey.value] !== undefined);
  const loading = computed(() => recovery.status.value === 'loading' && showLoading.value && !hasSnapshot.value && !refreshError.value);
  const refreshInfo = computed(
    () =>
      recovery.status.value === 'loading' &&
      showLoading.value &&
      hasSnapshot.value &&
      snapshotKeys.value[activeTabKey.value] !== queryKey() &&
      !refreshError.value
  );
  const refreshWarning = computed(() => hasSnapshot.value && recovery.retrying.value);
  const refreshTitle = computed(() =>
    recovery.retrying.value
      ? hasSnapshot.value
        ? '中央连接暂时异常，正在重试'
        : '暂时无法加载中央部署数据，正在重试'
      : refreshInfo.value
        ? '正在更新筛选结果'
        : '中央数据刷新失败，请重试'
  );
  const refreshDescription = computed(() => {
    const stale = hasSnapshot.value
      ? snapshotKeys.value[activeTabKey.value] === queryKey()
        ? '当前显示上次加载的数据。'
        : '当前显示上次加载的数据，与当前筛选条件可能不一致。'
      : '';
    const exhausted = recovery.status.value === 'failed' ? '自动重试已停止。' : '';
    return `${stale}${exhausted}${refreshError.value}`;
  });

  /** 自动请求失败由页面状态统一展示，避免每轮重复弹错。 */
  const reportRefreshError = () => undefined;

  /** 清空当前页面所有数据和临时态 */
  const clearData = () => {
    recovery.reset();
    refreshOnActivation = false;
    showLoading.value = false;
    snapshotKeys.value = {};
    tabLoadedFlags.value = {
      targets: false,
      servers: false,
      records: false,
    };
    clearDataHandlers.forEach((handler) => handler());
  };

  /**
   * 刷新当前激活 Tab 数据。
   * @param options 刷新选项
   */
  const refreshActiveTab = async (options: RefreshActiveTabOptions = {}) => {
    if (!ensureLoggedIn()) return;
    if (options.resetRecordsPage) resetRecordPage();
    const tabKey = activeTabKey.value;
    const key = queryKey();
    showLoading.value = !options.silent;
    try {
      await recovery.run(key, async (signal) => {
        if (tabKey === 'servers') {
          await refreshServerList(signal);
        } else if (tabKey === 'records') {
          await refreshRecordList({ ...options, signal });
        } else {
          /** 等待两个读取都结束，避免失败重试与上轮未结束请求交叉回写。 */
          const results = await Promise.allSettled([refreshServerList(signal), refreshTargetList(signal)]);
          const failed = results.find((result) => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        }
        signal.throwIfAborted();
        tabLoadedFlags.value[tabKey] = true;
        snapshotKeys.value[tabKey] = queryKey();
      });
    } catch (error) {
      if (options.propagateError) throw error;
    }
  };

  let tabRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 切换页面 Tab。
   * 1. 立即更新 activeTabKey，驱动 Tab 标签高亮与底部指示线以 60fps 满帧极速滑动；
   * 2. 延迟 180ms（待 Tab 切换动效完全平稳落定）后再触发表格 loading 与后端数据拉取，
   *    彻底杜绝数据请求与响应式 patch 争抢动画黄金帧导致的掉帧与顿挫感。
   * @param key Tab Key
   */
  const handleTabChange = (key: string | number) => {
    recovery.cancel();
    const nextKey = String(key) as NginxDeployTabKey;
    activeTabKey.value = ['targets', 'servers', 'records'].includes(nextKey) ? nextKey : 'targets';

    if (tabRefreshTimer) {
      clearTimeout(tabRefreshTimer);
      tabRefreshTimer = null;
    }

    tabRefreshTimer = setTimeout(() => {
      tabRefreshTimer = null;
      void refreshActiveTab({ force: true }).catch(reportRefreshError);
    }, 180);
  };

  // 监听当前 Tab：非 targets Tab 自动休眠运行态轮询，切回 targets 时自动恢复
  watch(activeTabKey, (currentTab) => {
    if (currentTab === 'targets') {
      params?.startTargetRuntimePolling?.();
    } else {
      params?.stopTargetRuntimePolling?.();
    }
  });

  /**
   * 初始化页面认证并刷新首屏数据。
   * @returns 当前是否已登录
   */
  const initPage = async () => {
    const loggedIn = await initAuthCheck();
    if (loggedIn) {
      try {
        await refreshActiveTab();
        return true;
      } catch (error) {
        reportRefreshError();
        return false;
      }
    }
    openLoginModal();
    return false;
  };

  /**
   * 重置受过滤影响的 Tab 缓存标记。
   * @param excludeKey 排除的 Tab
   */
  const clearTabCache = (excludeKey?: NginxDeployTabKey) => {
    recovery.cancel();
    (Object.keys(tabLoadedFlags.value) as NginxDeployTabKey[]).forEach((key) => {
      if (key !== excludeKey) {
        tabLoadedFlags.value[key] = false;
      }
    });
  };

  watch(
    () => [isLoggedIn.value ? 'logged-in' : 'logged-out', authState?.value?.accountId || '', authState?.value?.teamId || ''].join('|'),
    (newIdentity, oldIdentity) => {
      if (!isLoggedIn.value) {
        clearData();
        return;
      }
      if (newIdentity !== oldIdentity && isAuthReady()) {
        clearData();
        void refreshActiveTab().catch(reportRefreshError);
      }
    },
    { flush: 'sync' }
  );

  /** 手动重试立即开始新一轮，取消原有退避计时。 */
  const retryActiveTab = () => {
    recovery.cancel();
    return refreshActiveTab({ force: true });
  };

  const unregisterCentralRefresh = registerCentralDataRefreshHandler(async () => {
    if (pageActive) await refreshActiveTab({ force: true, propagateError: true });
  });
  /** 停用页面时停止列表恢复，不影响独立的发布任务。 */
  const cancelRefresh = () => {
    recovery.cancel();
    if (tabRefreshTimer) clearTimeout(tabRefreshTimer);
    tabRefreshTimer = null;
    showLoading.value = false;
  };
  onDeactivated(() => {
    pageActive = false;
    /** cancel 会清除可用性状态，单独保留未完成查询或连接故障的恢复意图。 */
    refreshOnActivation = recovery.unavailable.value || recovery.status.value !== 'idle';
    cancelRefresh();
  });
  onActivated(() => {
    pageActive = true;
    const shouldRefresh = refreshOnActivation || recovery.unavailable.value;
    refreshOnActivation = false;
    if (shouldRefresh && isLoggedIn.value) void refreshActiveTab();
  });
  onScopeDispose(() => {
    cancelRefresh();
    unregisterCentralRefresh();
  });

  return {
    loading,
    refreshError,
    refreshWarning,
    refreshInfo,
    refreshTitle,
    refreshDescription,
    centralUnavailable: recovery.unavailable,
    activeTabKey,
    tabLoadedFlags,
    clearData,
    clearTabCache,
    refreshActiveTab,
    retryActiveTab,
    handleTabChange,
    initPage,
  };
}
