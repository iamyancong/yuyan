/**
 * 桌面平台安全存储与浏览器标签页中的账号安全状态。
 * @description 桌面私钥永不返回 WebView；网页端不创建设备身份，PAT 仅保留在当前标签页会话中。
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../utils/env.ts';

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  deviceName: string;
  platform: string;
  createdAt: string;
}

export interface DeviceSignature {
  deviceId: string;
  algorithm: 'Ed25519';
  signature: string;
}

export interface SecureAccountState {
  accountId: string;
  deviceId: string;
  gitlabHost: string;
  gitlabUserId: number;
  gitlabUsername: string;
  gitlabDisplayName: string;
  gitlabAvatarUrl: string;
  gitlabToken: string;
  accessToken: string;
  refreshToken: string;
  teamId: string;
  role: 'viewer' | 'operator' | 'admin' | '';
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

let activeAccountCache: SecureAccountState | null | undefined;
let deviceIdentityCache: DeviceIdentity | null = null;

export const WEB_ACCOUNT_SESSION_KEY = 'yuyan:web-account-session';
export const WEB_ACCOUNT_LOCAL_KEY = 'yuyan:web-account-local';
export const WEB_REMEMBER_PREF_KEY = 'yuyan:web-remember-pref';

/** 记住我默认过期时间：30 天 */
export const WEB_REMEMBER_TTL_DAYS = 30;
export const WEB_REMEMBER_TTL_MS = WEB_REMEMBER_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface WebStoredAccountState extends SecureAccountState {
  /** 记住我过期时间戳（毫秒） */
  rememberExpiresAt?: number;
  /** 是否来自持久化存储 */
  persisted?: boolean;
}

/**
 * 获取用户在登录界面的「记住我」偏好。
 * @description 首次访问或未显式关闭时默认开启 30 天记住我（true）。若用户曾明确取消勾选，则遵循历史偏好。
 */
export function getRememberLoginPreference(): boolean {
  if (typeof window === 'undefined') return true;
  const pref = window.localStorage.getItem(WEB_REMEMBER_PREF_KEY);
  return pref !== 'false';
}

/**
 * 从浏览器存储恢复 Web 账号。
 * @description 优先读取标签页会话存储（sessionStorage）；
 * 若不存在则尝试从可信持久存储（localStorage）恢复未过期的会话（默认 30 天）。
 */
function loadWebAccount(): SecureAccountState | null {
  if (typeof window === 'undefined') return null;
  try {
    // 1. 优先从当前标签页 session 恢复
    const sessionRaw = window.sessionStorage.getItem(WEB_ACCOUNT_SESSION_KEY);
    if (sessionRaw) {
      const sessionVal = JSON.parse(sessionRaw);
      if (sessionVal?.gitlabToken && sessionVal?.gitlabHost && Number(sessionVal?.gitlabUserId)) {
        return sessionVal as SecureAccountState;
      }
    }

    // 2. 尝试从 localStorage 恢复已勾选「记住我」的凭据
    const localRaw = window.localStorage.getItem(WEB_ACCOUNT_LOCAL_KEY);
    if (localRaw) {
      const localVal = JSON.parse(localRaw) as WebStoredAccountState;
      if (localVal?.gitlabToken && localVal?.gitlabHost && Number(localVal?.gitlabUserId)) {
        // 检查过期时间
        if (localVal.rememberExpiresAt && Date.now() > localVal.rememberExpiresAt) {
          window.localStorage.removeItem(WEB_ACCOUNT_LOCAL_KEY);
          return null;
        }
        // 未过期，同步回当前 sessionStorage 加速本标签页后续访问
        window.sessionStorage.setItem(WEB_ACCOUNT_SESSION_KEY, JSON.stringify(localVal));
        return localVal as SecureAccountState;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 保存浏览器当前标签页与持久化 Web 账号。
 * @param state - 当前账号状态
 * @param rememberMe - 是否开启 30 天持久化记住我
 */
function saveWebAccount(state: SecureAccountState, rememberMe = false): void {
  if (typeof window === 'undefined') return;
  // 始终保存到当前标签页 session
  window.sessionStorage.setItem(WEB_ACCOUNT_SESSION_KEY, JSON.stringify(state));

  if (rememberMe) {
    const persistedState: WebStoredAccountState = {
      ...state,
      rememberExpiresAt: Date.now() + WEB_REMEMBER_TTL_MS,
      persisted: true,
    };
    window.localStorage.setItem(WEB_ACCOUNT_LOCAL_KEY, JSON.stringify(persistedState));
    window.localStorage.setItem(WEB_REMEMBER_PREF_KEY, 'true');
  } else {
    window.localStorage.removeItem(WEB_ACCOUNT_LOCAL_KEY);
    window.localStorage.setItem(WEB_REMEMBER_PREF_KEY, 'false');
  }
}

/** 清除浏览器会话及本地持久化 Web 账号。 */
function clearWebAccount(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(WEB_ACCOUNT_SESSION_KEY);
  window.localStorage.removeItem(WEB_ACCOUNT_LOCAL_KEY);
}

/** 获取或创建设备公钥身份。 */
export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  if (!isTauri()) throw new Error('设备身份仅在雨燕桌面端可用');
  if (!deviceIdentityCache) deviceIdentityCache = await invoke<DeviceIdentity>('get_or_create_device_identity');
  return deviceIdentityCache;
}

/** 使用原生设备私钥签署刷新挑战。 */
export function signDeviceChallenge(payload: string): Promise<DeviceSignature> {
  if (!isTauri()) return Promise.reject(new Error('设备签名仅在雨燕桌面端可用'));
  return invoke<DeviceSignature>('sign_device_challenge', { payload });
}

/** 读取当前活动账号安全状态。 */
export async function loadActiveSecureAccount(force = false): Promise<SecureAccountState | null> {
  if (!isTauri()) {
    if (activeAccountCache === undefined || force) activeAccountCache = loadWebAccount();
    return activeAccountCache;
  }
  if (activeAccountCache === undefined || force) {
    activeAccountCache = await invoke<SecureAccountState | null>('load_active_secure_account');
  }
  return activeAccountCache;
}

/** 保存当前活动账号安全状态。 */
export async function saveSecureAccount(state: SecureAccountState, rememberMe = false): Promise<void> {
  if (!isTauri()) {
    saveWebAccount(state, rememberMe);
    activeAccountCache = { ...state };
    return;
  }
  await invoke('save_secure_account', { state });
  activeAccountCache = { ...state };
}

/** 清除当前账号 PAT、雨燕令牌和活动账号指针。 */
export async function clearActiveSecureAccount(): Promise<void> {
  if (isTauri()) await invoke('clear_active_secure_account');
  else clearWebAccount();
  activeAccountCache = null;
}

/** 返回仅供内存调用链使用的中央会话，不复制到 localStorage。 */
export function getCachedSecureAccount(): SecureAccountState | null {
  return activeAccountCache || null;
}
