import { onScopeDispose, ref, watch, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { registerCentralDataRefreshHandler } from '@/services/centralDataRefresh';
import type { NginxDeployTabKey, RefreshActiveTabOptions } from '../types';
import { getErrorMessage } from '../utils';

import { useNginxDeployContext } from './useNginxDeployContext';

/** 部署中心生命周期 Hook 参数 */
interface UseNginxDeployLifecycleParams {
  authState?: Readonly<Ref<{ accountId?: string; teamId?: string; isAuthenticated?: boolean }>>;
  isLoggedIn?: Ref<boolean>;
  isAuthReady?: () => boolean;
  ensureLoggedIn?: () => boolean;
  initAuthCheck?: () => Promise<boolean>;
  openLoginModal?: () => void;
  refreshTargetList?: () => Promise<void>;
  refreshServerList?: () => Promise<void>;
  refreshRecordList?: (options?: RefreshActiveTabOptions) => Promise<void>;
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

  const loading = ref(false);
  const refreshError = ref('');
  const activeTabKey = ref<NginxDeployTabKey>('targets');
  const tabLoadedFlags = ref<Record<NginxDeployTabKey, boolean>>({
    targets: false,
    servers: false,
    records: false,
  });
  let activeRefreshSequence = 0;

  /**
   * 展示自动加载中央部署数据时的真实错误。
   * @param error 请求错误
   */
  const reportRefreshError = (error: unknown) => {
    message.error(`中央部署数据加载失败：${getErrorMessage(error)}`);
  };

  /** 清空当前页面所有数据和临时态 */
  const clearData = () => {
    activeRefreshSequence += 1;
    loading.value = false;
    refreshError.value = '';
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
    const refreshSequence = ++activeRefreshSequence;
    const tabKey = activeTabKey.value;
    if (options.resetRecordsPage) {
      resetRecordPage();
      tabLoadedFlags.value.records = false;
    }
    const hasCachedData = tabLoadedFlags.value[tabKey];
    const shouldShowLoading = Boolean(options.force || !hasCachedData);

    if (shouldShowLoading) {
      loading.value = true;
    }
    if (refreshSequence === activeRefreshSequence) {
      refreshError.value = '';
    }
    try {
      if (tabKey === 'servers') {
        await refreshServerList();
      } else if (tabKey === 'records') {
        await refreshRecordList(options);
      } else {
        await Promise.all([refreshServerList(), refreshTargetList()]);
      }
      if (refreshSequence === activeRefreshSequence) {
        tabLoadedFlags.value[tabKey] = true;
      }
    } catch (error) {
      if (refreshSequence === activeRefreshSequence) {
        refreshError.value = getErrorMessage(error);
      }
      throw error;
    } finally {
      if (shouldShowLoading && refreshSequence === activeRefreshSequence) {
        loading.value = false;
      }
    }
  };

  /**
   * 切换页面 Tab：已缓存的 Tab 立即展示，首次进入在下一动画帧调度拉数，确保点击反馈与动画不掉帧。
   * @param key Tab Key
   */
  const handleTabChange = (key: string | number) => {
    const nextKey = String(key) as NginxDeployTabKey;
    activeTabKey.value = ['targets', 'servers', 'records'].includes(nextKey) ? nextKey : 'targets';
    if (tabLoadedFlags.value[nextKey]) {
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void refreshActiveTab().catch(reportRefreshError);
      });
    });
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
        reportRefreshError(error);
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
    (Object.keys(tabLoadedFlags.value) as NginxDeployTabKey[]).forEach((key) => {
      if (key !== excludeKey) {
        tabLoadedFlags.value[key] = false;
      }
    });
  };

  watch(() => [
    isLoggedIn.value ? 'logged-in' : 'logged-out',
    authState?.value?.accountId || '',
    authState?.value?.teamId || '',
  ].join('|'), (newIdentity, oldIdentity) => {
    if (!isLoggedIn.value) {
      clearData();
      return;
    }
    if (newIdentity !== oldIdentity && isAuthReady()) {
      clearData();
      void refreshActiveTab().catch(reportRefreshError);
    }
  });

  const unregisterCentralRefresh = registerCentralDataRefreshHandler(() => refreshActiveTab({ force: true }));
  onScopeDispose(unregisterCentralRefresh);

  return {
    loading,
    refreshError,
    activeTabKey,
    tabLoadedFlags,
    clearData,
    clearTabCache,
    refreshActiveTab,
    handleTabChange,
    initPage,
  };
}
