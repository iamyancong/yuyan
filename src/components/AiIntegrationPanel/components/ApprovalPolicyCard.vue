<script setup lang="ts">
import { ref, watch } from 'vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { AgentApprovalPolicy } from '@/api/agent';
import type { CentralAccountApprovalPolicy } from '@/api/centralIdentity';
import { ACCOUNT_APPROVAL_TOOL_OPTIONS } from '../constant';

/** 审批策略卡片属性。 */
const props = defineProps<{
  policy?: AgentApprovalPolicy;
  accountPolicy?: CentralAccountApprovalPolicy | null;
  savingAccountPolicy?: boolean;
}>();

const emit = defineEmits<{
  /** 切换已授权项目自动执行。 */
  (event: 'change', enabled: boolean): void;
  /** 保存账号跨设备强制审批工具列表。 */
  (event: 'save-account-policy', forcedTools: string[]): void;
}>();
const selectedTools = ref<string[]>([]);

watch(
  () => props.accountPolicy?.forcedTools,
  (value) => { selectedTools.value = [...(value || [])]; },
  { immediate: true },
);

/** 保存账号跨设备审批策略。 */
const saveAccountPolicy = () => emit('save-account-policy', [...selectedTools.value]);
</script>

<template>
  <div class="ai-policy-stack">
    <div class="ai-policy-card ai-policy-card--switch">
      <div class="ai-policy-card__copy">
        <strong>当前设备自动执行</strong>
        <small>已授权项目的普通操作可直接执行，高危删除仍会逐次确认。</small>
      </div>
      <a-switch :checked="policy?.autoApproveGrantedProjects ?? true" @change="(checked: boolean) => emit('change', checked)" />
    </div>

    <div v-if="accountPolicy" class="ai-policy-card ai-account-policy-card">
      <div class="ai-policy-card__copy">
        <strong>账号跨设备审批</strong>
        <small>选中的操作在该账号全部设备上都需要人工确认。</small>
        <a-select
          v-model:value="selectedTools"
          mode="multiple"
          :options="ACCOUNT_APPROVAL_TOOL_OPTIONS"
          placeholder="未设置额外审批规则"
        />
      </div>
      <YButton
        size="small"
        :loading="savingAccountPolicy"
        @click="saveAccountPolicy"
      >保存策略</YButton>
    </div>
  </div>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
