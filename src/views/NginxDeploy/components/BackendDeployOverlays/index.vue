<script setup lang="ts">
import OpenApiDrawer from '../OpenApiDrawer/index.vue';
import BackendServiceLogDrawer from '../BackendServiceLogDrawer/index.vue';
import BackendJavaManagerDrawer from '../BackendJavaManagerDrawer/index.vue';
import BackendEnvironmentDrawer from '../BackendEnvironmentDrawer/index.vue';

defineOptions({ name: 'BackendDeployOverlays' });

defineProps<{
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  openApiState: Record<string, any>;
}>();
</script>

<template>
  <OpenApiDrawer
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
    v-model:open="targetState.serviceLogOpen.value"
    :target="targetState.serviceLogTarget.value"
    :content="targetState.serviceLogContent.value"
    :loading="targetState.serviceLogLoading.value"
    @refresh="targetState.refreshTargetServiceLogs"
  />
  <BackendJavaManagerDrawer
    v-model:open="targetState.javaManagerOpen.value"
    v-model:server-id="targetState.javaManagerServerId.value"
    :servers="serverState.servers.value"
    @updated="targetState.refreshBuildJdks"
    @select-build-jdk="targetState.selectBuildJdk"
    @select-runtime="targetState.selectServerRuntime"
  />
  <BackendEnvironmentDrawer
    v-model:open="targetState.environmentManagerOpen.value"
    :selected-environment-id="Number(targetState.targetForm?.environmentId || 0)"
    @updated="targetState.refreshDeployEnvironments"
    @select="targetState.selectDeployEnvironment"
  />
</template>
