/**
 * Agent 中央/本地执行上下文与内存凭据服务。
 * @description 凭据只保存在雨燕内嵌服务内存，不写入 Agent 数据库、结果或审计。
 */

import { GITLAB_HOST } from '../config/constants.mjs';

const runtimeSettings = {
  centralApiBase: '',
  centralAccessToken: '',
  centralAccessExpiresAt: '',
  gitlabHost: GITLAB_HOST,
  gitlabToken: '',
  accountId: '',
  deviceId: '',
  teamId: '',
  role: '',
  forcedApprovalTools: [],
  accountApprovalPolicyReady: false,
  syncedAt: '',
};

/** 规范化 HTTP 服务根地址。 */
function normalizeHttpBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('中央 API 地址必须使用 HTTP 或 HTTPS');
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * 从雨燕 WebView 同步当前执行上下文和已有凭据。
 * @param {Record<string, unknown>} patch 设置补丁
 * @returns {object} 脱敏状态
 */
export function updateAgentRuntimeSettings(patch = {}) {
  if ('centralApiBase' in patch) runtimeSettings.centralApiBase = normalizeHttpBase(patch.centralApiBase);
  if ('centralAccessToken' in patch) runtimeSettings.centralAccessToken = String(patch.centralAccessToken || '').trim();
  if ('centralAccessExpiresAt' in patch) runtimeSettings.centralAccessExpiresAt = String(patch.centralAccessExpiresAt || '').trim();
  if ('gitlabHost' in patch) runtimeSettings.gitlabHost = normalizeHttpBase(patch.gitlabHost);
  if ('gitlabToken' in patch) runtimeSettings.gitlabToken = String(patch.gitlabToken || '').trim();
  if ('accountId' in patch) runtimeSettings.accountId = String(patch.accountId || '').trim();
  if ('deviceId' in patch) runtimeSettings.deviceId = String(patch.deviceId || '').trim();
  if ('teamId' in patch) runtimeSettings.teamId = String(patch.teamId || '').trim();
  if ('role' in patch) runtimeSettings.role = ['viewer', 'operator', 'admin'].includes(String(patch.role || '')) ? String(patch.role) : '';
  if ('forcedApprovalTools' in patch) {
    runtimeSettings.forcedApprovalTools = Array.isArray(patch.forcedApprovalTools)
      ? [...new Set(patch.forcedApprovalTools.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 50)
      : [];
  }
  if ('accountApprovalPolicyReady' in patch) runtimeSettings.accountApprovalPolicyReady = patch.accountApprovalPolicyReady === true;
  runtimeSettings.syncedAt = new Date().toISOString();
  return getAgentRuntimeSettings();
}

/**
 * 获取执行上下文。
 * @param {{includeSecrets?: boolean}} options 是否供内部执行器读取凭据
 * @returns {object} 执行上下文
 */
export function getAgentRuntimeSettings({ includeSecrets = false } = {}) {
  const centralAccessValid = Boolean(
    runtimeSettings.centralAccessToken
    && runtimeSettings.centralAccessExpiresAt
    && Date.parse(runtimeSettings.centralAccessExpiresAt) > Date.now()
  );
  const common = {
    centralConfigured: Boolean(runtimeSettings.centralApiBase),
    centralSessionReady: Boolean(centralAccessValid && runtimeSettings.accountId && runtimeSettings.deviceId && runtimeSettings.teamId),
    hasGitlabCredential: Boolean(runtimeSettings.gitlabToken && runtimeSettings.gitlabHost),
    accountId: runtimeSettings.accountId,
    deviceId: runtimeSettings.deviceId,
    teamId: runtimeSettings.teamId,
    role: runtimeSettings.role,
    forcedApprovalTools: [...runtimeSettings.forcedApprovalTools],
    accountApprovalPolicyReady: runtimeSettings.accountApprovalPolicyReady,
    loggedIn: Boolean(runtimeSettings.accountId && runtimeSettings.deviceId),
    syncedAt: runtimeSettings.syncedAt,
  };
  return includeSecrets ? {
    ...common,
    centralApiBase: runtimeSettings.centralApiBase,
    centralAccessToken: runtimeSettings.centralAccessToken,
    centralAccessExpiresAt: runtimeSettings.centralAccessExpiresAt,
    gitlabHost: runtimeSettings.gitlabHost,
    gitlabToken: runtimeSettings.gitlabToken,
  } : common;
}
