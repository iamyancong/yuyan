import { ref, watch, type Ref } from 'vue';
import type { NginxDeployTabKey, RefreshActiveTabOptions } from '../types';

import { useNginxDeployContext } from './useNginxDeployContext';

/** 部署中心生命周期 Hook 参数 */
interface UseNginxDeployLifecycleParams {
  isLoggedIn?: Ref<boolean>;
  isAuthReady?: () => boolean;
  ensureLoggedIn?: () => boolean;
  initAuthCheck?: () => Promise<boolean>;
  openLoginModal?: () => void;
  refreshTargetList?: () => Promise<void>;
  refreshServerList?: () => Promise<void>;
  refreshRecordList?: () => Promise<void>;
  resetRecordPage?: () => void;
  clearDataHandlers?: Array<() => void>;
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
  const activeTabKey = ref<NginxDeployTabKey>('targets');

  /** 清空当前页面所有数据和临时态 */
  const clearData = () => {
    clearDataHandlers.forEach((handler) => handler());
  };

  /**
   * 刷新当前激活 Tab 数据。
   * @param options 刷新选项
   */
  const refreshActiveTab = async (options: RefreshActiveTabOptions = {}) => {
    if (!ensureLoggedIn()) return;
    if (options.resetRecordsPage) resetRecordPage();
    loading.value = true;
    try {
      if (activeTabKey.value === 'servers') {
        await refreshServerList();
        return;
      }
      if (activeTabKey.value === 'records') {
        await refreshRecordList();
        return;
      }
      await refreshTargetList();
    } finally {
      loading.value = false;
    }
  };

  /**
   * 切换页面 Tab 后重新查询当前 Tab 数据。
   * @param key Tab Key
   */
  const handleTabChange = async (key: string | number) => {
    const nextKey = String(key) as NginxDeployTabKey;
    activeTabKey.value = ['targets', 'servers', 'records'].includes(nextKey) ? nextKey : 'targets';
    await refreshActiveTab();
  };

  /**
   * 初始化页面认证并刷新首屏数据。
   * @returns 当前是否已登录
   */
  const initPage = async () => {
    const loggedIn = await initAuthCheck();
    if (loggedIn) {
      await refreshActiveTab();
      return true;
    }
    openLoginModal();
    return false;
  };

  watch(isLoggedIn, (newValue, oldValue) => {
    if (!newValue) {
      clearData();
      return;
    }
    if (newValue && !oldValue && isAuthReady()) {
      void refreshActiveTab();
    }
  });

  return {
    loading,
    activeTabKey,
    clearData,
    refreshActiveTab,
    handleTabChange,
    initPage,
  };
}
