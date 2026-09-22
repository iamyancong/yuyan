<script setup lang="ts">
import { computed, defineAsyncComponent, ref, unref, watch } from 'vue';
import { YButton } from '@yss-ui/components/lite';
import { openExternal } from '@/utils/open';
import type { DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';

defineOptions({ name: 'NginxDeployOverlays' });

/** 部署中心弹窗容器属性 */
interface NginxDeployOverlaysProps {
  lifecycleState?: Record<string, any>;
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
const RollbackConfirmModal = defineAsyncComponent(() => import('../RollbackConfirmModal/index.vue'));
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
const rollbackConfirmEverOpened = ref(false);
const rollbackProgressEverOpened = ref(false);
const nginxConfigEverOpened = ref(false);
const recordLogEverOpened = ref(false);
const backendOverlaysEverOpened = ref(false);

watch(
  () =>
    Boolean(
      unref(props.serverState?.serverModalOpen) ||
        unref(props.serverState?.runtimeDrawerOpen) ||
        unref(props.serverState?.fsDrawerOpen)
    ),
  (val) => {
    if (val && !serverOverlaysEverOpened.value) serverOverlaysEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(unref(props.targetState?.targetModalOpen)),
  (val) => {
    if (val && !targetModalEverOpened.value) targetModalEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(unref(props.progressState?.publishConfirmOpen)),
  (val) => {
    if (val && !publishConfirmEverOpened.value) publishConfirmEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(unref(props.progressState?.rollbackConfirmOpen)),
  (val) => {
    if (val && !rollbackConfirmEverOpened.value) rollbackConfirmEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(unref(props.progressState?.rollbackProgressOpen)),
  (val) => {
    if (val && !rollbackProgressEverOpened.value) rollbackProgressEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(unref(props.targetState?.nginxTargetId)),
  (val) => {
    if (val && !nginxConfigEverOpened.value) nginxConfigEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(unref(props.recordState?.recordLogOpen)),
  (val) => {
    if (val && !recordLogEverOpened.value) recordLogEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () =>
    Boolean(
      unref(props.openApiState?.drawerOpen) ||
        unref(props.targetState?.serviceLogOpen) ||
        unref(props.targetState?.javaManagerOpen) ||
        unref(props.targetState?.environmentManagerOpen)
    ),
  (val) => {
    if (val && !backendOverlaysEverOpened.value) backendOverlaysEverOpened.value = true;
  },
  { immediate: true }
);

/** 当前回滚/操作的目标访问地址 */
const currentRollbackTargetVisitUrl = computed(() => {
  const targetId =
    props.progressState?.activePublishTarget?.value?.id ||
    props.progressState?.activeRecord?.value?.targetId ||
    props.progressState?.pendingRollbackRecord?.value?.targetId;
  if (!targetId) return '';
  const found = props.targetState?.targets?.value?.find((t: any) => t.id === targetId);
  return found?.visitUrl || '';
});

/** 打开回滚后的站点 */
const openRollbackSite = async () => {
  if (currentRollbackTargetVisitUrl.value) {
    await openExternal(currentRollbackTargetVisitUrl.value);
  }
};

/** 跳转查看发布记录 */
const handleViewRecord = (target: any) => {
  props.progressState.publishConfirmOpen.value = false;
  if (props.recordState && target?.projectName) {
    props.recordState.recordProjectFilter.value = target.projectName;
    void props.recordState.handleRecordProjectChange?.(target.projectName);
  }
  if (props.lifecycleState) {
    props.lifecycleState.handleTabChange?.('records');
  }
};

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
    :central-unavailable="lifecycleState?.centralUnavailable.value"
    :result-unconfirmed="progressState.resultUnconfirmed.value"
    :can-verify-result="progressState.canVerifyResult.value"
    :verifying-result="progressState.verifyingResult.value"
    @verify-result="progressState.verifyResult"
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
    @view-record="handleViewRecord"
  />

  <RollbackConfirmModal
    v-if="rollbackConfirmEverOpened"
    v-model:open="progressState.rollbackConfirmOpen.value"
    :record="progressState.pendingRollbackRecord.value"
    :records="recordState?.records?.value || []"
    :action="progressState.pendingRollbackAction.value"
    :loading="progressState.progressState.running"
    @confirm="progressState.confirmRollback"
  />

  <template v-if="rollbackProgressEverOpened">
    <BackendServiceProgressModal
      v-if="isBackendServiceProgress"
      v-model:open="progressState.rollbackProgressOpen.value"
      :action="progressState.progressMode.value"
      :result-unconfirmed="progressState.resultUnconfirmed.value"
      :can-verify-result="progressState.canVerifyResult.value"
      :verifying-result="progressState.verifyingResult.value"
      @verify-result="progressState.verifyResult"
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
      :closable="!progressState.progressState.running"
      :maskClosable="!progressState.progressState.running"
    >
      <ProgressPanel
        :result-unconfirmed="progressState.resultUnconfirmed.value"
        :percent="progressState.progressState.percent"
        :title="progressState.progressState.title"
        :detail="progressState.progressState.detail"
        :logs="progressState.progressState.logs"
        :running="progressState.progressState.running"
      />
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <YButton
            v-if="!progressState.resultUnconfirmed.value && progressState.progressState.percent === 100 && currentRollbackTargetVisitUrl"
            type="primary"
            @click="openRollbackSite"
          >
            打开站点
          </YButton>
          <YButton v-if="progressState.resultUnconfirmed.value && progressState.canVerifyResult.value" :loading="progressState.verifyingResult.value" @click="progressState.verifyResult">核实任务结果</YButton>
          <YButton
            :disabled="progressState.progressState.running"
            @click="progressState.rollbackProgressOpen.value = false"
          >
            关闭
          </YButton>
        </div>
      </template>
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
