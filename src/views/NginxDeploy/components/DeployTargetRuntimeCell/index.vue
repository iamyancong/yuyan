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

/** 后端服务状态展示信息 */
const serviceState = computed(() => {
  if (props.record.projectType !== 'backend') return { title: '空闲', detail: '可操作', className: '' };
  const states = {
    online: { title: '在线', detail: `端口 ${props.record.serverPort || '-'}`, className: 'is-online' },
    offline: { title: '离线', detail: '可启动', className: 'is-offline' },
    starting: { title: '启动中', detail: '等待健康检查', className: 'is-transitioning' },
    stopping: { title: '停止中', detail: '等待进程退出', className: 'is-transitioning' },
    deploying: { title: '发布中', detail: '版本切换中', className: 'is-transitioning' },
    error: { title: '异常', detail: '请查看日志', className: 'is-error' },
    unknown: { title: '未知', detail: '等待探测', className: 'is-unknown' },
  } as const;
  return states[props.record.serviceStatus || 'unknown'];
});

/** 当前任务操作类型 */
const actionLabel = computed(() => getDeployProgressActionLabel(snapshot.value?.action));

/** 当前任务阶段 */
const stageLabel = computed(() => getDeployProgressStageLabel(snapshot.value));

/** 运行中阶段与发起人展示文案 */
const runningDetailText = computed(() => {
  const operator = String(snapshot.value?.operator || '').trim();
  if (operator) {
    return `${operator} · ${stageLabel.value}`;
  }
  return stageLabel.value;
});

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
  if (!running.value) {
    if (props.record.projectType !== 'backend') return '当前没有运行中的发布或回滚任务';
    return props.record.serviceStatusOutput || `后端服务状态：${serviceState.value.title}`;
  }
  const operator = String(snapshot.value?.operator || '').trim() || '未知操作人';
  return `${operator}发起${actionLabel.value}，当前阶段：${stageLabel.value}，开始于 ${formatDeployDateTime(snapshot.value?.startedAt)}`;
});
const emit = defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <a-tooltip :title="tooltipTitle" placement="top">
    <span
      class="target-runtime-cell"
      :class="[serviceState.className, { 'is-running': running, 'is-clickable': running }]"
      :style="progressStyle"
      @click="running && emit('click')"
    >
      <span class="target-runtime-cell__indicator">
        <span v-if="running" class="target-runtime-cell__spinner">
          <LoadingOutlined />
        </span>
        <span v-else class="target-runtime-cell__dot" />
      </span>
      <span class="target-runtime-cell__content">
        <strong>{{ running ? `正在${actionLabel}` : serviceState.title }}</strong>
        <small>{{ running ? runningDetailText : serviceState.detail }}</small>
      </span>
      <span v-if="running" class="target-runtime-cell__progress" />
    </span>
  </a-tooltip>
</template>

<style scoped lang="less">
@import './style.less';
</style>
