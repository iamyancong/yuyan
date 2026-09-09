<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import '@yss-ui/components/dist/style.css';
import { useYssVxeUI } from '@/composables/useYssVxeUI';
import NginxDeployWorkspace from './components/NginxDeployWorkspace/index.vue';
import NginxDeployOverlayHost from './components/NginxDeployOverlayHost/index.vue';
import {
  useNginxDeployActions,
  useNginxDeployAuth,
  useNginxDeployLifecycle,
  useNginxDeployProgress,
  useNginxDeployProjectContext,
  useNginxDeployRecords,
  useNginxDeployServers,
  useNginxDeployTargets,
  useTargetOpenApi,
} from './hooks/useNginxDeploy';
import { provideNginxDeployContext } from './hooks/useNginxDeployContext';
import type { RefreshActiveTabOptions } from './types';

defineOptions({ name: 'NginxDeploy' });

useYssVxeUI();

/** 部署项目类型 */
type DeployProjectType = 'all' | 'frontend' | 'backend';

/**
 * 读取合法的项目类型偏好，避免异常缓存导致页面所有项目均被过滤。
 * @returns 已校验的项目类型
 */
const getInitialProjectType = (): DeployProjectType => {
  const storedType = localStorage.getItem('yuyan_deploy_type_preference');
  return storedType === 'frontend' || storedType === 'backend' || storedType === 'all' ? storedType : 'all';
};

const projectType = ref<DeployProjectType>(getInitialProjectType());

/**
 * 切换全局项目类型并刷新当前 Tab。
 * @param type 目标项目类型
 */
const setProjectType = (type: DeployProjectType) => {
  if (projectType.value === type) return;
  projectType.value = type;
  localStorage.setItem('yuyan_deploy_type_preference', type);
  // 重置除了当前激活 Tab 之外的其他 Tab 缓存加载标记
  lifecycleState.clearTabCache(lifecycleState.activeTabKey.value);
  // 延迟刷新，让 Select 面板关闭动画先完成，避免同步阻塞导致交互卡顿
  const resetRecordsPage = lifecycleState.activeTabKey.value === 'records';
  void nextTick(() => refreshActiveTab({ force: true, resetRecordsPage }));
};

const project = useNginxDeployProjectContext();
const {
  authState,
  userName,
  isLoggedIn,
  openLoginModal,
  initAuthCheck,
  ensureLoggedIn: ensureLoggedInBase,
  isAuthReady,
} = useNginxDeployAuth();

let refreshActiveTabDelegate: (options?: RefreshActiveTabOptions) => Promise<void> = async () => undefined;

/**
 * 调用生命周期 Hook 暴露的当前 Tab 刷新方法。
 * @param options 刷新选项
 */
const refreshActiveTab = async (options: RefreshActiveTabOptions = {}) => {
  await refreshActiveTabDelegate(options);
};

/**
 * 校验当前登录态。
 * @returns 是否已登录
 */
const ensureLoggedIn = () => ensureLoggedInBase();

const serverState = useNginxDeployServers({ ensureLoggedIn, refreshActiveTab });
const targetState = useNginxDeployTargets({
  project,
  ensureLoggedIn,
  refreshActiveTab,
  servers: serverState.servers,
  refreshServerList: serverState.refreshServerList,
  projectType,
  authState,
});
const openApiState = useTargetOpenApi({ ensureLoggedIn, authState });
const recordState = useNginxDeployRecords({
  project,
  hasProjectContext: targetState.hasProjectContext,
  authState,
  ensureLoggedIn,
  refreshActiveTab,
  projectType,
});
const progressState = useNginxDeployProgress({
  ensureLoggedIn,
  refreshActiveTab,
  authState,
  userName,
  activeRecord: recordState.activeRecord,
  setTargetRuntimeSnapshot: targetState.setTargetRuntimeSnapshot,
  clearTargetRuntimeSnapshot: targetState.clearTargetRuntimeSnapshot,
});
const lifecycleState = useNginxDeployLifecycle({
  authState,
  isLoggedIn,
  isAuthReady,
  ensureLoggedIn,
  initAuthCheck,
  openLoginModal,
  refreshTargetList: targetState.refreshTargetList,
  refreshServerList: serverState.refreshServerList,
  refreshRecordList: recordState.refreshRecordList,
  resetRecordPage: recordState.resetRecordPage,
  startTargetRuntimePolling: targetState.startTargetRuntimePolling,
  stopTargetRuntimePolling: targetState.stopTargetRuntimePolling,
  clearDataHandlers: [
    serverState.clearServerData,
    targetState.clearTargetData,
    recordState.clearRecordData,
    progressState.clearProgressData,
  ],
});

refreshActiveTabDelegate = lifecycleState.refreshActiveTab;

const { serverActionConfig, targetActionConfig, recordActionConfig } = useNginxDeployActions({
  targetFormLoading: targetState.targetFormLoading,
  activeTargetId: targetState.activeTargetId,
  testServer: serverState.testServer,
  openNginxRuntime: serverState.openNginxRuntime,
  openEditServer: serverState.openEditServer,
  deleteServer: serverState.deleteServer,
  openPublishConfirm: progressState.openPublishConfirm,
  openOpenApi: openApiState.openOpenApi,
  runServiceAction: progressState.runTargetServiceAction,
  openServiceLogs: targetState.openTargetServiceLogs,
  openTargetProgress: progressState.openTargetProgress,
  openNginxConfig: targetState.openNginxConfig,
  openEditTarget: targetState.openEditTarget,
  syncTargetSite: targetState.syncTargetSite,
  deleteTarget: targetState.deleteTarget,
  getTargetRuntimeSnapshot: targetState.getTargetRuntimeSnapshot,
  openRecordLogs: recordState.openRecordLogs,
  runRollback: progressState.runRollback,
  runUndoRollback: progressState.runUndoRollback,
});

// 提供全局 NginxDeployContext，解除跨 Hooks/组件依赖传递链路
provideNginxDeployContext({
  project,
  authState,
  userName,
  isLoggedIn,
  isAuthReady,
  ensureLoggedIn,
  openLoginModal,
  initAuthCheck,

  servers: serverState.servers,
  targets: targetState.targets,
  allTargets: targetState.allTargets,
  activeRecord: recordState.activeRecord,
  hasProjectContext: targetState.hasProjectContext,
  targetFormLoading: targetState.targetFormLoading,
  activeTargetId: targetState.activeTargetId,
  projectType,
  setProjectType,

  refreshActiveTab,
  refreshServerList: serverState.refreshServerList,
  refreshTargetList: targetState.refreshTargetList,
  refreshRecordList: recordState.refreshRecordList,
  resetRecordPage: recordState.resetRecordPage,

  targetRuntimeSnapshots: targetState.targetRuntimeSnapshots,
  setTargetRuntimeSnapshot: targetState.setTargetRuntimeSnapshot,
  clearTargetRuntimeSnapshot: targetState.clearTargetRuntimeSnapshot,
});

onMounted(() => {
  void lifecycleState.initPage();
});
</script>

<template>
  <div class="nginx-deploy-boundary">
    <NginxDeployWorkspace
      :project="project"
      :lifecycle-state="lifecycleState"
      :server-state="serverState"
      :target-state="targetState"
      :record-state="recordState"
      :progress-state="progressState"
      :server-action-config="serverActionConfig"
      :target-action-config="targetActionConfig"
      :record-action-config="recordActionConfig"
    />
    <NginxDeployOverlayHost
      :server-state="serverState"
      :target-state="targetState"
      :record-state="recordState"
      :progress-state="progressState"
      :open-api-state="openApiState"
    />
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
