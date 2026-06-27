import { invoke } from '@tauri-apps/api/core';

/** Tauri 原生更新下载状态。 */
export interface NativeAppUpdateStatus {
  status: 'idle' | 'downloading' | 'completed' | 'error';
  progress: number;
  error: string | null;
  localPath: string | null;
}

/** Tauri 原生更新命令结果。 */
export interface NativeAppUpdateCommandResult {
  success: boolean;
  message: string;
}

/** Tauri 原生更新操作集合。 */
export interface NativeAppUpdateActions {
  startDownload: (url: string, filename: string) => Promise<NativeAppUpdateCommandResult>;
  getStatus: () => Promise<NativeAppUpdateStatus>;
  install: () => Promise<NativeAppUpdateCommandResult>;
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
  const startDownload = (url: string, filename: string) => {
    return invoke<NativeAppUpdateCommandResult>('start_app_update_download', { url, filename });
  };

  /** 获取当前原生下载状态。 */
  const getStatus = () => {
    return invoke<NativeAppUpdateStatus>('get_app_update_status');
  };

  /** 使用系统默认程序打开安装包。 */
  const install = () => {
    return invoke<NativeAppUpdateCommandResult>('install_app_update');
  };

  return {
    startDownload,
    getStatus,
    install,
  };
};
