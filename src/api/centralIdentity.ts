/** 雨燕中央 v2 身份与设备 API。 */

import { getApiBase } from '@/utils/env';
import { assertAllowedCentralUrl } from '@/utils/centralUrlPolicy';
import type { DeviceIdentity, SecureAccountState } from '@/services/secureAuth';

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
