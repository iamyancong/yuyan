import { h, ref } from 'vue';
import { CloseOutlined } from '@ant-design/icons-vue';
import { message, notification } from 'ant-design-vue';
import { Channel, invoke } from '@tauri-apps/api/core';
import {
  getDeployApiAuthHeaders,
  getServerFsDownloadUrl,
  streamServerFsEntryToWritable,
  type DeployServer,
  type NativeFileDownloadProgress,
  type NativeFileDownloadResult,
  type RemoteFsEntry,
} from '@/api/deploy';
import { isTauri } from '@/utils/env';
import { desktopFloatingTask } from '@/utils/desktopFloatingTask';
import { formatArchiveBytes } from '@/views/NginxDeploy/hooks/useNginxArchiveDownload';
import { getErrorMessage } from '@/views/NginxDeploy/utils';
import { buildFsSuggestedFileName, buildBatchFsSuggestedFileName, isDownloadCanceledError } from '../constant';

/** 检测当前环境是否支持 File System Access API 且处于安全上下文。 */
const canUseFileSystemAccess =
  typeof window !== 'undefined' &&
  'showSaveFilePicker' in window &&
  Boolean(window.isSecureContext);

/** 创建可访问的下载通知关闭图标。 */
const createDownloadNotificationCloseIcon = () => h(CloseOutlined, { 'aria-label': '关闭通知' });

/**
 * 远程文件系统下载 Hook。
 * 负责调度 Tauri 原生下载与 Web 浏览器流式落盘，提供进度浮窗与完成反馈。
 */
export function useRemoteFsDownload() {
  /** 当前正在下载的目标绝对路径或批量标识。 */
  const downloadingPath = ref<string | null>(null);
  let activeNotificationKey = '';
  let activeAbortController: AbortController | null = null;
  let activeWritableStream: any = null;
  let activeFileHandle: any = null;
  let isDownloadCancelled = false;
  let acceptsProgress = false;

  /** 请求取消正在进行的原生下载或浏览器端下载。 */
  const cancelActiveDownload = async () => {
    isDownloadCancelled = true;
    acceptsProgress = false;
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    if (activeWritableStream) {
      try {
        await activeWritableStream.abort();
      } catch {
        // 忽略重复关闭异常
      }
      activeWritableStream = null;
    }
    if (activeFileHandle) {
      try {
        await activeFileHandle.remove?.();
      } catch {
        // 忽略浏览器不支持或移除失败
      }
      activeFileHandle = null;
    }
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
    if (isDownloadCancelled || !acceptsProgress) {
      return;
    }
    const percent = progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.floor((progress.loadedBytes / progress.totalBytes) * 100))
      : null;
    const actionLabel = isDirectory ? '打包下载' : '下载文件';
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
   * 触发下载远程文件或目录（支持单个或批量）。
   * @param server 当前服务器
   * @param entries 目标条目或条目数组
   */
  const downloadRemoteFsEntries = async (
    server: DeployServer | null | undefined,
    entries: RemoteFsEntry | RemoteFsEntry[]
  ) => {
    const list = Array.isArray(entries) ? entries : [entries];
    const validEntries = list.filter((e) => e && e.type !== 'parent_dir' && e.path);

    if (!server?.id) {
      message.warning('缺少服务器信息，无法下载');
      return;
    }
    if (validEntries.length === 0) {
      message.warning('缺少有效的目标下载条目');
      return;
    }
    if (downloadingPath.value) {
      message.warning('当前有正在进行的下载任务，请稍候');
      return;
    }

    const isBatch = validEntries.length > 1;
    const isDirectory = !isBatch && validEntries[0].type === 'directory';
    const actionLabel = isBatch ? '打包下载' : (isDirectory ? '打包下载' : '下载');
    const displayName = isBatch ? `已选 ${validEntries.length} 项` : validEntries[0].name;
    const suggestedFileName = isBatch
      ? buildBatchFsSuggestedFileName(server, validEntries)
      : buildFsSuggestedFileName(server, validEntries[0]);

    const targetPaths = validEntries.map((e) => e.path as string);
    const downloadTarget = isBatch ? targetPaths : targetPaths[0];

    // 关键优化：若运行在 Web 端且支持 File System Access API，必须在用户点击事件的同步调用栈中第一时间唤起保存弹窗
    // 严禁在调用 showSaveFilePicker 之前产生任何 await 微任务，防止浏览器安全上下文判定用户手势失效 (User Gesture Expired)
    let fileHandle: any = null;
    let localWritable: any = null;

    if (!isTauri() && canUseFileSystemAccess) {
      try {
        fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: suggestedFileName,
        });
        localWritable = await fileHandle.createWritable();
        activeWritableStream = localWritable;
        activeFileHandle = fileHandle;
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          // 用户在系统弹窗中主动点击“取消”，优雅退出且零网络开销
          return;
        }
        // 若受环境策略影响或拒绝，静默回退到通用原生下载路径
        localWritable = null;
        activeWritableStream = null;
        activeFileHandle = null;
      }
    }

    downloadingPath.value = isBatch ? `batch:${validEntries.length}` : targetPaths[0];
    activeNotificationKey = `remote-fs-download-${Date.now()}`;
    isDownloadCancelled = false;
    acceptsProgress = true;
    activeAbortController = !isTauri() ? new AbortController() : null;

    if (isTauri()) {
      await desktopFloatingTask.startProgress({
        taskId: activeNotificationKey,
        title: `正在${actionLabel}`,
        projectName: displayName,
        envName: server.name || server.host || '远程服务器',
        stage: (isBatch || isDirectory) ? '正在连接远程主机并流式打包' : '正在连接远程主机',
        actions: [
          { id: 'cancel', text: '取消下载', danger: true },
        ],
        onAction: (actionId) => {
          if (actionId === 'cancel') {
            void cancelActiveDownload();
          }
        },
      });
    } else if (localWritable) {
      showProgressNotification(displayName, isBatch || isDirectory, {
        stage: 'connecting',
        loadedBytes: 0,
        totalBytes: null,
      });
    }

    try {
      if (!isTauri()) {
        // 1. 异步换取带鉴权凭据的短 URL
        const downloadUrl = await getServerFsDownloadUrl(server.id, downloadTarget);

        if (localWritable) {
          // 2A. 增强轨道：通过 File System Access API 直接流式落盘写文件，内存零增长，支持页内进度与取消
          const streamResult = await streamServerFsEntryToWritable(
            downloadUrl,
            localWritable,
            (loadedBytes) => {
              if (isDownloadCancelled || !acceptsProgress) return;
              showProgressNotification(displayName, isBatch || isDirectory, {
                stage: 'writing',
                loadedBytes,
                totalBytes: null,
              });
            },
            activeAbortController?.signal
          );

          activeWritableStream = null;
          activeFileHandle = null;
          if (isDownloadCancelled) {
            return;
          }

          notification.success({
            key: activeNotificationKey,
            class: 'c4d-download-notification',
            message: '下载已完成',
            description: `已成功保存到本地：${streamResult.fileName}`,
            duration: 4.5,
            closeIcon: createDownloadNotificationCloseIcon(),
          });
          return;
        }

        // 2B. 通用降级轨道（Firefox、Safari、非安全环境 HTTP 部署等）：
        // 动态创建隐藏链接交付浏览器内核原生下载管理器接管流式写盘，内存零占用
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = suggestedFileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();

        notification.success({
          key: activeNotificationKey,
          class: 'c4d-download-notification',
          message: '已提交给浏览器下载管理器',
          description: `${displayName}（${suggestedFileName}）`,
          duration: 3.5,
          closeIcon: createDownloadNotificationCloseIcon(),
        });
        return;
      }

      // 3. 桌面端（Tauri）：走现有成熟的 Rust 原生流式下载
      const progressChannel = new Channel<NativeFileDownloadProgress>();
      progressChannel.onmessage = (progress) => {
        if (acceptsProgress && !isDownloadCancelled) {
          showProgressNotification(displayName, isBatch || isDirectory, progress);
        }
      };

      const result = await invoke<NativeFileDownloadResult>('start_file_download', {
        url: await getServerFsDownloadUrl(server.id, downloadTarget),
        headers: { Accept: 'application/octet-stream', ...getDeployApiAuthHeaders() },
        suggestedFileName,
        onProgress: progressChannel,
      });

      acceptsProgress = false;
      if (isDownloadCancelled) {
        return;
      }
      await showNativeSuccess(result, server.name);
    } catch (error: unknown) {
      if (localWritable) {
        try {
          await localWritable.abort();
        } catch {
          // 忽略流中止异常
        }
        activeWritableStream = null;
      }
      if (activeFileHandle) {
        try {
          await activeFileHandle.remove?.();
        } catch {
          // 忽略浏览器不支持或移除失败
        }
        activeFileHandle = null;
      }

      if (isDownloadCanceledError(error, isDownloadCancelled)) {
        await desktopFloatingTask.dismiss();
        notification.close(activeNotificationKey);
        message.info(`已取消下载 ${displayName}`);
        return;
      }

      const errText = getErrorMessage(error);
      if (isTauri()) {
        await desktopFloatingTask.finish({
          taskId: activeNotificationKey,
          status: 'error',
          title: '下载失败',
          projectName: displayName,
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
      if (activeWritableStream) {
        try {
          await activeWritableStream.abort();
        } catch {}
        activeWritableStream = null;
      }
      activeFileHandle = null;
      downloadingPath.value = null;
      activeAbortController = null;
      acceptsProgress = false;
    }
  };

  /**
   * 触发下载单个远程文件或目录（向下兼容包装）。
   * @param server 当前服务器
   * @param entry 目标远程条目
   */
  const downloadRemoteFsEntry = (
    server: DeployServer | null | undefined,
    entry: RemoteFsEntry
  ) => downloadRemoteFsEntries(server, [entry]);

  return {
    downloadingPath,
    downloadRemoteFsEntry,
    downloadRemoteFsEntries,
    cancelActiveDownload,
  };
}
