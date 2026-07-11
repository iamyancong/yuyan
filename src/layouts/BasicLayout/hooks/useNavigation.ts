import { ref, computed } from 'vue';
import { useRoute, useRouter, NavigationFailureType, isNavigationFailure } from 'vue-router';
import { routes } from '@/router';
import { getMenuIcon } from '../constant';

/**
 * 布局导航与菜单状态管理的 Hook
 * @returns 包含当前选中菜单、标题、菜单项、路由加载状态以及跳转处理逻辑
 */
export function useNavigation() {
  const route = useRoute();
  const router = useRouter();
  
  /** 路由切换加载状态 */
  const routeLoading = ref(false);
  
  /** 路由跳转顺序标识，用于解决竞态问题 */
  let navigationSequence = 0;

  /** 当前选中的菜单项 Key 数组 */
  const selectedKeys = computed(() => [route.path]);

  /** 当前页面标题，从路由 meta 提取，默认为 '概览' */
  const title = computed(() => (route.meta?.title as string) || '概览');

  /** 根路由配置 */
  const rootRoute = routes.find((r) => r.path === '/');
  
  /** 经过过滤后的有效菜单路由 */
  const rawMenuRoutes = (rootRoute?.children || []).filter(
    (r) => !(r as any).redirect && (r.meta as any)?.title
  );

  /** 供 A Menu 渲染使用的菜单项列表 */
  const menuItems = computed(() =>
    rawMenuRoutes.map((r) => ({
      key: r.path as string,
      label: (r.meta as any).title as string,
      icon: getMenuIcon(r.name as string),
    }))
  );

  /**
   * 路由切换失败处理函数
   * @param error 路由切换错误对象
   */
  const handleNavigationError = (error: unknown) => {
    if (
      isNavigationFailure(error, NavigationFailureType.cancelled) ||
      isNavigationFailure(error, NavigationFailureType.duplicated)
    ) {
      return;
    }

    if (import.meta.env.DEV) {
      console.warn('路由切换失败', error);
    }
  };

  /**
   * 安全地切换到目标路由路径，并展示加载反馈遮罩
   * @param path 目标路由路径
   */
  const navigateToPath = async (path: string) => {
    if (!path || path === route.path) return;

    const currentNavigation = ++navigationSequence;
    routeLoading.value = true;
    try {
      await router.push(path);
    } finally {
      if (currentNavigation === navigationSequence) {
        routeLoading.value = false;
      }
    }
  };

  /**
   * 菜单项点击事件回调
   * @param param0 菜单点击参数，包含 key 属性
   */
  const onMenuClick = ({ key }: { key: string }) => {
    void navigateToPath(key).catch(handleNavigationError);
  };

  /**
   * 返回首页
   */
  const goHome = () => {
    void navigateToPath('/dashboard').catch(handleNavigationError);
  };

  return {
    selectedKeys,
    title,
    menuItems,
    routeLoading,
    onMenuClick,
    goHome,
    navigateToPath,
    handleNavigationError,
  };
}
