<script setup lang="ts">
import { computed } from 'vue';
import { ApiOutlined, DesktopOutlined } from '@ant-design/icons-vue';

defineOptions({ name: 'ProjectTypeIcon' });

/** 项目类型图标属性 */
interface ProjectTypeIconProps {
  /** 项目类型 */
  type?: 'frontend' | 'backend';
  /** 是否使用紧凑尺寸 */
  compact?: boolean;
}

const props = defineProps<ProjectTypeIconProps>();

/** 是否为后端项目 */
const isBackend = computed(() => props.type === 'backend');

/** 图标无障碍说明 */
const iconLabel = computed(() => (isBackend.value ? '后端服务' : '前端应用'));
</script>

<template>
  <span
    class="project-type-icon"
    :class="{ 'is-backend': isBackend, 'is-compact': compact }"
    role="img"
    :aria-label="iconLabel"
    :title="iconLabel"
  >
    <ApiOutlined v-if="isBackend" />
    <DesktopOutlined v-else />
    <i class="project-type-icon__signal" aria-hidden="true" />
  </span>
</template>

<style scoped lang="less">
@import './style.less';
</style>
