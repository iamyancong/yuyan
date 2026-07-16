import { onActivated, onDeactivated, onMounted, onUnmounted, ref, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { getTargetDeployProgress, type DeployProgressSnapshot, type DeployTarget } from '@/api/deploy';
import { getDeployProgressActionLabel } from '../constant';
import { getErrorMessage, isNotFoundError } from '../utils';

/** 部署目标运行态轮询间隔 */
const TARGET_RUNTIME_POLL_INTERVAL = 8000;

/** 判断当前页面是否处于后台隐藏状态 */
const isPageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * 管理部署目标的实时运行态长轮询与快照控制。
 * @description 将复杂的轮询机制与状态快照管理从巨无霸 Hook 中解耦分离，符合单一职责原则。
 * @param targets 部署目标响应式列表引用
 * @returns 运行态快照字典、轮询控制及校验方法
 */
export function useTargetRuntime(targets: Ref<DeployTarget[]>) {
  /** 部署目标的实时运行态快照缓存字典 */
  const targetRuntimeSnapshots = ref<Record<number, DeployProgressSnapshot>>({});
  /** 是否正在加载运行态快照 */
  const targetRuntimeLoading = ref(false);

  let runtimeRefreshSequence = 0;
  let targetRuntimeTimer: number | null = null;
  /** 当前组件是否允许发起运行态请求与轮询 */
  let runtimePollingEnabled = false;

  /** 页面回到前台时立即刷新一次运行态 */
  const handleVisibilityChange = () => {
    if (isPageHidden() || targetRuntimeTimer === null || !targets.value.length) return;
    void refreshTargetRuntimeSnapshots();
  };

  /**
   * 获取部署目标运行态快照。
   * @param target 部署目标
   * @returns 运行态快照
   */
  const getTargetRuntimeSnapshot = (target: Pick<DeployTarget, 'id'>) => targetRuntimeSnapshots.value[target.id];

  /**
   * 写入部署目标运行态快照。
   * @param snapshot 运行态快照
   */
  const setTargetRuntimeSnapshot = (snapshot: DeployProgressSnapshot) => {
    if (!snapshot.running) return;
    targetRuntimeSnapshots.value = {
      ...targetRuntimeSnapshots.value,
      [snapshot.targetId]: snapshot,
    };
  };

  /**
   * 移除部署目标运行态快照。
   * @param targetId 部署目标 ID
   */
  const clearTargetRuntimeSnapshot = (targetId: number) => {
    if (!targetRuntimeSnapshots.value[targetId]) return;
    const nextSnapshots = { ...targetRuntimeSnapshots.value };
    delete nextSnapshots[targetId];
    targetRuntimeSnapshots.value = nextSnapshots;
  };

  /**
   * 校验目标当前没有发布或回滚任务。
   * @param target 部署目标
   * @param operationLabel 当前操作文案
   * @returns 是否允许继续操作
   */
  const ensureTargetIdle = async (target: Pick<DeployTarget, 'id' | 'projectName' | 'projectType'>, operationLabel: string) => {
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

  /**
   * 刷新当前目标列表的运行态快照。
   * @param targetList 目标列表
   */
  const refreshTargetRuntimeSnapshots = async (targetList: DeployTarget[] = targets.value) => {
    if (!runtimePollingEnabled) {
      targetRuntimeLoading.value = false;
      return;
    }
    const sequence = ++runtimeRefreshSequence;
    if (!targetList.length) {
      targetRuntimeSnapshots.value = {};
      targetRuntimeLoading.value = false;
      return;
    }
    targetRuntimeLoading.value = true;
    const snapshots = await Promise.all(
      targetList.map(async (target) => {
        try {
          const snapshot = await getTargetDeployProgress(target.id, target.projectType);
          return snapshot.running ? snapshot : null;
        } catch (error: any) {
          if (isNotFoundError(error)) return null;
          return targetRuntimeSnapshots.value[target.id] || null;
        }
      })
    );
    if (sequence !== runtimeRefreshSequence) return;
    targetRuntimeSnapshots.value = snapshots.reduce<Record<number, DeployProgressSnapshot>>((snapshotMap, snapshot) => {
      if (snapshot?.running) snapshotMap[snapshot.targetId] = snapshot;
      return snapshotMap;
    }, {});
    targetRuntimeLoading.value = false;
  };

  /** 开始轮询部署目标运行态 */
  const startTargetRuntimePolling = () => {
    if (!runtimePollingEnabled || targetRuntimeTimer !== null) return;
    targetRuntimeTimer = window.setInterval(() => {
      if (!targets.value.length || isPageHidden()) return;
      void refreshTargetRuntimeSnapshots();
    }, TARGET_RUNTIME_POLL_INTERVAL);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
  };

  /** 停止轮询部署目标运行态 */
  const stopTargetRuntimePolling = () => {
    if (targetRuntimeTimer !== null) {
      window.clearInterval(targetRuntimeTimer);
      targetRuntimeTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };

  /** 取消并废弃所有正在进行的运行态快照请求 */
  const cancelPendingRequests = () => {
    runtimeRefreshSequence += 1;
    targetRuntimeLoading.value = false;
  };

  onMounted(() => {
    runtimePollingEnabled = true;
  });

  onActivated(() => {
    runtimePollingEnabled = true;
    startTargetRuntimePolling();
    if (!isPageHidden() && targets.value.length) {
      void refreshTargetRuntimeSnapshots();
    }
  });

  onDeactivated(() => {
    runtimePollingEnabled = false;
    stopTargetRuntimePolling();
    cancelPendingRequests();
  });

  onUnmounted(() => {
    runtimePollingEnabled = false;
    stopTargetRuntimePolling();
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
