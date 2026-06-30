import { onMounted, onUnmounted, ref } from 'vue';

/**
 * 带有“前后台可见性感知”的智能轮询 Hook。
 * 
 * 当窗口被最小化、切入后台或选项卡隐藏时，自动挂起轮询定时器以节省 CPU 与网络资源；
 * 当窗口重新回到前台时，恢复轮询定时器并立即执行一次接口调用，确保用户第一眼看到最新的状态。
 *
 * @param pollCallback 轮询执行的异步或同步回调函数
 * @param intervalMs 轮询时间间隔（毫秒），默认为 5000ms
 * @returns 包含当前激活状态和手动重新触发轮询的函数
 */
export function useVisibilityPoll(
  pollCallback: () => Promise<void> | void,
  intervalMs = 5000
) {
  const isActive = ref(true);
  let timerId: number | null = null;

  /**
   * 启动轮询定时器，并立即触发一次回调
   */
  const startPoll = async () => {
    stopPoll();
    try {
      await pollCallback();
    } catch (error) {
      console.error('[useVisibilityPoll] 轮询回调执行出错:', error);
    }
    timerId = window.setInterval(async () => {
      try {
        await pollCallback();
      } catch (error) {
        console.error('[useVisibilityPoll] 轮询回调执行出错:', error);
      }
    }, intervalMs);
  };

  /**
   * 停止当前轮询定时器
   */
  const stopPoll = () => {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  };

  /**
   * 监听浏览器或 WebView 可见性变化的事件处理器
   */
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      isActive.value = false;
      stopPoll();
    } else {
      isActive.value = true;
      startPoll();
    }
  };

  onMounted(() => {
    startPoll();
    document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  onUnmounted(() => {
    stopPoll();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  return {
    /** 当前轮询是否处于活跃状态（即是否在前台可见） */
    isActive,
    /** 手动触发立即刷新轮询并重新计时 */
    triggerManualRefresh: startPoll,
    /** 暴露停止轮询的方法以便外部手动干预 */
    stopPoll,
    /** 暴露重新开始轮询的方法 */
    startPoll,
  };
}
