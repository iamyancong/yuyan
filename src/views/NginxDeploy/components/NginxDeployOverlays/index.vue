<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import type { DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';

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

/** 各业务弹层完全按需异步加载，阻断首开大包与 Monaco 等重型依赖 */
const ProgressPanel = defineAsyncComponent(() => import('../ProgressPanel/index.vue'));
const PublishConfirmModal = defineAsyncComponent(() => import('../PublishConfirmModal/index.vue'));
const NginxConfigDrawer = defineAsyncComponent(() => import('../NginxConfigDrawer/index.vue'));
const RecordLogDrawer = defineAsyncComponent(() => import('../RecordLogDrawer/index.vue'));
const DeployTargetConfigModal = defineAsyncComponent(() => import('../DeployTargetConfigModal/index.vue'));
const ServerDeployOverlays = defineAsyncComponent(() => import('../ServerDeployOverlays/index.vue'));
const BackendDeployOverlays = defineAsyncComponent(() => import('../BackendDeployOverlays/index.vue'));
const BackendServiceProgressModal = defineAsyncComponent(() => import('../BackendServiceProgressModal/index.vue'));

/** 首次激活保活状态，未激活前零下载零挂载，关闭后保持保活避免重新渲染 */
const serverOverlaysEverOpened = ref(false);
const targetModalEverOpened = ref(false);
const publishConfirmEverOpened = ref(false);
const rollbackProgressEverOpened = ref(false);
const nginxConfigEverOpened = ref(false);
const recordLogEverOpened = ref(false);
const backendOverlaysEverOpened = ref(false);

watch(
  () => Boolean(props.serverState?.serverModalOpen?.value || props.serverState?.runtimeDrawerOpen?.value),
  (val) => {
    if (val && !serverOverlaysEverOpened.value) serverOverlaysEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.targetState?.targetModalOpen?.value),
  (val) => {
    if (val && !targetModalEverOpened.value) targetModalEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.progressState?.publishConfirmOpen?.value),
  (val) => {
    if (val && !publishConfirmEverOpened.value) publishConfirmEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.progressState?.rollbackProgressOpen?.value),
  (val) => {
    if (val && !rollbackProgressEverOpened.value) rollbackProgressEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.targetState?.nginxTargetId?.value),
  (val) => {
    if (val && !nginxConfigEverOpened.value) nginxConfigEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.recordState?.recordLogOpen?.value),
  (val) => {
    if (val && !recordLogEverOpened.value) recordLogEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () =>
    Boolean(
      props.openApiState?.drawerOpen?.value ||
        props.targetState?.serviceLogOpen?.value ||
        props.targetState?.javaManagerOpen?.value ||
        props.targetState?.environmentManagerOpen?.value
    ),
  (val) => {
    if (val && !backendOverlaysEverOpened.value) backendOverlaysEverOpened.value = true;
  },
  { immediate: true }
);

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
  <ServerDeployOverlays
    v-if="serverOverlaysEverOpened"
    :server-state="serverState"
  />

  <DeployTargetConfigModal
    v-if="targetModalEverOpened"
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
    v-if="publishConfirmEverOpened"
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
    :operator="progressState.progressState.operator"
    :started-at="progressState.progressState.startedAt"
    :current-user-name="progressState.userName?.value"
    :user-role="progressState.userRole?.value"
    @start="progressState.startPublishFromConfirm"
    @republish="progressState.republishFromConfirm"
    @stop="progressState.stopCurrentPublish"
  />

  <template v-if="rollbackProgressEverOpened">
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
  </template>

  <NginxConfigDrawer
    v-if="nginxConfigEverOpened"
    v-model:targetId="targetState.nginxTargetId.value"
    :target="activeNginxTarget"
    @save="targetState.handleSaveNginxConf"
  />

  <RecordLogDrawer
    v-if="recordLogEverOpened"
    v-model:open="recordState.recordLogOpen.value"
    :record="recordState.activeRecord.value"
    :loading="recordState.recordLogLoading.value"
  />

  <BackendDeployOverlays
    v-if="backendOverlaysEverOpened"
    :server-state="serverState"
    :target-state="targetState"
    :open-api-state="openApiState"
  />
</template>
