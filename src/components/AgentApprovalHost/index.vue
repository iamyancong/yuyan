<script setup lang="ts">
import { ExclamationCircleOutlined, SafetyCertificateOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import { useAgentApproval } from './hooks/useAgentApproval';

defineOptions({ name: 'AgentApprovalHost' });

const { currentOperation, deciding, decide } = useAgentApproval();
</script>

<template>
  <a-modal
    :open="Boolean(currentOperation)"
    :closable="false"
    :keyboard="false"
    :mask-closable="false"
    :footer="null"
    width="680px"
    wrap-class-name="agent-approval-modal"
  >
    <template v-if="currentOperation">
      <header class="agent-approval__header">
        <span class="agent-approval__icon"><ExclamationCircleOutlined /></span>
        <div>
          <small>YUYAN TRUST GATE</small>
          <h3>{{ currentOperation.approvalSummary?.title || currentOperation.toolName }}</h3>
          <p>{{ currentOperation.client }} 请求雨燕执行 {{ currentOperation.executionScope === 'local' ? '本机' : '中央服务器' }} 操作</p>
        </div>
      </header>
      <a-alert
        type="warning"
        show-icon
        message="请核对项目、服务器、环境、分支、Commit、构建命令与影响路径；批准只对当前参数哈希有效。"
      />
      <pre class="agent-approval__summary">{{ JSON.stringify(currentOperation.approvalSummary, null, 2) }}</pre>
      <div class="agent-approval__hash">
        <SafetyCertificateOutlined /> 参数摘要 {{ currentOperation.payloadHash.slice(0, 16) }}…
      </div>
      <footer class="agent-approval__actions">
        <YButton danger :disabled="deciding" @click="decide('reject')">拒绝</YButton>
        <YButton type="primary" :loading="deciding" @click="decide('approve')">确认并后台执行</YButton>
      </footer>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
