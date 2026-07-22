import { h, ref, type Ref } from 'vue';
import { CloseOutlined } from '@ant-design/icons-vue';
import message from 'ant-design-vue/es/message';
import notification from 'ant-design-vue/es/notification';
import { Channel, invoke } from '@tauri-apps/api/core';
import {
  downloadNginxInstanceArchive,
  getDeployApiAuthHeaders,
  getNginxInstanceArchiveDownloadUrl,
  getNginxInstanceArchiveSites,
  type DeployServer,
  type NativeFileDownloadProgress,
  type NativeFileDownloadResult,
  type NginxArchiveDownloadType,
  type NginxArchiveSelection,
  type NginxArchiveSiteOption,
  type NginxInstance,
  type NginxRuntimeStatus,
} from '@/api/deploy';
import { isTauri } from '@/utils/env';
import { getErrorMessage } from '../utils';

/** 归档类型文案。 */
const ARCHIVE_TYPE_LABEL: Record<NginxArchiveDownloadType, string> = {
  all: '完整运行包',
  html: '前端静态产物',
  conf: 'Nginx 配置文件',
};

/** 创建可访问的下载通知关闭图标。 */
const createDownloadNotificationCloseIcon = () => h(CloseOutlined, { 'aria-label': '关闭通知' });

/** Nginx 归档下载 Hook 参数。 */
interface UseNginxArchiveDownloadParams {
  ensureLoggedIn: () => boolean;
  runtimeServer: Ref<DeployServer | null>;
  runtimeStatus: Ref<NginxRuntimeStatus | null>;
  getActiveInstance: () => NginxInstance | null;
}

/** 选择窗口提交的数据。 */
export interface NginxArchiveSelectionSubmit {
  type: NginxArchiveDownloadType;
  siteIds: string[];
}

/**
 * 格式化文件大小。
 * @param bytes 字节数
 * @returns 可读文件大小
 */
export const formatArchiveBytes = (bytes: number) => {
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

/** 生成不含路径分隔符的下载兜底文件名。 */
const buildSuggestedFileName = (
  server: DeployServer | null,
  instance: NginxInstance,
  type: NginxArchiveDownloadType,
  sites: NginxArchiveSiteOption[]
) => {
  const sanitize = (value: string, fallback: string) => value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-+/g, '-') || fallback;
  const pad = (value: number) => String(value).padStart(2, '0');
  const now = new Date();
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ports = [...new Set(sites.flatMap((site) => site.listenPorts))].sort((left, right) => left - right).join('-');
  const prefix = `${sanitize(server?.name || server?.host || '', 'server')}-${sanitize(instance.name, 'nginx')}${ports ? `-${ports}` : ''}`;
  if (type === 'conf') return `${prefix}-nginx-${timestamp}.conf`;
  return `${prefix}${type === 'html' ? '-html' : ''}-${timestamp}.tar.gz`;
};

/** 使用 fetch + Blob 触发带认证头的浏览器下载。 */
const saveArchiveInBrowser = async (
  instanceId: number,
  selection: NginxArchiveSelection,
  onProgress: (loaded: number) => void
) => {
  const result = await downloadNginxInstanceArchive(
    instanceId,
    selection.type,
    onProgress,
    undefined,
    selection
  );
  const objectUrl = URL.createObjectURL(result.blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = result.fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
  return { fileName: result.fileName, fileSize: result.blob.size };
};

/**
 * 管理 Nginx 多 server 选择与可靠下载。
 * @param params 当前实例、服务器和登录态依赖
 * @returns 选择窗口状态和下载动作
 */
export function useNginxArchiveDownload(params: UseNginxArchiveDownloadParams) {
  const runtimeArchiveDownloading = ref(false);
  const archiveSelectionOpen = ref(false);
  const archiveSelectionLoading = ref(false);
  const archiveSelectionType = ref<NginxArchiveDownloadType>('all');
  const archiveConfigPath = ref('');
  const archiveRevision = ref('');
  const archiveSites = ref<NginxArchiveSiteOption[]>([]);
  let activeNotificationKey = '';

  /** 校验当前实例是否允许读取归档站点。 */
  const validateActiveInstance = () => {
    if (!params.ensureLoggedIn()) return null;
    const instance = params.getActiveInstance();
    if (!instance) return null;
    if (instance.instanceType !== 'managed') {
      message.warning('只有托管 Nginx 实例支持下载运行包');
      return null;
    }
    if (!params.runtimeStatus.value?.initialized) {
      message.warning('请先初始化托管 Nginx 实例，再下载运行包');
      return null;
    }
    return instance;
  };

  /** 从中央服务刷新可选 server 块。 */
  const refreshArchiveSites = async () => {
    const instance = validateActiveInstance();
    if (!instance) return;
    archiveSelectionLoading.value = true;
    try {
      const result = await getNginxInstanceArchiveSites(instance.id);
      archiveConfigPath.value = result.configPath;
      archiveRevision.value = result.revision;
      archiveSites.value = result.sites;
      if (!result.sites.length) message.warning('当前 nginx.conf 未解析到可下载的 server 块');
    } catch (error: unknown) {
      archiveSites.value = [];
      archiveRevision.value = '';
      message.error(getErrorMessage(error));
    } finally {
      archiveSelectionLoading.value = false;
    }
  };

  /** 打开 server 选择窗口，默认不勾选任何项。 */
  const downloadActiveNginxArchive = async (type: NginxArchiveDownloadType = 'all') => {
    if (!validateActiveInstance()) return;
    archiveSelectionType.value = type;
    archiveSites.value = [];
    archiveRevision.value = '';
    archiveConfigPath.value = '';
    archiveSelectionOpen.value = true;
    await refreshArchiveSites();
  };

  /** 请求取消正在进行的原生下载。 */
  const cancelActiveArchiveDownload = async () => {
    try {
      await invoke('cancel_file_download');
      message.info('正在取消下载…');
    } catch (error: unknown) {
      message.error(getErrorMessage(error));
    }
  };

  /** 渲染下载中的常驻通知。 */
  const showProgressNotification = (
    type: NginxArchiveDownloadType,
    progress: NativeFileDownloadProgress
  ) => {
    const percent = progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.floor((progress.loadedBytes / progress.totalBytes) * 100))
      : null;
    notification.info({
      key: activeNotificationKey,
      class: 'c4d-download-notification',
      message: `正在下载${ARCHIVE_TYPE_LABEL[type]}`,
      description: h('div', null, [
        h('p', { style: 'margin-bottom: 8px;' }, progress.stage === 'connecting'
          ? '正在连接中央归档服务并等待远程打包'
          : `已写入 ${formatArchiveBytes(progress.loadedBytes)}${progress.totalBytes ? ` / ${formatArchiveBytes(progress.totalBytes)}` : ''}`),
        h('div', { class: 'c4d-progress-wrapper' }, [
          h('div', { class: 'c4d-progress-track' }, [
            h('div', {
              class: 'c4d-progress-bar is-downloading',
              style: percent === null ? undefined : `width: ${percent}%`,
            }),
          ]),
        ]),
        h('button', {
          class: 'ant-btn ant-btn-sm',
          style: 'margin-top: 10px;',
          onClick: () => void cancelActiveArchiveDownload(),
        }, '取消下载'),
      ]),
      duration: 0,
      closeIcon: createDownloadNotificationCloseIcon(),
    });
  };

  /** 显示真实落盘后的常驻成功通知。 */
  const showNativeSuccess = async (result: NativeFileDownloadResult) => {
    const revealFile = async () => {
      try {
        await invoke('reveal_in_file_manager', { path: result.path });
        message.success('已在文件管理器中定位文件');
      } catch (error: unknown) {
        message.error(`定位失败：${getErrorMessage(error)}`);
      }
    };
    notification.success({
      key: activeNotificationKey,
      class: 'c4d-download-notification',
      message: '下载已完成',
      description: h('div', null, [
        h('p', { style: 'margin-bottom: 4px; font-weight: 600;' }, result.fileName),
        h('p', { style: 'margin-bottom: 4px;' }, `文件大小：${formatArchiveBytes(result.fileSize)}`),
        h('p', { style: 'margin-bottom: 10px; word-break: break-all;' }, `保存位置：${result.path}`),
        h('a', { href: 'javascript:;', class: 'c4d-locate-btn', onClick: revealFile }, '打开文件位置'),
      ]),
      duration: 0,
      closeIcon: createDownloadNotificationCloseIcon(),
    });
  };

  /** 显示中央服务返回的真实失败原因。 */
  const showDownloadFailure = (error: unknown, type: NginxArchiveDownloadType) => {
    const errorMessage = getErrorMessage(error);
    notification.error({
      key: activeNotificationKey,
      class: 'c4d-download-notification',
      message: '下载失败',
      description: h('div', null, [
        h('p', { style: 'margin-bottom: 10px; white-space: pre-wrap;' }, errorMessage),
        h('button', {
          class: 'ant-btn ant-btn-primary ant-btn-sm',
          onClick: () => {
            notification.close(activeNotificationKey);
            void downloadActiveNginxArchive(type);
          },
        }, '刷新配置后重试'),
      ]),
      duration: 0,
      closeIcon: createDownloadNotificationCloseIcon(),
    });
  };

  /** 按选择结果执行中央归档下载。 */
  const confirmArchiveDownload = async (submit: NginxArchiveSelectionSubmit) => {
    const instance = validateActiveInstance();
    if (!instance || runtimeArchiveDownloading.value) return;
    if (!submit.siteIds.length) {
      message.warning('请至少选择一个 server');
      return;
    }
    if (!archiveRevision.value) {
      message.warning('配置版本尚未加载，请刷新后重试');
      return;
    }

    const selection: NginxArchiveSelection = {
      type: submit.type,
      siteIds: [...new Set(submit.siteIds)],
      revision: archiveRevision.value,
    };
    const selectedSites = archiveSites.value.filter((site) => selection.siteIds.includes(site.id));
    archiveSelectionType.value = submit.type;
    archiveSelectionOpen.value = false;
    runtimeArchiveDownloading.value = true;
    activeNotificationKey = `nginx-archive-${Date.now()}`;
    showProgressNotification(submit.type, {
      stage: 'connecting',
      loadedBytes: 0,
      totalBytes: null,
    });

    try {
      if (!isTauri()) {
        const browserResult = await saveArchiveInBrowser(instance.id, selection, (loadedBytes) => {
          showProgressNotification(submit.type, { stage: 'writing', loadedBytes, totalBytes: null });
        });
        notification.success({
          key: activeNotificationKey,
          class: 'c4d-download-notification',
          message: '浏览器下载已开始',
          description: `${browserResult.fileName}（${formatArchiveBytes(browserResult.fileSize)}）`,
          duration: 0,
          closeIcon: createDownloadNotificationCloseIcon(),
        });
        return;
      }

      const progressChannel = new Channel<NativeFileDownloadProgress>();
      let acceptsProgress = true;
      progressChannel.onmessage = (progress) => {
        if (acceptsProgress) showProgressNotification(submit.type, progress);
      };
      const result = await invoke<NativeFileDownloadResult>('start_file_download', {
        url: await getNginxInstanceArchiveDownloadUrl(instance.id, submit.type, selection),
        headers: { Accept: 'application/octet-stream', ...getDeployApiAuthHeaders() },
        suggestedFileName: buildSuggestedFileName(params.runtimeServer.value, instance, submit.type, selectedSites),
        onProgress: progressChannel,
      });
      acceptsProgress = false;
      await showNativeSuccess(result);
    } catch (error: unknown) {
      if (getErrorMessage(error).includes('下载已取消')) {
        notification.close(activeNotificationKey);
        message.info(`已取消下载${ARCHIVE_TYPE_LABEL[submit.type]}`);
        return;
      }
      showDownloadFailure(error, submit.type);
    } finally {
      runtimeArchiveDownloading.value = false;
    }
  };

  /** 清空下载窗口临时态。 */
  const clearArchiveDownloadState = () => {
    archiveSelectionOpen.value = false;
    archiveSelectionLoading.value = false;
    archiveSelectionType.value = 'all';
    archiveConfigPath.value = '';
    archiveRevision.value = '';
    archiveSites.value = [];
  };

  return {
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
  };
}
