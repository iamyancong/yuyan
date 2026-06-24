<script setup lang="ts">
import { computed } from 'vue';
import { LoadingOutlined } from '@ant-design/icons-vue';
import { formatDeployDateTime, getDeployProgressActionLabel, getDeployProgressStageLabel } from '../../constant';
import type { RuntimeAwareDeployTarget } from '../../types';

defineOptions({ name: 'DeployTargetRuntimeCell' });

/** 部署目标运行态单元格属性 */
interface DeployTargetRuntimeCellProps {
  record: RuntimeAwareDeployTarget;
}

const props = defineProps<DeployTargetRuntimeCellProps>();

const snapshot = computed(() => props.record.runtimeSnapshot);

/** 是否存在运行中任务 */
const running = computed(() => Boolean(snapshot.value?.running));

/** 当前任务操作类型 */
const actionLabel = computed(() => getDeployProgressActionLabel(snapshot.value?.action));

/** 当前任务阶段 */
const stageLabel = computed(() => getDeployProgressStageLabel(snapshot.value));

/** 当前任务进度百分比 */
const progressPercent = computed(() => {
  const stageEvent = [...(snapshot.value?.events || [])].reverse().find((event) => event.type === 'stage');
  if (stageEvent?.type === 'stage') return Math.min(Math.max(stageEvent.percent, 0), 100);
  return running.value ? 4 : 0;
});

/** 运行态进度条样式变量 */
const progressStyle = computed(() => ({
  '--runtime-progress': `${progressPercent.value}%`,
}));

/** 运行态悬浮提示 */
const tooltipTitle = computed(() => {
  if (!running.value) return '当前没有运行中的发布或回滚任务';
  const operator = String(snapshot.value?.operator || '').trim() || '未知操作人';
  return `${operator}发起${actionLabel.value}，当前阶段：${stageLabel.value}，开始于 ${formatDeployDateTime(snapshot.value?.startedAt)}`;
});
</script>

<template>
  <a-tooltip :title="tooltipTitle" placement="top">
    <span class="target-runtime-cell" :class="{ 'is-running': running }" :style="progressStyle">
      <span class="target-runtime-cell__indicator">
        <span v-if="running" class="target-runtime-cell__spinner">
          <LoadingOutlined />
        </span>
        <span v-else class="target-runtime-cell__dot" />
      </span>
      <span class="target-runtime-cell__content">
        <strong>{{ running ? `正在${actionLabel}` : '空闲' }}</strong>
        <small>{{ running ? stageLabel : '可操作' }}</small>
      </span>
      <span v-if="running" class="target-runtime-cell__progress" />
    </span>
  </a-tooltip>
</template>

<style scoped lang="less">
@import './style.less';
</style>
