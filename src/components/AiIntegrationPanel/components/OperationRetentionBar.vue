<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { YButton } from '@yss-ui/components/lite';
import type { AgentOperationRetentionPolicy } from '@/api/agent';
import { AGENT_OPERATION_RETENTION_OPTIONS } from '../constant';

/** 任务记录维护栏属性。 */
const props = defineProps<{
  retentionDays: AgentOperationRetentionPolicy['retentionDays'];
  total: number;
  visibleCount: number;
  completedCount: number;
  saving?: boolean;
  clearing?: boolean;
}>();

const emit = defineEmits<{
  /** 保存任务保留期限。 */
  (event: 'update-retention', retentionDays: AgentOperationRetentionPolicy['retentionDays']): void;
  /** 清空全部已结束任务。 */
  (event: 'clear-completed'): void;
}>();

const pendingRetentionDays = ref<AgentOperationRetentionPolicy['retentionDays']>(props.retentionDays);

watch(
  () => props.retentionDays,
  (value) => { pendingRetentionDays.value = value; },
);

const retentionChanged = computed(() => pendingRetentionDays.value !== props.retentionDays);
const retentionConfirmDescription = computed(() => pendingRetentionDays.value === 0
  ? '应用后将停止自动清理，已有任务记录继续保留。'
  : `应用后会立即清理超过 ${pendingRetentionDays.value} 天的已结束任务，之后每小时自动执行。`);

/** 提交当前选择的任务保留期限。 */
const applyRetention = () => emit('update-retention', pendingRetentionDays.value);
</script>

<template>
  <div class="ai-operation-maintenance">
    <div class="ai-operation-maintenance__copy">
      <strong>任务记录保留</strong>
      <span>
        每小时自动清理，仅处理已结束任务
        <template v-if="total > visibleCount"> · 当前展示最近 {{ visibleCount }} 条，共 {{ total }} 条</template>
      </span>
    </div>
    <div class="ai-operation-maintenance__actions">
      <a-select
        v-model:value="pendingRetentionDays"
        :options="AGENT_OPERATION_RETENTION_OPTIONS"
        aria-label="任务记录保留期限"
      />
      <a-popconfirm
        title="应用任务保留策略？"
        :description="retentionConfirmDescription"
        ok-text="应用"
        cancel-text="取消"
        @confirm="applyRetention"
      >
        <YButton size="small" :disabled="!retentionChanged" :loading="saving">应用</YButton>
      </a-popconfirm>
      <a-popconfirm
        title="清空全部已结束任务？"
        description="删除后无法恢复，但不会影响待审批、执行中的任务和安全审计。"
        ok-text="清空"
        cancel-text="取消"
        @confirm="emit('clear-completed')"
      >
        <YButton size="small" danger :disabled="completedCount === 0" :loading="clearing">清理已结束</YButton>
      </a-popconfirm>
    </div>
  </div>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
