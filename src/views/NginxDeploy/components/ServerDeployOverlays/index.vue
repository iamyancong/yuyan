<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue';
import type { DeployServerPayload, NginxInstancePayload, NginxRuntimePayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';

defineOptions({ name: 'ServerDeployOverlays' });

const props = defineProps<{ serverState: Record<string, any> }>();

/** 抽屉组件按需异步加载，避免相互污染与整包加载 */
const ServerConfigDrawer = defineAsyncComponent(() => import('../ServerConfigDrawer/index.vue'));
const NginxRuntimeDrawer = defineAsyncComponent(() => import('../NginxRuntimeDrawer/index.vue'));

/** 首次激活标记，确保首次打开前零下载，关闭后常驻保活 */
const serverModalEverOpened = ref(false);
const runtimeDrawerEverOpened = ref(false);

watch(
  () => Boolean(props.serverState?.serverModalOpen?.value),
  (val) => {
    if (val && !serverModalEverOpened.value) serverModalEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.serverState?.runtimeDrawerOpen?.value),
  (val) => {
    if (val && !runtimeDrawerEverOpened.value) runtimeDrawerEverOpened.value = true;
  },
  { immediate: true }
);

/** 同步服务器 Formily 实例。 */
const setServerFormRef = (instance: FormilyRef | null) => {
  props.serverState.serverFormRef.value = instance;
};

/** 更新服务器表单值。 */
const updateServerForm = (values: Partial<DeployServerPayload>) => {
  Object.assign(props.serverState.serverForm, values || {});
};

/** 更新 Nginx 运行时表单值。 */
const updateRuntimeForm = (values: Partial<NginxRuntimePayload>) => {
  Object.assign(props.serverState.runtimeForm, values || {});
};

/** 更新 Nginx 实例表单值。 */
const updateRuntimeInstanceForm = (values: Partial<NginxInstancePayload>) => {
  Object.assign(props.serverState.runtimeInstanceForm, values || {});
};
</script>

<template>
  <ServerConfigDrawer
    v-if="serverModalEverOpened"
    v-model:open="serverState.serverModalOpen.value"
    :saving="serverState.serverSaving.value"
    :form-key="serverState.serverFormKey.value"
    :form="serverState.serverForm"
    @update:form="updateServerForm"
    @form-ref-change="setServerFormRef"
    @save="serverState.saveServer"
  />
  <NginxRuntimeDrawer
    v-if="runtimeDrawerEverOpened"
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
    :archive-selection-open="serverState.archiveSelectionOpen.value"
    :archive-selection-loading="serverState.archiveSelectionLoading.value"
    :archive-selection-type="serverState.archiveSelectionType.value"
    :archive-config-path="serverState.archiveConfigPath.value"
    :archive-sites="serverState.archiveSites.value"
    :instance-form-open="serverState.runtimeInstanceFormOpen.value"
    :instance-form-editing-id="serverState.runtimeInstanceEditingId.value"
    :instance-saving="serverState.runtimeInstanceSaving.value"
    :instance-form="serverState.runtimeInstanceForm"
    :progress="serverState.runtimeProgressState"
    @update:form="updateRuntimeForm"
    @update:instance-form-open="(value: boolean) => (serverState.runtimeInstanceFormOpen.value = value)"
    @update:instance-form="updateRuntimeInstanceForm"
    @change-server="(serverId: number) => {
      const target = serverState.servers.value.find((server: any) => server.id === serverId);
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
    @update:archive-selection-open="(value: boolean) => (serverState.archiveSelectionOpen.value = value)"
    @refresh-archive-sites="serverState.refreshArchiveSites"
    @confirm-archive-download="serverState.confirmArchiveDownload"
    @refresh="serverState.refreshRuntimeStatus"
  />
</template>
