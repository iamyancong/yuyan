import { computed, onMounted, onUnmounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  approveAgentOperation,
  cancelAgentOperation,
  getAgentClients,
  getAgentRuntime,
  getAgentSnapshot,
  installAgentClient,
  rejectAgentOperation,
  revokeAgentGrant,
  syncAgentRuntimeSettings,
  uninstallAgentClient,
  updateAgentApprovalPolicy,
  type AgentLauncherInfo,
  type AgentClientStatus,
  type AgentSnapshot,
} from '@/api/agent';
import { isTauri } from '@/utils/env';
import {
  getCentralAccountApprovalPolicy,
  getCentralAccountAudit,
  getCentralMe,
  listCentralDevices,
  revokeCentralDevice,
  updateCentralAccountApprovalPolicy,
  type CentralDevice,
  type CentralMe,
  type CentralAuditSnapshot,
  type CentralAccountApprovalPolicy,
} from '@/api/centralIdentity';
import { loadActiveSecureAccount, type SecureAccountState } from '@/services/secureAuth';

/** 管理 AI 集成状态、客户端安装与审批动作。 */
export function useAiIntegration() {
  const loading = ref(false);
  const available = ref(isTauri());
  const gatewayReady = ref(false);
  const gatewayError = ref('');
  const appVersion = ref('');
  const clients = ref<AgentClientStatus[]>([]);
  const genericConfig = ref<Record<string, unknown> | null>(null);
  const launcher = ref<AgentLauncherInfo | null>(null);
  const snapshot = ref<AgentSnapshot | null>(null);
  const secureAccount = ref<SecureAccountState | null>(null);
  const centralMe = ref<CentralMe | null>(null);
  const devices = ref<CentralDevice[]>([]);
  const centralAudit = ref<CentralAuditSnapshot | null>(null);
  const accountApprovalPolicy = ref<CentralAccountApprovalPolicy | null>(null);
  const identityLoading = ref(false);
  const accountPolicySaving = ref(false);
  let pollTimer: number | undefined;
  let lastIdentityRefreshAt = 0;

  const pendingOperations = computed(() => snapshot.value?.operations.items.filter((item) => item.status === 'pending_approval') || []);
  const recentOperations = computed(() => snapshot.value?.operations.items.slice(0, 8) || []);

  /** 将 Tauri 字符串错误与标准 Error 统一为可展示信息。 */
  const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) return String(error.message || '未知错误');
    return '未知错误';
  };

  /** 刷新平台安全存储账号以及当前用户的设备清单。 */
  const refreshIdentity = async (force = false) => {
    if (!force && Date.now() - lastIdentityRefreshAt < 15_000) return;
    lastIdentityRefreshAt = Date.now();
    identityLoading.value = true;
    try {
      secureAccount.value = await loadActiveSecureAccount(true);
      if (!secureAccount.value?.accessToken || Date.parse(secureAccount.value.accessExpiresAt) <= Date.now()) {
        centralMe.value = null;
        devices.value = [];
        centralAudit.value = null;
        accountApprovalPolicy.value = null;
        return;
      }
      [centralMe.value, devices.value, centralAudit.value, accountApprovalPolicy.value] = await Promise.all([
        getCentralMe(secureAccount.value),
        listCentralDevices(secureAccount.value),
        getCentralAccountAudit(secureAccount.value, 20),
        getCentralAccountApprovalPolicy(secureAccount.value),
      ]);
    } catch {
      centralMe.value = null;
      devices.value = [];
      centralAudit.value = null;
      accountApprovalPolicy.value = null;
    } finally {
      identityLoading.value = false;
    }
  };

  /** 刷新运行时、客户端与控制平面数据。 */
  const refresh = async (silent = false) => {
    if (!available.value) return;
    if (!silent) loading.value = true;
    const identityRefresh = refreshIdentity(!silent);
    try {
      const runtime = await getAgentRuntime();
      appVersion.value = runtime.descriptor.appVersion;
      await syncAgentRuntimeSettings();
      const [clientResult, snapshotResult] = await Promise.all([getAgentClients(), getAgentSnapshot()]);
      clients.value = clientResult.clients;
      genericConfig.value = clientResult.genericConfig;
      launcher.value = clientResult.launcher;
      snapshot.value = snapshotResult;
      gatewayReady.value = true;
      gatewayError.value = '';
    } catch (error) {
      gatewayReady.value = false;
      gatewayError.value = getErrorMessage(error);
      if (!silent) message.error(`Gateway 加载失败：${gatewayError.value}`);
    } finally {
      await identityRefresh;
      if (!silent) loading.value = false;
    }
  };

  /** 更新已授权项目自动执行策略。 */
  const changeApprovalPolicy = async (enabled: boolean) => {
    try {
      await updateAgentApprovalPolicy(enabled);
      message.success(enabled ? '已授权项目将默认自动执行普通操作' : '普通写操作已改为逐次审批');
      await refresh(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '审批策略更新失败');
    }
  };

  /** 保存当前账号跨设备强制审批工具列表。 */
  const saveAccountApprovalPolicy = async (forcedTools: string[]) => {
    if (!secureAccount.value) return;
    accountPolicySaving.value = true;
    try {
      accountApprovalPolicy.value = await updateCentralAccountApprovalPolicy(secureAccount.value, forcedTools);
      await syncAgentRuntimeSettings();
      message.success('账号跨设备审批策略已生效');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '账号审批策略保存失败');
    } finally {
      accountPolicySaving.value = false;
    }
  };

  /** 执行客户端安装类动作。 */
  const changeClient = async (client: AgentClientStatus['client'], action: 'install' | 'uninstall') => {
    try {
      if (action === 'install') await installAgentClient(client);
      else await uninstallAgentClient(client);
      message.success(action === 'install' ? 'MCP 客户端配置已安装/修复' : '雨燕 MCP 配置已卸载');
      await refresh(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '客户端配置修改失败');
    }
  };

  /** 执行任务审批动作。 */
  const decideOperation = async (id: string, action: 'approve' | 'reject' | 'cancel') => {
    try {
      if (action === 'approve') await approveAgentOperation(id);
      else if (action === 'reject') await rejectAgentOperation(id);
      else await cancelAgentOperation(id);
      await refresh(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '任务操作失败');
    }
  };

  /** 撤销项目授权。 */
  const revokeGrant = async (id: string) => {
    await revokeAgentGrant(id);
    message.success('项目授权已撤销');
    await refresh(true);
  };

  /** 撤销另一台设备并刷新中央设备状态。 */
  const revokeDevice = async (deviceId: string) => {
    if (!secureAccount.value) return;
    await revokeCentralDevice(secureAccount.value, deviceId);
    message.success('设备已撤销，其中央会话与未执行任务已失效');
    await refreshIdentity(true);
  };

  /** 复制通用 stdio 配置。 */
  const copyGenericConfig = async () => {
    if (!genericConfig.value) return;
    await navigator.clipboard.writeText(JSON.stringify(genericConfig.value, null, 2));
    message.success('本机标准 stdio 配置已复制');
  };

  onMounted(() => {
    void refresh();
    pollTimer = window.setInterval(() => void refresh(true), 3000);
    window.addEventListener('auth-state-changed', handleAuthStateChanged);
  });

  onUnmounted(() => {
    if (pollTimer) window.clearInterval(pollTimer);
    window.removeEventListener('auth-state-changed', handleAuthStateChanged);
  });

  /** 账号切换后立即丢弃旧设备列表并重新读取安全状态。 */
  function handleAuthStateChanged() {
    secureAccount.value = null;
    centralMe.value = null;
    devices.value = [];
    centralAudit.value = null;
    accountApprovalPolicy.value = null;
    void refreshIdentity(true);
  }

  return {
    loading, available, gatewayReady, gatewayError, appVersion, clients, launcher, snapshot, pendingOperations, recentOperations,
    secureAccount, centralMe, devices, centralAudit, accountApprovalPolicy, identityLoading, accountPolicySaving,
    refresh, changeClient, changeApprovalPolicy, saveAccountApprovalPolicy, decideOperation, revokeGrant, revokeDevice, copyGenericConfig,
  };
}
