import { nextTick, reactive, ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  createDeployServer,
  deleteDeployServer,
  listDeployServers,
  reorderDeployServers,
  testDeployServer,
  updateDeployServer,
  type DeployServer,
  type DeployServerPayload,
} from '@/api/deploy';
import type { FormilyRef, RefreshActiveTabOptions } from '../types';
import { createDefaultServerForm, getErrorMessage, getServerConnectionErrorMessage, getServerOrderErrorMessage } from '../utils';
import { extractSshFailure, type SshFailureField, type SshFailureInfo } from '../sshFailureGuide';
import { extractServerDuplicate, findServerDuplicate, type ServerDuplicateInfo } from '../serverDuplicatePolicy';
import { useNginxDeployContext } from './useNginxDeployContext';
import { useNginxRuntimeDrawer } from './useNginxRuntimeDrawer';

/** 服务器管理 Hook 参数 */
interface UseNginxDeployServersParams {
  ensureLoggedIn: () => boolean;
  refreshActiveTab: (options?: RefreshActiveTabOptions) => Promise<void>;
}

/**
 * 管理独立服务器列表和服务器配置表单。
 * @description 支持零传参的依赖注入，解耦原本扁平化的数据传递网络。
 * @param params 可选的认证和刷新依赖（不传时从 NginxDeployContext 获取）
 * @returns 服务器数据、表单状态和操作方法
 */
export function useNginxDeployServers(params?: UseNginxDeployServersParams) {
  const fallbackContext = useNginxDeployContext;
  const getContext = () => {
    try {
      return fallbackContext();
    } catch {
      return null;
    }
  };
  const context = getContext();

  const ensureLoggedIn = params?.ensureLoggedIn ?? context?.ensureLoggedIn!;
  const refreshActiveTab = params?.refreshActiveTab ?? context?.refreshActiveTab!;

  const serverSaving = ref(false);
  const serverOrderSaving = ref(false);
  const servers = ref<DeployServer[]>([]);
  const serverModalOpen = ref(false);
  const serverFormKey = ref(0);
  const activeServerId = ref<number | null>(null);
  const serverFormRef = ref<FormilyRef | null>(null);
  const serverForm = reactive<DeployServerPayload>(createDefaultServerForm());
  /** 保存时 SSH 校验失败的详情，抽屉保持打开并展示引导（#47）。 */
  const serverSaveFailure = ref<SshFailureInfo | null>(null);
  /** 请求抽屉聚焦某个字段；token 递增以便重复聚焦同一字段。 */
  const serverFocusRequest = ref<{ field: SshFailureField; token: number } | null>(null);
  /** 保存时查重失败（地址或名称已存在），抽屉里显示错误和「查看已有服务器」（#47）。 */
  const serverDuplicate = ref<ServerDuplicateInfo | null>(null);

  const fsDrawerOpen = ref(false);
  const fsDrawerServer = ref<DeployServer | null>(null);
  const fsDrawerInitialPath = ref<string>('');
  let fsDrawerSelectCallback: ((path: string) => void) | null = null;

  /**
   * 打开远程目录浏览抽屉。
   * @param server 服务器配置
   * @param initialPath 可选初始路径
   * @param onSelect 可选选择路径回填回调
   */
  const openRemoteFsBrowse = (server: DeployServer, initialPath?: string, onSelect?: (path: string) => void) => {
    if (!ensureLoggedIn()) return;
    fsDrawerServer.value = server;
    fsDrawerInitialPath.value = initialPath || '';
    fsDrawerSelectCallback = onSelect || null;
    fsDrawerOpen.value = true;
  };

  /**
   * 处理远程目录选择回填。
   * @param path 选中的远程路径
   */
  const handleFsDrawerSelectPath = (path: string) => {
    fsDrawerSelectCallback?.(path);
  };

  /** 重置服务器表单 */
  const resetServerForm = () => {
    Object.assign(serverForm, createDefaultServerForm());
    activeServerId.value = null;
    serverSaveFailure.value = null;
    serverDuplicate.value = null;
    serverFocusRequest.value = null;
  };

  /** 服务器表单中所有可能被标红的字段 */
  const SERVER_ERROR_FIELDS: SshFailureField[] = ['name', 'host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'useSudo'];

  /** 清除上一次保存失败留下的字段错误 */
  const clearServerFieldErrors = () => {
    SERVER_ERROR_FIELDS.forEach((field) => {
      if (!field) return;
      serverFormRef.value?.setFieldState?.(field, (state: any) => {
        state.selfErrors = [];
      });
    });
  };

  /**
   * 标红并聚焦字段。
   * @param field 字段名
   * @param errorText 字段下方的错误提示
   */
  const markServerField = (field: SshFailureField, errorText: string) => {
    if (!field) return;
    serverFormRef.value?.setFieldState?.(field, (state: any) => {
      state.selfErrors = [errorText];
    });
    serverFocusRequest.value = { field, token: (serverFocusRequest.value?.token || 0) + 1 };
  };

  /** 各错误码在字段下方显示的简短提示 */
  const FIELD_ERROR_TEXT: Record<string, string> = {
    auth_failed: '登录失败，请检查账号和密码/私钥',
    refused: 'SSH 端口拒绝连接，请检查端口',
    timeout: '连接超时，请检查地址并确认已连上内网或 VPN',
    unreachable: '网络不可达，请检查地址并确认已连上内网或 VPN',
    sudo_unavailable: 'sudo 不可用或需要密码',
    ssh_error: '连接失败，请检查服务器地址',
  };

  /** 同步服务器表单值到 Formily 内部状态 */
  const syncServerFormValues = () => {
    serverFormRef.value?.setValues?.({ ...serverForm });
  };

  /** 刷新服务器管理列表 */
  let serverRefreshSequence = 0;
  const refreshServerList = async (signal?: AbortSignal) => {
    const sequence = ++serverRefreshSequence;
    const list = await listDeployServers(signal);
    if (signal?.aborted || sequence !== serverRefreshSequence) return;
    servers.value = list;
  };

  /**
   * 保存服务器拖拽后的展示顺序。
   * @param orderedServers 排序后的服务器列表
   */
  const reorderServerList = async (orderedServers: DeployServer[]) => {
    if (serverOrderSaving.value) return;
    const previousServers = [...servers.value];
    servers.value = [...orderedServers];
    serverOrderSaving.value = true;
    try {
      servers.value = await reorderDeployServers(orderedServers.map((server) => server.id));
      message.success('服务器顺序已更新，部署服务器下拉将按此顺序展示');
    } catch (error) {
      servers.value = previousServers;
      message.error(getServerOrderErrorMessage(error));
    } finally {
      serverOrderSaving.value = false;
    }
  };

  const runtimeState = useNginxRuntimeDrawer({
    ensureLoggedIn,
    refreshActiveTab,
    refreshServerList,
  });

  /** 打开新增服务器弹窗 */
  const openCreateServer = async () => {
    if (!ensureLoggedIn()) return;
    resetServerForm();
    serverFormKey.value += 1;
    serverModalOpen.value = true;
    await nextTick();
    syncServerFormValues();
  };

  /**
   * 打开编辑服务器弹窗。
   * @param server 服务器配置
   */
  const openEditServer = async (server: DeployServer, options: { focusField?: SshFailureField; failure?: SshFailureInfo | null } = {}) => {
    if (!ensureLoggedIn()) return;
    serverSaveFailure.value = options.failure || null;
    serverDuplicate.value = null;
    serverFocusRequest.value = null;
    activeServerId.value = server.id;
    Object.assign(serverForm, {
      ...createDefaultServerForm(),
      ...server,
      password: '',
      privateKey: '',
      passphrase: '',
    });
    serverFormKey.value += 1;
    serverModalOpen.value = true;
    await nextTick();
    syncServerFormValues();
    if (options.focusField) {
      await nextTick();
      markServerField(options.focusField, options.failure ? FIELD_ERROR_TEXT[options.failure.code] || options.failure.message : '请在这里修改后保存，保存时会重新校验 SSH 登录');
    }
  };

  /** 保存服务器 */
  const saveServer = async () => {
    if (!ensureLoggedIn()) return;
    serverSaving.value = true;
    serverSaveFailure.value = null;
    serverDuplicate.value = null;
    clearServerFieldErrors();
    try {
      const values = (serverFormRef.value?.getValues?.() || serverForm) as DeployServerPayload;
      const payload = { ...serverForm, ...values };
      // 先用已加载的列表即时查重，命中就不请求后端；最终以后端 409 为准。
      const current = activeServerId.value ? servers.value.find((item) => item.id === activeServerId.value) || null : null;
      const localDuplicate = findServerDuplicate(servers.value, payload, current);
      if (localDuplicate) {
        showServerDuplicate(localDuplicate);
        return;
      }
      // 保存前后端会先用 SSH 登录一次，登录不成功不会写库（#47）。
      const saved = activeServerId.value
        ? await updateDeployServer(activeServerId.value, payload)
        : await createDeployServer(payload);
      const account = saved?.verification?.account;
      const verifiedText = saved?.verification?.checked ? `，SSH 登录校验通过${account ? `（${account}）` : ''}` : '';
      message.success(`${activeServerId.value ? '服务器配置已更新' : '服务器配置已新增'}${verifiedText}`);
      (saved?.verification?.warnings || []).forEach((warning) => message.warning(warning));
      serverModalOpen.value = false;
      await refreshActiveTab({ force: true });
    } catch (error: any) {
      const duplicate = extractServerDuplicate(error);
      const failure = duplicate ? null : extractSshFailure(error);
      if (duplicate) {
        showServerDuplicate(duplicate);
        // 列表可能过期（别人刚新增），刷新一下以便「查看已有服务器」能找到。
        void refreshServerList().catch(() => undefined);
      } else if (failure) {
        // 弹窗保持打开、保留已填内容，标红并聚焦对应字段。
        serverSaveFailure.value = failure;
        markServerField(failure.field, FIELD_ERROR_TEXT[failure.code] || failure.message);
        message.error(failure.message);
      } else {
        message.error(getErrorMessage(error));
      }
    } finally {
      serverSaving.value = false;
    }
  };

  /**
   * 在抽屉里显示查重错误并标红对应字段。
   * @param duplicate 重复详情
   */
  const showServerDuplicate = (duplicate: ServerDuplicateInfo) => {
    serverDuplicate.value = duplicate;
    markServerField(duplicate.field, duplicate.field === 'host' ? '相同地址、端口和账号的服务器已存在' : '服务器名称已存在');
    message.error(duplicate.message);
  };

  /** 「查看已有服务器」：关掉当前弹窗，打开已有服务器的编辑框。 */
  const viewDuplicateServer = async () => {
    const targetId = serverDuplicate.value?.existingServerId;
    if (!targetId) return;
    let existing = servers.value.find((item) => item.id === targetId);
    if (!existing) {
      await refreshServerList().catch(() => undefined);
      existing = servers.value.find((item) => item.id === targetId);
    }
    serverModalOpen.value = false;
    serverDuplicate.value = null;
    if (!existing) {
      message.warning('已有服务器不在当前列表中，请刷新后在「服务器管理」中查看');
      return;
    }
    await nextTick();
    await openEditServer(existing);
  };

  /**
   * 删除服务器配置。
   * @param server 服务器配置
   */
  const deleteServer = async (server: DeployServer) => {
    if (!ensureLoggedIn()) return;
    await deleteDeployServer(server.id, server.name);
    message.success('服务器配置已删除');
    await refreshActiveTab({ force: true });
  };

  /**
   * 检测服务器连接。
   * @param server 服务器配置
   */
  const testServer = async (server: DeployServer) => {
    if (!ensureLoggedIn()) return;
    try {
      const result = await testDeployServer(server.id);
      const outputLines = String(result.output || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const account = result.account || [...outputLines].reverse().find((item) => item !== 'yuyan-ops-ready');
      message.success(account ? `服务器“${server.name}”连接正常，登录账号：${account}` : `服务器“${server.name}”连接正常`);
      if (result.sudo?.checked && !result.sudo.ok) message.warning(result.sudo.message);
    } catch (error) {
      message.error(getServerConnectionErrorMessage(error, server.name));
    } finally {
      void refreshServerList().catch(() => undefined);
    }
  };

  /** 清空服务器管理数据和临时态 */
  const clearServerData = () => {
    serverRefreshSequence += 1;
    servers.value = [];
    activeServerId.value = null;
    serverModalOpen.value = false;
    serverSaveFailure.value = null;
    serverDuplicate.value = null;
    fsDrawerOpen.value = false;
    fsDrawerServer.value = null;
    fsDrawerSelectCallback = null;
    runtimeState.clearNginxRuntimeDrawer();
  };

  return {
    serverSaving,
    serverOrderSaving,
    servers,
    serverModalOpen,
    serverFormKey,
    activeServerId,
    serverFormRef,
    serverForm,
    serverSaveFailure,
    serverDuplicate,
    viewDuplicateServer,
    serverFocusRequest,
    fsDrawerOpen,
    fsDrawerServer,
    fsDrawerInitialPath,
    ...runtimeState,
    refreshServerList,
    reorderServerList,
    openCreateServer,
    openEditServer,
    openRemoteFsBrowse,
    handleFsDrawerSelectPath,
    saveServer,
    deleteServer,
    testServer,
    clearServerData,
  };
}
