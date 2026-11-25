/** 雨燕中央 v2 身份与设备 API。 */

import { getApiBase, isTauri } from '@/utils/env';
import { assertAllowedCentralUrl } from '@/utils/centralUrlPolicy';
import type { DeviceIdentity, SecureAccountState } from '@/services/secureAuth';
import { extractBearerToken, reportCentralSessionInvalid } from '@/services/centralSessionGuard';

export interface CentralExchangeResult {
  accountId: string;
  user: { id: number; username: string; name: string; avatarUrl: string };
  deviceId: string;
  teamId: string;
  role: 'viewer' | 'operator' | 'admin';
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface CentralDevice {
  deviceId: string;
  deviceName: string;
  platform: string;
  status: 'active' | 'revoked';
  lastSeenAt: string;
  revokedAt?: string;
  createdAt: string;
}

export interface CentralMe {
  accountId: string;
  userId: string;
  deviceId: string;
  /** 是否在 YUYAN_SYSTEM_ADMINS 白名单中（未配置时为 false）。 */
  isSystemAdmin?: boolean;
}

export interface CentralAuditSnapshot {
  items: Array<Record<string, unknown> & { eventId?: string; action?: string; createdAt?: string }>;
  total: number;
  chain: { valid: boolean; count: number; brokenAt?: string };
}

export interface CentralAccountApprovalPolicy {
  accountId: string;
  forcedTools: string[];
}

/** 获取中央 API 根地址，公网强制 HTTPS，可信私网允许 HTTP。 */
function getCentralBase(): string {
  const base = getApiBase('').replace(/\/$/, '');
  if (!base) throw new Error('未配置雨燕中央服务地址 VITE_APP_SERVER_URL');
  return assertAllowedCentralUrl(base);
}

/** 解析中央统一响应。 */
async function requestCentral<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getCentralBase()}${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const error = new Error(body?.error?.message || `雨燕中央服务返回 HTTP ${response.status}`) as Error & { code?: string; status?: number };
    error.code = body?.error?.code;
    error.status = response.status;
    reportCentralSessionInvalid(error, extractBearerToken(options.headers));
    throw error;
  }
  return body.data as T;
}

/** 生成短期雨燕账号与设备会话头。 */
function getIdentityHeaders(state: SecureAccountState): Record<string, string> {
  return {
    Authorization: `Bearer ${state.accessToken}`,
    'X-Yuyan-Client': 'desktop',
  };
}

/** 使用 GitLab PAT 实时验证身份并注册设备。 */
export function exchangeGitlabIdentity(gitlabHost: string, gitlabToken: string, device: DeviceIdentity) {
  return requestCentral<CentralExchangeResult>('/api/v2/auth/gitlab/exchange', {
    method: 'POST',
    body: JSON.stringify({ gitlabHost, gitlabToken, device }),
  });
}

/** 使用设备签名轮换短期会话。 */
export function refreshCentralSession(payload: { deviceId: string; refreshToken: string; timestamp: number; nonce: string; signature: string }) {
  return requestCentral<Pick<SecureAccountState, 'accountId' | 'teamId' | 'role' | 'accessToken' | 'refreshToken' | 'accessExpiresAt' | 'refreshExpiresAt'>>('/api/v2/auth/refresh', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 注销当前中央会话。 */
export function logoutCentralSession(state: SecureAccountState) {
  if (!state.accessToken) return Promise.resolve({ revoked: false });
  return requestCentral<{ revoked: boolean }>('/api/v2/auth/logout', {
    method: 'POST',
    headers: getIdentityHeaders(state),
  });
}

/** 列出当前账号的所有设备。 */
export function listCentralDevices(state: SecureAccountState) {
  return requestCentral<CentralDevice[]>('/api/v2/me/devices', {
    headers: getIdentityHeaders(state),
  });
}

/** 查询中央解析出的真实账号和设备身份。 */
export function getCentralMe(state: SecureAccountState) {
  return requestCentral<CentralMe>('/api/v2/me', {
    headers: getIdentityHeaders(state),
  });
}

/** 读取当前账号的中央审计并校验 HMAC 链。 */
export function getCentralAccountAudit(state: SecureAccountState, limit = 20) {
  return requestCentral<CentralAuditSnapshot>(`/api/v2/me/audit?limit=${Math.min(100, Math.max(1, limit))}`, {
    headers: getIdentityHeaders(state),
  });
}

/** 读取当前账号的跨设备审批策略。 */
export function getCentralAccountApprovalPolicy(state: SecureAccountState) {
  return requestCentral<CentralAccountApprovalPolicy>('/api/v2/me/approval-policy', {
    headers: getIdentityHeaders(state),
  });
}

/** 替换当前账号的跨设备审批策略。 */
export function updateCentralAccountApprovalPolicy(state: SecureAccountState, forcedTools: string[]) {
  return requestCentral<CentralAccountApprovalPolicy>('/api/v2/me/approval-policy', {
    method: 'PUT',
    headers: getIdentityHeaders(state),
    body: JSON.stringify({ forcedTools }),
  });
}

/** 撤销当前账号的一台设备。 */
export function revokeCentralDevice(state: SecureAccountState, deviceId: string) {
  return requestCentral<{ revoked: boolean }>(`/api/v2/me/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: getIdentityHeaders(state),
  });
}

export interface CentralUserSession {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  status: 'active' | 'revoked';
  lastSeenAt: string;
  createdAt: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  isCurrent: boolean;
}

export interface CentralRecentDeployRecord {
  id: number;
  targetId: number;
  projectId: number;
  projectName: string;
  envName: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  status: 'running' | 'success' | 'failed' | 'stopped' | string;
  action: 'deploy' | 'rollback' | 'undoRollback' | string;
  operator: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  serverName: string;
}

export interface CentralUserProfile {
  accountId: string;
  gitlab: {
    id: number | null;
    host: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    email: string;
    createdAt: string;
    webUrl: string;
  };
  identity: {
    team: { id: string; name: string } | null;
    role: 'viewer' | 'operator' | 'admin' | '';
    isSystemAdmin: boolean;
    currentDeviceId: string;
    currentSessionId: string;
    authMode: 'central' | 'web_gitlab';
    sessions: CentralUserSession[];
    sessionCapabilities: {
      canList: boolean;
      canRevokeOthers: boolean;
    };
  };
  activity: {
    windowDays: number;
    stats30d: {
      totalCount: number;
      successCount: number;
      failedCount: number;
      stoppedCount: number;
      runningCount: number;
      finishedCount: number;
      successRate: number | null;
    };
    recentDeploys: CentralRecentDeployRecord[];
  };
}

/** 构造个人资料接口完整地址（桌面端校验中央服务策略，网页端走同源相对路径）。 */
function getProfileRequestUrl(path: string): string {
  const customBase = typeof window !== 'undefined' ? window.localStorage.getItem('CUSTOM_API_BASE') : null;
  if (isTauri() || customBase) {
    return `${getCentralBase()}${path}`;
  }
  return getApiBase(path);
}

/** 根据当前可用凭据构造个人资料请求头（支持桌面端 Bearer 会话与网页端 GitLab PAT）。 */
function getProfileHeaders(state: SecureAccountState): Record<string, string> {
  const hasCentralToken = Boolean(
    state.accessToken
    && Number.isFinite(Date.parse(state.accessExpiresAt))
    && Date.parse(state.accessExpiresAt) > Date.now()
  );
  if (hasCentralToken) {
    return {
      ...getIdentityHeaders(state),
      ...(state.gitlabToken && state.gitlabHost
        ? { 'X-GitLab-Token': state.gitlabToken, 'X-GitLab-Host': state.gitlabHost }
        : {}),
    };
  }
  return {
    'X-Yuyan-Client': 'web',
    ...(state.gitlabToken ? { 'X-GitLab-Token': state.gitlabToken } : {}),
    ...(state.gitlabHost ? { 'X-GitLab-Host': state.gitlabHost } : {}),
  };
}

/** 发起个人资料相关请求（兼容网页端相对路径与桌面端中央网关）。 */
async function requestProfileApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(getProfileRequestUrl(path), {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const error = new Error(body?.error?.message || `雨燕中央服务返回 HTTP ${response.status}`) as Error & { code?: string; status?: number };
    error.code = body?.error?.code;
    error.status = response.status;
    reportCentralSessionInvalid(error, extractBearerToken(options.headers));
    throw error;
  }
  return body.data as T;
}

/** 获取当前登录用户的完整个人资料（GitLab 信息、雨燕身份与会话、近 30 天发布活动）。 */
export function getCentralUserProfile(state: SecureAccountState) {
  return requestProfileApi<CentralUserProfile>('/api/v2/me/profile', {
    headers: getProfileHeaders(state),
  });
}

/** 注销当前账号名下的其他活跃会话（不可注销当前会话）。 */
export function revokeCentralSession(state: SecureAccountState, sessionId: string) {
  return requestProfileApi<{ revoked: boolean; sessionId: string }>(`/api/v2/me/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: getProfileHeaders(state),
  });
}
