<script setup lang="ts">
import { YButton } from '@yss-ui/components/lite';
import type { AgentProjectGrant } from '@/api/agent';

/** 项目授权列表属性。 */
defineProps<{ grants: AgentProjectGrant[] }>();

const emit = defineEmits<{
  /** 撤销项目授权。 */
  (event: 'revoke', id: string): void;
}>();
</script>

<template>
  <div v-if="grants.length" class="ai-grant-list">
    <div v-for="grant in grants" :key="grant.id" class="ai-grant-item">
      <div>
        <strong>{{ grant.client }} · {{ grant.workspacePath.split('/').pop() }}</strong>
        <small :title="grant.workspacePath">{{ grant.workspacePath }}</small>
      </div>
      <a-popconfirm title="撤销后该客户端再次访问时需要重新审批，确定继续？" @confirm="emit('revoke', grant.id)">
        <YButton size="small" danger>撤销</YButton>
      </a-popconfirm>
    </div>
  </div>
  <a-empty v-else description="暂无已授权项目" />
</template>
