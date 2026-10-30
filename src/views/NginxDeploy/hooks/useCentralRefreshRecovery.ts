import { computed, ref } from 'vue';
import { CENTRAL_LIST_READ_TIMEOUT_MS, isReadCancelled, isRecoverableReadError, recoverCentralRead } from '@/utils/centralReadRecovery';
import { CENTRAL_NOTICE_MIN_DURATION_MS, shouldShowCentralRefreshNotice } from '@/utils/centralRefreshNoticePolicy';

/** 刷新执行选项。 */
export interface CentralRefreshRunOptions {
  /** 后台/静默刷新：自动重试期间不提示、不禁用操作，仅最终失败时提示 */
  quiet?: boolean;
}

/** 部署页面刷新会话；同查询复用请求，新查询废弃旧请求。 */
export function useCentralRefreshRecovery() {
  const status = ref<'idle' | 'loading' | 'recovering' | 'failed'>('idle');
  const error = ref<unknown>(null);
  const failures = ref(0);
  const failingSince = ref<number | null>(null);
  const quiet = ref(false);
  /** 故障持续时长到达阈值时触发重新计算 */
  const clock = ref(0);
  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  let active: { key: string; controller: AbortController; promise: Promise<void> } | null = null;

  const clearDurationTimer = () => {
    if (durationTimer) clearTimeout(durationTimer);
    durationTimer = null;
  };

  const resetFailure = () => {
    clearDurationTimer();
    failures.value = 0;
    failingSince.value = null;
  };

  /** 是否展示提示条：单次慢请求后重试成功不打扰用户。 */
  const noticeVisible = computed(() => {
    void clock.value;
    return shouldShowCentralRefreshNotice({
      quiet: quiet.value,
      status: status.value,
      failures: failures.value,
      failingSince: failingSince.value,
      now: Date.now(),
    });
  });

  /** 中央是否判定为不可用（禁用发布等操作）；与提示条同步，避免无提示时按钮莫名置灰。 */
  const unavailable = computed(() => noticeVisible.value && (status.value === 'recovering' || isRecoverableReadError(error.value)));

  /** 取消当前查询并清除其故障状态，避免提示消失后仍禁用操作；旧响应不得回写。 */
  const cancel = () => {
    active?.controller.abort();
    active = null;
    status.value = 'idle';
    error.value = null;
    quiet.value = false;
    resetFailure();
  };

  /** 身份切换时同时重置可用性，避免继承其他团队的故障。 */
  const reset = () => {
    cancel();
  };

  /** 执行可恢复查询；错误由调用方的统一状态提示消费。 */
  const run = (key: string, read: (signal: AbortSignal) => Promise<void>, options: CentralRefreshRunOptions = {}): Promise<void> => {
    if (active?.key === key) {
      // 复用进行中的请求；用户主动刷新时升级为可提示
      if (!options.quiet) quiet.value = false;
      return active.promise;
    }
    cancel();
    const controller = new AbortController();
    status.value = 'loading';
    quiet.value = Boolean(options.quiet);
    const promise = recoverCentralRead(read, {
      signal: controller.signal,
      requestTimeoutMs: CENTRAL_LIST_READ_TIMEOUT_MS,
      onRetry: (reason) => {
        if (controller.signal.aborted) return;
        error.value = reason;
        status.value = 'recovering';
        failures.value += 1;
        if (failingSince.value === null) {
          failingSince.value = Date.now();
          clearDurationTimer();
          durationTimer = setTimeout(() => {
            durationTimer = null;
            clock.value += 1;
          }, CENTRAL_NOTICE_MIN_DURATION_MS);
        }
      },
    })
      .then(() => {
        if (controller.signal.aborted) return;
        status.value = 'idle';
        error.value = null;
        resetFailure();
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isReadCancelled(reason)) return;
        error.value = reason;
        status.value = 'failed';
        clearDurationTimer();
        throw reason;
      })
      .finally(() => {
        if (active?.controller === controller) active = null;
      });
    active = { key, controller, promise };
    return promise;
  };

  return {
    status,
    error,
    unavailable,
    noticeVisible,
    retrying: computed(() => status.value === 'recovering' && noticeVisible.value),
    run,
    cancel,
    reset,
  };
}
