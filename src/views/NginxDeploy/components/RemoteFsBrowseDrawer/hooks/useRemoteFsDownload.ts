import { h, ref } from 'vue';
import { CloseOutlined } from '@ant-design/icons-vue';
import { message, notification } from 'ant-design-vue';
import { Channel, invoke } from '@tauri-apps/api/core';
import {
  downloadServerFsEntry,
  getDeployApiAuthHeaders,
  getServerFsDownloadUrl,
  type DeployServer,
  type NativeFileDownloadProgress,
  type NativeFileDownloadResult,
  type RemoteFsEntry,
} from '@/api/deploy';
import { isTauri } from '@/utils/env';
import { desktopFloatingTask } from '@/utils/desktopFloatingTask';
import { formatArchiveBytes } from '@/views/NginxDeploy/hooks/useNginxArchiveDownload';
import { getErrorMessage } from '@/views/NginxDeploy/utils';
import { buildFsSuggestedFileName } from '../constant';

/** 创建可访问的下载通知关闭图标。 */
const createDownloadNotificationCloseIcon = () => h(CloseOutlined, { 'aria-label': '关闭通知' });

/**
 * 远程文件系统下载 Hook。
 * 负责调度 Tauri 原生下载与 Web 浏览器下载，提供进度浮窗与完成反馈。
 */
export function useRemoteFsDownload() {
  /** 当前正在下载的目标绝对路径。 */
  const downloadingPath = ref<string | null>(null);
  let activeNotificationKey = '';

  /** 请求取消正在进行的原生下载。 */
  const cancelActiveDownload = async () => {
    try {
      if (isTauri()) {
        await invoke('cancel_file_download');
      }
      await desktopFloatingTask.dismiss();
      notification.close(activeNotificationKey);
    } catch (error: unknown) {
      const err = getErrorMessage(error);
      if (!err.includes('当前没有正在下载')) {
        message.error(err);
      }
    }
  };

  /** 渲染浏览器端下载中的常驻通知。 */
  const showProgressNotification = (
    entryName: string,
    isDirectory: boolean,
    progress: NativeFileDownloadProgress
  ) => {
    const percent = progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.floor((progress.loadedBytes / progress.totalBytes) * 100))
      : null;
    const actionLabel = isDirectory ? '打包下载目录' : '下载文件';
    const stageText = progress.stage === 'connecting'
      ? (isDirectory ? '正在连接远程主机并流式打包' : '正在连接远程主机')
      : `已写入 ${formatArchiveBytes(progress.loadedBytes)}${progress.totalBytes ? ` / ${formatArchiveBytes(progress.totalBytes)}` : ''}`;

    if (isTauri()) {
      void desktopFloatingTask.updateProgress({
        progressPercentage: percent,
        loadedBytes: progress.loadedBytes,
        totalBytes: progress.totalBytes,
        stage: stageText,
      });
      return;
    }

    notification.info({
      key: activeNotificationKey,
      class: 'c4d-download-notification',
      message: `正在${actionLabel}：${entryName}`,
      description: h('div', null, [
        h('p', { style: 'margin-bottom: 8px;' }, stageText),
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
          style: 'margin-top: 10px; position: relative; z-index: 2;',
          onClick: () => void cancelActiveDownload(),
        }, '取消下载'),
      ]),
      duration: 0,
      closeIcon: createDownloadNotificationCloseIcon(),
    });
  };

  /** 显示真实落盘后的常驻成功通知。 */
  const showNativeSuccess = async (result: NativeFileDownloadResult, serverName?: string) => {
    const revealFile = async () => {
      try {
        await invoke('reveal_in_file_manager', { path: result.path });
        message.success('已打开文件所在位置');
      } catch (error: unknown) {
        message.error(`打开失败：${getErrorMessage(error)}`);
      }
    };

    if (isTauri()) {
      await desktopFloatingTask.finish({
        taskId: activeNotificationKey,
        status: 'success',
        title: '下载已完成',
        projectName: result.fileName,
        targetName: serverName,
        envName: '已保存',
        stage: `文件大小：${formatArchiveBytes(result.fileSize)}`,
        autoDismiss: false,
        actions: [
          { id: 'reveal', text: '打开文件位置', primary: true },
        ],
        onAction: async (actionId) => {
          if (actionId === 'reveal') {
            await revealFile();
            await desktopFloatingTask.dismiss();
          }
        },
      });
      return;
    }

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
      duration: 4.5,
      closeIcon: createDownloadNotificationCloseIcon(),
    });
  };

  /**
   * 触发下载远程文件或目录。
   * @param server 当前服务器
   * @param entry 目标远程条目
   */
  const downloadRemoteFsEntry = async (
    server: DeployServer | null | undefined,
    entry: RemoteFsEntry
  ) => {
    if (!server?.id) {
      message.warning('缺少服务器信息，无法下载');
      return;
    }
    if (!entry.path) {
      message.warning('缺少目标路径，无法下载');
      return;
    }
    if (downloadingPath.value) {
      message.warning('当前有正在进行的下载任务，请稍候');
      return;
    }

    const isDirectory = entry.type === 'directory';
    const actionLabel = isDirectory ? '打包下载' : '下载';
    const suggestedFileName = buildFsSuggestedFileName(server, entry);

    downloadingPath.value = entry.path;
    activeNotificationKey = `remote-fs-download-${Date.now()}`;

    if (isTauri()) {
      await desktopFloatingTask.startProgress({
        taskId: activeNotificationKey,
        title: `正在${actionLabel}`,
        projectName: entry.name,
        envName: server.name || server.host || '远程服务器',
        stage: isDirectory ? '正在连接远程主机并流式打包' : '正在连接远程主机',
        actions: [
          { id: 'cancel', text: '取消下载', danger: true },
        ],
        onAction: (actionId) => {
          if (actionId === 'cancel') {
            void cancelActiveDownload();
          }
        },
      });
    } else {
      showProgressNotification(entry.name, isDirectory, {
        stage: 'connecting',
        loadedBytes: 0,
        totalBytes: null,
      });
    }

    try {
      if (!isTauri()) {
        const browserResult = await downloadServerFsEntry(server.id, entry.path, (loadedBytes) => {
          showProgressNotification(entry.name, isDirectory, {
            stage: 'writing',
            loadedBytes,
            totalBytes: null,
          });
        });

        const objectUrl = URL.createObjectURL(browserResult.blob);
        try {
          const link = document.createElement('a');
          link.href = objectUrl;
          link.download = browserResult.fileName;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          link.remove();
        } finally {
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        }

        notification.success({
          key: activeNotificationKey,
          class: 'c4d-download-notification',
          message: '浏览器下载已开始',
          description: `${browserResult.fileName}（${formatArchiveBytes(browserResult.blob.size)}）`,
          duration: 3.5,
          closeIcon: createDownloadNotificationCloseIcon(),
        });
        return;
      }

      const progressChannel = new Channel<NativeFileDownloadProgress>();
      let acceptsProgress = true;
      progressChannel.onmessage = (progress) => {
        if (acceptsProgress) {
          showProgressNotification(entry.name, isDirectory, progress);
        }
      };

      const result = await invoke<NativeFileDownloadResult>('start_file_download', {
        url: await getServerFsDownloadUrl(server.id, entry.path),
        headers: { Accept: 'application/octet-stream', ...getDeployApiAuthHeaders() },
        suggestedFileName,
        onProgress: progressChannel,
      });

      acceptsProgress = false;
      await showNativeSuccess(result, server.name);
    } catch (error: unknown) {
      const errText = getErrorMessage(error);
      if (errText.includes('下载已取消') || errText.includes('导出已取消')) {
        await desktopFloatingTask.dismiss();
        notification.close(activeNotificationKey);
        message.info(`已取消下载 ${entry.name}`);
        return;
      }

      if (isTauri()) {
        await desktopFloatingTask.finish({
          taskId: activeNotificationKey,
          status: 'error',
          title: '下载失败',
          projectName: entry.name,
          errorMessage: errText,
          autoDismiss: false,
        });
      } else {
        notification.error({
          key: activeNotificationKey,
          class: 'c4d-download-notification',
          message: '下载失败',
          description: errText,
          duration: 5.0,
          closeIcon: createDownloadNotificationCloseIcon(),
        });
      }
    } finally {
      downloadingPath.value = null;
    }
  };

  return {
    downloadingPath,
    downloadRemoteFsEntry,
    cancelActiveDownload,
  };
}
