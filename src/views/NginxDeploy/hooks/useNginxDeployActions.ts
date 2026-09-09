import { computed, type Ref, ref, onActivated, onDeactivated, onMounted, onUnmounted } from 'vue';
import type { YTableActionConfig } from '@yss-ui/components/lite';
import type { DeployProgressSnapshot, DeployRecord, DeployServer, DeployTarget } from '@/api/deploy';
import { useNginxDeployContext } from './useNginxDeployContext';
import { isTauri } from '@/utils/env';
import message from 'ant-design-vue/es/message';
import axios from 'axios';

/** 部署中心表格操作 Hook 参数 */
interface UseNginxDeployActionsParams {
  targetFormLoading?: Ref<boolean>;
  activeTargetId?: Ref<number | null>;
  testServer?: (server: DeployServer) => Promise<void>;
  openNginxRuntime?: (server: DeployServer) => Promise<void>;
  openEditServer?: (server: DeployServer) => Promise<void>;
  deleteServer?: (server: DeployServer) => Promise<void>;
  openPublishConfirm?: (target: DeployTarget) => Promise<void>;
  openOpenApi?: (target: DeployTarget) => Promise<void>;
  runServiceAction?: (target: DeployTarget, action: 'start' | 'stop' | 'restart') => Promise<void>;
  openServiceLogs?: (target: DeployTarget) => Promise<void>;
  openTargetProgress?: (target: DeployTarget) => Promise<void>;
  openNginxConfig?: (target: DeployTarget) => void;
  openEditTarget?: (target: DeployTarget) => Promise<void>;
  syncTargetSite?: (target: DeployTarget) => Promise<void>;
  deleteTarget?: (target: DeployTarget) => Promise<void>;
  getTargetRuntimeSnapshot?: (target: Pick<DeployTarget, 'id'>) => DeployProgressSnapshot | undefined;
  openRecordLogs?: (record: DeployRecord) => Promise<void>;
  runRollback?: (record: DeployRecord) => Promise<void>;
  runUndoRollback?: (record: DeployRecord) => Promise<void>;
}

/**
 * 生成部署中心三张表的操作列配置。
 * @description 支持零传参的依赖注入，解耦原本扁平化的数据传递网络。
 * @param params 可选操作回调依赖
 * @returns 服务器、目标和发布历史表格操作配置
 */
export function useNginxDeployActions(params?: UseNginxDeployActionsParams) {
  const fallbackContext = useNginxDeployContext;
  const getContext = () => {
    try {
      return fallbackContext();
    } catch {
      return null;
    }
  };
  const context = getContext();

  const targetFormLoading = params?.targetFormLoading ?? context?.targetFormLoading;
  const activeTargetId = params?.activeTargetId ?? context?.activeTargetId;

  const testServer = params?.testServer;
  const openNginxRuntime = params?.openNginxRuntime;
  const openEditServer = params?.openEditServer;
  const deleteServer = params?.deleteServer;

  const isLocalHelperOnline = ref(true);
  let heartbeatTimer: number | null = null;

  /** 检查本机辅助服务是否在线 */
  const checkHeartbeat = async () => {
    if (isTauri()) {
      isLocalHelperOnline.value = true;
      return;
    }
    try {
      await axios.get('http://127.0.0.1:3100/health', { timeout: 1000 });
      isLocalHelperOnline.value = true;
    } catch {
      isLocalHelperOnline.value = false;
    }
  };

  /** 启动本机辅助服务心跳 */
  const startHeartbeat = () => {
    if (heartbeatTimer !== null) return;
    void checkHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      void checkHeartbeat();
    }, 5000);
  };

  /** 停止本机辅助服务心跳 */
  const stopHeartbeat = () => {
    if (heartbeatTimer === null) return;
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  onMounted(startHeartbeat);
  onActivated(startHeartbeat);
  onDeactivated(stopHeartbeat);
  onUnmounted(stopHeartbeat);

  const openPublishConfirm = params?.openPublishConfirm;
  const openOpenApi = params?.openOpenApi;
  const runServiceAction = params?.runServiceAction;
  const openServiceLogs = params?.openServiceLogs;
  const openTargetProgress = params?.openTargetProgress;
  const openNginxConfig = params?.openNginxConfig;
  const openEditTarget = params?.openEditTarget;
  const syncTargetSite = params?.syncTargetSite;
  const deleteTarget = params?.deleteTarget;
  const openRecordLogs = params?.openRecordLogs;
  const runRollback = params?.runRollback;
  const runUndoRollback = params?.runUndoRollback;

  const getTargetRuntimeSnapshot = (target: Pick<DeployTarget, 'id'>) => {
    if (params?.getTargetRuntimeSnapshot) return params.getTargetRuntimeSnapshot(target);
    if (context?.targetRuntimeSnapshots) return context.targetRuntimeSnapshots.value[target.id];
    return undefined;
  };

  /**
   * 判断部署目标是否存在运行中任务。
   * @param target 部署目标
   * @returns 是否运行中
   */
  const isTargetRunning = (target: DeployTarget) => Boolean(getTargetRuntimeSnapshot(target)?.running);

  const serverActionConfig = computed<YTableActionConfig>(() => ({
    width: 300,
    fixed: 'right',
    buttons: [
      {
        key: 'test',
        text: '检测连接',
        type: 'link',
        confirmProps: { needLoading: true },
        clickFn: async ({ row }, _button, helpers) => {
          try {
            await testServer?.(row);
          } finally {
            helpers?.hideLoading?.();
          }
        },
      },
      {
        key: 'nginx',
        text: 'Nginx 管理',
        type: 'link',
        clickFn: ({ row }) => {
          void openNginxRuntime?.(row);
        },
      },
      {
        key: 'edit',
        text: '编辑',
        type: 'link',
        clickFn: ({ row }) => openEditServer?.(row),
      },
      {
        key: 'delete',
        text: '删除',
        type: 'link',
        isConfirm: true,
        confirmProps: { title: '确认删除该服务器配置？', okText: '删除', cancelText: '取消' },
        clickFn: async ({ row }) => {
          await deleteServer?.(row);
        },
      },
    ],
  }));

  const targetActionConfig = computed<YTableActionConfig>(() => ({
    width: 280,
    fixed: 'right',
    buttons: [
      {
        key: 'progress',
        text: '查看进度',
        type: 'link',
        hideFn: ({ row }) => !isTargetRunning(row),
        clickFn: ({ row }) => {
          void openTargetProgress?.(row);
        },
      },
      {
        key: 'deploy',
        text: '发布',
        type: 'link',
        hideFn: ({ row }) => isTargetRunning(row),
        clickFn: ({ row }) => {
          if (row.projectType === 'backend' && !isTauri()) {
            message.warning('后端项目需要本地打包环境，请使用雨燕客户端进行发布');
            return;
          }
          void openPublishConfirm?.(row);
        },
      },
      {
        key: 'openapi',
        text: '生成 OpenAPI',
        type: 'link',
        hideFn: ({ row }) => row.projectType !== 'backend' || isTargetRunning(row),
        clickFn: ({ row }) => {
          if (!isTauri()) {
            message.warning('生成 OpenAPI 需要本地构建环境，请使用雨燕客户端进行操作');
            return;
          }
          void openOpenApi?.(row);
        },
      },
      {
        key: 'nginx',
        text: 'Nginx',
        type: 'link',
        hideFn: ({ row }) => row.projectType === 'backend',
        disabledFn: ({ row }) => isTargetRunning(row),
        clickFn: ({ row }) => {
          openNginxConfig?.(row);
        },
      },
      {
        key: 'syncSite',
        text: '同步站点',
        type: 'link',
        hideFn: ({ row }) => row.projectType === 'backend' || !row.nginxSiteManaged,
        disabledFn: ({ row }) => isTargetRunning(row),
        isConfirm: true,
        confirmProps: {
          title: '确认同步托管 Nginx 站点配置？',
          okText: '同步',
          cancelText: '取消',
          needLoading: true,
        },
        clickFn: async ({ row }, _btn, helpers) => {
          try {
            await syncTargetSite?.(row);
          } finally {
            helpers?.hideLoading?.();
          }
        },
      },
      {
        key: 'startService',
        text: '启动',
        type: 'link',
        hideFn: ({ row }) => row.projectType !== 'backend' || row.serviceStatus === 'online' || isTargetRunning(row),
        isConfirm: true,
        confirmProps: {
          title: '确认启动该后端服务？',
          okText: '启动',
          cancelText: '取消',
          needLoading: true,
        },
        clickFn: async ({ row }, _btn, helpers) => {
          try {
            await runServiceAction?.(row, 'start');
          } finally {
            helpers?.hideLoading?.();
          }
        },
      },
      {
        key: 'stopService',
        text: '停止',
        type: 'link',
        hideFn: ({ row }) => row.projectType !== 'backend' || row.serviceStatus !== 'online' || isTargetRunning(row),
        isConfirm: true,
        confirmProps: { title: '确认优雅停止该后端服务？', okText: '停止', cancelText: '取消', needLoading: true },
        clickFn: async ({ row }, _btn, helpers) => {
          try {
            await runServiceAction?.(row, 'stop');
          } finally {
            helpers?.hideLoading?.();
          }
        },
      },
      {
        key: 'restartService',
        text: '重启',
        type: 'link',
        hideFn: ({ row }) => row.projectType !== 'backend' || row.serviceStatus !== 'online' || isTargetRunning(row),
        isConfirm: true,
        confirmProps: { title: '确认重启该后端服务？', okText: '重启', cancelText: '取消', needLoading: true },
        clickFn: async ({ row }, _btn, helpers) => {
          try {
            await runServiceAction?.(row, 'restart');
          } finally {
            helpers?.hideLoading?.();
          }
        },
      },
      {
        key: 'serviceLogs',
        text: '日志',
        type: 'link',
        hideFn: ({ row }) => row.projectType !== 'backend',
        clickFn: ({ row }) => void openServiceLogs?.(row),
      },
      {
        key: 'edit',
        text: '编辑',
        type: 'link',
        disabledFn: ({ row }) => isTargetRunning(row) || Boolean(targetFormLoading?.value && activeTargetId?.value !== row.id),
        clickFn: ({ row }) => openEditTarget?.(row),
      },
      {
        key: 'delete',
        text: '删除',
        type: 'link',
        disabledFn: ({ row }) => isTargetRunning(row),
        isConfirm: true,
        confirmProps: { title: '确认删除该部署目标？', okText: '删除', cancelText: '取消' },
        clickFn: async ({ row }) => {
          await deleteTarget?.(row);
        },
      },
    ],
  }));

  const recordActionConfig = computed<YTableActionConfig>(() => ({
    width: 120,
    fixed: 'right',
    buttons: [
      { key: 'logs', text: '日志', type: 'link', clickFn: ({ row }) => openRecordLogs?.(row) },
      {
        key: 'rollback',
        text: '回滚',
        type: 'link',
        isConfirm: true,
        hideFn: ({ row }) => !row.canRollback,
        confirmProps: { title: '确认回滚到当前记录的可恢复版本？', okText: '回滚', cancelText: '取消' },
        clickFn: ({ row }) => runRollback?.(row),
      },
      {
        key: 'undoRollback',
        text: '撤销回滚',
        type: 'link',
        isConfirm: true,
        hideFn: ({ row }) => !row.canUndoRollback,
        confirmProps: { title: '确认撤销本次回滚并恢复到回滚前版本？', okText: '撤销回滚', cancelText: '取消' },
        clickFn: ({ row }) => runUndoRollback?.(row),
      },
    ],
  }));

  return {
    serverActionConfig,
    targetActionConfig,
    recordActionConfig,
  };
}
