<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue';

defineOptions({ name: 'NginxDeployOverlayHost' });

/** 部署中心弹层宿主属性 */
interface NginxDeployOverlayHostProps {
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  recordState: Record<string, any>;
  progressState: Record<string, any>;
  openApiState: Record<string, any>;
}

const props = defineProps<NginxDeployOverlayHostProps>();

/** 重型弹窗与抽屉仅在首次打开时加载 */
const NginxDeployOverlays = defineAsyncComponent(() => import('../NginxDeployOverlays/index.vue'));

/** 当前是否存在需要渲染的部署弹层 */
const hasVisibleOverlay = computed(() =>
  Boolean(
    props.serverState.serverModalOpen.value ||
      props.serverState.runtimeDrawerOpen.value ||
      props.targetState.targetModalOpen.value ||
      props.targetState.nginxTargetId.value ||
      props.targetState.serviceLogOpen.value ||
      props.targetState.javaManagerOpen.value ||
      props.targetState.environmentManagerOpen.value ||
      props.recordState.recordLogOpen.value ||
      props.progressState.publishConfirmOpen.value ||
      props.progressState.rollbackProgressOpen.value ||
      props.openApiState.drawerOpen.value
  )
);
</script>

<template>
  <NginxDeployOverlays
    v-if="hasVisibleOverlay"
    :server-state="serverState"
    :target-state="targetState"
    :record-state="recordState"
    :progress-state="progressState"
    :open-api-state="openApiState"
  />
</template>
