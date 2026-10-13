import { h, ref } from 'vue';
import type { Ref } from 'vue';
import { CloseOutlined } from '@ant-design/icons-vue';
import { message, notification } from 'ant-design-vue';
import type { CreateMicroAppResponse } from '@/api/scaffold';
import { getScaffoldAuthHeaders } from '@/api/scaffold';
import type { NativeFileDownloadProgress, NativeFileDownloadResult } from '@/api/deploy';
import { getApiBase, isTauri } from '@/utils/env';
import { desktopFloatingTask } from '@/utils/desktopFloatingTask';
import { formatDownloadSize, getErrorMessage } from '../constant';

/** 脚手架创建结果。 */
type ScaffoldResult = CreateMicroAppResponse['data'] | null;

/** 创建可访问的下载通知关闭图标。 */
const createDownloadNotificationCloseIcon = () => h(CloseOutlined, { 'aria-label': '关闭通知' });

/**
 * 脚手架生成包下载逻辑。
 * 负责调度 Tauri 原生下载与 Web 浏览器流式落盘，提供进度浮窗、保存目录与打开文件位置交互。
 * @param result 创建结果
 * @returns 下载处理函数与响应式状态
 */
export const useScaffoldDownload = (result: Ref<ScaffoldResult>) => {
  const downloading = ref(false);
  const downloaded = ref(false);
  const downloadedSize = ref('');
  const downloadedPath = ref('');

  let activeNotificationKey = '';
  let isDownloadCancelled = false;
  let acceptsProgress = false;

  /**
   * 在系统的文件管理器中定位并选中下载的文件。
   * @param targetPath 指定路径（可选）
   */
  const openDownloadedFolder = async (targetPath?: string) => {
    const filePath = targetPath || downloadedPath.value;
    if (!filePath) {
      message.info('未获取到本地文件路径，请在系统下载目录中查看');
      return;
    }

    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('reveal_in_file_manager', { path: filePath });
        message.success('已打开文件所在位置');
      } catch (error: unknown) {
        message.error(`打开失败：${getErrorMessage(error)}`);
      }
    } else {
      message.info('浏览器环境下请前往系统下载目录查看');
    }
  };

  /**
   * 取消正在进行的下载任务。
   */
  const cancelActiveDownload = async () => {
    isDownloadCancelled = true;
    acceptsProgress = false;
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cancel_file_download');
      } catch {
        // 忽略非活跃下载异常
      }
      await desktopFloatingTask.dismiss();
    }
    notification.close(activeNotificationKey);
    downloading.value = false;
    message.info('已取消下载');
  };

  /**
   * 显示落盘成功反馈，提供打开文件所在位置入口。
   */
  const showDownloadSuccess = async (
    downloadData: { path?: string; fileName: string; fileSize: number },
    appName: string
  ) => {
    const sizeText = formatDownloadSize(downloadData.fileSize);
    downloaded.value = true;
    downloadedSize.value = sizeText;
    if (downloadData.path) {
      downloadedPath.value = downloadData.path;
    }

    if (isTauri() && downloadData.path) {
      const filePath = downloadData.path;
      await desktopFloatingTask.finish({
        taskId: activeNotificationKey,
        status: 'success',
        title: '下载已完成',
        projectName: downloadData.fileName,
        targetName: appName,
        envName: '已保存',
        stage: `文件大小：${sizeText}`,
        autoDismiss: false,
        actions: [
          { id: 'reveal', text: '打开文件位置', primary: true },
        ],
        onAction: async (actionId) => {
          if (actionId === 'reveal') {
            await openDownloadedFolder(filePath);
            await desktopFloatingTask.dismiss();
          }
        },
      });
      return;
    }

    // 浏览器环境下反馈
    notification.success({
      key: activeNotificationKey,
      class: 'c4d-download-notification',
      message: '项目压缩包已完成下载',
      description: h('div', null, [
        h('p', { style: 'margin-bottom: 4px; font-weight: 600;' }, downloadData.fileName),
        h('p', { style: 'margin-bottom: 4px;' }, `文件大小：${sizeText}`),
        h('p', { style: 'margin-bottom: 4px; opacity: 0.85;' }, '已提交浏览器下载管理器保存至系统下载目录'),
      ]),
      duration: 5,
      closeIcon: createDownloadNotificationCloseIcon(),
    });
  };

  /**
   * 显示下载失败反馈。
   */
  const showDownloadError = async (error: unknown, suggestedFileName: string) => {
    const errorMessage = getErrorMessage(error);
    if (isTauri()) {
      await desktopFloatingTask.finish({
        taskId: activeNotificationKey,
        status: 'error',
        title: '下载失败',
        projectName: suggestedFileName,
        errorMessage,
        autoDismiss: false,
        actions: [
          { id: 'retry', text: '重试下载', primary: true },
        ],
        onAction: (actionId) => {
          if (actionId === 'retry') {
            void handleDownload();
          }
        },
      });
      return;
    }
    notification.error({
      key: activeNotificationKey,
      class: 'c4d-download-notification',
      message: '下载失败',
      description: errorMessage,
      duration: 5,
      closeIcon: createDownloadNotificationCloseIcon(),
    });
  };

  /**
   * 下载脚手架生成包。
   */
  const handleDownload = async () => {
    const downloadPath = result.value?.downloadPath;
    if (!downloadPath || downloading.value) return;

    downloading.value = true;
    isDownloadCancelled = false;
    acceptsProgress = true;
    activeNotificationKey = `scaffold-download-${Date.now()}`;
    const appName = result.value?.appName || 'microapp';
    const suggestedFileName = `${appName}.zip`;

    const resolvedDownloadPath = /^https?:\/\//i.test(downloadPath)
      ? downloadPath
      : `${getApiBase('')}${downloadPath.startsWith('/') ? downloadPath : `/${downloadPath}`}`;

    if (isTauri()) {
      await desktopFloatingTask.startProgress({
        taskId: activeNotificationKey,
        title: '正在下载项目压缩包',
        projectName: suggestedFileName,
        targetName: appName,
        envName: '微应用脚手架',
        stage: '正在连接服务并准备下载...',
        actions: [
          { id: 'cancel', text: '取消下载', danger: true },
        ],
        onAction: (actionId) => {
          if (actionId === 'cancel') {
            void cancelActiveDownload();
          }
        },
      });
    }

    try {
      if (isTauri()) {
        try {
          const { invoke, Channel } = await import('@tauri-apps/api/core');
          const progressChannel = new Channel<NativeFileDownloadProgress>();
          progressChannel.onmessage = (progress) => {
            if (isDownloadCancelled || !acceptsProgress) return;
            const percent = progress.totalBytes && progress.totalBytes > 0
              ? Math.min(100, Math.floor((progress.loadedBytes / progress.totalBytes) * 100))
              : null;
            const stageText = progress.stage === 'connecting'
              ? '正在连接服务并准备下载'
              : `已写入 ${formatDownloadSize(progress.loadedBytes)}${progress.totalBytes ? ` / ${formatDownloadSize(progress.totalBytes)}` : ''}`;

            void desktopFloatingTask.updateProgress({
              progressPercentage: percent,
              loadedBytes: progress.loadedBytes,
              totalBytes: progress.totalBytes,
              stage: stageText,
            });
          };

          const downloadResult = await invoke<NativeFileDownloadResult>('start_file_download', {
            url: resolvedDownloadPath,
            headers: getScaffoldAuthHeaders(),
            suggestedFileName,
            onProgress: progressChannel,
          });

          acceptsProgress = false;
          if (isDownloadCancelled) return;

          await showDownloadSuccess({
            path: downloadResult.path,
            fileName: downloadResult.fileName || suggestedFileName,
            fileSize: downloadResult.fileSize,
          }, appName);
          return;
        } catch (tauriError: any) {
          if (isDownloadCancelled) return;
          console.warn('[useScaffoldDownload] Tauri 原生下载失败，尝试浏览器方式回退:', tauriError);
          if (String(tauriError).includes('下载已取消')) {
            return;
          }
        }
      }

      // 浏览器环境（或桌面端回退）
      const response = await fetch(resolvedDownloadPath, { headers: getScaffoldAuthHeaders() });
      if (!response.ok) {
        const text = await response.text();
        let errorMessage = text || '下载失败';
        try {
          const parsed = JSON.parse(text);
          errorMessage = parsed?.error || parsed?.message || errorMessage;
        } catch {
          errorMessage = text || errorMessage;
        }
        throw new Error(errorMessage);
      }

      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = suggestedFileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10_000);

      acceptsProgress = false;
      if (isDownloadCancelled) return;

      await showDownloadSuccess({
        fileName: suggestedFileName,
        fileSize: blob.size,
      }, appName);
    } catch (error) {
      if (isDownloadCancelled) return;
      await showDownloadError(error, suggestedFileName);
    } finally {
      downloading.value = false;
    }
  };

  return {
    handleDownload,
    openDownloadedFolder,
    downloading,
    downloaded,
    downloadedSize,
    downloadedPath,
  };
};
