<script setup lang="ts">
import { computed } from 'vue';
import type { DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';
import ProgressPanel from '../ProgressPanel/index.vue';
import PublishConfirmModal from '../PublishConfirmModal/index.vue';
import NginxConfigDrawer from '../NginxConfigDrawer/index.vue';
import RecordLogDrawer from '../RecordLogDrawer/index.vue';
import DeployTargetConfigModal from '../DeployTargetConfigModal/index.vue';
import ServerDeployOverlays from '../ServerDeployOverlays/index.vue';
import BackendDeployOverlays from '../BackendDeployOverlays/index.vue';
import BackendServiceProgressModal from '../BackendServiceProgressModal/index.vue';

defineOptions({ name: 'NginxDeployOverlays' });

/** 部署中心弹窗容器属性 */
interface NginxDeployOverlaysProps {
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  recordState: Record<string, any>;
  progressState: Record<string, any>;
  openApiState: Record<string, any>;
}

const props = defineProps<NginxDeployOverlaysProps>();

const activeNginxTarget = computed(() => {
  const targetId = Number(props.targetState.nginxTargetId.value || 0);
  return props.targetState.targets.value.find((target: any) => target.id === targetId) || null;
});

/** 当前是否为后端服务启停操作 */
const isBackendServiceProgress = computed(() => ['start', 'stop', 'restart'].includes(props.progressState.progressMode.value));

/**
 * 同步部署目标 Formily 实例。
 * @param instance 表单实例
 */
const setTargetFormRef = (instance: FormilyRef | null) => {
  props.targetState.targetFormRef.value = instance;
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
  <ServerDeployOverlays :server-state="serverState" />
  <DeployTargetConfigModal
    v-model:open="targetState.targetModalOpen.value"
    :saving="targetState.targetSaving.value"
    :loading="targetState.targetFormLoading.value"
    :form="targetState.targetFormModel.value"
    :schema="targetState.targetSchema"
    :target-id="targetState.activeTargetId.value"
    @update:form="updateTargetForm"
    @form-ref-change="setTargetFormRef"
    @inspect="targetState.inspectActiveBackendTarget"
    @manage-java="targetState.openJavaManager"
    @manage-environment="targetState.openEnvironmentManager"
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

  <BackendServiceProgressModal
    v-if="isBackendServiceProgress"
    v-model:open="progressState.rollbackProgressOpen.value"
    :action="progressState.progressMode.value"
    :target="progressState.activePublishTarget.value"
    :percent="progressState.progressState.percent"
    :title="progressState.progressState.title"
    :detail="progressState.progressState.detail"
    :logs="progressState.progressState.logs"
    :running="progressState.progressState.running"
  />

  <a-modal
    v-else
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
  <BackendDeployOverlays :server-state="serverState" :target-state="targetState" :open-api-state="openApiState" />
</template>
