<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, unref, watch } from 'vue';

defineOptions({ name: 'NginxDeployOverlayHost' });

/** 部署中心弹层宿主属性 */
interface NginxDeployOverlayHostProps {
  lifecycleState?: Record<string, any>;
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
    unref(props.serverState?.serverModalOpen) ||
      unref(props.serverState?.runtimeDrawerOpen) ||
      unref(props.targetState?.targetModalOpen) ||
      unref(props.targetState?.nginxTargetId) ||
      unref(props.targetState?.serviceLogOpen) ||
      unref(props.targetState?.javaManagerOpen) ||
      unref(props.targetState?.environmentManagerOpen) ||
      unref(props.recordState?.recordLogOpen) ||
      unref(props.progressState?.publishConfirmOpen) ||
      unref(props.progressState?.rollbackProgressOpen) ||
      unref(props.progressState?.rollbackConfirmOpen) ||
      unref(props.openApiState?.drawerOpen)
  )
);

/** 首次有任意弹层打开后保持保活，避免全部关闭后整树卸载销毁导致二次打开重新渲染与保活失效 */
const hasEverOpened = ref(false);
watch(
  hasVisibleOverlay,
  (visible) => {
    if (visible && !hasEverOpened.value) {
      hasEverOpened.value = true;
    }
  },
  { immediate: true }
);

/**
 * 首屏挂载后利用浏览器空闲调度预加载核心抽屉与弹层 chunk，消除首次点击时的网络拉取顿挫
 */
onMounted(() => {
  const scheduleIdlePrefetch = window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1200));
  scheduleIdlePrefetch(() => {
    void import('../NginxDeployOverlays/index.vue');
    void import('../ServerConfigDrawer/index.vue');
    void import('../NginxRuntimeDrawer/index.vue');
    void import('../DeployTargetConfigModal/index.vue');
  });
});
</script>

<template>
  <NginxDeployOverlays
    v-if="hasEverOpened"
    :lifecycle-state="lifecycleState"
    :server-state="serverState"
    :target-state="targetState"
    :record-state="recordState"
    :progress-state="progressState"
    :open-api-state="openApiState"
  />
</template>
