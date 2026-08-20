<script setup lang="ts">
import { computed } from 'vue';
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
/** 当前需要跨设备人工审批的普通操作。 */
const selectedTools = computed(() => props.accountPolicy?.forcedTools || []);

/** 判断指定普通操作是否需要跨设备人工审批。 */
const isToolApprovalRequired = (toolName: string) => selectedTools.value.includes(toolName);

/** 切换单项跨设备审批策略并立即保存。 */
const changeToolApproval = (toolName: string, required: boolean) => {
  if (props.savingAccountPolicy) return;
  const nextTools = new Set(selectedTools.value);
  if (required) nextTools.add(toolName);
  else nextTools.delete(toolName);
  emit('save-account-policy', [...nextTools]);
};
</script>

<template>
  <div class="ai-policy-stack">
    <div class="ai-policy-card ai-policy-card--switch">
      <div class="ai-policy-card__copy">
        <strong>普通操作默认直接执行</strong>
        <small>MCP 安装后，已授权项目的配置、发布和服务操作无需再返回雨燕确认。</small>
        <small class="ai-policy-card__guard">高危删除始终逐次确认，不受此开关影响。</small>
      </div>
      <a-switch :checked="policy?.autoApproveGrantedProjects ?? true" @change="(checked: boolean) => emit('change', checked)" />
    </div>

    <div v-if="accountPolicy" class="ai-policy-card ai-account-policy-card">
      <div class="ai-account-policy-card__head">
        <div class="ai-policy-card__copy">
          <strong>需要人工审批的操作</strong>
          <small>开关默认关闭；开启后，该操作在账号全部设备上都需人工确认。</small>
        </div>
        <span>{{ selectedTools.length }} 项需确认</span>
      </div>
      <div class="ai-account-policy-card__tools">
        <div v-for="option in ACCOUNT_APPROVAL_TOOL_OPTIONS" :key="option.value" class="ai-account-policy-tool">
          <span>{{ option.label }}</span>
          <a-switch
            size="small"
            :checked="isToolApprovalRequired(option.value)"
            :loading="savingAccountPolicy"
            :disabled="savingAccountPolicy"
            :aria-label="`${option.label}需要人工审批`"
            @change="(checked: boolean) => changeToolApproval(option.value, checked)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
