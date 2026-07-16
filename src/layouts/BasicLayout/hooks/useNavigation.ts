import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter, NavigationFailureType, isNavigationFailure } from 'vue-router';
import { routes } from '@/router';
import { getMenuIcon } from '../constant';

/** 布局与侧栏共享的路由切换状态 */
const routeLoading = ref(false);

/** 用户刚点击、尚未完成路由提交的目标路径 */
const pendingPath = ref('');

/** 全局路由跳转顺序标识，用于丢弃快速连点产生的旧导航 */
let navigationSequence = 0;

/**
 * 等待菜单选中态至少完成一次浏览器绘制。
 * @returns 下一帧绘制完成后的 Promise
 */
const waitForInteractionPaint = async () => {
  await nextTick();
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
};

/**
 * 布局导航与菜单状态管理的 Hook
 * @returns 包含当前选中菜单、标题、菜单项、路由加载状态以及跳转处理逻辑
 */
export function useNavigation() {
  const route = useRoute();
  const router = useRouter();

  /** 当前选中的菜单项 Key 数组 */
  const selectedKeys = computed(() => [pendingPath.value || route.path]);

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
   * 安全地切换到目标路由路径，并展示轻量加载进度
   * @param path 目标路由路径
   */
  const navigateToPath = async (path: string) => {
    if (!path || path === route.path) return;

    const currentNavigation = ++navigationSequence;
    pendingPath.value = path;
    routeLoading.value = true;
    try {
      await waitForInteractionPaint();
      if (currentNavigation !== navigationSequence) return;
      await router.push(path);
    } finally {
      if (currentNavigation === navigationSequence) {
        pendingPath.value = '';
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
   * 返回首页（默认为 /scaffold）
   */
  const goHome = () => {
    void navigateToPath('/scaffold').catch(handleNavigationError);
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
