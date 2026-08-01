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

  /** 重置服务器表单 */
  const resetServerForm = () => {
    Object.assign(serverForm, createDefaultServerForm());
    activeServerId.value = null;
  };

  /** 同步服务器表单值到 Formily 内部状态 */
  const syncServerFormValues = () => {
    serverFormRef.value?.setValues?.({ ...serverForm });
  };

  /** 刷新服务器管理列表 */
  const refreshServerList = async () => {
    servers.value = await listDeployServers();
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
  const openEditServer = async (server: DeployServer) => {
    if (!ensureLoggedIn()) return;
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
  };

  /** 保存服务器 */
  const saveServer = async () => {
    if (!ensureLoggedIn()) return;
    serverSaving.value = true;
    try {
      const values = (serverFormRef.value?.getValues?.() || serverForm) as DeployServerPayload;
      const payload = { ...serverForm, ...values };
      if (activeServerId.value) {
        await updateDeployServer(activeServerId.value, payload);
        message.success('服务器配置已更新');
      } else {
        await createDeployServer(payload);
        message.success('服务器配置已新增');
      }
      serverModalOpen.value = false;
      await refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      serverSaving.value = false;
    }
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
      const account = [...outputLines].reverse().find((item) => item !== 'yuyan-ops-ready');
      message.success(account ? `服务器“${server.name}”连接正常，登录账号：${account}` : `服务器“${server.name}”连接正常`);
    } catch (error) {
      message.error(getServerConnectionErrorMessage(error, server.name));
    }
  };

  /** 清空服务器管理数据和临时态 */
  const clearServerData = () => {
    servers.value = [];
    activeServerId.value = null;
    serverModalOpen.value = false;
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
    ...runtimeState,
    refreshServerList,
    reorderServerList,
    openCreateServer,
    openEditServer,
    saveServer,
    deleteServer,
    testServer,
    clearServerData,
  };
}
