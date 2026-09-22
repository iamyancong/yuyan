import { computed, ref } from 'vue';
import { isReadCancelled, isRecoverableReadError, recoverCentralRead } from '@/utils/centralReadRecovery';

/** 部署页面刷新会话；同查询复用请求，新查询废弃旧请求。 */
export function useCentralRefreshRecovery() {
  const status = ref<'idle' | 'loading' | 'recovering' | 'failed'>('idle');
  const error = ref<unknown>(null);
  const unavailable = ref(false);
  let active: { key: string; controller: AbortController; promise: Promise<void> } | null = null;

  /** 取消当前查询并清除其故障状态，避免提示消失后仍禁用操作；旧响应不得回写。 */
  const cancel = () => {
    active?.controller.abort();
    active = null;
    status.value = 'idle';
    error.value = null;
    unavailable.value = false;
  };

  /** 身份切换时同时重置可用性，避免继承其他团队的故障。 */
  const reset = () => {
    cancel();
  };

  /** 执行可恢复查询；错误由调用方的统一状态提示消费。 */
  const run = (key: string, read: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (active?.key === key) return active.promise;
    cancel();
    const controller = new AbortController();
    status.value = 'loading';
    const promise = recoverCentralRead(read, {
      signal: controller.signal,
      onRetry: (reason) => {
        error.value = reason;
        status.value = 'recovering';
        unavailable.value = true;
      },
    })
      .then(() => {
        if (controller.signal.aborted) return;
        status.value = 'idle';
        error.value = null;
        unavailable.value = false;
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isReadCancelled(reason)) return;
        error.value = reason;
        status.value = 'failed';
        unavailable.value = isRecoverableReadError(reason);
        throw reason;
      })
      .finally(() => {
        if (active?.controller === controller) active = null;
      });
    active = { key, controller, promise };
    return promise;
  };

  return { status, error, unavailable, retrying: computed(() => status.value === 'recovering'), run, cancel, reset };
}
