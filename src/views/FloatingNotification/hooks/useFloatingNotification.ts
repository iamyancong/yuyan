import { computed, onMounted, onUnmounted, ref } from 'vue';
import { isTauri } from '@/utils/env';
import {
  AUTO_DISMISS_DURATION_MS,
  DEFAULT_NOTIFICATION_DATA,
  type DesktopFloatingTaskAction,
  type FloatingNotificationData,
} from '../constant';

/** 自动关闭倒计时的暂停来源。 */
type CountdownPauseReason = 'hover' | 'focus';

/** 当前焦点的输入来源，用于区分鼠标点击与键盘导航。 */
type FocusInteractionOrigin = 'keyboard' | 'pointer';

/** Tauri invoke 函数类型。 */
type TauriInvoke = typeof import('@tauri-apps/api/core')['invoke'];

/**
 * 浮窗通知核心交互 Composable。
 * 包含事件监听、倒计时、悬停暂停、关闭动画与主应用激活唤醒。
 */
export const useFloatingNotification = () => {
  const notificationData = ref<FloatingNotificationData>(DEFAULT_NOTIFICATION_DATA);
  const isVisible = ref(true);
  const isClosing = ref(false);
  const isHovered = ref(false);
  const isFocusedWithin = ref(false);
  const progress = ref(100);

  /** 判断是否为持续长任务进度模式（进度常驻不倒计时） */
  const isProgressMode = computed(() => {
    return notificationData.value.mode === 'progress' || notificationData.value.status === 'downloading';
  });

  /** 判断当前通知是否应该触发倒计时自动关闭。 */
  const shouldAutoDismiss = computed(() => {
    // 1. 进度条长任务模式（包含下载中）：绝对常驻，不自动关闭
    if (isProgressMode.value) return false;
    // 2. 显式指定 autoDismiss 为 false 的（如长任务完成态产物展示）：常驻，不自动关闭
    if (notificationData.value.autoDismiss === false) return false;
    // 3. 显式指定 durationMs 小于等于 0 的：常驻，不自动关闭
    if (notificationData.value.durationMs !== undefined && notificationData.value.durationMs <= 0) return false;
    return true;
  });

  const pauseReasons = new Set<CountdownPauseReason>();
  let unlistenEvent: (() => void) | null = null;
  let countdownTimer: number | null = null;
  let dismissTimer: number | null = null;
  let interactionSyncFrame: number | null = null;
  let nativePointerPollTimer: number | null = null;
  let nativePointerPollInFlight = false;
  let nativeInvoke: TauriInvoke | null = null;
  let nativeInteractionSync = Promise.resolve();
  let lastNativeInteractionState: boolean | null = null;
  let remainingMs = AUTO_DISMISS_DURATION_MS;
  let lastTickTime = 0;
  let isAutoClosing = false;
  let focusInteractionOrigin: FocusInteractionOrigin = 'keyboard';

  /** 获取不受系统时间校准影响的单调时间。 */
  const getCurrentTime = (): number => {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  };

  /** 停止当前倒计时轮询。 */
  const stopCountdownTimer = () => {
    if (countdownTimer === null) return;
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  };

  /**
   * 串行同步原生窗口交互状态，避免快速进出时异步 invoke 乱序。
   * @param interacting 是否正在与通知交互
   * @param force 是否忽略前端去重并强制同步
   */
  const syncNativeInteractionState = (interacting: boolean, force = false) => {
    if (!isTauri() || (!force && lastNativeInteractionState === interacting)) return;
    lastNativeInteractionState = interacting;
    nativeInteractionSync = nativeInteractionSync
      .catch(() => undefined)
      .then(async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_floating_notification_interacting', { interacting });
      })
      .catch(() => undefined);
  };

  /**
   * 应用原生层返回的全局鼠标命中状态。
   * DOM hover 仍用于前台即时响应，原生结果覆盖后台 WebView 不派发 pointerenter 的场景。
   * @param isNativeHovered 鼠标是否位于浮窗的屏幕范围内
   */
  const applyNativePointerState = (isNativeHovered: boolean) => {
    if (!isVisible.value) return;

    if (isNativeHovered) {
      isHovered.value = true;
      pauseCountdown('hover');
      return;
    }

    isHovered.value = false;
    resumeCountdown('hover');
  };

  /** 读取一次原生全局鼠标位置，避免异步调用重叠。 */
  const pollNativePointerState = async () => {
    if (!nativeInvoke || nativePointerPollInFlight || !isVisible.value) return;
    nativePointerPollInFlight = true;
    try {
      const isNativeHovered = await nativeInvoke<boolean>(
        'sync_floating_notification_pointer_interaction'
      );
      applyNativePointerState(isNativeHovered);
    } catch {
      /** 原生命中检测不可用时继续使用 DOM 事件。 */
    } finally {
      nativePointerPollInFlight = false;
    }
  };

  /** 启动原生鼠标命中轮询，覆盖 macOS 后台应用场景。 */
  const startNativePointerTracking = async () => {
    if (!isTauri() || nativePointerPollTimer !== null) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      nativeInvoke = invoke;
      await pollNativePointerState();
      nativePointerPollTimer = window.setInterval(() => {
        void pollNativePointerState();
      }, 80);
    } catch {
      nativeInvoke = null;
    }
  };

  /** 停止原生鼠标命中轮询。 */
  const stopNativePointerTracking = () => {
    if (nativePointerPollTimer !== null) {
      window.clearInterval(nativePointerPollTimer);
      nativePointerPollTimer = null;
    }
    nativeInvoke = null;
    nativePointerPollInFlight = false;
  };

  /** 读取 DOM 的真实悬停和焦点状态，避免透明 WebView 丢失边界事件。 */
  const getActualInteractionState = () => {
    const card = document.querySelector<HTMLElement>('.floating-glass-card');
    return {
      isActuallyHovered: Boolean(card?.matches(':hover')),
      isActuallyFocused: Boolean(
        focusInteractionOrigin === 'keyboard' && card && card.contains(document.activeElement)
      ),
    };
  };

  /** 自动关闭前再次确认真实交互状态，命中时恢复可见状态并保持暂停。 */
  const preserveNotificationIfInteracting = (): boolean => {
    const { isActuallyHovered, isActuallyFocused } = getActualInteractionState();
    if (!isActuallyHovered && !isActuallyFocused && pauseReasons.size === 0) return false;

    if (dismissTimer !== null) {
      window.clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    isHovered.value = isActuallyHovered;
    isFocusedWithin.value = isActuallyFocused;
    if (isActuallyHovered) pauseReasons.add('hover');
    if (isActuallyFocused) pauseReasons.add('focus');
    isClosing.value = false;
    isAutoClosing = false;
    stopCountdownTimer();
    syncNativeInteractionState(true, true);
    return true;
  };

  /** 将最近一次计时点至当前时刻的耗时结算到剩余时长。 */
  const settleElapsedTime = () => {
    const now = getCurrentTime();
    if (lastTickTime > 0 && pauseReasons.size === 0 && !isClosing.value) {
      const duration = notificationData.value.durationMs || AUTO_DISMISS_DURATION_MS;
      remainingMs = Math.max(0, remainingMs - Math.max(0, now - lastTickTime));
      progress.value = Math.max(0, (remainingMs / duration) * 100);
    }
    lastTickTime = now;
  };

  /** 执行一次倒计时轮询。 */
  const tickCountdown = () => {
    if (pauseReasons.size > 0 || isClosing.value || !isVisible.value) {
      stopCountdownTimer();
      return;
    }

    settleElapsedTime();
    if (remainingMs > 0) return;

    progress.value = 0;
    stopCountdownTimer();
    void dismissAutomatically();
  };

  /** 在没有暂停原因时启动倒计时轮询。 */
  const startCountdownTimer = () => {
    if (
      !shouldAutoDismiss.value
      || countdownTimer
      || pauseReasons.size > 0
      || isClosing.value
      || !isVisible.value
      || remainingMs <= 0
    ) {
      return;
    }
    lastTickTime = getCurrentTime();
    countdownTimer = window.setInterval(tickCountdown, 50);
  };

  /**
   * 关闭当前通知悬浮窗并通知 Rust 层隐藏窗口。
   */
  const dismissNotification = async (force: boolean) => {
    if (!isVisible.value || isClosing.value) return;
    if (!force && preserveNotificationIfInteracting()) return;

    isClosing.value = true;
    isAutoClosing = !force;
    stopCountdownTimer();

    if (dismissTimer !== null) window.clearTimeout(dismissTimer);
    // 预留 320ms CSS 退出平滑过渡，动画完成后再隐藏 Tauri 窗口。
    dismissTimer = window.setTimeout(async () => {
      dismissTimer = null;
      if (!force && preserveNotificationIfInteracting()) return;

      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const didHide = await invoke<boolean>('hide_floating_notification', { force });
          if (!didHide && !force) {
            isClosing.value = false;
            isAutoClosing = false;
            syncNativeInteractionState(true, true);
            return;
          }
        } catch {
          // 忽略关闭异常
        }
      }

      isVisible.value = false;
      isClosing.value = false;
      isHovered.value = false;
      isFocusedWithin.value = false;
      isAutoClosing = false;
      pauseReasons.clear();
      syncNativeInteractionState(false, true);
    }, 320);
  };

  /** 用户主动关闭通知。 */
  const dismiss = async () => dismissNotification(true);

  /** 倒计时结束后尝试自动关闭通知。 */
  const dismissAutomatically = async () => dismissNotification(false);

  /**
   * 启动自动关闭倒计时与进度条衰减。
   */
  const startCountdown = () => {
    stopCountdownTimer();
    if (isProgressMode.value) {
      if (typeof notificationData.value.progressPercentage === 'number') {
        progress.value = notificationData.value.progressPercentage;
      } else {
        progress.value = 100;
      }
      return;
    }

    // 若当前通知配置为常驻（如长任务完成态需用户主动查看或点击操作），不启动倒计时
    if (!shouldAutoDismiss.value) {
      progress.value = 100;
      return;
    }

    const duration = notificationData.value.durationMs || AUTO_DISMISS_DURATION_MS;
    remainingMs = duration;
    progress.value = 100;
    lastTickTime = getCurrentTime();
    startCountdownTimer();
  };

  /**
   * 响应悬浮窗操作按钮点击（如取消导出、重试、自定义动作）。
   * @param action 操作按钮定义
   */
  const handleActionClick = async (action: DesktopFloatingTaskAction) => {
    if (isTauri()) {
      try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('desktop-task-action', {
          actionId: action.id,
          taskId: notificationData.value.taskId,
        });
      } catch {
        // 忽略广播异常
      }
    }

    if (action.id === 'cancel') {
      void dismiss();
    }
  };

  /** 暂停自动关闭，并冻结当前剩余时长。 */
  const pauseCountdown = (reason: CountdownPauseReason) => {
    if (pauseReasons.has(reason) || !isVisible.value) return;

    if (isClosing.value) {
      if (!isAutoClosing) return;
      if (dismissTimer !== null) {
        window.clearTimeout(dismissTimer);
        dismissTimer = null;
      }
      isClosing.value = false;
      isAutoClosing = false;
    }

    if (pauseReasons.size === 0) {
      settleElapsedTime();
    }

    pauseReasons.add(reason);
    stopCountdownTimer();
    syncNativeInteractionState(true);
  };

  /** 移除指定暂停原因；所有暂停原因都解除后从冻结点继续。 */
  const resumeCountdown = (reason: CountdownPauseReason) => {
    if (!pauseReasons.delete(reason)) return;
    syncNativeInteractionState(pauseReasons.size > 0);
    // 关键守卫：常驻任务（长任务进度或明确非自动关闭）绝对不恢复倒计时
    if (!shouldAutoDismiss.value) return;
    if (pauseReasons.size > 0 || !isVisible.value || isClosing.value) return;
    if (remainingMs <= 0) remainingMs = 1;
    lastTickTime = getCurrentTime();
    startCountdownTimer();
  };

  /**
   * 打开部署站点的外部浏览器链接。
   */
  const handleOpenSite = async () => {
    const url = notificationData.value.visitUrl;
    if (!url) return;
    try {
      if (isTauri()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    void dismiss();
  };

  /**
   * 点击通知主体唤醒主窗口并聚焦。
   */
  const handleCardClick = async () => {
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_main_window_focus');
      } catch {
        // 忽略聚焦唤醒异常
      }
    }
    void dismiss();
  };

  /** 指针进入通知卡片时冻结倒计时。 */
  const handlePointerEnter = () => {
    isHovered.value = true;
    pauseCountdown('hover');
  };

  /** 指针离开通知卡片时从冻结的剩余时长继续倒计时。 */
  const handlePointerLeave = () => {
    if (!isHovered.value) return;
    isHovered.value = false;
    resumeCountdown('hover');
  };

  /** 键盘焦点进入通知卡片时暂停，保证辅助操作期间不会自动关闭。 */
  const handleFocusIn = () => {
    const shouldPauseForFocus = focusInteractionOrigin === 'keyboard';
    isFocusedWithin.value = shouldPauseForFocus;
    if (shouldPauseForFocus) pauseCountdown('focus');
    else resumeCountdown('focus');
  };

  /** 键盘焦点真正离开整张卡片后恢复倒计时。 */
  const handleFocusOut = (event: FocusEvent) => {
    const card = event.currentTarget as HTMLElement | null;
    const nextTarget = event.relatedTarget as Node | null;
    if (card && nextTarget && card.contains(nextTarget)) return;

    isFocusedWithin.value = false;
    resumeCountdown('focus');
  };

  /**
   * 指针从 WebView 边缘离开时补偿组件事件。
   * relatedTarget 在透明窗口或 SVG 子元素间切换时可能为 null，必须同时确认坐标已越界。
   */
  const handleWindowPointerOut = (event: PointerEvent) => {
    const isOutsideViewport =
      event.clientX <= 0 ||
      event.clientY <= 0 ||
      event.clientX >= window.innerWidth ||
      event.clientY >= window.innerHeight;
    if (event.relatedTarget === null && isOutsideViewport) {
      handlePointerLeave();
    }
  };

  /** 文档级离开事件用于兜底指针快速滑出透明窗口的场景。 */
  const handleDocumentMouseLeave = () => {
    handlePointerLeave();
  };

  /** 鼠标点击产生的焦点不单独阻止鼠标移出后的倒计时。 */
  const handleWindowPointerDown = () => {
    focusInteractionOrigin = 'pointer';
    isFocusedWithin.value = false;
    resumeCountdown('focus');
  };

  /** 根据当前真实 hover 与焦点状态校准暂停来源。 */
  const syncInteractionPauseState = () => {
    interactionSyncFrame = null;
    const { isActuallyHovered, isActuallyFocused } = getActualInteractionState();

    isHovered.value = isActuallyHovered;
    isFocusedWithin.value = isActuallyFocused;

    if (isActuallyHovered) pauseCountdown('hover');
    else resumeCountdown('hover');

    if (isActuallyFocused) pauseCountdown('focus');
    else resumeCountdown('focus');

    syncNativeInteractionState(pauseReasons.size > 0, true);
  };

  /** 下一帧校准交互状态，等待 keyed 通知节点完成更新。 */
  const scheduleInteractionPauseSync = () => {
    if (interactionSyncFrame !== null) window.cancelAnimationFrame(interactionSyncFrame);
    interactionSyncFrame = window.requestAnimationFrame(syncInteractionPauseState);
  };

  /** 使用 Esc 快捷键关闭当前通知。进行中的长任务不响应 Esc 避免截图取消误触。 */
  const handleWindowKeydown = (event: KeyboardEvent) => {
    focusInteractionOrigin = 'keyboard';
    if (event.key !== 'Escape' || !isVisible.value) return;
    if (isProgressMode.value) return;
    event.preventDefault();
    void dismiss();
  };

  onMounted(async () => {
    // 注入透明背景类
    document.documentElement.classList.add('is-transparent-window');
    document.body.classList.add('is-transparent-window');
    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.classList.add('is-transparent-window');
    }

    window.addEventListener('pointerout', handleWindowPointerOut);
    window.addEventListener('pointerdown', handleWindowPointerDown);
    window.addEventListener('keydown', handleWindowKeydown);
    document.addEventListener('mouseleave', handleDocumentMouseLeave);

    if (isTauri()) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const handleIncomingPayload = (payload: Partial<FloatingNotificationData>) => {
          if (dismissTimer) {
            window.clearTimeout(dismissTimer);
            dismissTimer = null;
          }
          notificationData.value = {
            ...DEFAULT_NOTIFICATION_DATA,
            ...payload,
          };
          isVisible.value = true;
          isClosing.value = false;
          isAutoClosing = false;
          lastNativeInteractionState = null;
          startCountdown();
          scheduleInteractionPauseSync();
        };

        const handleIncomingProgress = (progressPayload: {
          progressPercentage?: number | null;
          loadedBytes?: number;
          totalBytes?: number | null;
          stage?: string;
        }) => {
          // 收到任何进度更新，立即停止倒计时，确保持续任务绝对不闪退
          stopCountdownTimer();
          if (!isVisible.value) isVisible.value = true;
          if (progressPayload.loadedBytes !== undefined) {
            notificationData.value.loadedBytes = progressPayload.loadedBytes;
          }
          if (progressPayload.totalBytes !== undefined) {
            notificationData.value.totalBytes = progressPayload.totalBytes;
          }
          if (progressPayload.progressPercentage !== undefined) {
            notificationData.value.progressPercentage = progressPayload.progressPercentage;
            if (progressPayload.progressPercentage !== null) {
              progress.value = progressPayload.progressPercentage;
            }
          }
          if (progressPayload.stage !== undefined) {
            notificationData.value.stage = progressPayload.stage;
          }
        };

        const unlistenDeploy = await listen<FloatingNotificationData>(
          'deploy-notification-event',
          (event) => {
            if (event.payload) handleIncomingPayload(event.payload);
          }
        );

        const unlistenDesktopTask = await listen<FloatingNotificationData>(
          'desktop-task-event',
          (event) => {
            if (event.payload) handleIncomingPayload(event.payload);
          }
        );

        const unlistenProgress = await listen<{
          progressPercentage?: number | null;
          loadedBytes?: number;
          totalBytes?: number | null;
          stage?: string;
        }>('desktop-task-progress', (event) => {
          if (event.payload) handleIncomingProgress(event.payload);
        });

        unlistenEvent = () => {
          unlistenDeploy();
          unlistenDesktopTask();
          unlistenProgress();
        };

        // 核心修复：浮窗挂载或窗口重新唤醒时主动拉取 Rust 缓存的最新任务状态
        const pullLatestState = async () => {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const latestCached = await invoke<FloatingNotificationData | null>('get_latest_floating_notification');
            if (latestCached) {
              handleIncomingPayload(latestCached);
            }
          } catch {
            // 忽略拉取异常
          }
        };

        void pullLatestState();

        const handleReactivated = () => {
          if (!isVisible.value || isClosing.value) {
            void pullLatestState();
          }
        };

        window.addEventListener('focus', handleReactivated);
        document.addEventListener('visibilitychange', handleReactivated);

        const prevUnlisten = unlistenEvent;
        unlistenEvent = () => {
          window.removeEventListener('focus', handleReactivated);
          document.removeEventListener('visibilitychange', handleReactivated);
          if (prevUnlisten) prevUnlisten();
        };
      } catch {
        // 忽略非 Tauri 或事件监听异常
      }
    }

    if (shouldAutoDismiss.value) {
      startCountdown();
    }
    scheduleInteractionPauseSync();
    void startNativePointerTracking();
  });

  onUnmounted(() => {
    window.removeEventListener('pointerout', handleWindowPointerOut);
    window.removeEventListener('pointerdown', handleWindowPointerDown);
    window.removeEventListener('keydown', handleWindowKeydown);
    document.removeEventListener('mouseleave', handleDocumentMouseLeave);

    stopCountdownTimer();
    stopNativePointerTracking();
    if (dismissTimer) {
      window.clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    if (interactionSyncFrame !== null) {
      window.cancelAnimationFrame(interactionSyncFrame);
      interactionSyncFrame = null;
    }
    pauseReasons.clear();
    syncNativeInteractionState(false, true);
    if (unlistenEvent) {
      unlistenEvent();
      unlistenEvent = null;
    }
  });

  return {
    notificationData,
    isVisible,
    isClosing,
    isHovered,
    isProgressMode,
    progress,
    dismiss,
    handleActionClick,
    handleOpenSite,
    handleCardClick,
    handlePointerEnter,
    handlePointerLeave,
    handleFocusIn,
    handleFocusOut,
  };
};
