<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue';

defineOptions({ name: 'BackendDeployOverlays' });

const props = defineProps<{
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  openApiState: Record<string, any>;
}>();

/** 各独立抽屉按需异步加载，避免轻量抽屉触发 Monaco 等重量依赖 */
const OpenApiDrawer = defineAsyncComponent(() => import('../OpenApiDrawer/index.vue'));
const BackendServiceLogDrawer = defineAsyncComponent(() => import('../BackendServiceLogDrawer/index.vue'));
const BackendJavaManagerDrawer = defineAsyncComponent(() => import('../BackendJavaManagerDrawer/index.vue'));
const BackendEnvironmentDrawer = defineAsyncComponent(() => import('../BackendEnvironmentDrawer/index.vue'));

const openApiEverOpened = ref(false);
const serviceLogEverOpened = ref(false);
const javaManagerEverOpened = ref(false);
const environmentManagerEverOpened = ref(false);

watch(
  () => Boolean(props.openApiState?.drawerOpen?.value),
  (val) => {
    if (val && !openApiEverOpened.value) openApiEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.targetState?.serviceLogOpen?.value),
  (val) => {
    if (val && !serviceLogEverOpened.value) serviceLogEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.targetState?.javaManagerOpen?.value),
  (val) => {
    if (val && !javaManagerEverOpened.value) javaManagerEverOpened.value = true;
  },
  { immediate: true }
);

watch(
  () => Boolean(props.targetState?.environmentManagerOpen?.value),
  (val) => {
    if (val && !environmentManagerEverOpened.value) environmentManagerEverOpened.value = true;
  },
  { immediate: true }
);
</script>

<template>
  <OpenApiDrawer
    v-if="openApiEverOpened"
    v-model:open="openApiState.drawerOpen.value"
    :target="openApiState.activeTarget.value"
    :artifact="openApiState.artifact.value"
    :content="openApiState.content.value"
    :loading="openApiState.loading.value"
    :generating="openApiState.generating.value"
    :error-message="openApiState.errorMessage.value"
    :percent="openApiState.percent.value"
    :stage-text="openApiState.stageText.value"
    :log-content="openApiState.logContent.value"
    @generate="openApiState.generateOpenApi(true)"
    @cancel="openApiState.cancelOpenApi"
    @download="openApiState.downloadOpenApi"
  />
  <BackendServiceLogDrawer
    v-if="serviceLogEverOpened"
    v-model:open="targetState.serviceLogOpen.value"
    :target="targetState.serviceLogTarget.value"
    :content="targetState.serviceLogContent.value"
    :loading="targetState.serviceLogLoading.value"
    @refresh="targetState.refreshTargetServiceLogs"
  />
  <BackendJavaManagerDrawer
    v-if="javaManagerEverOpened"
    v-model:open="targetState.javaManagerOpen.value"
    v-model:server-id="targetState.javaManagerServerId.value"
    :servers="serverState.servers.value"
    @updated="targetState.refreshBuildJdks"
    @select-build-jdk="targetState.selectBuildJdk"
    @select-runtime="targetState.selectServerRuntime"
  />
  <BackendEnvironmentDrawer
    v-if="environmentManagerEverOpened"
    v-model:open="targetState.environmentManagerOpen.value"
    :selected-environment-id="Number(targetState.targetForm?.environmentId || 0)"
    @updated="targetState.refreshDeployEnvironments"
    @select="targetState.selectDeployEnvironment"
  />
</template>
