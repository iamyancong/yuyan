<script setup lang="ts">
import AiControlIcon from './AiControlIcon.vue';

defineOptions({ name: 'AiIntegrationTrigger' });

const emit = defineEmits<{
  /** 打开 AI 控制中心。 */
  (event: 'open'): void;
}>();

/** 打开 AI 控制中心并阻止桌面标题栏拖拽接管点击。 */
const handleOpen = (event: MouseEvent) => {
  event.stopPropagation();
  emit('open');
};
</script>

<template>
  <a-button
    type="text"
    class="header-action-btn btn-ai-control"
    aria-label="打开 AI 控制中心"
    @click="handleOpen"
  >
    <template #icon>
      <AiControlIcon class="action-icon" />
    </template>
  </a-button>
</template>
