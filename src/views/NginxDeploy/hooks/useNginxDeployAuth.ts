import { computed } from 'vue';
import { useAuth, waitForAuthReady } from '@/composables/useAuth';

/**
 * 管理部署中心认证检查与登录弹窗兜底。
 * @returns 认证状态、初始化检查和登录校验方法
 */
export function useNginxDeployAuth() {
  const { authState, userName, isLoggedIn, authLoading } = useAuth();
  const userRole = computed(() => authState.value?.role || '');
  let authReady = false;

  /** 打开全局登录弹窗 */
  const openLoginModal = () => {
    window.dispatchEvent(new CustomEvent('show-login-modal'));
  };

  /**
   * 等待认证初始化完成。
   * @returns 当前是否已登录
   */
  const initAuthCheck = async () => {
    // watch 驱动等待认证初始化完成，替代原先的忙等轮询
    await waitForAuthReady();
    authReady = true;
    return isLoggedIn.value;
  };

  /**
   * 确保当前已登录，否则执行未授权清理并打开登录弹窗。
   * @param onUnauthorized 未登录时的数据清理回调
   * @returns 是否允许继续执行
   */
  const ensureLoggedIn = (onUnauthorized?: () => void) => {
    if (isLoggedIn.value) return true;
    onUnauthorized?.();
    openLoginModal();
    return false;
  };

  /**
   * 获取认证初始化是否已完成。
   * @returns 是否完成初始化检查
   */
  const isAuthReady = () => authReady;

  return {
    authState,
    userName,
    userRole,
    isLoggedIn,
    authLoading,
    openLoginModal,
    initAuthCheck,
    ensureLoggedIn,
    isAuthReady,
  };
}
