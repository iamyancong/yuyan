<script setup lang="ts">
import { computed } from 'vue';
import type { DeployServerPayload, DeployTargetPayload, NginxInstancePayload, NginxRuntimePayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';
import ProgressPanel from '../ProgressPanel/index.vue';
import PublishConfirmModal from '../PublishConfirmModal/index.vue';
import NginxConfigDrawer from '../NginxConfigDrawer/index.vue';
import NginxRuntimeDrawer from '../NginxRuntimeDrawer/index.vue';
import RecordLogDrawer from '../RecordLogDrawer/index.vue';
import ServerConfigDrawer from '../ServerConfigDrawer/index.vue';
import DeployTargetConfigModal from '../DeployTargetConfigModal/index.vue';

defineOptions({ name: 'NginxDeployOverlays' });

/** 部署中心弹窗容器属性 */
interface NginxDeployOverlaysProps {
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  recordState: Record<string, any>;
  progressState: Record<string, any>;
}

const props = defineProps<NginxDeployOverlaysProps>();

const activeNginxTarget = computed(() => {
  const targetId = Number(props.targetState.nginxTargetId.value || 0);
  return props.targetState.targets.value.find((target: any) => target.id === targetId) || null;
});

/**
 * 同步服务器 Formily 实例。
 * @param instance 表单实例
 */
const setServerFormRef = (instance: FormilyRef | null) => {
  props.serverState.serverFormRef.value = instance;
};

/**
 * 同步部署目标 Formily 实例。
 * @param instance 表单实例
 */
const setTargetFormRef = (instance: FormilyRef | null) => {
  props.targetState.targetFormRef.value = instance;
};

/**
 * 更新服务器表单值。
 * @param values 表单值
 */
const updateServerForm = (values: Partial<DeployServerPayload>) => {
  Object.assign(props.serverState.serverForm, values || {});
};

/**
 * 更新 Nginx 运行时表单值。
 * @param values 表单值
 */
const updateRuntimeForm = (values: Partial<NginxRuntimePayload>) => {
  Object.assign(props.serverState.runtimeForm, values || {});
};

/**
 * 更新 Nginx 实例表单值。
 * @param values 表单值
 */
const updateRuntimeInstanceForm = (values: Partial<NginxInstancePayload>) => {
  Object.assign(props.serverState.runtimeInstanceForm, values || {});
};

/**
 * 更新部署目标表单值。
 * @param values 表单值
 */
const updateTargetForm = (values: Partial<DeployTargetPayload>) => {
  Object.assign(props.targetState.targetForm, values || {});
};
</script>

<template>
  <ServerConfigDrawer
    v-model:open="serverState.serverModalOpen.value"
    :saving="serverState.serverSaving.value"
    :form-key="serverState.serverFormKey.value"
    :form="serverState.serverForm"
    @update:form="updateServerForm"
    @form-ref-change="setServerFormRef"
    @save="serverState.saveServer"
  />
  <NginxRuntimeDrawer
    v-model:open="serverState.runtimeDrawerOpen.value"
    :servers="serverState.servers.value"
    :server="serverState.runtimeServer.value"
    :instances="serverState.runtimeInstances.value"
    :active-instance-id="serverState.activeNginxInstanceId.value"
    :status="serverState.runtimeStatus.value"
    :form="serverState.runtimeForm"
    :loading="serverState.runtimeLoading.value"
    :initializing="serverState.runtimeInitializing.value"
    :action-loading="serverState.runtimeActionLoading.value"
    :archive-downloading="serverState.runtimeArchiveDownloading.value"
    :instance-form-open="serverState.runtimeInstanceFormOpen.value"
    :instance-form-key="serverState.runtimeInstanceFormKey.value"
    :instance-saving="serverState.runtimeInstanceSaving.value"
    :instance-form="serverState.runtimeInstanceForm"
    :progress="serverState.runtimeProgressState"
    @update:form="updateRuntimeForm"
    @update:instance-form-open="(value: boolean) => (serverState.runtimeInstanceFormOpen.value = value)"
    @update:instance-form="updateRuntimeInstanceForm"
    @change-server="(serverId: number) => {
      const target = serverState.servers.value.find((s: any) => s.id === serverId);
      if (target) serverState.switchRuntimeServer(target);
    }"
    @select-instance="serverState.selectNginxInstance"
    @create-instance="serverState.createServerNginxInstance"
    @edit-instance="serverState.openEditNginxInstance"
    @save-instance="serverState.saveActiveNginxInstance"
    @delete-instance="serverState.deleteActiveNginxInstance"
    @init="serverState.initServerNginxRuntime"
    @action="serverState.runServerNginxRuntimeAction"
    @download-archive="serverState.downloadActiveNginxArchive"
    @refresh="serverState.refreshRuntimeStatus"
  />
  <DeployTargetConfigModal
    v-model:open="targetState.targetModalOpen.value"
    :saving="targetState.targetSaving.value"
    :loading="targetState.targetFormLoading.value"
    :form="targetState.targetFormModel.value"
    :schema="targetState.targetSchema"
    @update:form="updateTargetForm"
    @form-ref-change="setTargetFormRef"
    @save="targetState.saveTarget"
  />
  <PublishConfirmModal
    v-model:open="progressState.publishConfirmOpen.value"
    :target="progressState.activePublishTarget.value"
    :percent="progressState.progressState.percent"
    :title="progressState.progressState.title"
    :detail="progressState.progressState.detail"
    :logs="progressState.progressState.logs"
    :running="progressState.progressState.running"
    :started="progressState.publishStarted.value"
    :stopped="progressState.progressState.stopped"
    :stoppable="progressState.publishStoppable.value"
    :stopping="progressState.publishStopping.value"
    @start="progressState.startPublishFromConfirm"
    @republish="progressState.republishFromConfirm"
    @stop="progressState.stopCurrentPublish"
  />

  <a-modal
    v-model:open="progressState.rollbackProgressOpen.value"
    :title="progressState.rollbackProgressTitle.value"
    width="860px"
    :bodyStyle="{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto', padding: '24px' }"
    style="top: 40px"
    :footer="null"
    :closable="!progressState.progressState.running"
    :maskClosable="!progressState.progressState.running"
  >
    <ProgressPanel
      :percent="progressState.progressState.percent"
      :title="progressState.progressState.title"
      :detail="progressState.progressState.detail"
      :logs="progressState.progressState.logs"
      :running="progressState.progressState.running"
    />
  </a-modal>

  <NginxConfigDrawer
    v-model:targetId="targetState.nginxTargetId.value"
    :target="activeNginxTarget"
    @save="targetState.handleSaveNginxConf"
  />
  <RecordLogDrawer
    v-model:open="recordState.recordLogOpen.value"
    :record="recordState.activeRecord.value"
    :loading="recordState.recordLogLoading.value"
  />
</template>
