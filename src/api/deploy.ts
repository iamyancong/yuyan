import axios from 'axios';
import { getApiBase } from '@/utils/env';

/** 本地辅助服务状态 */
export interface LocalServerStatus {
  port: number;
  pid?: number | null;
  running: boolean;
  status: 'idle' | 'starting' | 'running' | 'error' | string;
  nodePath?: string | null;
  lastError?: string | null;
  lastOutput?: string;
}

/** 桌面端更新信息接口 */
export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  version?: string;
  latestVersion?: string;
  notes?: string;
  updateLogs?: string;
  url?: string;
  downloadUrl?: string;
  filename?: string;
  size?: number;
  sha256?: string;
  signature?: string;
  etag?: string;
  channel?: string;
  target?: string;
  source?: 'manifest' | 'github-release';
  message?: string;
}

/**
 * 获取服务器模式部署 API 鉴权头。
 * @returns 部署 API 鉴权头
 */
export const getDeployApiAuthHeaders = (): Record<string, string> => {
  let token = String(import.meta.env.VITE_DEPLOY_API_TOKEN || '').trim();
  try {
    token = String(window.localStorage.getItem('yuyan_deploy_api_token') || token).trim();
  } catch {
    // 忽略异常
  }
  return token ? { 'X-Deploy-Token': token } : {};
};

/**
 * 查询桌面端更新信息。
 * @param currentVersion 当前软件版本号
 * @param platform 客户端系统类型
 * @param arch 客户端 CPU 架构
 * @param channel 更新通道
 */
export const checkAppUpdateFromServer = (
  currentVersion: string,
  platform: string,
  arch: string,
  channel = 'stable'
): Promise<AppUpdateCheckResult> => {
  return axios.get(getApiBase('/deploy-api/app-update/check'), {
    params: { currentVersion, platform, arch, channel },
    headers: getDeployApiAuthHeaders(),
  }).then((res) => {
    const data = res.data as AppUpdateCheckResult;
    if (data && data.downloadUrl && !data.downloadUrl.startsWith('http')) {
      data.downloadUrl = getApiBase(data.downloadUrl);
    }
    if (data && data.url && !data.url.startsWith('http')) {
      data.url = getApiBase(data.url);
    }
    return data;
  });
};
