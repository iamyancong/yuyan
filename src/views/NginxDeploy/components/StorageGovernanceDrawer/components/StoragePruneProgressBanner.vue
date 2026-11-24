<script setup lang="ts">
import { computed } from 'vue';
import { StopOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { StoragePruneJobSnapshot } from '@/api/deploy';
import { formatStorageBytes } from '../constant';

defineOptions({ name: 'StoragePruneProgressBanner' });

/** 异步存储清理实时进度横幅属性 */
interface StoragePruneProgressBannerProps {
  /** 当前展示的异步清理任务快照 */
  job: StoragePruneJobSnapshot;
}

const props = defineProps<StoragePruneProgressBannerProps>();

const emit = defineEmits<{
  /** 用户点击停止清理 */
  (e: 'cancel'): void;
  /** 关闭已完成/失败/取消状态横幅 */
  (e: 'dismiss'): void;
}>();

const isRunning = computed(() => props.job.status === 'running');

const progressStatus = computed<'active' | 'success' | 'exception' | 'normal'>(() => {
  if (props.job.status === 'running') return 'active';
  if (props.job.status === 'succeeded') return 'success';
  if (props.job.status === 'failed') return 'exception';
  return 'normal';
});

const summaryMeta = computed(() => {
  const parts: string[] = [];
  if (props.job.totalApps > 0) {
    parts.push(`应用 ${props.job.completedApps}/${props.job.totalApps}`);
  }
  if (props.job.deletedBackups > 0) {
    parts.push(`已删 ${props.job.deletedBackups} 份备份`);
  }
  if (props.job.freedBytes > 0) {
    parts.push(`释放约 ${formatStorageBytes(props.job.freedBytes)}`);
  }
  if (props.job.casGc && props.job.casGc.deletedObjects > 0) {
    parts.push(`回收 ${props.job.casGc.deletedObjects} 个对象`);
  }
  return parts.join(' · ');
});
</script>

<template>
  <div class="sg-progress-banner" :class="`sg-progress-banner--${job.status}`">
    <div class="sg-progress-banner__header">
      <div class="sg-progress-banner__title">
        <span class="sg-progress-banner__phase">{{ job.phaseLabel || '正在执行存储清理…' }}</span>
        <span v-if="summaryMeta" class="sg-progress-banner__meta">{{ summaryMeta }}</span>
      </div>
      <div class="sg-progress-banner__actions">
        <YButton
          v-if="isRunning"
          size="small"
          danger
          :loading="job.cancelling"
          @click="emit('cancel')"
        >
          <template #icon><StopOutlined /></template>
          {{ job.cancelling ? '停止中…' : '停止清理' }}
        </YButton>
        <YButton v-else size="small" type="link" @click="emit('dismiss')">收起</YButton>
      </div>
    </div>
    <a-progress
      :percent="job.percent"
      :status="progressStatus"
      :stroke-width="6"
      size="small"
    />
    <div v-if="job.status === 'failed' && job.error" class="sg-progress-banner__error">
      {{ job.error }}
    </div>
  </div>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
