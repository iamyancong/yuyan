import { reactive, ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  createNginxInstance,
  deleteNginxInstance,
  getNginxInstanceStatus,
  initNginxInstanceWithProgress,
  runNginxInstanceAction,
  updateNginxInstance,
  type DeployProgressEvent,
  type DeployServer,
  type NginxInstance,
  type NginxInstancePayload,
  type NginxRuntimeAction,
  type NginxRuntimePayload,
  type NginxRuntimeStatus,
} from '@/api/deploy';
import type { RefreshActiveTabOptions } from '../types';
import { getErrorMessage, getPreferredNginxInstance, getVisibleNginxInstances } from '../utils';
import { createDefaultNginxInstanceForm } from '../components/NginxRuntimeDrawer/constant';
import { useNginxArchiveDownload } from './useNginxArchiveDownload';

/** Nginx 运行时抽屉 Hook 参数 */
interface UseNginxRuntimeDrawerParams {
  ensureLoggedIn: () => boolean;
  refreshActiveTab: (options?: RefreshActiveTabOptions) => Promise<void>;
  refreshServerList: () => Promise<void>;
}

/**
 * 管理服务器行独立 Nginx 初始化与运行时操作抽屉。
 * @param params 登录态、服务器刷新和当前 Tab 刷新依赖
 * @returns Nginx 运行时抽屉状态和操作方法
 */
export function useNginxRuntimeDrawer(params: UseNginxRuntimeDrawerParams) {
  const runtimeDrawerOpen = ref(false);
  const runtimeServer = ref<DeployServer | null>(null);
  const runtimeInstances = ref<NginxInstance[]>([]);
  const activeNginxInstanceId = ref<number | null>(null);
  const runtimeStatus = ref<NginxRuntimeStatus | null>(null);
  const runtimeLoading = ref(false);
  const runtimeInitializing = ref(false);
  const runtimeActionLoading = ref<NginxRuntimeAction | ''>('');
  const runtimeStatusRequestSeq = ref(0);
  const runtimeInstanceFormOpen = ref(false);
  const runtimeInstanceEditingId = ref<number | null>(null);
  const runtimeInstanceSaving = ref(false);
  const runtimeForm = reactive<NginxRuntimePayload>({
    baseRoot: '/opt/yuyan',
    portStart: 8080,
    useSudo: false,
  });
  const runtimeInstanceForm = reactive<NginxInstancePayload>(createDefaultNginxInstanceForm());
  const runtimeProgressState = reactive<{
    percent: number;
    title: string;
    detail: string;
    logs: DeployProgressEvent[];
    running: boolean;
  }>({
    percent: 0,
    title: '',
    detail: '',
    logs: [],
    running: false,
  });

  /**
   * 判断命令是否为系统 Nginx 的通用默认命令。
   * @param command 命令文本
   * @param type 命令类型
   * @returns 是否通用默认命令
   */
  const isGenericNginxCommand = (command: string | undefined, type: 'test' | 'reload') => {
    const normalized = String(command || '').trim();
    if (!normalized) return true;
    return type === 'reload' ? normalized === 'nginx -s reload' : normalized === 'nginx -t';
  };

  /**
   * 获取托管实例管理脚本路径。
   * @param source 实例或表单数据
   * @returns 管理脚本路径
   */
  const getManagedScriptPath = (source: Partial<NginxInstance & NginxInstancePayload>) => {
    const baseRoot = String(source.baseRoot || '/opt/yuyan').replace(/\/+$/, '') || '/opt/yuyan';
    return source.scriptPath || `${baseRoot}/nginx/yuyan-nginx.sh`;
  };

  /**
   * 解析托管实例命令，避免使用系统 Nginx 的裸命令。
   * @param source 实例或表单数据
   * @param type 命令类型
   * @returns 托管实例命令
   */
  const resolveManagedCommand = (source: Partial<NginxInstance & NginxInstancePayload>, type: 'test' | 'reload') => {
    const command = type === 'reload' ? source.nginxReloadCommand : source.nginxTestCommand;
    if (!isGenericNginxCommand(command, type)) return String(command || '').trim();
    return `${getManagedScriptPath(source)} ${type}`;
  };

  /**
   * 将运行时状态同步到初始化表单。
   * @param status 运行时状态
   */
  const syncRuntimeForm = (status?: NginxRuntimeStatus | null) => {
    const runtime = status?.runtime;
    runtimeForm.baseRoot = runtime?.baseRoot || status?.baseRoot || '/opt/yuyan';
    runtimeForm.portStart = Number(runtime?.portStart || status?.portStart || 8080);
    runtimeForm.useSudo = Boolean(runtime?.useSudo);
  };

  /** 当前选中的 Nginx 实例 */
  const getActiveInstance = () => runtimeInstances.value.find((item) => item.id === activeNginxInstanceId.value) || null;

  const {
    runtimeArchiveDownloading,
    archiveSelectionOpen,
    archiveSelectionLoading,
    archiveSelectionType,
    archiveConfigPath,
    archiveSites,
    downloadActiveNginxArchive,
    refreshArchiveSites,
    confirmArchiveDownload,
    clearArchiveDownloadState,
  } = useNginxArchiveDownload({
    ensureLoggedIn: params.ensureLoggedIn,
    runtimeServer,
    runtimeStatus,
    getActiveInstance,
  });

  /**
   * 更新抽屉内缓存的服务器实例列表。
   * @param instances 最新 Nginx 实例列表
   */
  const updateRuntimeServerInstances = (instances: NginxInstance[]) => {
    if (!runtimeServer.value) return;
    const defaultId = runtimeServer.value?.defaultNginxInstanceId || 0;
    const preferredInstance = getPreferredNginxInstance({ ...runtimeServer.value, nginxInstances: instances });
    const nextDefaultId = preferredInstance?.id || (instances.some((item) => item.id === defaultId) ? defaultId : instances[0]?.id || 0);
    runtimeServer.value = {
      ...runtimeServer.value,
      defaultNginxInstanceId: nextDefaultId,
      nginxInstances: instances,
    };
  };

  /**
   * 局部更新抽屉内的单个 Nginx 实例。
   * @param updated 最新实例
   */
  const patchRuntimeInstance = (updated: NginxInstance) => {
    const exists = runtimeInstances.value.some((item) => item.id === updated.id);
    runtimeInstances.value = exists
      ? runtimeInstances.value.map((item) => {
          if (item.id !== updated.id) return item;
          // 保留 targetCount：status API 不返回准确的绑定数
          return { ...updated, targetCount: updated.targetCount || item.targetCount || 0 };
        })
      : [...runtimeInstances.value, updated];
    updateRuntimeServerInstances(runtimeInstances.value);
  };

  /**
   * 应用接口返回的运行时状态，并同步实例列表与表单。
   * @param status 最新运行时状态
   */
  const applyRuntimeStatus = (status: NginxRuntimeStatus) => {
    runtimeStatus.value = status;
    const runtime = status.runtime;
    if (runtime && 'instanceType' in runtime) {
      patchRuntimeInstance(runtime);
    }
    syncRuntimeForm(status);
  };

  /** 同步服务器实例列表 */
  const syncRuntimeInstances = (server: DeployServer | null) => {
    runtimeInstances.value = getVisibleNginxInstances(server);
    if (!activeNginxInstanceId.value || !runtimeInstances.value.some((item) => item.id === activeNginxInstanceId.value)) {
      const preferredInstance = getPreferredNginxInstance(server);
      activeNginxInstanceId.value = runtimeInstances.value.some((item) => item.id === preferredInstance?.id) ? preferredInstance?.id || null : runtimeInstances.value[0]?.id || null;
    }
  };

  /** 重置 Nginx 初始化进度 */
  const resetRuntimeProgress = () => {
    runtimeProgressState.percent = 0;
    runtimeProgressState.title = '';
    runtimeProgressState.detail = '';
    runtimeProgressState.logs = [];
    runtimeProgressState.running = false;
  };

  /**
   * 将实例数据转换为编辑表单。
   * @param instance Nginx 实例
   * @returns 表单数据
   */
  const createNginxInstanceFormFromInstance = (instance: NginxInstance): NginxInstancePayload => ({
    ...createDefaultNginxInstanceForm(),
    name: instance.name,
    instanceType: instance.instanceType,
    defaultDeployRoot: instance.defaultDeployRoot,
    defaultNginxConfPath: instance.defaultNginxConfPath,
    nginxWorkDir: instance.nginxWorkDir,
    nginxTestCommand: instance.instanceType === 'managed' ? resolveManagedCommand(instance, 'test') : instance.nginxTestCommand,
    nginxReloadCommand: instance.instanceType === 'managed' ? resolveManagedCommand(instance, 'reload') : instance.nginxReloadCommand,
    baseRoot: instance.baseRoot || '/opt/yuyan',
    portStart: Number(instance.portStart || 8080),
    useSudo: Boolean(instance.useSudo),
  });

  /**
   * 校验实例编辑表单。
   * @param payload 实例表单
   * @returns 是否通过
   */
  const validateNginxInstanceForm = (payload: NginxInstancePayload) => {
    const name = String(payload.name || '').trim();
    const defaultDeployRoot = String(payload.defaultDeployRoot || '').trim();
    const defaultNginxConfPath = String(payload.defaultNginxConfPath || '').trim();
    const baseRoot = String(payload.baseRoot || '').trim();
    const portStart = Number(payload.portStart || 0);
    if (!name) {
      message.warning('Nginx 实例名称必填');
      return false;
    }
    if (defaultDeployRoot && !defaultDeployRoot.startsWith('/')) {
      message.warning('默认部署根目录必须使用服务器绝对路径');
      return false;
    }
    if (defaultNginxConfPath && !defaultNginxConfPath.startsWith('/')) {
      message.warning('默认配置文件必须使用服务器绝对路径');
      return false;
    }
    if (payload.instanceType === 'managed' && !baseRoot.startsWith('/')) {
      message.warning('托管根目录必须使用服务器绝对路径');
      return false;
    }
    if (payload.instanceType === 'managed' && (!Number.isInteger(portStart) || portStart < 1 || portStart > 65535)) {
      message.warning('默认监听端口必须在 1-65535 之间');
      return false;
    }
    if (String(payload.nginxTestCommand || '').includes('\n') || String(payload.nginxReloadCommand || '').includes('\n')) {
      message.warning('Nginx 命令不能包含换行');
      return false;
    }
    return true;
  };

  /**
   * 应用流式初始化事件。
   * @param event 初始化事件
   */
  const applyRuntimeProgressEvent = (event: DeployProgressEvent) => {
    runtimeProgressState.logs.push(event);
    if (event.type === 'stage') {
      runtimeProgressState.percent = event.percent;
      runtimeProgressState.title = event.message;
      runtimeProgressState.detail = event.detail || '';
    }
    if (event.type === 'result') {
      runtimeProgressState.percent = 100;
      runtimeProgressState.title = '初始化完成';
      runtimeProgressState.detail = '';
      runtimeProgressState.running = false;
    }
    if (event.type === 'error') {
      runtimeProgressState.title = '初始化失败';
      runtimeProgressState.detail = event.message;
      runtimeProgressState.running = false;
    }
  };

  /**
   * 刷新当前抽屉内运行时状态。
   * @param serverId 服务器 ID
   */
  const refreshRuntimeStatus = async (instanceId = activeNginxInstanceId.value) => {
    if (!instanceId) return;
    const requestSeq = runtimeStatusRequestSeq.value + 1;
    runtimeStatusRequestSeq.value = requestSeq;
    runtimeLoading.value = true;
    try {
      const status = await getNginxInstanceStatus(instanceId);
      if (requestSeq === runtimeStatusRequestSeq.value && instanceId === activeNginxInstanceId.value) {
        applyRuntimeStatus(status);
      }
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      if (requestSeq === runtimeStatusRequestSeq.value) {
        runtimeLoading.value = false;
      }
    }
  };

  /**
   * 直接打开 Nginx 运行时抽屉。
   * @param allServers 可选的全量服务器列表
   */
  const openNginxRuntimeDrawer = async (allServers?: DeployServer[]) => {
    if (!params.ensureLoggedIn()) return;
    resetRuntimeProgress();
    if (allServers?.length) {
      await openNginxRuntime(allServers[0]);
      return;
    }
    runtimeServer.value = null;
    runtimeInstances.value = [];
    activeNginxInstanceId.value = null;
    runtimeStatus.value = null;
    syncRuntimeForm(null);
    runtimeDrawerOpen.value = true;
  };

  /**
   * 打开 Nginx 运行时抽屉。
   * @param server 服务器配置
   */
  const openNginxRuntime = async (server: DeployServer) => {
    if (!params.ensureLoggedIn()) return;
    runtimeServer.value = server;
    syncRuntimeInstances(server);
    runtimeStatus.value = null;
    resetRuntimeProgress();
    const instance = getActiveInstance();
    syncRuntimeForm({
      runtime: instance || server.nginxRuntime,
      initialized: Boolean(instance?.initializedAt || server.nginxRuntime?.initializedAt),
      running: (instance?.status || server.nginxRuntime?.status) === 'running',
      status: instance?.status || server.nginxRuntime?.status || 'uninitialized',
      statusOutput: instance?.statusOutput || server.nginxRuntime?.statusOutput || '',
      platform: '',
      manifest: null,
      version: instance?.runtimeVersion || server.nginxRuntime?.runtimeVersion || '',
      packageVariant: instance?.packageVariant || server.nginxRuntime?.packageVariant || '',
      baseRoot: instance?.baseRoot || server.nginxRuntime?.baseRoot || '/opt/yuyan',
      installRoot: instance?.nginxRoot || server.nginxRuntime?.nginxRoot || '/opt/yuyan/nginx',
      sitesDir: instance?.sitesDir || server.nginxRuntime?.sitesDir || '/opt/yuyan/nginx/conf/conf.d',
      webRoot: instance?.htmlRoot || server.nginxRuntime?.htmlRoot || '/opt/yuyan/html',
      scriptPath: instance?.scriptPath || server.nginxRuntime?.scriptPath || '/opt/yuyan/nginx/yuyan-nginx.sh',
      mainConfPath: instance?.nginxRoot ? `${instance.nginxRoot}/conf/nginx.conf` : '/opt/yuyan/nginx/conf/nginx.conf',
      portStart: instance?.portStart || server.nginxRuntime?.portStart || 8080,
    });
    runtimeDrawerOpen.value = true;
    await refreshRuntimeStatus();
  };

  /**
   * 切换当前管理的 Nginx 实例。
   * @param instanceId 实例 ID
   */
  const selectNginxInstance = async (instanceId: number) => {
    clearArchiveDownloadState();
    activeNginxInstanceId.value = Number(instanceId || 0) || null;
    resetRuntimeProgress();
    await refreshRuntimeStatus();
  };

  /**
   * 在抽屉内切换服务器。
   * @param server 目标服务器
   */
  const switchRuntimeServer = async (server: DeployServer) => {
    clearArchiveDownloadState();
    runtimeServer.value = server;
    syncRuntimeInstances(server);
    runtimeStatus.value = null;
    resetRuntimeProgress();
    const instance = getActiveInstance();
    syncRuntimeForm({
      runtime: instance || server.nginxRuntime,
      initialized: Boolean(instance?.initializedAt || server.nginxRuntime?.initializedAt),
      running: (instance?.status || server.nginxRuntime?.status) === 'running',
      status: instance?.status || server.nginxRuntime?.status || 'uninitialized',
      statusOutput: instance?.statusOutput || server.nginxRuntime?.statusOutput || '',
      platform: '',
      manifest: null,
      version: instance?.runtimeVersion || server.nginxRuntime?.runtimeVersion || '',
      packageVariant: instance?.packageVariant || server.nginxRuntime?.packageVariant || '',
      baseRoot: instance?.baseRoot || server.nginxRuntime?.baseRoot || '/opt/yuyan',
      installRoot: instance?.nginxRoot || server.nginxRuntime?.nginxRoot || '/opt/yuyan/nginx',
      sitesDir: instance?.sitesDir || server.nginxRuntime?.sitesDir || '/opt/yuyan/nginx/conf/conf.d',
      webRoot: instance?.htmlRoot || server.nginxRuntime?.htmlRoot || '/opt/yuyan/html',
      scriptPath: instance?.scriptPath || server.nginxRuntime?.scriptPath || '/opt/yuyan/nginx/yuyan-nginx.sh',
      mainConfPath: instance?.nginxRoot ? `${instance.nginxRoot}/conf/nginx.conf` : '/opt/yuyan/nginx/conf/nginx.conf',
      portStart: instance?.portStart || server.nginxRuntime?.portStart || 8080,
    });
    await refreshRuntimeStatus();
  };

  /** 初始化当前服务器 Nginx 运行时 */
  const initServerNginxRuntime = async () => {
    if (!params.ensureLoggedIn()) return;
    const instance = getActiveInstance();
    if (!instance) return;
    if (instance.instanceType !== 'managed') {
      message.info('已有 Nginx 无需初始化，请使用“校验接入”检查现有配置');
      return;
    }
    const baseRoot = String(runtimeForm.baseRoot || '').trim();
    const portStart = Number(runtimeForm.portStart || 0);
    if (!baseRoot.startsWith('/')) {
      message.warning('Nginx 根目录必须使用服务器绝对路径');
      return;
    }
    if (!Number.isInteger(portStart) || portStart < 1 || portStart > 65535) {
      message.warning('端口起始值必须在 1-65535 之间');
      return;
    }
    runtimeInitializing.value = true;
    resetRuntimeProgress();
    runtimeProgressState.running = true;
    runtimeProgressState.title = '准备初始化';
    runtimeProgressState.detail = baseRoot;
    try {
      const result = await initNginxInstanceWithProgress(instance.id, { baseRoot, portStart, useSudo: Boolean(runtimeForm.useSudo) }, { onEvent: applyRuntimeProgressEvent });
      applyRuntimeStatus(result);
      message.success(result.running ? 'Nginx 已初始化并运行' : 'Nginx 已初始化');
      await params.refreshServerList();
      await params.refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      runtimeProgressState.running = false;
      runtimeInitializing.value = false;
    }
  };

  /**
   * 执行托管 Nginx 运行时操作。
   * @param action 操作类型
   */
  const runServerNginxRuntimeAction = async (action: NginxRuntimeAction) => {
    if (!params.ensureLoggedIn()) return;
    const instance = getActiveInstance();
    if (!instance) return;
    runtimeActionLoading.value = action;
    try {
      const result = await runNginxInstanceAction(instance.id, action);
      applyRuntimeStatus(result.status);
      message.success(result.output || '操作成功');
      await params.refreshServerList();
      await params.refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      runtimeActionLoading.value = '';
    }
  };

  /**
   * 创建 Nginx 实例。
   * @param instanceType 实例类型
   */
  const createServerNginxInstance = (instanceType: NginxInstance['instanceType']) => {
    if (!params.ensureLoggedIn()) return;
    const server = runtimeServer.value;
    if (!server) return;
    if (instanceType === 'managed' && runtimeInstances.value.some((item) => item.instanceType === 'managed')) {
      message.warning('同一服务器只能新增一个托管 Nginx；多个 yuyan 主应用请在当前 nginx.conf 中新增 server 配置');
      return;
    }
    const suffix = runtimeInstances.value.filter((item) => item.instanceType === instanceType).length + 1;
    const managed = instanceType === 'managed';
    Object.assign(runtimeInstanceForm, createDefaultNginxInstanceForm(), {
      name: managed ? 'yuyan托管' : `已有 Nginx ${suffix}`,
      instanceType,
      baseRoot: managed ? '/opt/yuyan' : '',
      portStart: managed ? 8082 : 8080,
      useSudo: Boolean(server.useSudo),
      defaultDeployRoot: managed ? '/opt/yuyan/html' : server.defaultDeployRoot || '/data/webapps/{appName}',
      defaultNginxConfPath: managed ? '/opt/yuyan/nginx/conf/nginx.conf' : server.defaultNginxConfPath || '/etc/nginx/conf.d/{appName}.conf',
      nginxWorkDir: managed ? '' : server.nginxWorkDir,
      nginxTestCommand: managed ? '/opt/yuyan/nginx/yuyan-nginx.sh test' : server.nginxTestCommand || 'nginx -t',
      nginxReloadCommand: managed ? '/opt/yuyan/nginx/yuyan-nginx.sh reload' : server.nginxReloadCommand || 'nginx -s reload',
    });
    runtimeInstanceEditingId.value = null;
    runtimeInstanceFormOpen.value = true;
  };

  /** 打开当前实例编辑表单 */
  const openEditNginxInstance = () => {
    const instance = getActiveInstance();
    if (!instance) return;
    Object.assign(runtimeInstanceForm, createNginxInstanceFormFromInstance(instance));
    runtimeInstanceEditingId.value = instance.id;
    runtimeInstanceFormOpen.value = true;
  };

  /**
   * 保存新增或编辑的 Nginx 实例配置。
   * @param values Formily 校验通过后的字段值
   */
  const saveActiveNginxInstance = async (values: NginxInstancePayload = runtimeInstanceForm) => {
    if (!params.ensureLoggedIn()) return;
    const server = runtimeServer.value;
    if (!server) return;
    const editingId = runtimeInstanceEditingId.value;
    const payload = {
      ...runtimeInstanceForm,
      ...values,
      name: String(values.name || '').trim(),
      defaultDeployRoot: String(values.defaultDeployRoot || '').trim(),
      defaultNginxConfPath: String(values.defaultNginxConfPath || '').trim(),
      nginxWorkDir: String(values.nginxWorkDir || '').trim(),
      nginxTestCommand: String(values.nginxTestCommand || '').trim(),
      nginxReloadCommand: String(values.nginxReloadCommand || '').trim(),
      baseRoot: String(values.baseRoot || '').trim(),
      portStart: Number(values.portStart || 0),
      useSudo: Boolean(values.useSudo),
    };
    if (payload.instanceType === 'managed') {
      payload.nginxTestCommand = resolveManagedCommand(payload, 'test');
      payload.nginxReloadCommand = resolveManagedCommand(payload, 'reload');
    }
    if (!validateNginxInstanceForm(payload)) return;
    runtimeInstanceSaving.value = true;
    try {
      const saved = editingId
        ? await updateNginxInstance(editingId, payload)
        : await createNginxInstance(server.id, payload);
      patchRuntimeInstance(saved);
      activeNginxInstanceId.value = saved.id;
      runtimeInstanceFormOpen.value = false;
      runtimeInstanceEditingId.value = null;
      message.success(editingId ? 'Nginx 实例已更新' : payload.instanceType === 'external' ? '已有 Nginx 已接入' : '托管 Nginx 实例已新增');
      await refreshRuntimeStatus(saved.id);
      await params.refreshServerList();
      await params.refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      runtimeInstanceSaving.value = false;
    }
  };

  /** 删除当前 Nginx 实例 */
  const deleteActiveNginxInstance = async () => {
    if (!params.ensureLoggedIn()) return;
    const instance = getActiveInstance();
    if (!instance) return;
    try {
      await deleteNginxInstance(instance.id);
      message.success('Nginx 实例已删除');
      await params.refreshServerList();
      runtimeInstances.value = runtimeInstances.value.filter((item) => item.id !== instance.id);
      updateRuntimeServerInstances(runtimeInstances.value);
      syncRuntimeInstances(runtimeServer.value);
      runtimeStatus.value = null;
      await refreshRuntimeStatus();
      await params.refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    }
  };

  /** 清空运行时抽屉临时态 */
  const clearNginxRuntimeDrawer = () => {
    runtimeDrawerOpen.value = false;
    runtimeServer.value = null;
    runtimeInstances.value = [];
    activeNginxInstanceId.value = null;
    runtimeStatus.value = null;
    runtimeInstanceFormOpen.value = false;
    runtimeInstanceEditingId.value = null;
    Object.assign(runtimeInstanceForm, createDefaultNginxInstanceForm());
    clearArchiveDownloadState();
    resetRuntimeProgress();
  };

  return {
    runtimeDrawerOpen,
    runtimeServer,
    runtimeInstances,
    activeNginxInstanceId,
    runtimeStatus,
    runtimeLoading,
    runtimeInitializing,
    runtimeActionLoading,
    runtimeArchiveDownloading,
    archiveSelectionOpen,
    archiveSelectionLoading,
    archiveSelectionType,
    archiveConfigPath,
    archiveSites,
    runtimeInstanceFormOpen,
    runtimeInstanceEditingId,
    runtimeInstanceSaving,
    runtimeForm,
    runtimeInstanceForm,
    runtimeProgressState,
    openNginxRuntime,
    openNginxRuntimeDrawer,
    selectNginxInstance,
    switchRuntimeServer,
    refreshRuntimeStatus,
    initServerNginxRuntime,
    runServerNginxRuntimeAction,
    downloadActiveNginxArchive,
    refreshArchiveSites,
    confirmArchiveDownload,
    createServerNginxInstance,
    openEditNginxInstance,
    saveActiveNginxInstance,
    deleteActiveNginxInstance,
    clearNginxRuntimeDrawer,
  };
}
