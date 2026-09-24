import { unref } from 'vue';

/**
 * 部署中心弹层宿主属性接口
 */
export interface NginxDeployOverlayHostProps {
  lifecycleState?: Record<string, any>;
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  recordState: Record<string, any>;
  progressState: Record<string, any>;
  openApiState: Record<string, any>;
}

/** 弹层状态入参支持可选 */
export type OverlayStates = Partial<NginxDeployOverlayHostProps>;

/**
 * 校验当前是否存在任意处于激活或可见状态的部署中心弹层或抽屉
 * @description 统一聚合所有子模块弹层状态，支持 Ref 与原生布尔值解包，确保任意弹层被触发时宿主能激活挂载
 * @param states 各模块状态集合
 * @returns 是否存在处于激活状态的弹层
 */
export function hasAnyVisibleOverlay(states?: OverlayStates | null): boolean {
  if (!states) return false;
  const { serverState, targetState, recordState, progressState, openApiState } = states;
  return Boolean(
    unref(serverState?.serverModalOpen) ||
      unref(serverState?.runtimeDrawerOpen) ||
      unref(serverState?.fsDrawerOpen) ||
      unref(targetState?.targetModalOpen) ||
      unref(targetState?.nginxTargetId) ||
      unref(targetState?.serviceLogOpen) ||
      unref(targetState?.javaManagerOpen) ||
      unref(targetState?.environmentManagerOpen) ||
      unref(recordState?.recordLogOpen) ||
      unref(progressState?.publishConfirmOpen) ||
      unref(progressState?.rollbackProgressOpen) ||
      unref(progressState?.rollbackConfirmOpen) ||
      unref(openApiState?.drawerOpen)
  );
}
