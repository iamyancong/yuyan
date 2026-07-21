<script setup lang="ts">
import {
  ApiOutlined,
  AuditOutlined,
  FolderOpenOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import AiSectionShell from './components/AiSectionShell.vue';
import ClientInstallList from './components/ClientInstallList.vue';
import ApprovalPolicyCard from './components/ApprovalPolicyCard.vue';
import GrantList from './components/GrantList.vue';
import OperationList from './components/OperationList.vue';
import IdentityDeviceCard from './components/IdentityDeviceCard.vue';
import { useAiIntegration } from './hooks/useAiIntegration';
import { useAiSections } from './hooks/useAiSections';

defineOptions({ name: 'AiIntegrationPanel' });

const {
  loading, available, gatewayReady, gatewayError, appVersion, clients, launcher, snapshot, secureAccount, centralMe, devices,
  centralAudit, accountApprovalPolicy, identityLoading, accountPolicySaving, recentOperations,
  refresh, changeClient, changeApprovalPolicy, saveAccountApprovalPolicy, decideOperation,
  revokeGrant, revokeDevice, copyGenericConfig,
} = useAiIntegration();
const { isSectionExpanded, toggleSection } = useAiSections();
</script>

<template>
  <section class="ai-integration" :class="{ 'is-unavailable': !available }">
    <div class="ai-integration__head">
      <div>
        <strong>连接与权限</strong>
        <span>管理账号设备、MCP 客户端和执行审批</span>
      </div>
      <span class="ai-gateway-status" :class="{ 'is-ready': gatewayReady }" :title="gatewayError">
        <i />{{ !available ? '仅桌面端可用' : gatewayReady ? `Gateway 已就绪 · v${appVersion}` : 'Gateway 不可用' }}
      </span>
    </div>

    <a-spin :spinning="loading && !snapshot">
      <template v-if="available">
        <a-alert v-if="gatewayError" class="ai-gateway-alert" type="error" :message="`Gateway 加载失败：${gatewayError}`" show-icon />
        <div class="ai-sections">
          <AiSectionShell section-id="ai-section-identity" title="账号与设备" :summary="`${secureAccount?.gitlabUsername || '未登录'} · ${devices.length} 台设备`" :expanded="isSectionExpanded('identity')" @toggle="toggleSection('identity')">
            <template #icon><UserOutlined /></template>
            <IdentityDeviceCard :account="secureAccount" :central-me="centralMe" :devices="devices" :loading="identityLoading" @revoke="revokeDevice" />
          </AiSectionShell>

          <AiSectionShell section-id="ai-section-clients" title="MCP 客户端" summary="Codex · Cursor · Antigravity" :expanded="isSectionExpanded('clients')" @toggle="toggleSection('clients')">
            <template #icon><ApiOutlined /></template>
            <ClientInstallList :clients="clients" @change="changeClient" />
            <div class="ai-client-tools">
              <YButton size="small" @click="copyGenericConfig">复制其他客户端配置</YButton>
              <p v-if="launcher">稳定启动器：{{ launcher.path }}<br />{{ launcher.runtimeMode === 'development' ? '当前连接本机调试服务' : '当前连接已安装版本' }}，配置仅适用于本机。</p>
            </div>
          </AiSectionShell>

          <AiSectionShell section-id="ai-section-operations" title="任务与审批" :summary="`${snapshot?.operations.total || 0} 个任务`" :expanded="isSectionExpanded('operations')" @toggle="toggleSection('operations')">
            <template #icon><SafetyCertificateOutlined /></template>
            <ApprovalPolicyCard :policy="snapshot?.approvalPolicy" :account-policy="accountApprovalPolicy" :saving-account-policy="accountPolicySaving" @change="changeApprovalPolicy" @save-account-policy="saveAccountApprovalPolicy" />
            <OperationList :operations="recentOperations" @decide="decideOperation" />
          </AiSectionShell>

          <AiSectionShell section-id="ai-section-grants" title="已授权项目" :summary="`${snapshot?.grants.total || 0} 个项目`" :expanded="isSectionExpanded('grants')" @toggle="toggleSection('grants')">
            <template #icon><FolderOpenOutlined /></template>
            <GrantList :grants="snapshot?.grants.items || []" @revoke="revokeGrant" />
          </AiSectionShell>

          <AiSectionShell section-id="ai-section-audit" title="安全审计" :summary="`${snapshot?.auditChain.count || 0} 条本机记录`" :expanded="isSectionExpanded('audit')" @toggle="toggleSection('audit')">
            <template #icon><AuditOutlined /></template>
            <div class="ai-audit-statuses">
              <a-alert v-if="centralAudit" :type="centralAudit.chain.valid ? 'success' : 'error'" :message="centralAudit.chain.valid ? `账号中央审计链完整，共 ${centralAudit.chain.count} 条` : `账号中央审计链在 ${centralAudit.chain.brokenAt || '未知位置'} 断裂`" show-icon />
              <a-alert :type="snapshot?.auditChain.valid ? 'success' : 'error'" :message="snapshot?.auditChain.valid ? `本机 HMAC 审计链完整，共 ${snapshot?.auditChain.count || 0} 条` : '本机审计链校验失败，请停止外部 Agent 操作'" show-icon />
            </div>
            <ul class="ai-audit-list">
              <li v-for="item in centralAudit?.items.slice(0, 8) || []" :key="`central-${String(item.eventId)}`"><span>账号 · {{ item.action || 'operation' }}</span><small>{{ item.createdAt }}</small></li>
              <li v-for="item in snapshot?.audit.items.slice(0, 8) || []" :key="String(item.eventId)"><span>{{ item.action }}</span><small>{{ item.toolName || item.client || 'control-plane' }} · {{ item.createdAt }}</small></li>
            </ul>
          </AiSectionShell>
        </div>

        <div class="ai-integration__footer"><span>运行状态每 3 秒自动同步</span><YButton size="small" :loading="loading" @click="refresh()">刷新诊断</YButton></div>
      </template>
      <a-alert v-else type="info" message="请在雨燕桌面端中配置 AI 集成" show-icon />
    </a-spin>
  </section>
</template>

<style scoped lang="less">
@import './style.less';
</style>
