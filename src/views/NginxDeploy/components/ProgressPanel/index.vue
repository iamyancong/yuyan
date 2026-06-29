<script setup lang="ts">
import type { DeployProgressEvent } from '@/api/deploy';
import { getLogText } from './constant';

defineOptions({ name: 'DeployProgressPanel' });

/** 属性定义 */
defineProps<{
  percent: number;
  title: string;
  detail: string;
  logs: DeployProgressEvent[];
  running: boolean;
}>();
</script>

<template>
  <div class="deploy-progress-panel">
    <a-progress :percent="percent" :status="running ? 'active' : percent >= 100 ? 'success' : 'normal'" />
    <div class="deploy-progress-title">{{ title || '等待执行' }}</div>
    <div class="deploy-progress-detail">{{ detail }}</div>
    <div class="deploy-progress-logs">
      <div
        v-for="(item, index) in logs"
        :key="`${item.timestamp}-${index}`"
        :class="['deploy-progress-log', `is-${item.type}`]"
      >
        {{ getLogText(item) }}
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
