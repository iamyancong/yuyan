/**
 * 桌面系统钥匙串与浏览器标签页中的账号安全状态。
 * @description 桌面私钥永不返回 WebView；网页端不创建设备身份，PAT 仅保留在当前标签页会话中。
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/utils/env';

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
const WEB_ACCOUNT_STORAGE_KEY = 'yuyan:web-account-session';

/** 从浏览器当前标签页恢复 Web 账号，不跨浏览器会话持久化。 */
function loadWebAccount(): SecureAccountState | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(WEB_ACCOUNT_STORAGE_KEY) || 'null');
    if (!value?.gitlabToken || !value?.gitlabHost || !Number(value?.gitlabUserId)) return null;
    return value as SecureAccountState;
  } catch {
    return null;
  }
}

/** 保存浏览器当前标签页的 Web 账号。 */
function saveWebAccount(state: SecureAccountState): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(WEB_ACCOUNT_STORAGE_KEY, JSON.stringify(state));
}

/** 清除浏览器当前标签页的 Web 账号。 */
function clearWebAccount(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(WEB_ACCOUNT_STORAGE_KEY);
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
export async function saveSecureAccount(state: SecureAccountState): Promise<void> {
  if (!isTauri()) {
    saveWebAccount(state);
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
