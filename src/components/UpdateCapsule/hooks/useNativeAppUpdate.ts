import { getDeployApiToken } from '@/api/deploy';
import { isTauri } from '@/utils/env';

/** Tauri 原生更新下载状态。 */
export interface NativeAppUpdateStatus {
  status: 'idle' | 'downloading' | 'paused' | 'completed' | 'error';
  progress: number;
  error: string | null;
  localPath: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number;
  remainingSeconds: number | null;
  resumable: boolean;
  retryCount: number;
  version: string;
  assetId: string;
  filename: string;
  expectedSha256: string | null;
  expectedEtag: string | null;
  expectedSignature: string | null;
}

/** Tauri 原生更新命令结果。 */
export interface NativeAppUpdateCommandResult {
  success: boolean;
  message: string;
}

/** Tauri 原生更新操作集合。 */
export interface NativeAppUpdateActions {
  startDownload: (
    url: string,
    filename: string,
    metadata: NativeAppUpdateMetadata
  ) => Promise<NativeAppUpdateCommandResult>;
  cancelDownload: () => Promise<NativeAppUpdateCommandResult>;
  getStatus: () => Promise<NativeAppUpdateStatus>;
  discard: () => Promise<NativeAppUpdateCommandResult>;
  getTarget: () => Promise<NativeAppUpdateTarget>;
  install: () => Promise<NativeAppUpdateCommandResult>;
}

/** 更新包完整性元数据。 */
export interface NativeAppUpdateMetadata {
  version: string;
  assetId: string;
  expectedSize?: number;
  sha256?: string;
  etag?: string;
  signature?: string;
}

/** 当前客户端更新目标。 */
export interface NativeAppUpdateTarget {
  platform: string;
  arch: string;
}

/**
 * 获取 Tauri 原生自动更新操作。
 * @returns 下载、状态查询和安装命令
 */
export const useNativeAppUpdate = (): NativeAppUpdateActions => {
  /**
   * 启动原生后台下载。
   * @param url 内网更新代理地址
   * @param filename 安装包文件名
   */
  const startDownload = async (url: string, filename: string, metadata: NativeAppUpdateMetadata) => {
    if (!isTauri()) return { success: false, message: 'Not in Tauri environment' };
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeAppUpdateCommandResult>('start_app_update_download', {
      url,
      version: metadata.version,
      assetId: metadata.assetId,
      filename,
      expectedSize: metadata.expectedSize,
      sha256: metadata.sha256,
      etag: metadata.etag,
      signature: metadata.signature,
      deployApiToken: getDeployApiToken() || undefined,
    });
  };

  /** 暂停当前下载并保留断点。 */
  const cancelDownload = async () => {
    if (!isTauri()) return { success: false, message: 'Not in Tauri environment' };
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeAppUpdateCommandResult>('cancel_app_update_download');
  };

  /** 获取当前原生下载状态。 */
  const getStatus = async () => {
    if (!isTauri()) {
      return {
        status: 'idle',
        progress: 0,
        error: null,
        localPath: null,
        downloadedBytes: 0,
        totalBytes: null,
        bytesPerSecond: 0,
        remainingSeconds: null,
        resumable: false,
        retryCount: 0,
        version: '',
        assetId: '',
        filename: '',
        expectedSha256: null,
        expectedEtag: null,
        expectedSignature: null,
      } as NativeAppUpdateStatus;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeAppUpdateStatus>('get_app_update_status');
  };

  /** 清理不再需要的本机更新包和断点状态。 */
  const discard = async () => {
    if (!isTauri()) return { success: false, message: 'Not in Tauri environment' };
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeAppUpdateCommandResult>('discard_app_update');
  };

  /** 获取当前系统和 CPU 架构。 */
  const getTarget = async () => {
    if (!isTauri()) return { platform: 'unknown', arch: 'unknown' };
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeAppUpdateTarget>('get_app_update_target');
  };

  /** 验签、覆盖安装并自动重启应用。 */
  const install = async () => {
    if (!isTauri()) return { success: false, message: 'Not in Tauri environment' };
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeAppUpdateCommandResult>('install_app_update', {
      deployApiToken: getDeployApiToken() || undefined,
    });
  };

  return {
    startDownload,
    cancelDownload,
    getStatus,
    discard,
    getTarget,
    install,
  };
};
