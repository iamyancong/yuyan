<script setup lang="ts">
import { YButton } from '@ycwang-dev/components/lite';
import type { AgentOperation } from '@/api/agent';
import { AGENT_RISK_LABELS, AGENT_STATUS_META } from '../constant';

/** 操作列表属性。 */
defineProps<{ operations: AgentOperation[] }>();

const emit = defineEmits<{
  /** 审批或取消任务。 */
  (event: 'decide', id: string, action: 'approve' | 'reject' | 'cancel'): void;
}>();

/** 读取任务的统一执行回执。 */
const getExecutionReport = (operation: AgentOperation) => operation.result?.executionReport as {
  summary?: string;
  changes?: string[];
  verification?: string[];
} | undefined;
</script>

<template>
  <div v-if="operations.length" class="ai-operation-list">
    <article v-for="item in operations" :key="item.id" class="ai-operation-item">
      <div class="ai-operation-item__head">
        <strong>{{ item.approvalSummary?.title || item.toolName }}</strong>
        <a-tag :color="AGENT_STATUS_META[item.status].color">{{ AGENT_STATUS_META[item.status].label }}</a-tag>
      </div>
      <div class="ai-operation-item__meta">
        {{ item.client }} · {{ AGENT_RISK_LABELS[item.riskLevel] }} · {{ item.executionScope === 'local' ? '本机执行' : '中央执行' }}
      </div>
      <pre v-if="item.status === 'pending_approval'">{{ JSON.stringify(item.approvalSummary, null, 2) }}</pre>
      <a-progress v-if="item.progress" :percent="item.progress.percent" size="small" :status="item.status === 'failed' ? 'exception' : 'active'" />
      <div v-if="getExecutionReport(item)" class="ai-operation-item__report">
        <strong>{{ getExecutionReport(item)?.summary }}</strong>
        <span v-for="change in getExecutionReport(item)?.changes || []" :key="change">{{ change }}</span>
        <span v-for="verification in getExecutionReport(item)?.verification || []" :key="verification">{{ verification }}</span>
      </div>
      <p v-if="item.error" class="ai-operation-item__error">{{ item.error.code }}：{{ item.error.message }}</p>
      <div class="ai-operation-item__actions">
        <template v-if="item.status === 'pending_approval'">
          <YButton size="small" type="primary" @click="emit('decide', item.id, 'approve')">批准</YButton>
          <YButton size="small" danger @click="emit('decide', item.id, 'reject')">拒绝</YButton>
        </template>
        <YButton v-else-if="['queued', 'running'].includes(item.status)" size="small" danger @click="emit('decide', item.id, 'cancel')">取消</YButton>
      </div>
    </article>
  </div>
  <a-empty v-else description="暂无 Agent 任务" />
</template>
