import { invoke } from '@tauri-apps/api/core';

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
  getTarget: () => Promise<NativeAppUpdateTarget>;
  install: () => Promise<NativeAppUpdateCommandResult>;
}

/** 更新包完整性元数据。 */
export interface NativeAppUpdateMetadata {
  expectedSize?: number;
  sha256?: string;
  etag?: string;
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
  const startDownload = (url: string, filename: string, metadata: NativeAppUpdateMetadata) => {
    return invoke<NativeAppUpdateCommandResult>('start_app_update_download', {
      url,
      filename,
      expectedSize: metadata.expectedSize,
      sha256: metadata.sha256,
      etag: metadata.etag,
    });
  };

  /** 暂停当前下载并保留断点。 */
  const cancelDownload = () => {
    return invoke<NativeAppUpdateCommandResult>('cancel_app_update_download');
  };

  /** 获取当前原生下载状态。 */
  const getStatus = () => {
    return invoke<NativeAppUpdateStatus>('get_app_update_status');
  };

  /** 获取当前系统和 CPU 架构。 */
  const getTarget = () => {
    return invoke<NativeAppUpdateTarget>('get_app_update_target');
  };

  /** 使用系统默认程序打开安装包。 */
  const install = () => {
    return invoke<NativeAppUpdateCommandResult>('install_app_update');
  };

  return {
    startDownload,
    cancelDownload,
    getStatus,
    getTarget,
    install,
  };
};
