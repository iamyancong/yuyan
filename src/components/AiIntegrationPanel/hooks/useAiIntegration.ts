import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
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
import { useAgentEventStream } from '@/composables/useAgentEventStream';
import { useAgentOperationMaintenance } from './useAgentOperationMaintenance';

/** AI 控制中心中央身份可见时刷新间隔。 */
const IDENTITY_REFRESH_INTERVAL = 60_000;

/** Agent 事件触发完整快照刷新的合并窗口。 */
const SNAPSHOT_EVENT_DEBOUNCE = 1_000;

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
  const { eventSequence } = useAgentEventStream();
  let identityTimer: number | undefined;
  let snapshotRefreshTimer: number | undefined;
  let lastIdentityRefreshAt = 0;
  let identityRefreshSequence = 0;
  let componentActive = false;
  let snapshotRefreshPromise: Promise<void> | null = null;
  let snapshotRefreshQueued = false;
  let snapshotRequestSequence = 0;
  let fullRefreshSequence = 0;

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
    const sequence = ++identityRefreshSequence;
    lastIdentityRefreshAt = Date.now();
    identityLoading.value = true;
    try {
      const nextSecureAccount = await loadActiveSecureAccount(true);
      if (!componentActive || sequence !== identityRefreshSequence) return;
      secureAccount.value = nextSecureAccount;
      if (!nextSecureAccount?.accessToken || Date.parse(nextSecureAccount.accessExpiresAt) <= Date.now()) {
        centralMe.value = null;
        devices.value = [];
        centralAudit.value = null;
        accountApprovalPolicy.value = null;
        return;
      }
      const [nextCentralMe, nextDevices, nextCentralAudit, nextAccountApprovalPolicy] = await Promise.all([
        getCentralMe(nextSecureAccount),
        listCentralDevices(nextSecureAccount),
        getCentralAccountAudit(nextSecureAccount, 20),
        getCentralAccountApprovalPolicy(nextSecureAccount),
      ]);
      if (!componentActive || sequence !== identityRefreshSequence) return;
      centralMe.value = nextCentralMe;
      devices.value = nextDevices;
      centralAudit.value = nextCentralAudit;
      accountApprovalPolicy.value = nextAccountApprovalPolicy;
    } catch {
      if (!componentActive || sequence !== identityRefreshSequence) return;
      centralMe.value = null;
      devices.value = [];
      centralAudit.value = null;
      accountApprovalPolicy.value = null;
    } finally {
      if (sequence === identityRefreshSequence) identityLoading.value = false;
    }
  };

  /** 仅刷新 Agent 控制平面快照，并合并并发事件。 */
  const refreshAgentSnapshot = async () => {
    if (!available.value || !componentActive) return;
    if (snapshotRefreshPromise) {
      snapshotRefreshQueued = true;
      await snapshotRefreshPromise;
      return;
    }
    const sequence = ++snapshotRequestSequence;
    snapshotRefreshPromise = (async () => {
      try {
        const nextSnapshot = await getAgentSnapshot();
        if (!componentActive || sequence !== snapshotRequestSequence) return;
        snapshot.value = nextSnapshot;
        gatewayReady.value = true;
        gatewayError.value = '';
      } catch (error) {
        if (!componentActive || sequence !== snapshotRequestSequence) return;
        gatewayReady.value = false;
        gatewayError.value = getErrorMessage(error);
      }
    })();
    try {
      await snapshotRefreshPromise;
    } finally {
      snapshotRefreshPromise = null;
      if (snapshotRefreshQueued && componentActive) {
        snapshotRefreshQueued = false;
        void refreshAgentSnapshot();
      }
    }
  };

  const {
    operationRetentionSaving,
    completedOperationsClearing,
    deletingOperationIds,
    changeOperationRetention,
    removeOperation,
    clearCompletedOperations,
  } = useAgentOperationMaintenance(refreshAgentSnapshot);

  /** 将一批 Agent 事件合并为至多每秒一次快照刷新。 */
  const scheduleAgentSnapshotRefresh = () => {
    if (!componentActive) return;
    if (snapshotRefreshTimer) window.clearTimeout(snapshotRefreshTimer);
    snapshotRefreshTimer = window.setTimeout(() => {
      snapshotRefreshTimer = undefined;
      void refreshAgentSnapshot();
    }, SNAPSHOT_EVENT_DEBOUNCE);
  };

  /** 安排下一次仅在页面可见时执行的中央身份刷新。 */
  const scheduleIdentityRefresh = () => {
    if (identityTimer) window.clearTimeout(identityTimer);
    identityTimer = undefined;
    if (!componentActive || document.visibilityState === 'hidden') return;
    identityTimer = window.setTimeout(async () => {
      identityTimer = undefined;
      await refreshIdentity(true);
      scheduleIdentityRefresh();
    }, IDENTITY_REFRESH_INTERVAL);
  };

  /** 刷新运行时、客户端与控制平面数据。 */
  const refresh = async (silent = false) => {
    if (!available.value) return;
    const refreshSequence = ++fullRefreshSequence;
    if (!silent) loading.value = true;
    const identityRefresh = refreshIdentity(!silent);
    try {
      const runtime = await getAgentRuntime();
      appVersion.value = runtime.descriptor.appVersion;
      await syncAgentRuntimeSettings();
      const snapshotSequence = ++snapshotRequestSequence;
      const [clientResult, snapshotResult] = await Promise.all([getAgentClients(), getAgentSnapshot()]);
      if (!componentActive || refreshSequence !== fullRefreshSequence) return;
      clients.value = clientResult.clients;
      genericConfig.value = clientResult.genericConfig;
      launcher.value = clientResult.launcher;
      if (snapshotSequence === snapshotRequestSequence) {
        snapshot.value = snapshotResult;
        gatewayReady.value = true;
        gatewayError.value = '';
      }
    } catch (error) {
      if (!componentActive || refreshSequence !== fullRefreshSequence) return;
      gatewayReady.value = false;
      gatewayError.value = getErrorMessage(error);
      if (!silent) message.error(`Gateway 加载失败：${gatewayError.value}`);
    } finally {
      await identityRefresh;
      if (!silent && refreshSequence === fullRefreshSequence) loading.value = false;
    }
  };

  /** 更新已授权项目自动执行策略。 */
  const changeApprovalPolicy = async (enabled: boolean) => {
    try {
      await updateAgentApprovalPolicy(enabled);
      message.success(enabled ? '已授权项目将默认自动执行普通操作' : '普通写操作已改为逐次审批');
      await refreshAgentSnapshot();
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
      await refreshAgentSnapshot();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '任务操作失败');
    }
  };

  /** 撤销项目授权。 */
  const revokeGrant = async (id: string) => {
    await revokeAgentGrant(id);
    message.success('项目授权已撤销');
    await refreshAgentSnapshot();
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
    componentActive = true;
    void refresh();
    scheduleIdentityRefresh();
    window.addEventListener('auth-state-changed', handleAuthStateChanged);
    document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  onUnmounted(() => {
    componentActive = false;
    identityRefreshSequence += 1;
    snapshotRequestSequence += 1;
    fullRefreshSequence += 1;
    if (identityTimer) window.clearTimeout(identityTimer);
    if (snapshotRefreshTimer) window.clearTimeout(snapshotRefreshTimer);
    window.removeEventListener('auth-state-changed', handleAuthStateChanged);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  watch(eventSequence, scheduleAgentSnapshotRefresh);

  /** 账号切换后立即丢弃旧设备列表并重新读取安全状态。 */
  function handleAuthStateChanged() {
    snapshotRequestSequence += 1;
    fullRefreshSequence += 1;
    loading.value = false;
    snapshot.value = null;
    gatewayReady.value = false;
    secureAccount.value = null;
    centralMe.value = null;
    devices.value = [];
    centralAudit.value = null;
    accountApprovalPolicy.value = null;
    void syncAgentRuntimeSettings().then(refreshAgentSnapshot).catch(() => undefined);
    void refreshIdentity(true);
  }

  /** 页面恢复可见时立即刷新身份并恢复低频调度。 */
  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      if (identityTimer) window.clearTimeout(identityTimer);
      identityTimer = undefined;
      return;
    }
    void refreshIdentity(true);
    scheduleIdentityRefresh();
  }

  return {
    loading, available, gatewayReady, gatewayError, appVersion, clients, launcher, snapshot, pendingOperations, recentOperations,
    secureAccount, centralMe, devices, centralAudit, accountApprovalPolicy, identityLoading, accountPolicySaving,
    operationRetentionSaving, completedOperationsClearing, deletingOperationIds,
    refresh, changeClient, changeApprovalPolicy, saveAccountApprovalPolicy, decideOperation,
    changeOperationRetention, removeOperation, clearCompletedOperations,
    revokeGrant, revokeDevice, copyGenericConfig,
  };
}
