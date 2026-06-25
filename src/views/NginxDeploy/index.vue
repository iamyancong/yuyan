<script setup lang="ts">
import { onMounted } from 'vue';
import '@ycwang-dev/components/dist/style.css';
import { useYssVxeUI } from '@/composables/useYssVxeUI';
import NginxDeployWorkspace from './components/NginxDeployWorkspace/index.vue';
import NginxDeployOverlays from './components/NginxDeployOverlays/index.vue';
import {
  useNginxDeployActions,
  useNginxDeployAuth,
  useNginxDeployLifecycle,
  useNginxDeployProgress,
  useNginxDeployProjectContext,
  useNginxDeployRecords,
  useNginxDeployServers,
  useNginxDeployTargets,
} from './hooks/useNginxDeploy';
import { provideNginxDeployContext } from './hooks/useNginxDeployContext';
import type { RefreshActiveTabOptions } from './types';

defineOptions({ name: 'NginxDeploy' });

useYssVxeUI();

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
});
const recordState = useNginxDeployRecords({
  project,
  hasProjectContext: targetState.hasProjectContext,
  allTargets: targetState.allTargets,
  authState,
  ensureLoggedIn,
  refreshActiveTab,
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
  isLoggedIn,
  isAuthReady,
  ensureLoggedIn,
  initAuthCheck,
  openLoginModal,
  refreshTargetList: targetState.refreshTargetList,
  refreshServerList: serverState.refreshServerList,
  refreshRecordList: recordState.refreshRecordList,
  resetRecordPage: recordState.resetRecordPage,
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
      :server-action-config="serverActionConfig"
      :target-action-config="targetActionConfig"
      :record-action-config="recordActionConfig"
    />
    <NginxDeployOverlays
      :server-state="serverState"
      :target-state="targetState"
      :record-state="recordState"
      :progress-state="progressState"
    />
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
