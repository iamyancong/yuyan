import { onActivated, onDeactivated, onMounted, onUnmounted, ref, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  getTargetDeployProgress,
  listDeployTargetRuntimeSnapshots,
  type DeployProgressSnapshot,
  type DeployTarget,
} from '@/api/deploy';
import { getDeployProgressActionLabel } from '../constant';
import { getErrorMessage, isNotFoundError } from '../utils';
import {
  getTargetRuntimePollDelay,
  isTargetRuntimeBatchUnsupported,
  mapWithConcurrency,
  TARGET_RUNTIME_FALLBACK_CONCURRENCY,
} from './targetRuntimePolicy';

/** 判断当前页面是否处于后台隐藏状态。 */
const isPageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * 管理部署目标聚合运行态、自适应轮询与快照控制。
 * @param targets 部署目标响应式列表引用
 * @returns 运行态快照字典、轮询控制及校验方法
 */
export function useTargetRuntime(targets: Ref<DeployTarget[]>) {
  /** 部署目标的实时运行态快照缓存字典。 */
  const targetRuntimeSnapshots = ref<Record<number, DeployProgressSnapshot>>({});
  /** 是否正在加载运行态快照。 */
  const targetRuntimeLoading = ref(false);

  let runtimeRefreshSequence = 0;
  let targetRuntimeTimer: number | null = null;
  let runtimeAbortController: AbortController | null = null;
  let runtimeRefreshPromise: Promise<void> | null = null;
  let runtimeRefreshQueued = false;
  let runtimePollingEnabled = false;
  let visibilityListenerAttached = false;
  let batchApiSupported = true;
  let consecutiveFailures = 0;
  let requestedTargetKey = '';

  /** 清理下一次轮询定时器。 */
  const clearScheduledRefresh = () => {
    if (targetRuntimeTimer === null) return;
    window.clearTimeout(targetRuntimeTimer);
    targetRuntimeTimer = null;
  };

  /** 根据当前任务与失败状态安排下一次刷新。 */
  const scheduleNextRefresh = () => {
    clearScheduledRefresh();
    if (!runtimePollingEnabled || isPageHidden() || !targets.value.length) return;
    const delay = getTargetRuntimePollDelay(
      Object.keys(targetRuntimeSnapshots.value).length > 0,
      consecutiveFailures,
      !batchApiSupported,
    );
    targetRuntimeTimer = window.setTimeout(() => {
      targetRuntimeTimer = null;
      void refreshTargetRuntimeSnapshots();
    }, delay);
  };

  /** 页面可见性变化时暂停请求或立即补同步。 */
  const handleVisibilityChange = () => {
    if (isPageHidden()) {
      clearScheduledRefresh();
      cancelPendingRequests();
      return;
    }
    if (runtimePollingEnabled && targets.value.length) void refreshTargetRuntimeSnapshots();
  };

  /** 绑定页面可见性监听。 */
  const attachVisibilityListener = () => {
    if (visibilityListenerAttached || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerAttached = true;
  };

  /** 解绑页面可见性监听。 */
  const detachVisibilityListener = () => {
    if (!visibilityListenerAttached || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerAttached = false;
  };

  /** 获取部署目标运行态快照。 */
  const getTargetRuntimeSnapshot = (target: Pick<DeployTarget, 'id'>) => targetRuntimeSnapshots.value[target.id];

  /** 写入部署目标运行态快照。 */
  const setTargetRuntimeSnapshot = (snapshot: DeployProgressSnapshot) => {
    if (!snapshot.running) return;
    targetRuntimeSnapshots.value = {
      ...targetRuntimeSnapshots.value,
      [snapshot.targetId]: snapshot,
    };
  };

  /** 移除部署目标运行态快照。 */
  const clearTargetRuntimeSnapshot = (targetId: number) => {
    if (!targetRuntimeSnapshots.value[targetId]) return;
    const nextSnapshots = { ...targetRuntimeSnapshots.value };
    delete nextSnapshots[targetId];
    targetRuntimeSnapshots.value = nextSnapshots;
  };

  /** 校验目标当前没有发布或回滚任务。 */
  const ensureTargetIdle = async (
    target: Pick<DeployTarget, 'id' | 'projectName' | 'projectType'>,
    operationLabel: string,
  ) => {
    try {
      const snapshot = await getTargetDeployProgress(target.id, target.projectType);
      if (!snapshot.running) {
        clearTargetRuntimeSnapshot(target.id);
        return true;
      }
      setTargetRuntimeSnapshot(snapshot);
      message.warning(`${target.projectName || '当前部署目标'}正在${getDeployProgressActionLabel(snapshot.action)}，暂不可${operationLabel}`);
      return false;
    } catch (error: any) {
      if (isNotFoundError(error)) {
        clearTargetRuntimeSnapshot(target.id);
        return true;
      }
      message.error(getErrorMessage(error));
      return false;
    }
  };

  /** 使用旧服务端逐目标接口，并限制并发数。 */
  const fetchLegacyTargetSnapshots = async (targetList: DeployTarget[], signal: AbortSignal) => {
    const snapshots = await mapWithConcurrency(targetList, TARGET_RUNTIME_FALLBACK_CONCURRENCY, async (target) => {
      try {
        const snapshot = await getTargetDeployProgress(target.id, target.projectType, signal);
        return snapshot.running ? snapshot : null;
      } catch (error: any) {
        if (signal.aborted || isNotFoundError(error)) return null;
        throw error;
      }
    });
    return snapshots.filter((snapshot): snapshot is DeployProgressSnapshot => Boolean(snapshot));
  };

  /** 获取聚合快照，旧服务端自动回退为限流逐目标请求。 */
  const fetchTargetSnapshots = async (targetList: DeployTarget[], signal: AbortSignal) => {
    if (batchApiSupported) {
      try {
        const batch = await listDeployTargetRuntimeSnapshots(signal);
        const visibleTargetIds = new Set(targetList.map((target) => target.id));
        return batch.items.filter((snapshot) => snapshot.running && visibleTargetIds.has(snapshot.targetId));
      } catch (error: any) {
        if (!isTargetRuntimeBatchUnsupported(error)) throw error;
        batchApiSupported = false;
      }
    }
    return fetchLegacyTargetSnapshots(targetList, signal);
  };

  /** 刷新当前目标列表的运行态快照。 */
  const refreshTargetRuntimeSnapshots = async (targetList: DeployTarget[] = targets.value) => {
    if (!runtimePollingEnabled) {
      targetRuntimeLoading.value = false;
      return;
    }
    const targetKey = targetList.map((target) => `${target.id}:${target.projectType}`).sort().join(',');
    if (targetKey !== requestedTargetKey) {
      requestedTargetKey = targetKey;
      runtimeRefreshSequence += 1;
      runtimeAbortController?.abort();
    }
    if (runtimeRefreshPromise) {
      runtimeRefreshQueued = true;
      await runtimeRefreshPromise;
      return;
    }
    if (!targetList.length) {
      targetRuntimeSnapshots.value = {};
      targetRuntimeLoading.value = false;
      clearScheduledRefresh();
      return;
    }

    const sequence = ++runtimeRefreshSequence;
    const controller = new AbortController();
    runtimeAbortController = controller;
    targetRuntimeLoading.value = true;
    const promise = (async () => {
      try {
        const snapshots = await fetchTargetSnapshots(targetList, controller.signal);
        if (controller.signal.aborted || sequence !== runtimeRefreshSequence || !runtimePollingEnabled) return;
        targetRuntimeSnapshots.value = snapshots.reduce<Record<number, DeployProgressSnapshot>>((snapshotMap, snapshot) => {
          snapshotMap[snapshot.targetId] = snapshot;
          return snapshotMap;
        }, {});
        consecutiveFailures = 0;
      } catch {
        if (!controller.signal.aborted && sequence === runtimeRefreshSequence) consecutiveFailures += 1;
      }
    })();
    runtimeRefreshPromise = promise;
    try {
      await promise;
    } finally {
      if (runtimeRefreshPromise === promise) runtimeRefreshPromise = null;
      if (runtimeAbortController === controller) runtimeAbortController = null;
      if (sequence === runtimeRefreshSequence) targetRuntimeLoading.value = false;
      if (runtimeRefreshQueued && runtimePollingEnabled && !isPageHidden()) {
        runtimeRefreshQueued = false;
        void refreshTargetRuntimeSnapshots();
      } else {
        runtimeRefreshQueued = false;
        scheduleNextRefresh();
      }
    }
  };

  /** 开始部署运行态自适应轮询。 */
  const startTargetRuntimePolling = () => {
    if (!runtimePollingEnabled) return;
    attachVisibilityListener();
    scheduleNextRefresh();
  };

  /** 停止部署运行态轮询并取消当前请求。 */
  const stopTargetRuntimePolling = () => {
    clearScheduledRefresh();
    detachVisibilityListener();
    runtimeAbortController?.abort();
    runtimeAbortController = null;
  };

  /** 取消并废弃所有正在进行的运行态快照请求。 */
  function cancelPendingRequests() {
    runtimeRefreshSequence += 1;
    runtimeRefreshQueued = false;
    runtimeAbortController?.abort();
    runtimeAbortController = null;
    targetRuntimeLoading.value = false;
  }

  onMounted(() => {
    runtimePollingEnabled = true;
  });

  onActivated(() => {
    runtimePollingEnabled = true;
    startTargetRuntimePolling();
    if (!isPageHidden() && targets.value.length) void refreshTargetRuntimeSnapshots();
  });

  onDeactivated(() => {
    runtimePollingEnabled = false;
    stopTargetRuntimePolling();
    cancelPendingRequests();
  });

  onUnmounted(() => {
    runtimePollingEnabled = false;
    stopTargetRuntimePolling();
    cancelPendingRequests();
  });

  return {
    targetRuntimeSnapshots,
    targetRuntimeLoading,
    getTargetRuntimeSnapshot,
    setTargetRuntimeSnapshot,
    clearTargetRuntimeSnapshot,
    ensureTargetIdle,
    refreshTargetRuntimeSnapshots,
    startTargetRuntimePolling,
    stopTargetRuntimePolling,
    cancelPendingRequests,
  };
}
