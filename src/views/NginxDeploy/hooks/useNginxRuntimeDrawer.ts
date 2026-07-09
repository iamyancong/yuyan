import { reactive, ref, h } from 'vue';
import message from 'ant-design-vue/es/message';
import notification from 'ant-design-vue/es/notification';
import Modal from 'ant-design-vue/es/modal';
import {
  createNginxInstance,
  deleteNginxInstance,
  saveNginxInstanceArchiveToLocal,
  getNginxInstanceArchiveDownloadUrl,
  getNginxInstanceStatus,
  initNginxInstanceWithProgress,
  isLocalServerUnavailableError,
  runNginxInstanceAction,
  updateNginxInstance,
  type DeployProgressEvent,
  type DeployServer,
  type NginxInstance,
  type NginxInstancePayload,
  type NginxRuntimeAction,
  type NginxRuntimePayload,
  type NginxRuntimeStatus,
  type NginxArchiveSaveEvent,
  type NginxArchiveSaveStage,
} from '@/api/deploy';
import type { RefreshActiveTabOptions } from '../types';
import { getErrorMessage, getPreferredNginxInstance, getVisibleNginxInstances } from '../utils';
import { createDefaultNginxInstanceForm } from '../components/NginxRuntimeDrawer/constant';
import { downloadDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/utils/env';

/** Nginx 运行时抽屉 Hook 参数 */
interface UseNginxRuntimeDrawerParams {
  ensureLoggedIn: () => boolean;
  refreshActiveTab: (options?: RefreshActiveTabOptions) => Promise<void>;
  refreshServerList: () => Promise<void>;
}

/** 运行包下载阶段文案 */
const ARCHIVE_SAVE_STAGE_LABEL: Record<NginxArchiveSaveStage, string> = {
  preparing: '准备下载',
  prechecking: '远程预检',
  packing: '远程打包',
  writing: '写入磁盘',
  finished: '下载完成',
};

/** 自动下载运行包的目录名 */
const ARCHIVE_DOWNLOAD_DIR_NAME = 'yuyan-runtime-packages';

/**
 * 拼接系统原生路径。
 * @param base 基础目录
 * @param parts 路径片段
 * @returns 拼接后的路径
 */
const joinNativePath = (base: string, ...parts: string[]) => {
  const separator = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))].join(separator);
};

/**
 * 格式化文件大小。
 * @param bytes 字节数
 * @returns 可读文件大小
 */
const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
};

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
  const runtimeArchiveDownloading = ref(false);
  const runtimeInstanceFormOpen = ref(false);
  const runtimeInstanceFormKey = ref(0);
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
    activeNginxInstanceId.value = Number(instanceId || 0) || null;
    resetRuntimeProgress();
    await refreshRuntimeStatus();
  };

  /**
   * 在抽屉内切换服务器。
   * @param server 目标服务器
   */
  const switchRuntimeServer = async (server: DeployServer) => {
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

  const downloadActiveNginxArchive = async (type: 'all' | 'html' | 'conf' = 'all') => {
    if (!params.ensureLoggedIn()) return;
    const instance = getActiveInstance();
    if (!instance) return;
    if (instance.instanceType !== 'managed') {
      message.warning('只有托管 Nginx 实例支持下载运行包');
      return;
    }
    if (!runtimeStatus.value?.initialized) {
      message.warning('请先初始化托管 Nginx 实例，再下载运行包');
      return;
    }

    const typeLabels = {
      all: '完整运行包',
      html: '前端静态产物 (HTML)',
      conf: 'Nginx 配置文件 (nginx.conf)',
    };
    const typeLabel = typeLabels[type] || '运行包';

    const sanitizeName = (val: string) => val.trim().replace(/\s+/g, '-').replace(/[\\/:*?"<>|]/g, '-').replace(/-+/g, '-');
    const serverPart = sanitizeName(runtimeServer.value?.name || runtimeServer.value?.host || 'server');
    const instancePart = sanitizeName(instance.name || 'instance');
    const pad = (v: number) => String(v).padStart(2, '0');
    const d = new Date();
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    
    let defaultFileName = '';
    if (type === 'conf') {
      defaultFileName = 'nginx.conf';
    } else {
      const suffix = type === 'html' ? '-html' : '';
      defaultFileName = `${serverPart}-${instancePart}${suffix}-${ts}.tar.gz`;
    }

    /** 触发普通浏览器下载，作为本地直写不可用时的降级方案。 */
    const triggerBrowserDownload = () => {
      const downloadUrl = getNginxInstanceArchiveDownloadUrl(instance.id, type);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = defaultFileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    const isTauriClient = isTauri();
    let filePath = '';
    if (isTauriClient) {
      try {
        const dlDir = await downloadDir();
        filePath = joinNativePath(dlDir, ARCHIVE_DOWNLOAD_DIR_NAME, defaultFileName);
      } catch (e) {
        console.warn('获取默认下载目录失败', e);
        message.error('获取系统下载目录失败，无法自动保存运行包');
        return;
      }
    }

    if (!isTauriClient) {
      triggerBrowserDownload();
      return;
    }

    const controller = new AbortController();
    let isFinished = false;
    let currentLoaded = 0;
    let currentStage: NginxArchiveSaveStage = 'preparing';
    let currentStageMessage = '正在准备自动下载任务';
    let savedFilePath = filePath;
    let savedFileName = defaultFileName;
    let isUpdatingNotification = false;

    const notificationKey = `download-${Date.now()}`;

    /** 展示关闭下载通知时的二次确认。 */
    const showConfirmModal = () => {
      if (isFinished) return;

      const confirmModal = Modal.confirm({
        title: '确认要关闭提示吗？',
        okText: '终止下载',
        cancelText: '取消',
        okButtonProps: { danger: true },
        content: h('div', null, [
          h('p', null, '选择“终止下载”将终止本次直写并释放服务器资源。点击“取消”将返回前台下载界面。'),
          h('p', { style: 'margin-bottom: 12px; color: rgba(0,0,0,0.45); font-size: 12px;' }, '您也可以转为后台静默下载，不会关闭下载进程：'),
          h('button', {
            class: 'ant-btn ant-btn-primary ant-btn-sm',
            onClick: () => {
              message.info(`已转为后台下载 ${typeLabel}`);
              confirmModal.destroy();
            }
          }, '转为后台运行')
        ]),
        onOk() {
          isFinished = true;
          controller.abort();
        },
        onCancel() {
          triggerNotification();
        }
      });
    };

    /** 打开关于弹窗查看本地服务诊断信息。 */
    const openDiagnosticModal = () => {
      window.dispatchEvent(new CustomEvent('show-about-modal'));
    };

    /**
     * 创建下载失败后的操作按钮组。
     * @param includeFallback 是否展示普通下载按钮
     */
    const createFailureActions = (includeFallback = false) => h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px;' }, [
      h('button', {
        class: 'ant-btn ant-btn-primary ant-btn-sm',
        onClick: () => {
          notification.close(notificationKey);
          void downloadActiveNginxArchive(type);
        }
      }, '重试'),
      includeFallback
        ? h('button', {
            class: 'ant-btn ant-btn-sm',
            onClick: () => {
              triggerBrowserDownload();
              message.info('已切换为普通下载');
            }
          }, '普通下载')
        : null,
      h('button', {
        class: 'ant-btn ant-btn-sm',
        onClick: openDiagnosticModal,
      }, '打开诊断信息')
    ].filter(Boolean));

    /** 将下载错误转成用户可理解的中文文案。 */
    const formatDownloadErrorMessage = (error: any) => {
      if (isLocalServerUnavailableError(error)) {
        return error.message || '本地辅助服务未就绪，已切换为普通下载';
      }
      const raw = getErrorMessage(error);
      if (raw === 'Failed to fetch') {
        return '网络请求失败，请检查本地辅助服务、内网服务地址或网络连接';
      }
      return raw;
    };

    /** 统一渲染下载进度通知。 */
    const triggerNotification = () => {
      if (isFinished) return;

      const stageLabel = ARCHIVE_SAVE_STAGE_LABEL[currentStage] || '下载中';
      const progressText = currentLoaded > 0 ? formatBytes(currentLoaded) : '处理中';
      const description = currentLoaded > 0
        ? `${currentStageMessage}，已写入 ${formatBytes(currentLoaded)}`
        : currentStageMessage;

      isUpdatingNotification = true;

      notification.info({
        key: notificationKey,
        class: 'c4d-download-notification',
        icon: h('span', { class: 'c4d-status-led is-downloading' }),
        message: h('div', { style: 'display: flex; justify-content: space-between; align-items: center; width: 100%;' }, [
          h('span', null, `${stageLabel} ${typeLabel}`),
          h('span', { class: 'c4d-percent-text' }, progressText)
        ]),
        description: h('div', null, [
          h('span', null, description),
          h('div', { class: 'c4d-progress-wrapper' }, [
            h('div', { class: 'c4d-progress-track' }, [
              h('div', { class: 'c4d-progress-bar is-downloading' })
            ])
          ])
        ]),
        duration: 0,
        onClose: () => {
          if (isUpdatingNotification) {
            return;
          }
          showConfirmModal();
        }
      });

      setTimeout(() => {
        isUpdatingNotification = false;
      }, 50);
    };

    /**
     * 根据服务端 SSE 更新下载状态。
     * @param event 保存事件
     */
    const handleSaveEvent = (event: NginxArchiveSaveEvent) => {
      if (event.stage) currentStage = event.stage;
      if (event.message) currentStageMessage = event.message;
      if (event.loaded !== undefined) currentLoaded = event.loaded;
      if (event.filePath) savedFilePath = event.filePath;
      if (event.fileName) savedFileName = event.fileName;
      if (!event.finished) triggerNotification();
    };

    triggerNotification();

    runtimeArchiveDownloading.value = true;
    try {
      await saveNginxInstanceArchiveToLocal(
        instance.id,
        type,
        filePath,
        handleSaveEvent,
        controller.signal
      );

      isFinished = true;
      const fileBaseName = savedFileName || savedFilePath.substring(savedFilePath.lastIndexOf(savedFilePath.includes('\\') ? '\\' : '/') + 1);

      const openFolderLink = h('a', {
        href: 'javascript:;',
        class: 'c4d-locate-btn',
        onClick: () => {
          invoke('reveal_in_file_manager', { path: savedFilePath })
            .catch(err => message.error(`定位失败: ${err}`));
        }
      }, '打开文件位置');

      const successText = '已成功直写保存';
      const confSuccessText = 'Nginx 配置文件已直写完成';

      if (type === 'conf') {
        notification.success({
          key: notificationKey,
          class: 'c4d-download-notification',
          icon: h('span', { class: 'c4d-status-led is-success' }),
          message: h('div', { style: 'display: flex; justify-content: space-between; align-items: center; width: 100%;' }, [
            h('span', null, '下载已完成'),
            h('span', { class: 'c4d-percent-text success' }, '100%')
          ]),
          description: h('div', null, [
            h('p', { style: 'margin-bottom: 4px;' }, `${confSuccessText}：${fileBaseName}`),
            h('div', { class: 'c4d-progress-wrapper', style: 'margin-bottom: 12px;' }, [
              h('div', { class: 'c4d-progress-track' }, [
                h('div', { class: 'c4d-progress-bar is-success', style: 'width: 100%' })
              ])
            ]),
            openFolderLink
          ]),
          duration: 6,
          onClose: () => {},
        });
      } else {
        const scriptPath = instance.scriptPath || `${instance.baseRoot}/nginx/yuyan-nginx.sh`;
        const actionTip = `目标机执行：tar -xzf ${fileBaseName} -C / ；运行 ${scriptPath} start 启动服务。`;

        notification.success({
          key: notificationKey,
          class: 'c4d-download-notification',
          icon: h('span', { class: 'c4d-status-led is-success' }),
          message: h('div', { style: 'display: flex; justify-content: space-between; align-items: center; width: 100%;' }, [
            h('span', null, '下载已完成'),
            h('span', { class: 'c4d-percent-text success' }, '100%')
          ]),
          description: h('div', null, [
            h('p', { style: 'margin-bottom: 4px;' }, `${successText}：${fileBaseName}`),
            h('p', { style: 'font-size: 12px; color: rgba(0,0,0,0.45); margin-bottom: 8px;' }, actionTip),
            h('div', { class: 'c4d-progress-wrapper', style: 'margin-bottom: 12px;' }, [
              h('div', { class: 'c4d-progress-track' }, [
                h('div', { class: 'c4d-progress-bar is-success', style: 'width: 100%' })
              ])
            ]),
            openFolderLink
          ]),
          duration: 10,
          onClose: () => {},
        });
      }
    } catch (error: any) {
      isFinished = true;
      if (error.name === 'AbortError') {
        message.info(`已取消下载 ${typeLabel}`);
        notification.close(notificationKey);
        return;
      }
      if (isLocalServerUnavailableError(error)) {
        triggerBrowserDownload();
        notification.warning({
          key: notificationKey,
          class: 'c4d-download-notification',
          icon: h('span', { class: 'c4d-status-led is-error' }),
          message: '已切换为普通下载',
          description: h('div', null, [
            h('p', { style: 'margin-bottom: 8px;' }, formatDownloadErrorMessage(error)),
            h('p', { style: 'font-size: 12px; color: rgba(0,0,0,0.45); margin-bottom: 8px;' }, '本地直写依赖内嵌 Node 辅助服务；当前服务不可用时，文件仍会通过浏览器下载。'),
            createFailureActions(true)
          ]),
          duration: 8,
          onClose: () => {},
        });
        return;
      }
      notification.error({
        key: notificationKey,
        class: 'c4d-download-notification',
        icon: h('span', { class: 'c4d-status-led is-error' }),
        message: '下载失败',
        description: h('div', null, [
          h('p', { style: 'margin-bottom: 8px;' }, formatDownloadErrorMessage(error)),
          h('div', { class: 'c4d-progress-wrapper' }, [
            h('div', { class: 'c4d-progress-track' }, [
              h('div', { class: 'c4d-progress-bar is-error', style: 'width: 100%' })
            ])
          ]),
          createFailureActions(false)
        ]),
        duration: 5,
        onClose: () => {},
      });
    } finally {
      runtimeArchiveDownloading.value = false;
    }
  };

  /**
   * 创建 Nginx 实例。
   * @param instanceType 实例类型
   */
  const createServerNginxInstance = async (instanceType: NginxInstance['instanceType']) => {
    if (!params.ensureLoggedIn()) return;
    const server = runtimeServer.value;
    if (!server) return;
    if (instanceType === 'managed' && runtimeInstances.value.some((item) => item.instanceType === 'managed')) {
      message.warning('同一服务器只能新增一个托管 Nginx；多个 yuyan 主应用请在当前 nginx.conf 中新增 server 配置');
      return;
    }
    try {
      const suffix = runtimeInstances.value.length + 1;
      const instance = await createNginxInstance(server.id, {
        name: instanceType === 'managed' ? 'yuyan托管' : `已有 Nginx ${suffix}`,
        instanceType,
        baseRoot: instanceType === 'managed' ? '/opt/yuyan' : `/opt/yuyan-${suffix}`,
        portStart: instanceType === 'managed' ? 8082 : 8080 + suffix,
        useSudo: Boolean(server.useSudo),
        defaultDeployRoot: instanceType === 'managed' ? '/opt/yuyan/html' : server.defaultDeployRoot,
        defaultNginxConfPath: instanceType === 'managed' ? '/opt/yuyan/nginx/conf/nginx.conf' : server.defaultNginxConfPath,
        nginxWorkDir: server.nginxWorkDir,
        nginxTestCommand: instanceType === 'managed' ? '/opt/yuyan/nginx/yuyan-nginx.sh test' : server.nginxTestCommand,
        nginxReloadCommand: instanceType === 'managed' ? '/opt/yuyan/nginx/yuyan-nginx.sh reload' : server.nginxReloadCommand,
      });
      patchRuntimeInstance(instance);
      activeNginxInstanceId.value = instance.id;
      message.success('Nginx 实例已新增');
      await refreshRuntimeStatus(instance.id);
      await params.refreshServerList();
      await params.refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    }
  };

  /** 打开当前实例编辑表单 */
  const openEditNginxInstance = () => {
    const instance = getActiveInstance();
    if (!instance) return;
    Object.assign(runtimeInstanceForm, createNginxInstanceFormFromInstance(instance));
    runtimeInstanceFormKey.value += 1;
    runtimeInstanceFormOpen.value = true;
  };

  /** 保存当前 Nginx 实例配置 */
  const saveActiveNginxInstance = async () => {
    if (!params.ensureLoggedIn()) return;
    const instance = getActiveInstance();
    if (!instance) return;
    const payload = {
      ...runtimeInstanceForm,
      name: String(runtimeInstanceForm.name || '').trim(),
      defaultDeployRoot: String(runtimeInstanceForm.defaultDeployRoot || '').trim(),
      defaultNginxConfPath: String(runtimeInstanceForm.defaultNginxConfPath || '').trim(),
      nginxWorkDir: String(runtimeInstanceForm.nginxWorkDir || '').trim(),
      nginxTestCommand: String(runtimeInstanceForm.nginxTestCommand || '').trim(),
      nginxReloadCommand: String(runtimeInstanceForm.nginxReloadCommand || '').trim(),
      baseRoot: String(runtimeInstanceForm.baseRoot || '').trim(),
      portStart: Number(runtimeInstanceForm.portStart || 0),
      useSudo: Boolean(runtimeInstanceForm.useSudo),
    };
    if (payload.instanceType === 'managed') {
      payload.nginxTestCommand = resolveManagedCommand(payload, 'test');
      payload.nginxReloadCommand = resolveManagedCommand(payload, 'reload');
    }
    if (!validateNginxInstanceForm(payload)) return;
    runtimeInstanceSaving.value = true;
    try {
      const updated = await updateNginxInstance(instance.id, payload);
      patchRuntimeInstance(updated);
      runtimeInstanceFormOpen.value = false;
      message.success('Nginx 实例已更新');
      await refreshRuntimeStatus(updated.id);
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
    Object.assign(runtimeInstanceForm, createDefaultNginxInstanceForm());
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
    runtimeInstanceFormOpen,
    runtimeInstanceFormKey,
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
    createServerNginxInstance,
    openEditNginxInstance,
    saveActiveNginxInstance,
    deleteActiveNginxInstance,
    clearNginxRuntimeDrawer,
  };
}
