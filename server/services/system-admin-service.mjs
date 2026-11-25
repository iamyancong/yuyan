/**
 * 系统管理员白名单（#69 增量）
 * @description 中央库灾备等全局能力只对 YUYAN_SYSTEM_ADMINS 中的账号开放。
 * 未配置时默认拒绝所有人（fail closed）。定时备份/巡检走内部调度，不经过本门禁。
 */

import { getRequestContext } from './request-context.mjs';
import { ensureCentralIdentitySchema } from './central-identity-service.mjs';

/** 占位/系统上下文，不能当作人类管理员身份。 */
const NON_HUMAN_USER_IDS = new Set(['', 'legacy-disabled', 'system', 'legacy-device']);

/**
 * 解析 `YUYAN_SYSTEM_ADMINS` 白名单。
 * @description 以逗号分隔（也兼容中文逗号、分号和换行），忽略大小写与首尾空白。
 * @param {string} [raw=process.env.YUYAN_SYSTEM_ADMINS] - 原始环境变量
 * @returns {string[]} 规范化后的标识列表（小写）
 */
export function parseSystemAdminAllowlist(raw = process.env.YUYAN_SYSTEM_ADMINS) {
  return String(raw || '')
    .split(/[,，;；\n]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 白名单是否已配置至少一个标识。
 * @param {string} [raw]
 * @returns {boolean}
 */
export function isSystemAdminAllowlistConfigured(raw = process.env.YUYAN_SYSTEM_ADMINS) {
  return parseSystemAdminAllowlist(raw).length > 0;
}

/**
 * 是否属于需要系统管理员白名单的中央灾备写/读接口（不含权限探测接口）。
 * @param {string} pathname - Express `req.path`（不含挂载前缀）
 * @returns {boolean}
 */
export function isPrivilegedCentralBackupPath(pathname) {
  return (
    pathname === '/central-backup'
    || pathname === '/central-backup/settings'
    || pathname === '/central-backup/run'
    || pathname === '/central-backup/patrol'
  );
}

/**
 * 规范化单个身份标识，空值返回空串。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * 从 users / identity_links 收集可用于比对的标识（GitLab 用户名、邮箱、账号 ID）。
 * @param {string} userId - 中央账号 ID
 * @returns {Promise<string[]>}
 */
export async function loadAccountIdentifiers(userId) {
  const id = String(userId || '').trim();
  if (!id || NON_HUMAN_USER_IDS.has(id)) return [];
  const db = await ensureCentralIdentitySchema();
  const identifiers = [id];
  try {
    const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(id);
    if (user) {
      identifiers.push(user.id, user.username, user.email);
    }
    const links = db.prepare(
      "SELECT external_username FROM identity_links WHERE user_id = ? AND provider = 'gitlab'"
    ).all(id);
    for (const link of links) {
      identifiers.push(link.external_username);
    }
  } catch {
    // 身份表尚未迁移完成时，至少保留 userId 本身参与比对
  }
  return identifiers;
}

/**
 * 从请求中收集会话身份标识（中央会话 + 网页 GitLab 用户）。
 * @param {{ webGitlabUser?: { username?: string, email?: string, public_email?: string } }} [req]
 * @returns {Promise<string[]>}
 */
export async function collectRequestIdentifiers(req = {}) {
  const identifiers = [];
  const context = getRequestContext();
  const userId = String(context?.userId || context?.accountId || '').trim();
  if (userId && !NON_HUMAN_USER_IDS.has(userId)) {
    identifiers.push(userId, context.accountId, context.userId);
    const fromDb = await loadAccountIdentifiers(userId);
    identifiers.push(...fromDb);
  }
  const gitlabUser = req?.webGitlabUser;
  if (gitlabUser && typeof gitlabUser === 'object') {
    identifiers.push(gitlabUser.username, gitlabUser.email, gitlabUser.public_email, gitlabUser.commit_email);
  }
  return [...new Set(identifiers.map(normalizeIdentifier).filter(Boolean))];
}

/**
 * 判断一组标识是否命中白名单（忽略大小写）。
 * @param {Iterable<string>} identifiers
 * @param {string[]} [allowlist]
 * @returns {boolean}
 */
export function matchSystemAdminAllowlist(identifiers, allowlist = parseSystemAdminAllowlist()) {
  if (!allowlist.length) return false;
  const allowed = new Set(allowlist);
  for (const item of identifiers || []) {
    const normalized = normalizeIdentifier(item);
    if (normalized && allowed.has(normalized)) return true;
  }
  return false;
}

/**
 * 解析当前请求是否为系统管理员。
 * @param {object} [req]
 * @returns {Promise<{ configured: boolean, isSystemAdmin: boolean }>}
 */
export async function resolveSystemAdminAccess(req = {}) {
  const configured = isSystemAdminAllowlistConfigured();
  if (!configured) return { configured: false, isSystemAdmin: false };
  const identifiers = await collectRequestIdentifiers(req);
  return {
    configured: true,
    isSystemAdmin: matchSystemAdminAllowlist(identifiers),
  };
}

/**
 * 断言当前请求来自白名单内的系统管理员；未配置或未命中时抛出 403。
 * @param {object} [req]
 * @returns {Promise<{ configured: true, isSystemAdmin: true }>}
 */
export async function assertSystemAdminAccess(req = {}) {
  const access = await resolveSystemAdminAccess(req);
  if (!access.configured) {
    const error = new Error('未配置系统管理员');
    error.statusCode = 403;
    error.status = 403;
    error.code = 'system_admin_unconfigured';
    throw error;
  }
  if (!access.isSystemAdmin) {
    const error = new Error('当前账号不是系统管理员，无权使用中央灾备');
    error.statusCode = 403;
    error.status = 403;
    error.code = 'system_admin_required';
    throw error;
  }
  return { configured: true, isSystemAdmin: true };
}
