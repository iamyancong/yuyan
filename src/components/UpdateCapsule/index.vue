<script setup lang="ts">
import { computed } from 'vue';
import { useAppUpdate } from './hooks/useAppUpdate';
import { STATUS_CONFIG_MAP } from './constant';
import './style.less';

defineOptions({ name: 'UpdateCapsule' });

const { hasUpdate, updateState, updatePercent, handleCapsuleClick } = useAppUpdate();

/** 当前状态对应的配置 */
const config = computed(() => STATUS_CONFIG_MAP[updateState.value.status]);
</script>

<template>
  <div
    v-if="hasUpdate"
    class="update-capsule"
    :class="config.className"
    @click="handleCapsuleClick"
  >
    <!-- 左侧图标 -->
    <component :is="config.icon" class="capsule-icon" />

    <!-- 进度数字（下载中） -->
    <template v-if="updateState.status === 'downloading'">
      <span v-if="updatePercent > 0 && updatePercent < 100" class="progress-text">
        {{ updatePercent }}%
      </span>
      <span v-else class="capsule-label">{{ config.label }}</span>
      <div class="progress-bar-bg" :style="{ width: `${updatePercent}%` }"></div>
    </template>

    <!-- 其他状态文案 -->
    <span v-else class="capsule-label">{{ config.label }}</span>
  </div>
</template>
