/**
 * 独立服务器部署数据存储服务
 * @description 基于 Node 内置 SQLite 保存服务器、部署目标和发布记录
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { DEPLOY_DATA_DIR, DEPLOY_DB_PATH, DEPLOY_LOG_DIR, DEPLOY_RECORD_KEEP_PER_PROJECT, DEPLOY_SECRET_KEY, GITLAB_HOST, GITLAB_TOKEN } from '../config/constants.mjs';
import { normalizeBackendConfig, normalizeBackendServiceName, normalizeHealthCheckPath, parseJavaMajorVersion, validateBackendDeployRoot } from './backend-domain.mjs';
import { getRequestTeamId, SHARED_DEPLOY_WORKSPACE_ID } from './request-context.mjs';

let dbInstance = null;

/** 服务重启后写入遗留发布记录的说明日志 */
const DEPLOY_INTERRUPTED_LOG_MESSAGE = '雨燕服务重启，上一次发布任务未正常结束，已自动标记为停止';

/** 服务重启后写入遗留中央任务的错误信息 */
const CENTRAL_DEPLOY_INTERRUPTED_ERROR = JSON.stringify({
  code: 'service_restarted',
  message: '雨燕服务重启，中央部署任务已中断，请重新发布',
  retryable: true,
});

/** 需要并入共享中央部署工作区的业务表，不包含设备 JDK 和 OpenAPI 缓存。 */
const SHARED_DEPLOY_WORKSPACE_TABLES = [
  'deploy_servers',
  'nginx_runtimes',
  'nginx_instances',
  'deploy_targets',
  'deploy_records',
  'backend_target_configs',
  'server_java_runtimes',
  'deploy_environments',
  'backend_releases',
  'deploy_tasks',
];

/**
 * 生成当前 ISO 时间
 * @returns {string} ISO 时间字符串
 */
function now() {
  return new Date().toISOString();
}

/**
 * 获取加密密钥
 * @returns {Buffer} AES-256-GCM 密钥
 */
function getCipherKey() {
  return crypto.createHash('sha256').update(String(DEPLOY_SECRET_KEY)).digest();
}

/**
 * 加密部署凭据
 * @param {Object} credential - 凭据信息
 * @returns {string} 加密后的 JSON 字符串
 */
function encryptCredential(credential, teamId = getRequestTeamId()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getCipherKey(), iv);
  cipher.setAAD(Buffer.from(`yuyan-team:${teamId}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    schemaVersion: 2,
    teamId,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

/**
 * 解密部署凭据
 * @param {string} raw - 加密后的 JSON 字符串
 * @returns {Object} 凭据信息
 */
function decryptCredential(raw, expectedTeamId = getRequestTeamId()) {
  try {
    if (!raw) return {};
    const payload = JSON.parse(raw);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getCipherKey(), Buffer.from(payload.iv, 'base64'));
    if (payload.schemaVersion >= 2) {
      if (payload.teamId !== expectedTeamId) throw new Error('凭据不属于当前账号');
      decipher.setAAD(Buffer.from(`yuyan-team:${expectedTeamId}`, 'utf8'));
    }
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    throw new Error('服务器凭据解密失败：当前 DEPLOY_SECRET_KEY 与保存该服务器时使用的值不一致。请使用原来的 DEPLOY_SECRET_KEY 启动服务，或删除该服务器后重新新增。');
  }
}

/**
 * 解析 JSON 字段
 * @param {string} value - JSON 字符串
 * @param {*} fallback - 解析失败兜底值
 * @returns {*} 解析后的值
 */
function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

/** 默认 Nginx 运行时根目录 */
export const DEFAULT_NGINX_RUNTIME_BASE_ROOT = '/opt/yuyan';

/** Nginx 实例类型 */
const NGINX_INSTANCE_TYPES = new Set(['external', 'managed']);

/** 默认外部 Nginx 实例名称 */
const DEFAULT_EXTERNAL_NGINX_INSTANCE_NAME = '系统 Nginx';

/** 默认托管 Nginx 实例名称 */
const DEFAULT_MANAGED_NGINX_INSTANCE_NAME = 'yuyan托管';

/**
 * 标准化远程绝对目录。
 * @param {string} value - 原始目录
 * @param {string} fallback - 兜底目录
 * @returns {string} 标准目录
 */
function normalizeRemoteRoot(value, fallback) {
  const normalized = path.posix.normalize(String(value || fallback).trim().replace(/\\/g, '/'));
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

/**
 * 按根目录派生托管 Nginx 运行时路径。
 * @param {string} baseRoot - 运行时根目录
 * @returns {Object} 派生路径
 */
function deriveNginxRuntimePaths(baseRoot = DEFAULT_NGINX_RUNTIME_BASE_ROOT) {
  const root = normalizeRemoteRoot(baseRoot, DEFAULT_NGINX_RUNTIME_BASE_ROOT);
  const nginxRoot = path.posix.join(root, 'nginx');
  return {
    baseRoot: root,
    nginxRoot,
    htmlRoot: path.posix.join(root, 'html'),
    sitesDir: path.posix.join(nginxRoot, 'conf', 'conf.d'),
    logsDir: path.posix.join(nginxRoot, 'logs'),
    scriptPath: path.posix.join(nginxRoot, 'yuyan-nginx.sh'),
  };
}

/**
 * 获取托管 Nginx 主配置路径。
 * @param {Object} paths - 托管路径集合
 * @returns {string} 主配置路径
 */
function getManagedMainConfPath(paths) {
  return path.posix.join(paths.nginxRoot, 'conf', 'nginx.conf');
}

/**
 * 判断命令是否为系统 Nginx 的通用默认命令。
 * @param {string} command - 命令文本
 * @param {'test'|'reload'} type - 命令类型
 * @returns {boolean} 是否通用默认命令
 */
function isGenericNginxCommand(command, type) {
  const normalized = String(command || '').trim();
  if (!normalized) return true;
  return type === 'reload' ? normalized === 'nginx -s reload' : normalized === 'nginx -t';
}

/**
 * 获取托管 Nginx 实例管理脚本路径。
 * @param {Object} row - 实例数据库行
 * @returns {string} 管理脚本路径
 */
function getManagedInstanceScriptPath(row) {
  const baseRoot = row.base_root || DEFAULT_NGINX_RUNTIME_BASE_ROOT;
  const nginxRoot = row.nginx_root || path.posix.join(baseRoot, 'nginx');
  return row.script_path || path.posix.join(nginxRoot, 'yuyan-nginx.sh');
}

/**
 * 解析实例命令，托管实例的历史裸命令自动切换为管理脚本。
 * @param {Object} row - 实例数据库行
 * @param {'test'|'reload'} type - 命令类型
 * @returns {string} 命令文本
 */
function resolveNginxInstanceCommand(row, type) {
  const field = type === 'reload' ? row.nginx_reload_command : row.nginx_test_command;
  if (row.instance_type === 'managed') {
    if (isGenericNginxCommand(field, type)) return `${getManagedInstanceScriptPath(row)} ${type}`;
    return String(field || '').trim();
  }
  return String(field || (type === 'reload' ? 'nginx -s reload' : 'nginx -t')).trim();
}

/**
 * 读取数据表字段名。
 * @param {DatabaseSync} db - 数据库实例
 * @param {string} tableName - 表名
 * @returns {string[]} 字段名列表
 */
function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((item) => item.name);
}

/**
 * 判断数据表是否存在。
 * @param {DatabaseSync} db 数据库实例
 * @param {string} tableName 表名
 * @returns {boolean} 是否存在
 */
function hasTable(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

/**
 * 标准化发布记录 ID。
 * @param {number|string|null|undefined} value - 原始记录 ID
 * @returns {number} 有效记录 ID，无效时返回 0
 */
function normalizeRecordId(value) {
  const id = Number(value || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/**
 * 根据历史字段推断发布记录操作类型。
 * @param {Object} row - 发布记录数据库行
 * @returns {'deploy'|'rollback'|'undoRollback'} 操作类型
 */
function resolveRecordAction(row) {
  const action = String(row?.action || '').trim();
  if (['deploy', 'rollback', 'undoRollback'].includes(action)) return action;
  const branch = String(row?.branch || '');
  if (branch.startsWith('undo-rollback-')) return 'undoRollback';
  return branch.startsWith('rollback-') ? 'rollback' : 'deploy';
}

/**
 * 从回滚分支名中提取来源记录 ID。
 * @param {string} branch - 发布记录分支字段
 * @returns {number} 来源记录 ID
 */
function parseRollbackSourceRecordId(branch) {
  const matched = String(branch || '').match(/^(?:undo-)?rollback-(\d+)$/);
  return matched ? normalizeRecordId(matched[1]) : 0;
}

/**
 * 规范化 GitLab 服务地址。
 * @param {string} host - GitLab 原始地址
 * @returns {string} GitLab 基础地址
 */
function normalizeGitlabHost(host) {
  try {
    const url = new URL(host);
    return `${url.protocol}//${url.host}`;
  } catch {
    return String(host || '').replace(/\/$/, '');
  }
}

/**
 * 判断文本是否包含中文。
 * @param {string} value - 原始文本
 * @returns {boolean} 是否包含中文
 */
function hasChineseText(value) {
  return /[\u4e00-\u9fa5]/.test(String(value || ''));
}

/**
 * 从 GitLab 用户列表里选择更适合展示的用户名。
 * @param {Object[]} users - GitLab 用户列表
 * @param {string} fallbackName - 兜底名称
 * @returns {string} 展示名称
 */
function pickGitlabUserDisplayName(users, fallbackName) {
  const list = Array.isArray(users) ? users : [];
  const chineseUser = list.find((user) => hasChineseText(user?.name));
  if (chineseUser?.name) return String(chineseUser.name).trim();
  const firstName = String(list[0]?.name || '').trim();
  return firstName || fallbackName;
}

/**
 * 请求 GitLab 用户列表并选取展示名。
 * @param {string} url - GitLab 用户接口地址
 * @param {Record<string, string>} headers - 请求头
 * @param {string} fallbackName - 兜底名称
 * @returns {Promise<string>} 展示名
 */
async function fetchGitlabUserDisplayName(url, headers, fallbackName) {
  const response = await fetch(url, { headers }).catch(() => null);
  if (!response?.ok) return fallbackName;
  const users = await response.json().catch(() => []);
  return pickGitlabUserDisplayName(users, fallbackName);
}

/**
 * 搜索 GitLab 用户展示名。
 * @param {string} base - GitLab 基础地址
 * @param {Record<string, string>} headers - 请求头
 * @param {number|string} projectId - GitLab 项目 ID
 * @param {string} keyword - 搜索关键字
 * @param {string} fallbackName - 兜底名称
 * @returns {Promise<string>} 用户展示名
 */
async function searchGitlabUserDisplayName(base, headers, projectId, keyword, fallbackName) {
  const searchText = String(keyword || '').trim();
  if (!searchText) return fallbackName;
  const usernameLikeText = searchText.includes('@') ? searchText.split('@')[0] : searchText;

  const searchUrls = [
    `${base}/api/v4/users?username=${encodeURIComponent(usernameLikeText)}`,
    `${base}/api/v4/projects/${encodeURIComponent(projectId)}/members/all?query=${encodeURIComponent(usernameLikeText)}`,
    `${base}/api/v4/projects/${encodeURIComponent(projectId)}/users?search=${encodeURIComponent(usernameLikeText)}`,
    `${base}/api/v4/users?search=${encodeURIComponent(usernameLikeText)}`,
  ];

  if (searchText !== usernameLikeText) {
    searchUrls.push(
      `${base}/api/v4/projects/${encodeURIComponent(projectId)}/members/all?query=${encodeURIComponent(searchText)}`,
      `${base}/api/v4/projects/${encodeURIComponent(projectId)}/users?search=${encodeURIComponent(searchText)}`,
      `${base}/api/v4/users?search=${encodeURIComponent(searchText)}`
    );
  }

  let bestName = fallbackName;
  for (const url of searchUrls) {
    const displayName = await fetchGitlabUserDisplayName(url, headers, fallbackName);
    if (hasChineseText(displayName)) return displayName;
    if (displayName && displayName !== fallbackName) bestName = displayName;
  }
  return bestName;
}

/**
 * 获取 GitLab 提交元信息。
 * @param {number|string} projectId - GitLab 项目 ID
 * @param {string} commitSha - Commit SHA
 * @param {string} [gitlabToken] - GitLab 访问令牌
 * @param {string} [gitlabHost] - GitLab 服务地址
 * @returns {Promise<{message: string, author: string}>} 提交元信息
 */
export async function fetchGitlabCommitMeta(projectId, commitSha, gitlabToken = '', gitlabHost = '') {
  const safeProjectId = Number(projectId || 0);
  const safeCommitSha = String(commitSha || '').trim();
  if (!safeProjectId || !safeCommitSha) return { message: '', author: '' };

  const base = normalizeGitlabHost(gitlabHost || GITLAB_HOST);
  const token = String(gitlabToken || GITLAB_TOKEN || '').trim();
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  const url = `${base}/api/v4/projects/${encodeURIComponent(safeProjectId)}/repository/commits/${encodeURIComponent(safeCommitSha)}`;
  const response = await fetch(url, { headers }).catch(() => null);
  if (!response?.ok) return { message: '', author: '' };

  const commit = await response.json().catch(() => null);
  const title = String(commit?.title || '').trim();
  const message = title || String(commit?.message || '').split(/\r?\n/)[0]?.trim() || '';
  const rawAuthor = String(commit?.author_name || commit?.committer_name || '').trim();
  const authorEmail = String(commit?.author_email || commit?.committer_email || '').trim();
  let author = rawAuthor;
  if (!hasChineseText(rawAuthor)) {
    const emailDisplayName = await searchGitlabUserDisplayName(base, headers, safeProjectId, authorEmail, rawAuthor);
    author = hasChineseText(emailDisplayName) || !rawAuthor ? emailDisplayName : await searchGitlabUserDisplayName(base, headers, safeProjectId, rawAuthor, emailDisplayName || rawAuthor);
  }
  return { message, author };
}

/**
 * 补全旧发布记录缺失的提交元信息，并回写数据库。
 * @param {Object[]} records - 发布记录列表
 * @param {Object} options - 补全选项
 * @returns {Promise<Object[]>} 补全后的发布记录列表
 */
async function hydrateRecordCommitMessages(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const missingRecords = list.filter((record) => {
    const missingMessage = !String(record?.commitMessage || '').trim();
    const shouldImproveAuthor = !String(record?.commitAuthor || '').trim() || !hasChineseText(record.commitAuthor);
    return record?.commitSha && (missingMessage || shouldImproveAuthor);
  });
  if (!missingRecords.length) return list;

  const db = await getDeployDb();
  const commitCache = new Map();
  for (const record of missingRecords) {
    const cacheKey = `${record.projectId}:${record.commitSha}`;
    if (!commitCache.has(cacheKey)) {
      const commitMeta = await fetchGitlabCommitMeta(record.projectId, record.commitSha, options.gitlabToken, options.gitlabHost);
      commitCache.set(cacheKey, commitMeta);
    }
    const commitMeta = commitCache.get(cacheKey);
    if (!commitMeta?.message && !commitMeta?.author) continue;
    record.commitMessage = record.commitMessage || commitMeta.message;
    record.commitAuthor = hasChineseText(record.commitAuthor) ? record.commitAuthor : commitMeta.author || record.commitAuthor;
    db.prepare('UPDATE deploy_records SET commit_message = ?, commit_author = ? WHERE id = ?').run(record.commitMessage || '', record.commitAuthor || '', Number(record.id));
  }
  return list;
}

/**
 * 补齐旧发布记录的操作类型和版本引用字段。
 * @param {DatabaseSync} db - SQLite 数据库实例
 * @param {Object} options - 迁移选项
 */
function normalizeDeployRecordVersionFields(db, options = {}) {
  const rows = db
    .prepare(
      `SELECT id, target_id, branch, status, backup_path, action, source_record_id, restored_record_id, backup_record_id
       FROM deploy_records
       ORDER BY target_id ASC, started_at ASC, id ASC`
    )
    .all();
  if (!rows.length) return;

  const normalizedById = new Map();
  const currentSuccessByTarget = new Map();
  const updates = [];

  rows.forEach((row) => {
    const id = normalizeRecordId(row.id);
    const targetId = normalizeRecordId(row.target_id);
    let action = resolveRecordAction(row);
    const branch = String(row.branch || '');
    const looksLikeLegacyRollback = options.inferLegacyAction && (branch.startsWith('rollback-') || branch.startsWith('undo-rollback-')) && !normalizeRecordId(row.source_record_id);
    if (looksLikeLegacyRollback) {
      action = branch.startsWith('undo-rollback-') ? 'undoRollback' : 'rollback';
    }
    let sourceRecordId = normalizeRecordId(row.source_record_id);
    let restoredRecordId = normalizeRecordId(row.restored_record_id);
    let backupRecordId = normalizeRecordId(row.backup_record_id);

    if (!sourceRecordId && (action === 'rollback' || action === 'undoRollback')) {
      sourceRecordId = parseRollbackSourceRecordId(row.branch);
    }

    const previousSuccessId = normalizeRecordId(currentSuccessByTarget.get(targetId));
    if (!backupRecordId && row.backup_path) {
      backupRecordId = action === 'rollback' || action === 'undoRollback' ? previousSuccessId || sourceRecordId : previousSuccessId;
    }

    if (!restoredRecordId && row.status === 'success') {
      if (action === 'deploy') {
        restoredRecordId = id;
      } else if (sourceRecordId) {
        const sourceRecord = normalizedById.get(sourceRecordId);
        restoredRecordId = normalizeRecordId(sourceRecord?.backupRecordId);
      }
    }

    if (
      action !== String(row.action || '') ||
      sourceRecordId !== normalizeRecordId(row.source_record_id) ||
      restoredRecordId !== normalizeRecordId(row.restored_record_id) ||
      backupRecordId !== normalizeRecordId(row.backup_record_id)
    ) {
      updates.push({ action, sourceRecordId, restoredRecordId, backupRecordId, id });
    }

    normalizedById.set(id, { action, sourceRecordId, restoredRecordId, backupRecordId });
    if (row.status === 'success') currentSuccessByTarget.set(targetId, id);
  });

  if (!updates.length) return;
  db.exec('BEGIN');
  try {
    const stmt = db.prepare('UPDATE deploy_records SET action = ?, source_record_id = ?, restored_record_id = ?, backup_record_id = ? WHERE id = ?');
    updates.forEach((item) => {
      stmt.run(item.action, item.sourceRecordId || null, item.restoredRecordId || null, item.backupRecordId || null, item.id);
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 获取每个部署目标当前生效的成功记录 ID。
 * @param {DatabaseSync} db - SQLite 数据库实例
 * @param {number[]} targetIds - 部署目标 ID 列表
 * @returns {Map<number, number>} 部署目标 ID 与当前成功记录 ID 映射
 */
function getCurrentRecordIdsByTarget(db, targetIds) {
  const result = new Map();
  const ids = Array.from(new Set((targetIds || []).map(normalizeRecordId).filter(Boolean)));
  if (!ids.length) return result;
  const stmt = db.prepare(
    `SELECT id
     FROM deploy_records
     WHERE target_id = ? AND status = 'success'
     ORDER BY started_at DESC, id DESC
     LIMIT 1`
  );
  ids.forEach((targetId) => {
    const row = stmt.get(targetId);
    if (row?.id) result.set(targetId, Number(row.id));
  });
  return result;
}

/**
 * 获取存在的发布记录 ID 集合。
 * @param {DatabaseSync} db - SQLite 数据库实例
 * @param {number[]} recordIds - 发布记录 ID 列表
 * @returns {Set<number>} 存在的发布记录 ID 集合
 */
function getExistingRecordIds(db, recordIds) {
  const ids = Array.from(new Set((recordIds || []).map(normalizeRecordId).filter(Boolean)));
  if (!ids.length) return new Set();
  const rows = db.prepare(`SELECT id FROM deploy_records WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Set(rows.map((row) => Number(row.id)));
}

/**
 * 解析发布记录完成后实际生效的提交信息。
 * @param {DatabaseSync} db - SQLite 数据库实例
 * @param {Object} record - 发布记录
 * @param {Set<number>} visited - 已访问记录 ID，避免异常链路循环
 * @returns {{commitSha: string, commitMessage: string, commitAuthor: string}} 生效提交快照
 */
function resolveEffectiveCommitSnapshot(db, record, visited = new Set()) {
  const recordId = normalizeRecordId(record?.id);
  if (!record || (recordId && visited.has(recordId))) {
    return { commitSha: '', commitMessage: '', commitAuthor: '' };
  }
  if (recordId) visited.add(recordId);

  const commitSha = String(record.commitSha || '').trim();
  if (commitSha) {
    return {
      commitSha,
      commitMessage: record.commitMessage || '',
      commitAuthor: record.commitAuthor || '',
    };
  }

  const restoredRecordId = normalizeRecordId(record.restoredRecordId);
  if (restoredRecordId && restoredRecordId !== recordId) {
    const row = db.prepare('SELECT * FROM deploy_records WHERE id = ?').get(restoredRecordId);
    const restoredRecord = mapRecord(row, { includeLogs: false });
    const snapshot = resolveEffectiveCommitSnapshot(db, restoredRecord, visited);
    if (snapshot.commitSha) return snapshot;
  }

  const sourceRecordId = normalizeRecordId(record.sourceRecordId);
  if (sourceRecordId && sourceRecordId !== recordId) {
    const sourceRow = db.prepare('SELECT * FROM deploy_records WHERE id = ?').get(sourceRecordId);
    const sourceRecord = mapRecord(sourceRow, { includeLogs: false });
    const sourceBackupRecordId = normalizeRecordId(sourceRecord?.backupRecordId);
    if (sourceBackupRecordId && !visited.has(sourceBackupRecordId)) {
      const backupRow = db.prepare('SELECT * FROM deploy_records WHERE id = ?').get(sourceBackupRecordId);
      const backupRecord = mapRecord(backupRow, { includeLogs: false });
      const snapshot = resolveEffectiveCommitSnapshot(db, backupRecord, visited);
      if (snapshot.commitSha) return snapshot;
    }
  }

  return { commitSha: '', commitMessage: '', commitAuthor: '' };
}

/**
 * 补充发布记录当前状态和可执行操作。
 * @param {DatabaseSync} db - SQLite 数据库实例
 * @param {Object[]} records - 发布记录列表
 * @returns {Object[]} 补充后的发布记录列表
 */
function decorateRecordState(db, records) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return list;
  const currentIds = getCurrentRecordIdsByTarget(db, list.map((record) => record.targetId));
  const existingBackupIds = getExistingRecordIds(db, list.map((record) => record.backupRecordId));
  list.forEach((record) => {
    const effectiveCommit = resolveEffectiveCommitSnapshot(db, record);
    if (effectiveCommit.commitSha) {
      record.commitSha = effectiveCommit.commitSha;
      record.commitMessage = record.commitMessage || effectiveCommit.commitMessage;
      record.commitAuthor = record.commitAuthor || effectiveCommit.commitAuthor;
    }
    const backupRecordId = normalizeRecordId(record.backupRecordId);
    const hasRecoverableBackup = Boolean(record.backupPath && backupRecordId && existingBackupIds.has(backupRecordId));
    record.isCurrentVersion = record.status === 'success' && currentIds.get(Number(record.targetId)) === Number(record.id);
    record.canUndoRollback = record.isCurrentVersion && record.action === 'rollback' && hasRecoverableBackup;
    record.canRollback = record.isCurrentVersion && record.action !== 'rollback' && hasRecoverableBackup;
  });
  return list;
}

/**
 * 获取发布记录日志文件路径
 * @param {number} recordId - 发布记录 ID
 * @returns {string} 日志文件路径
 */
function getRecordLogPath(recordId) {
  return path.join(DEPLOY_LOG_DIR, `record-${Number(recordId)}.json`);
}

/**
 * 写入发布记录日志文件
 * @param {number} recordId - 发布记录 ID
 * @param {Array<Object>} logs - 日志列表
 * @returns {Promise<string>} 日志文件路径
 */
async function writeRecordLogs(recordId, logs = []) {
  await fs.mkdir(DEPLOY_LOG_DIR, { recursive: true });
  const logPath = getRecordLogPath(recordId);
  await fs.writeFile(logPath, JSON.stringify(logs || []), 'utf8');
  return logPath;
}

/**
 * 读取发布记录日志
 * @param {Object} row - 数据库行
 * @returns {Promise<Array<Object>>} 日志列表
 */
async function readRecordLogs(row) {
  if (row?.log_path) {
    const content = await fs.readFile(row.log_path, 'utf8').catch(() => '');
    if (content) return parseJson(content, []);
  }
  return parseJson(row?.logs, []);
}

/**
 * 删除本地发布记录日志文件
 * @param {string} logPath - 日志文件路径
 */
async function deleteRecordLogFile(logPath) {
  if (!logPath) return;
  await fs.rm(logPath, { force: true }).catch(() => {});
}

/**
 * 转换服务器数据，默认不回传敏感凭据
 * @param {Object} row - 数据库行
 * @returns {Object} 服务器数据
 */
function mapServer(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id || 'legacy-team',
    sortOrder: Number(row.sort_order || 0),
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    useSudo: Boolean(row.use_sudo),
    defaultDeployRoot: row.default_deploy_root || '',
    defaultBackendRoot: row.default_backend_root || '',
    defaultNginxConfPath: row.default_nginx_conf_path || '',
    nginxWorkDir: row.nginx_work_dir || '',
    nginxTestCommand: row.nginx_test_command || 'nginx -t',
    nginxReloadCommand: row.nginx_reload_command || 'nginx -s reload',
    remark: row.remark || '',
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasCredential: Boolean(row.encrypted_secret),
    defaultNginxInstanceId: Number(row.default_nginx_instance_id || 0),
    nginxInstances: row.nginx_instances || [],
    nginxRuntime: row.nginx_runtime_id
      ? mapNginxRuntime({
          id: row.nginx_runtime_id,
          server_id: row.id,
          base_root: row.nginx_runtime_base_root,
          nginx_root: row.nginx_runtime_nginx_root,
          html_root: row.nginx_runtime_html_root,
          sites_dir: row.nginx_runtime_sites_dir,
          logs_dir: row.nginx_runtime_logs_dir,
          script_path: row.nginx_runtime_script_path,
          port_start: row.nginx_runtime_port_start,
          use_sudo: row.nginx_runtime_use_sudo,
          runtime_version: row.nginx_runtime_version,
          package_sha256: row.nginx_runtime_package_sha256,
          package_variant: row.nginx_runtime_package_variant,
          status: row.nginx_runtime_status,
          status_output: row.nginx_runtime_status_output,
          initialized_at: row.nginx_runtime_initialized_at,
          created_at: row.nginx_runtime_created_at,
          updated_at: row.nginx_runtime_updated_at,
        })
      : null,
  };
}

/**
 * 转换 Nginx 实例数据。
 * @param {Object} row - 数据库行
 * @returns {Object|null} Nginx 实例
 */
function mapNginxInstance(row) {
  if (!row) return null;
  const instanceType = NGINX_INSTANCE_TYPES.has(row.instance_type) ? row.instance_type : 'external';
  const scriptPath = instanceType === 'managed' ? getManagedInstanceScriptPath(row) : row.script_path || '';
  return {
    id: row.id,
    teamId: row.team_id || 'legacy-team',
    serverId: row.server_id,
    name: row.name,
    instanceType,
    defaultDeployRoot: row.default_deploy_root || '',
    defaultNginxConfPath: row.default_nginx_conf_path || '',
    nginxWorkDir: row.nginx_work_dir || '',
    nginxTestCommand: resolveNginxInstanceCommand(row, 'test'),
    nginxReloadCommand: resolveNginxInstanceCommand(row, 'reload'),
    baseRoot: row.base_root || '',
    nginxRoot: row.nginx_root || '',
    htmlRoot: row.html_root || '',
    sitesDir: row.sites_dir || '',
    logsDir: row.logs_dir || '',
    scriptPath,
    portStart: Number(row.port_start || 8080),
    useSudo: Boolean(row.use_sudo),
    runtimeVersion: row.runtime_version || '',
    packageSha256: row.package_sha256 || '',
    packageVariant: row.package_variant || '',
    status: row.status || 'unknown',
    statusOutput: row.status_output || '',
    initializedAt: row.initialized_at || '',
    targetCount: Number(row.target_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 转换托管 Nginx 运行时数据。
 * @param {Object} row - 数据库行
 * @returns {Object|null} 运行时数据
 */
function mapNginxRuntime(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id || 'legacy-team',
    serverId: row.server_id,
    baseRoot: row.base_root,
    nginxRoot: row.nginx_root,
    htmlRoot: row.html_root,
    sitesDir: row.sites_dir,
    logsDir: row.logs_dir,
    scriptPath: row.script_path,
    portStart: Number(row.port_start || 8080),
    useSudo: Boolean(row.use_sudo),
    runtimeVersion: row.runtime_version || '',
    packageSha256: row.package_sha256 || '',
    packageVariant: row.package_variant || '',
    status: row.status || 'unknown',
    statusOutput: row.status_output || '',
    initializedAt: row.initialized_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 将 Nginx 实例转换为旧托管运行时结构。
 * @param {Object|null} instance - Nginx 实例
 * @returns {Object|null} 旧运行时结构
 */
function mapRuntimeFromInstance(instance) {
  if (!instance || instance.instanceType !== 'managed') return null;
  return {
    id: instance.id,
    serverId: instance.serverId,
    baseRoot: instance.baseRoot,
    nginxRoot: instance.nginxRoot,
    htmlRoot: instance.htmlRoot,
    sitesDir: instance.sitesDir,
    logsDir: instance.logsDir,
    scriptPath: instance.scriptPath,
    portStart: instance.portStart,
    useSudo: instance.useSudo,
    runtimeVersion: instance.runtimeVersion,
    packageSha256: instance.packageSha256,
    packageVariant: instance.packageVariant,
    status: instance.status,
    statusOutput: instance.statusOutput,
    initializedAt: instance.initializedAt,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

/**
 * 读取服务器下的 Nginx 实例。
 * @param {DatabaseSync} db - 数据库实例
 * @param {number} serverId - 服务器 ID
 * @returns {Object[]} Nginx 实例列表
 */
function listNginxInstancesByServerId(db, serverId) {
  return db
    .prepare(
      `SELECT i.*, COUNT(t.id) AS target_count
       FROM nginx_instances i
       LEFT JOIN deploy_targets t ON t.nginx_instance_id = i.id
       WHERE i.server_id = ?
       GROUP BY i.id
       ORDER BY i.instance_type = 'managed' DESC, i.updated_at DESC, i.id DESC`
    )
    .all(Number(serverId))
    .map(mapNginxInstance);
}

/**
 * 为服务器附加 Nginx 实例集合与过渡兼容运行时字段。
 * @param {DatabaseSync} db - 数据库实例
 * @param {Object} row - 服务器行
 * @returns {Object|null} 服务器对象
 */
function hydrateServer(db, row) {
  const server = mapServer(row);
  if (!server) return null;
  const instances = listNginxInstancesByServerId(db, server.id);
  server.nginxInstances = instances;
  const managedRuntime = instances.find((item) => item.instanceType === 'managed' && item.initializedAt) || instances.find((item) => item.instanceType === 'managed');
  server.nginxRuntime = mapRuntimeFromInstance(managedRuntime);
  server.defaultNginxInstanceId = managedRuntime?.id || server.defaultNginxInstanceId || instances[0]?.id || 0;
  return server;
}

/**
 * 转换部署目标数据
 * @param {Object} row - 数据库行
 * @returns {Object} 部署目标数据
 */
function mapTarget(row) {
  if (!row) return null;
  const serverHost = row.deploy_server_host || '';
  const backendPort = Number(row.server_port || 0);
  return {
    id: row.id,
    teamId: row.team_id || 'legacy-team',
    projectId: row.project_id,
    projectSource: row.project_source || 'ops',
    projectName: row.project_name,
    projectDescription: row.project_description || '',
    projectPath: row.project_path,
    repositoryUrl: row.repository_url,
    defaultBranch: row.default_branch || 'dev',
    envName: row.env_name,
    serverId: row.server_id,
    serverName: row.deploy_server_name || '',
    serverHost,
    deployRoot: row.deploy_root,
    nginxConfPath: row.nginx_conf_path,
    nginxSiteManaged: Boolean(row.nginx_site_managed),
    nginxInstanceId: Number(row.nginx_instance_id || 0),
    nginxInstanceName: row.nginx_instance_name || '',
    nginxInstanceType: row.nginx_instance_type || '',
    listenPort: Number(row.listen_port || 0),
    nginxServerName: row.server_name || '',
    enableNginxTest: Boolean(row.enable_nginx_test),
    enableNginxReload: Boolean(row.enable_nginx_reload),
    installCommand: row.install_command,
    buildCommand: row.build_command,
    artifactDir: row.artifact_dir,
    preserveSubDirs: row.preserve_sub_dirs || '',
    uploadStrategy: row.upload_strategy || 'overlayKeepAssets',
    visitUrl: row.visit_url || '',
    remark: row.remark || '',
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectType: row.project_type || 'frontend',
    jdkId: Number(row.jdk_id || 0),
    stopCommand: row.stop_command || '',
    startCommand: row.start_command || '',
    healthCheckUrl: row.health_check_url || '',
    serviceRole: row.service_role || 'application',
    environmentId: Number(row.environment_id || 0),
    environmentName: row.environment_name || '',
    serviceName: row.service_name || normalizeBackendServiceName(row.project_name),
    buildJdkId: Number(row.build_jdk_id || row.jdk_id || 0),
    requiredJdkAlias: row.required_jdk_alias || '',
    serverJavaRuntimeId: Number(row.server_java_runtime_id || 0),
    runtimeJavaHome: row.runtime_java_home || '',
    runtimeJavaVersion: row.runtime_java_version || '',
    serverPort: backendPort,
    springProfiles: row.spring_profiles || '',
    externalConfigPath: row.external_config_path || '',
    jvmOptions: row.jvm_options || '',
    appArgs: row.app_args || '',
    processMode: row.process_mode || 'pid',
    stopTimeoutSeconds: Number(row.stop_timeout_seconds || 30),
    startupTimeoutSeconds: Number(row.startup_timeout_seconds || 120),
    healthCheckPath: row.health_check_path || normalizeHealthCheckPath(row.health_check_url || '/actuator/health'),
    nacosServerAddr: row.nacos_server_addr || row.environment_nacos_server_addr || '',
    nacosConsoleUrl: row.nacos_console_url || row.environment_nacos_console_url || '',
    nacosNamespace: row.nacos_namespace || row.environment_nacos_namespace || '',
    nacosGroup: row.nacos_group || row.environment_nacos_group || '',
    nacosStatus: row.environment_status || (row.nacos_server_addr ? 'unknown' : 'unconfigured'),
    requireNacosRegistration: Boolean(row.require_nacos_registration),
    gatewayUrl: row.gateway_url || row.environment_gateway_public_url || '',
    gatewayProbePath: row.gateway_probe_path || '',
    artifactPattern: row.artifact_pattern || row.artifact_dir || '',
    openapiCommand: row.openapi_command || '',
    openapiOutputPath: row.openapi_output_path || '',
    legacyStartCommand: row.legacy_start_command || row.start_command || '',
    legacyStopCommand: row.legacy_stop_command || row.stop_command || '',
    needsReview: Boolean(row.needs_review),
    serviceStatus: row.service_status || 'unknown',
    serviceStatusOutput: row.last_status_output || '',
    serviceStatusAt: row.last_status_at || '',
    directUrl: serverHost && backendPort ? `http://${serverHost}:${backendPort}` : '',
  };
}

/**
 * 转换发布记录数据
 * @param {Object} row - 数据库行
 * @param {Object} options - 转换选项
 * @returns {Object} 发布记录数据
 */
function mapRecord(row, options = {}) {
  if (!row) return null;
  const includeLogs = options.includeLogs !== false;
  const action = resolveRecordAction(row);
  return {
    id: row.id,
    teamId: row.team_id || 'legacy-team',
    targetId: row.target_id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectType: row.project_type || 'frontend',
    projectPath: row.project_path || '',
    repositoryUrl: row.repository_url || '',
    envName: row.env_name,
    branch: row.branch,
    commitSha: row.commit_sha || '',
    commitMessage: row.commit_message || '',
    commitAuthor: row.commit_author || '',
    status: row.status,
    releasePath: row.release_path || '',
    backupPath: row.backup_path || '',
    action,
    sourceRecordId: normalizeRecordId(row.source_record_id),
    restoredRecordId: normalizeRecordId(row.restored_record_id),
    backupRecordId: normalizeRecordId(row.backup_record_id),
    isCurrentVersion: false,
    canRollback: false,
    canUndoRollback: false,
    logs: includeLogs ? parseJson(row.logs, []) : [],
    logPath: row.log_path || '',
    operator: row.operator || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at || '',
    createdAt: row.created_at,
  };
}

/**
 * 构建外部 Nginx 实例保存字段。
 * @param {Object} server - 服务器行
 * @returns {Object} 实例字段
 */
function createExternalInstanceFromServer(server) {
  return {
    name: DEFAULT_EXTERNAL_NGINX_INSTANCE_NAME,
    instanceType: 'external',
    defaultDeployRoot: server.default_deploy_root || '/data/webapps/{appName}',
    defaultNginxConfPath: server.default_nginx_conf_path || '/etc/nginx/conf.d/{appName}.conf',
    nginxWorkDir: server.nginx_work_dir || '',
    nginxTestCommand: server.nginx_test_command || 'nginx -t',
    nginxReloadCommand: server.nginx_reload_command || 'nginx -s reload',
    baseRoot: '',
    nginxRoot: '',
    htmlRoot: '',
    sitesDir: '',
    logsDir: '',
    scriptPath: '',
    portStart: 8080,
    useSudo: Boolean(server.use_sudo),
    status: 'unknown',
  };
}

/**
 * 构建托管 Nginx 实例保存字段。
 * @param {Object} runtime - 旧托管运行时行
 * @returns {Object} 实例字段
 */
function createManagedInstanceFromRuntime(runtime) {
  const paths = deriveNginxRuntimePaths(runtime.base_root || DEFAULT_NGINX_RUNTIME_BASE_ROOT);
  const scriptPath = runtime.script_path || paths.scriptPath;
  const htmlRoot = runtime.html_root || paths.htmlRoot;
  return {
    name: DEFAULT_MANAGED_NGINX_INSTANCE_NAME,
    instanceType: 'managed',
    defaultDeployRoot: htmlRoot,
    defaultNginxConfPath: getManagedMainConfPath({ ...paths, nginxRoot: runtime.nginx_root || paths.nginxRoot }),
    nginxWorkDir: '',
    nginxTestCommand: `${scriptPath} test`,
    nginxReloadCommand: `${scriptPath} reload`,
    baseRoot: runtime.base_root || paths.baseRoot,
    nginxRoot: runtime.nginx_root || paths.nginxRoot,
    htmlRoot,
    sitesDir: runtime.sites_dir || paths.sitesDir,
    logsDir: runtime.logs_dir || paths.logsDir,
    scriptPath,
    portStart: Number(runtime.port_start || 8080),
    useSudo: Boolean(runtime.use_sudo),
    runtimeVersion: runtime.runtime_version || '',
    packageSha256: runtime.package_sha256 || '',
    packageVariant: runtime.package_variant || '',
    status: runtime.status || 'unknown',
    statusOutput: runtime.status_output || '',
    initializedAt: runtime.initialized_at || '',
  };
}

/**
 * 插入 Nginx 实例。
 * @param {DatabaseSync} db - 数据库实例
 * @param {number} serverId - 服务器 ID
 * @param {Object} payload - 实例参数
 * @returns {number} 实例 ID
 */
function insertNginxInstance(db, serverId, payload) {
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO nginx_instances
       (server_id, name, instance_type, default_deploy_root, default_nginx_conf_path, nginx_work_dir,
        nginx_test_command, nginx_reload_command, base_root, nginx_root, html_root, sites_dir, logs_dir,
        script_path, port_start, use_sudo, runtime_version, package_sha256, package_variant, status,
        status_output, initialized_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(serverId),
      payload.name || DEFAULT_EXTERNAL_NGINX_INSTANCE_NAME,
      NGINX_INSTANCE_TYPES.has(payload.instanceType) ? payload.instanceType : 'external',
      payload.defaultDeployRoot || '',
      payload.defaultNginxConfPath || '',
      payload.nginxWorkDir || '',
      payload.nginxTestCommand || 'nginx -t',
      payload.nginxReloadCommand || 'nginx -s reload',
      payload.baseRoot || '',
      payload.nginxRoot || '',
      payload.htmlRoot || '',
      payload.sitesDir || '',
      payload.logsDir || '',
      payload.scriptPath || '',
      Number(payload.portStart || 8080),
      payload.useSudo ? 1 : 0,
      payload.runtimeVersion || '',
      payload.packageSha256 || '',
      payload.packageVariant || '',
      payload.status || 'unknown',
      payload.statusOutput || '',
      payload.initializedAt || null,
      ts,
      ts
    );
  return Number(result.lastInsertRowid);
}

/**
 * 将旧服务器级 Nginx 配置迁移为实例模型，并补齐目标绑定。
 * @param {DatabaseSync} db - 数据库实例
 */
function migrateLegacyNginxInstances(db) {
  const servers = db.prepare('SELECT * FROM deploy_servers').all();
  for (const server of servers) {
    const externalInstance =
      db
        .prepare("SELECT * FROM nginx_instances WHERE server_id = ? AND instance_type = 'external' AND name = ? LIMIT 1")
        .get(server.id, DEFAULT_EXTERNAL_NGINX_INSTANCE_NAME) || null;

    const runtime = db.prepare('SELECT * FROM nginx_runtimes WHERE server_id = ? LIMIT 1').get(server.id);
    let managedInstance = null;
    if (runtime) {
      managedInstance =
        db
          .prepare("SELECT * FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' AND base_root = ? LIMIT 1")
          .get(server.id, runtime.base_root || DEFAULT_NGINX_RUNTIME_BASE_ROOT) ||
        (() => {
          const id = insertNginxInstance(db, server.id, createManagedInstanceFromRuntime(runtime));
          return db.prepare('SELECT * FROM nginx_instances WHERE id = ?').get(id);
        })();
    }

    const defaultInstanceId = managedInstance?.id || externalInstance?.id || 0;
    if ((managedInstance?.id && Number(server.default_nginx_instance_id || 0) !== Number(managedInstance.id)) || (!Number(server.default_nginx_instance_id || 0) && defaultInstanceId)) {
      db.prepare('UPDATE deploy_servers SET default_nginx_instance_id = ? WHERE id = ?').run(defaultInstanceId, server.id);
    }

    const targets = db.prepare('SELECT id, nginx_site_managed FROM deploy_targets WHERE server_id = ? AND COALESCE(nginx_instance_id, 0) = 0').all(server.id);
    for (const target of targets) {
      const instanceId = target.nginx_site_managed && managedInstance?.id ? managedInstance.id : externalInstance?.id || managedInstance?.id || 0;
      if (instanceId) {
        db.prepare('UPDATE deploy_targets SET nginx_instance_id = ? WHERE id = ?').run(instanceId, target.id);
      }
    }
  }
}

/**
 * 在首次后端架构迁移前备份 SQLite 文件。
 * @param {DatabaseSync} db 数据库实例
 * @returns {Promise<string>} 备份文件路径，无需备份时为空
 */
async function backupDeployDbBeforeBackendMigration(db) {
  const migrated = hasTable(db, 'schema_migrations')
    ? Boolean(db.prepare("SELECT version FROM schema_migrations WHERE version = 3").get())
    : false;
  if (migrated) return '';
  const stat = await fs.stat(DEPLOY_DB_PATH).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) return '';
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupPath = `${DEPLOY_DB_PATH}.pre-backend-v3-${timestamp}.bak`;
  await fs.copyFile(DEPLOY_DB_PATH, backupPath);
  return backupPath;
}

/**
 * 在首次多租户迁移前备份中央 SQLite，重复启动不会重复备份。
 * @param {DatabaseSync} db 数据库实例
 * @returns {Promise<string>} 备份文件路径，无需备份时为空
 */
async function backupDeployDbBeforeMultiTenantMigration(db) {
  const migrated = hasTable(db, 'schema_migrations')
    ? Boolean(db.prepare('SELECT version FROM schema_migrations WHERE version = 5').get())
    : false;
  if (migrated) return '';
  const stat = await fs.stat(DEPLOY_DB_PATH).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) return '';
  const existing = (await fs.readdir(path.dirname(DEPLOY_DB_PATH)).catch(() => []))
    .find((name) => name.startsWith(`${path.basename(DEPLOY_DB_PATH)}.pre-multitenant-v5-`) && name.endsWith('.bak'));
  if (existing) return path.join(path.dirname(DEPLOY_DB_PATH), existing);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupPath = `${DEPLOY_DB_PATH}.pre-multitenant-v5-${timestamp}.bak`;
  await fs.copyFile(DEPLOY_DB_PATH, backupPath);
  return backupPath;
}

/**
 * 在首次共享中央部署工作区迁移前备份 SQLite，重复启动复用已有备份。
 * @param {DatabaseSync} db 数据库实例
 * @returns {Promise<string>} 备份文件路径，无需备份时为空
 */
async function backupDeployDbBeforeSharedWorkspaceMigration(db) {
  const migrated = hasTable(db, 'schema_migrations')
    ? Boolean(db.prepare('SELECT version FROM schema_migrations WHERE version = 6').get())
    : false;
  if (migrated) return '';
  const stat = await fs.stat(DEPLOY_DB_PATH).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) return '';
  const existing = (await fs.readdir(path.dirname(DEPLOY_DB_PATH)).catch(() => []))
    .find((name) => name.startsWith(`${path.basename(DEPLOY_DB_PATH)}.pre-shared-workspace-v6-`) && name.endsWith('.bak'));
  if (existing) return path.join(path.dirname(DEPLOY_DB_PATH), existing);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupPath = `${DEPLOY_DB_PATH}.pre-shared-workspace-v6-${timestamp}.bak`;
  await fs.copyFile(DEPLOY_DB_PATH, backupPath);
  return backupPath;
}

/**
 * 将已存在的后端部署目标迁入一对一配置表。
 * @param {DatabaseSync} db 数据库实例
 */
function migrateLegacyBackendTargets(db) {
  const targets = db.prepare("SELECT * FROM deploy_targets WHERE project_type = 'backend'").all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO backend_target_configs
     (target_id, service_role, service_name, build_jdk_id, runtime_java_home, runtime_java_version, server_port,
      spring_profiles, external_config_path, jvm_options, app_args, process_mode, stop_timeout_seconds,
      startup_timeout_seconds, health_check_path, nacos_server_addr, nacos_console_url, nacos_namespace,
      nacos_group, gateway_url, gateway_probe_path, artifact_pattern, openapi_command, openapi_output_path,
      legacy_start_command, legacy_stop_command, needs_review, service_status, last_status_output,
      last_status_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const target of targets) {
    let port = 0;
    try {
      port = Number(new URL(String(target.health_check_url || '')).port || 0);
    } catch {}
    const legacyStart = String(target.start_command || '').trim();
    const legacyStop = String(target.stop_command || '').trim();
    const ts = target.updated_at || target.created_at || now();
    insert.run(
      target.id,
      'application',
      normalizeBackendServiceName(target.project_name),
      Number(target.jdk_id || 0) || null,
      '',
      '',
      port || null,
      '',
      '',
      '',
      '',
      legacyStart || legacyStop ? 'legacy' : 'pid',
      30,
      120,
      normalizeHealthCheckPath(target.health_check_url || '/actuator/health'),
      '',
      '',
      '',
      '',
      '',
      '',
      target.artifact_dir || '',
      '',
      '',
      legacyStart,
      legacyStop,
      legacyStart || legacyStop ? 1 : 0,
      'unknown',
      '',
      '',
      ts,
      ts
    );
  }
}

/**
 * 应用后端部署架构 v1 数据迁移。
 * @param {DatabaseSync} db 数据库实例
 */
function applyBackendSchemaMigration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backend_target_configs (
      target_id INTEGER PRIMARY KEY,
      environment_id INTEGER,
      service_role TEXT NOT NULL DEFAULT 'application',
      service_name TEXT NOT NULL,
      build_jdk_id INTEGER,
      server_java_runtime_id INTEGER,
      runtime_java_home TEXT,
      runtime_java_version TEXT,
      server_port INTEGER,
      spring_profiles TEXT,
      external_config_path TEXT,
      jvm_options TEXT,
      app_args TEXT,
      process_mode TEXT NOT NULL DEFAULT 'pid',
      stop_timeout_seconds INTEGER NOT NULL DEFAULT 30,
      startup_timeout_seconds INTEGER NOT NULL DEFAULT 120,
      health_check_path TEXT NOT NULL DEFAULT '/actuator/health',
      nacos_server_addr TEXT,
      nacos_console_url TEXT,
      nacos_namespace TEXT,
      nacos_group TEXT,
      require_nacos_registration INTEGER NOT NULL DEFAULT 0,
      gateway_url TEXT,
      gateway_probe_path TEXT,
      artifact_pattern TEXT NOT NULL,
      openapi_command TEXT,
      openapi_output_path TEXT,
      legacy_start_command TEXT,
      legacy_stop_command TEXT,
      needs_review INTEGER NOT NULL DEFAULT 0,
      service_status TEXT NOT NULL DEFAULT 'unknown',
      last_status_output TEXT,
      last_status_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(target_id) REFERENCES deploy_targets(id),
      FOREIGN KEY(server_java_runtime_id) REFERENCES server_java_runtimes(id)
    );

    CREATE TABLE IF NOT EXISTS server_java_runtimes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      home_path TEXT NOT NULL,
      java_version TEXT,
      major_version INTEGER,
      vendor TEXT,
      arch TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_output TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(server_id, home_path),
      FOREIGN KEY(server_id) REFERENCES deploy_servers(id)
    );

    CREATE TABLE IF NOT EXISTS deploy_environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      nacos_server_addr TEXT,
      nacos_console_url TEXT,
      nacos_namespace TEXT,
      nacos_group TEXT,
      encrypted_nacos_secret TEXT,
      gateway_target_id INTEGER,
      gateway_public_url TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_output TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backend_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      record_id INTEGER,
      release_name TEXT NOT NULL,
      release_dir TEXT NOT NULL,
      jar_name TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      commit_sha TEXT,
      status TEXT NOT NULL DEFAULT 'uploaded',
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      FOREIGN KEY(target_id) REFERENCES deploy_targets(id),
      FOREIGN KEY(record_id) REFERENCES deploy_records(id)
    );

    CREATE TABLE IF NOT EXISTS openapi_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      generated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(target_id) REFERENCES deploy_targets(id)
    );

    CREATE TABLE IF NOT EXISTS deploy_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      percent INTEGER NOT NULL DEFAULT 0,
      operator TEXT,
      log_path TEXT,
      result_ref TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(target_id) REFERENCES deploy_targets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_backend_releases_target_created ON backend_releases(target_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_openapi_target_commit ON openapi_artifacts(target_id, branch, commit_sha, generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deploy_tasks_target_started ON deploy_tasks(target_id, started_at DESC, id DESC);
  `);

  const jdkColumns = getTableColumns(db, 'build_jdks');
  if (!jdkColumns.includes('java_version')) db.exec('ALTER TABLE build_jdks ADD COLUMN java_version TEXT');
  if (!jdkColumns.includes('major_version')) db.exec('ALTER TABLE build_jdks ADD COLUMN major_version INTEGER');
  if (!jdkColumns.includes('vendor')) db.exec('ALTER TABLE build_jdks ADD COLUMN vendor TEXT');
  if (!jdkColumns.includes('arch')) db.exec('ALTER TABLE build_jdks ADD COLUMN arch TEXT');
  if (!jdkColumns.includes('status')) db.exec("ALTER TABLE build_jdks ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown'");
  if (!jdkColumns.includes('status_output')) db.exec('ALTER TABLE build_jdks ADD COLUMN status_output TEXT');
  if (!jdkColumns.includes('last_checked_at')) db.exec('ALTER TABLE build_jdks ADD COLUMN last_checked_at TEXT');

  const backendColumns = getTableColumns(db, 'backend_target_configs');
  if (!backendColumns.includes('environment_id')) db.exec('ALTER TABLE backend_target_configs ADD COLUMN environment_id INTEGER');
  if (!backendColumns.includes('require_nacos_registration')) db.exec('ALTER TABLE backend_target_configs ADD COLUMN require_nacos_registration INTEGER NOT NULL DEFAULT 0');
  if (!backendColumns.includes('server_java_runtime_id')) db.exec('ALTER TABLE backend_target_configs ADD COLUMN server_java_runtime_id INTEGER');
  if (!backendColumns.includes('required_jdk_alias')) {
    db.exec('ALTER TABLE backend_target_configs ADD COLUMN required_jdk_alias TEXT');
    try {
      db.exec(`
        UPDATE backend_target_configs
        SET required_jdk_alias = (
          SELECT name FROM build_jdks WHERE build_jdks.id = backend_target_configs.build_jdk_id
        )
        WHERE build_jdk_id IS NOT NULL AND required_jdk_alias IS NULL
      `);
    } catch (e) {
      console.warn('[Migration] 升级 required_jdk_alias 初始数据失败:', e);
    }
  }

  migrateLegacyBackendTargets(db);
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)').run('backend-deployment-v1', now());
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, ?, ?)').run('backend-environments-and-server-root-v2', now());
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, ?, ?)').run('backend-runtime-jdk-reference-v3', now());
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (4, ?, ?)').run('backend-logical-jdk-alias-v4', now());
}

/**
 * 为全部部署领域表增加账号隔离边界，并使用当前请求上下文填充新记录。
 * @param {DatabaseSync} db 数据库实例
 */
function applyMultiTenantSchemaMigration(db) {
  const tables = [
    'deploy_servers',
    'nginx_runtimes',
    'nginx_instances',
    'build_jdks',
    'deploy_targets',
    'deploy_records',
    'backend_target_configs',
    'server_java_runtimes',
    'deploy_environments',
    'backend_releases',
    'openapi_artifacts',
    'deploy_tasks',
  ];
  for (const tableName of tables) {
    if (!hasTable(db, tableName)) continue;
    if (!getTableColumns(db, tableName).includes('team_id')) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN team_id TEXT NOT NULL DEFAULT 'legacy-team'`);
    }
    const primaryColumn = tableName === 'backend_target_configs' ? 'target_id' : 'id';
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${tableName}_team ON ${tableName}(team_id, ${primaryColumn})`);
    db.exec(`DROP TRIGGER IF EXISTS trg_${tableName}_assign_team`);
  }
  const inheritedTeamTriggers = [
    ['nginx_runtimes', 'id', 'server_id', 'deploy_servers'],
    ['nginx_instances', 'id', 'server_id', 'deploy_servers'],
    ['deploy_targets', 'id', 'server_id', 'deploy_servers'],
    ['server_java_runtimes', 'id', 'server_id', 'deploy_servers'],
    ['deploy_records', 'id', 'target_id', 'deploy_targets'],
    ['backend_target_configs', 'target_id', 'target_id', 'deploy_targets'],
    ['backend_releases', 'id', 'target_id', 'deploy_targets'],
    ['openapi_artifacts', 'id', 'target_id', 'deploy_targets'],
    ['deploy_tasks', 'id', 'target_id', 'deploy_targets'],
  ];
  for (const [tableName, primaryColumn, foreignColumn, parentTable] of inheritedTeamTriggers) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${tableName}_inherit_team
      AFTER INSERT ON ${tableName}
      BEGIN
        UPDATE ${tableName}
        SET team_id = (SELECT team_id FROM ${parentTable} WHERE id = NEW.${foreignColumn})
        WHERE ${primaryColumn} = NEW.${primaryColumn};
      END
    `);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (5, ?, ?)')
    .run('multi-user-team-boundary-v5', now());
}

/**
 * 规范化每个团队的服务器排序值，兼容升级前没有排序字段的历史数据。
 * @param {DatabaseSync} db 数据库实例
 * @param {boolean} manageTransaction 是否由当前方法管理事务
 */
function normalizeServerSortOrder(db, manageTransaction = true) {
  const rows = db
    .prepare(
      `SELECT id, team_id
       FROM deploy_servers
       ORDER BY team_id ASC,
                CASE WHEN sort_order > 0 THEN 0 ELSE 1 END ASC,
                sort_order ASC,
                updated_at DESC,
                id DESC`
    )
    .all();
  if (!rows.length) return;

  const update = db.prepare('UPDATE deploy_servers SET sort_order = ? WHERE id = ? AND team_id = ?');
  let activeTeamId = '';
  let sortOrder = 0;
  if (manageTransaction) db.exec('BEGIN');
  try {
    rows.forEach((row) => {
      if (row.team_id !== activeTeamId) {
        activeTeamId = row.team_id;
        sortOrder = 0;
      }
      sortOrder += 1;
      update.run(sortOrder, Number(row.id), row.team_id);
    });
    if (manageTransaction) db.exec('COMMIT');
  } catch (error) {
    if (manageTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 原子合并历史账号部署空间，并将绑定 teamId 的凭据换绑到共享工作区。
 * @param {DatabaseSync} db 数据库实例
 * @returns {{ migratedRows: Record<string, number>; reencryptedCredentials: number }} 迁移统计
 */
function applySharedDeployWorkspaceMigration(db) {
  const migratedRows = {};
  let reencryptedCredentials = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const serverRows = db
      .prepare('SELECT id, team_id, encrypted_secret FROM deploy_servers WHERE team_id <> ?')
      .all(SHARED_DEPLOY_WORKSPACE_ID);
    const updateServerCredential = db.prepare(
      'UPDATE deploy_servers SET encrypted_secret = ? WHERE id = ? AND team_id = ?',
    );
    for (const row of serverRows) {
      const credential = decryptCredential(row.encrypted_secret, row.team_id);
      updateServerCredential.run(
        encryptCredential(credential, SHARED_DEPLOY_WORKSPACE_ID),
        Number(row.id),
        row.team_id,
      );
      reencryptedCredentials += 1;
    }

    const environmentRows = db
      .prepare('SELECT id, team_id, encrypted_nacos_secret FROM deploy_environments WHERE team_id <> ?')
      .all(SHARED_DEPLOY_WORKSPACE_ID);
    const updateEnvironmentCredential = db.prepare(
      'UPDATE deploy_environments SET encrypted_nacos_secret = ? WHERE id = ? AND team_id = ?',
    );
    for (const row of environmentRows) {
      if (!row.encrypted_nacos_secret) continue;
      const credential = decryptCredential(row.encrypted_nacos_secret, row.team_id);
      updateEnvironmentCredential.run(
        encryptCredential(credential, SHARED_DEPLOY_WORKSPACE_ID),
        Number(row.id),
        row.team_id,
      );
      reencryptedCredentials += 1;
    }

    if (hasTable(db, 'backend_target_configs')) {
      db.exec(`
        UPDATE backend_target_configs
        SET required_jdk_alias = COALESCE(
              NULLIF(required_jdk_alias, ''),
              (SELECT name FROM build_jdks WHERE build_jdks.id = backend_target_configs.build_jdk_id),
              ''
            ),
            build_jdk_id = NULL
        WHERE build_jdk_id IS NOT NULL
      `);
    }
    if (hasTable(db, 'deploy_targets') && getTableColumns(db, 'deploy_targets').includes('jdk_id')) {
      db.prepare('UPDATE deploy_targets SET jdk_id = NULL WHERE jdk_id IS NOT NULL').run();
    }

    for (const tableName of SHARED_DEPLOY_WORKSPACE_TABLES) {
      if (!hasTable(db, tableName) || !getTableColumns(db, tableName).includes('team_id')) continue;
      const result = db.prepare(`UPDATE ${tableName} SET team_id = ? WHERE team_id <> ?`)
        .run(SHARED_DEPLOY_WORKSPACE_ID, SHARED_DEPLOY_WORKSPACE_ID);
      migratedRows[tableName] = Number(result.changes || 0);
    }
    if (hasTable(db, 'central_target_locks')) {
      db.prepare('DELETE FROM central_target_locks').run();
    }
    normalizeServerSortOrder(db, false);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (6, ?, ?)')
      .run('shared-central-deploy-workspace-v6', now());
    db.exec('COMMIT');
    return { migratedRows, reencryptedCredentials };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 收口上一个服务进程遗留的运行态任务和发布记录。
 * @description 进程退出后内存任务无法恢复，若不主动收口，发布历史和中央操作会永久显示执行中。
 * @param {DatabaseSync} db 数据库实例
 * @returns {Promise<void>}
 */
async function reconcileInterruptedDeployExecutions(db) {
  const interruptedAt = now();
  const runningRecords = db
    .prepare("SELECT id, logs, log_path FROM deploy_records WHERE status = 'running'")
    .all();

  for (const row of runningRecords) {
    const storedLogs = await readRecordLogs(row);
    const logs = Array.isArray(storedLogs) ? storedLogs : [];
    logs.push({
      level: 'warn',
      message: DEPLOY_INTERRUPTED_LOG_MESSAGE,
      stage: 'interrupted',
      timestamp: interruptedAt,
    });

    let logPath = row.log_path || '';
    let inlineLogs = JSON.stringify(logs);
    try {
      logPath = await writeRecordLogs(row.id, logs);
      inlineLogs = '[]';
    } catch (error) {
      console.warn(`[deploy-store] 写入中断发布记录 #${row.id} 的恢复日志失败:`, error);
    }

    db.prepare(
      `UPDATE deploy_records
       SET status = 'stopped', logs = ?, log_path = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`
    ).run(inlineLogs, logPath, interruptedAt, Number(row.id));
  }

  db.prepare(
    `UPDATE deploy_tasks
     SET status = 'interrupted', error = ?, heartbeat_at = ?, finished_at = ?
     WHERE status = 'running'`
  ).run(DEPLOY_INTERRUPTED_LOG_MESSAGE, interruptedAt, interruptedAt);

  db.prepare(
    `UPDATE backend_target_configs
     SET service_status = 'unknown', last_status_output = ?, last_status_at = ?, updated_at = ?
     WHERE service_status IN ('deploying', 'starting', 'stopping')`
  ).run(DEPLOY_INTERRUPTED_LOG_MESSAGE, interruptedAt, interruptedAt);

  if (hasTable(db, 'artifact_jobs')) {
    if (hasTable(db, 'central_agent_operations')) {
      db.prepare(
        `UPDATE central_agent_operations
         SET status = 'failed', error_json = ?, updated_at = ?
         WHERE id IN (
           SELECT operation_id FROM artifact_jobs WHERE status IN ('queued', 'running')
         ) AND status IN ('queued', 'running')`
      ).run(CENTRAL_DEPLOY_INTERRUPTED_ERROR, interruptedAt);
    }

    db.prepare(
      `UPDATE artifact_jobs
       SET status = 'failed', error_json = ?, updated_at = ?
       WHERE status IN ('queued', 'running')`
    ).run(CENTRAL_DEPLOY_INTERRUPTED_ERROR, interruptedAt);
  }
}

/**
 * 获取数据库实例
 * @returns {DatabaseSync} SQLite 数据库实例
 */
export async function getDeployDb() {
  if (dbInstance) return dbInstance;
  await fs.mkdir(DEPLOY_DATA_DIR, { recursive: true });
  dbInstance = new DatabaseSync(DEPLOY_DB_PATH);
  await backupDeployDbBeforeBackendMigration(dbInstance);
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS deploy_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL,
      use_sudo INTEGER NOT NULL DEFAULT 0,
      default_deploy_root TEXT,
      default_backend_root TEXT,
      default_nginx_conf_path TEXT,
      nginx_work_dir TEXT,
      nginx_test_command TEXT,
      nginx_reload_command TEXT,
      default_nginx_instance_id INTEGER,
      remark TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nginx_runtimes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL UNIQUE,
      base_root TEXT NOT NULL,
      nginx_root TEXT NOT NULL,
      html_root TEXT NOT NULL,
      sites_dir TEXT NOT NULL,
      logs_dir TEXT NOT NULL,
      script_path TEXT NOT NULL,
      port_start INTEGER NOT NULL DEFAULT 8080,
      use_sudo INTEGER NOT NULL DEFAULT 0,
      runtime_version TEXT,
      package_sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_output TEXT,
      initialized_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(server_id) REFERENCES deploy_servers(id)
    );

    CREATE TABLE IF NOT EXISTS nginx_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      instance_type TEXT NOT NULL DEFAULT 'external',
      default_deploy_root TEXT,
      default_nginx_conf_path TEXT,
      nginx_work_dir TEXT,
      nginx_test_command TEXT,
      nginx_reload_command TEXT,
      base_root TEXT,
      nginx_root TEXT,
      html_root TEXT,
      sites_dir TEXT,
      logs_dir TEXT,
      script_path TEXT,
      port_start INTEGER NOT NULL DEFAULT 8080,
      use_sudo INTEGER NOT NULL DEFAULT 0,
      runtime_version TEXT,
      package_sha256 TEXT,
      package_variant TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_output TEXT,
      initialized_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(server_id) REFERENCES deploy_servers(id)
    );

    CREATE TABLE IF NOT EXISTS build_jdks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      home_path TEXT NOT NULL,
      java_version TEXT,
      major_version INTEGER,
      vendor TEXT,
      arch TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      status_output TEXT,
      last_checked_at TEXT,
      remark TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deploy_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      project_source TEXT NOT NULL DEFAULT 'ops',
      project_name TEXT NOT NULL,
      project_description TEXT,
      project_path TEXT NOT NULL,
      repository_url TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'dev',
      env_name TEXT NOT NULL,
      server_id INTEGER NOT NULL,
      nginx_instance_id INTEGER,
      deploy_root TEXT NOT NULL,
      nginx_conf_path TEXT NOT NULL,
      nginx_site_managed INTEGER NOT NULL DEFAULT 0,
      listen_port INTEGER,
      server_name TEXT,
      enable_nginx_test INTEGER NOT NULL DEFAULT 0,
      enable_nginx_reload INTEGER NOT NULL DEFAULT 0,
      install_command TEXT NOT NULL,
      build_command TEXT NOT NULL,
      artifact_dir TEXT NOT NULL DEFAULT 'dist',
      preserve_sub_dirs TEXT NOT NULL DEFAULT '',
      upload_strategy TEXT NOT NULL DEFAULT 'overlayKeepAssets',
      visit_url TEXT,
      remark TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      project_type TEXT NOT NULL DEFAULT 'frontend',
      jdk_id INTEGER,
      stop_command TEXT,
      start_command TEXT,
      health_check_url TEXT,
      FOREIGN KEY(server_id) REFERENCES deploy_servers(id)
    );

    CREATE TABLE IF NOT EXISTS deploy_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      project_name TEXT NOT NULL,
      env_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT,
      commit_message TEXT,
      commit_author TEXT,
      status TEXT NOT NULL,
      release_path TEXT,
      backup_path TEXT,
      action TEXT NOT NULL DEFAULT 'deploy',
      source_record_id INTEGER,
      restored_record_id INTEGER,
      backup_record_id INTEGER,
      logs TEXT NOT NULL DEFAULT '[]',
      log_path TEXT,
      operator TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(target_id) REFERENCES deploy_targets(id)
    );

    CREATE INDEX IF NOT EXISTS idx_deploy_records_project_started ON deploy_records(project_id, started_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_deploy_records_target_started ON deploy_records(target_id, started_at DESC, id DESC);
  `);
  const serverColumns = getTableColumns(dbInstance, 'deploy_servers');
  if (!serverColumns.includes('default_deploy_root')) {
    dbInstance.exec('ALTER TABLE deploy_servers ADD COLUMN default_deploy_root TEXT');
  }
  if (!serverColumns.includes('default_backend_root')) {
    dbInstance.exec('ALTER TABLE deploy_servers ADD COLUMN default_backend_root TEXT');
  }
  if (!serverColumns.includes('default_nginx_conf_path')) {
    dbInstance.exec('ALTER TABLE deploy_servers ADD COLUMN default_nginx_conf_path TEXT');
  }
  if (!serverColumns.includes('nginx_work_dir')) {
    dbInstance.exec('ALTER TABLE deploy_servers ADD COLUMN nginx_work_dir TEXT');
  }
  if (!serverColumns.includes('nginx_test_command')) {
    dbInstance.exec("ALTER TABLE deploy_servers ADD COLUMN nginx_test_command TEXT DEFAULT 'nginx -t'");
  }
  if (!serverColumns.includes('nginx_reload_command')) {
    dbInstance.exec("ALTER TABLE deploy_servers ADD COLUMN nginx_reload_command TEXT DEFAULT 'nginx -s reload'");
  }
  if (!serverColumns.includes('default_nginx_instance_id')) {
    dbInstance.exec('ALTER TABLE deploy_servers ADD COLUMN default_nginx_instance_id INTEGER');
  }
  if (!serverColumns.includes('sort_order')) {
    dbInstance.exec('ALTER TABLE deploy_servers ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  }
  const targetColumns = getTableColumns(dbInstance, 'deploy_targets');
  if (!targetColumns.includes('project_description')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN project_description TEXT');
  }
  if (!targetColumns.includes('project_source')) {
    dbInstance.exec("ALTER TABLE deploy_targets ADD COLUMN project_source TEXT NOT NULL DEFAULT 'ops'");
  }
  if (!targetColumns.includes('enable_nginx_test')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN enable_nginx_test INTEGER NOT NULL DEFAULT 0');
  }
  if (!targetColumns.includes('enable_nginx_reload')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN enable_nginx_reload INTEGER NOT NULL DEFAULT 0');
  }
  if (!targetColumns.includes('preserve_sub_dirs')) {
    dbInstance.exec("ALTER TABLE deploy_targets ADD COLUMN preserve_sub_dirs TEXT NOT NULL DEFAULT ''");
  }
  if (!targetColumns.includes('upload_strategy')) {
    dbInstance.exec("ALTER TABLE deploy_targets ADD COLUMN upload_strategy TEXT NOT NULL DEFAULT 'overlayKeepAssets'");
  }
  if (!targetColumns.includes('nginx_site_managed')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN nginx_site_managed INTEGER NOT NULL DEFAULT 0');
  }
  if (!targetColumns.includes('listen_port')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN listen_port INTEGER');
  }
  if (!targetColumns.includes('server_name')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN server_name TEXT');
  }
  if (!targetColumns.includes('nginx_instance_id')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN nginx_instance_id INTEGER');
  }
  if (!targetColumns.includes('remark')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN remark TEXT');
  }
  if (!targetColumns.includes('project_type')) {
    dbInstance.exec("ALTER TABLE deploy_targets ADD COLUMN project_type TEXT NOT NULL DEFAULT 'frontend'");
  }
  if (!targetColumns.includes('jdk_id')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN jdk_id INTEGER');
  }
  if (!targetColumns.includes('stop_command')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN stop_command TEXT');
  }
  if (!targetColumns.includes('start_command')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN start_command TEXT');
  }
  if (!targetColumns.includes('health_check_url')) {
    dbInstance.exec('ALTER TABLE deploy_targets ADD COLUMN health_check_url TEXT');
  }
  const runtimeColumns = getTableColumns(dbInstance, 'nginx_runtimes');
  if (!runtimeColumns.includes('package_variant')) {
    dbInstance.exec('ALTER TABLE nginx_runtimes ADD COLUMN package_variant TEXT');
  }
  migrateLegacyNginxInstances(dbInstance);
  const recordColumns = getTableColumns(dbInstance, 'deploy_records');
  if (!recordColumns.includes('log_path')) {
    dbInstance.exec('ALTER TABLE deploy_records ADD COLUMN log_path TEXT');
  }
  if (!recordColumns.includes('commit_message')) {
    dbInstance.exec('ALTER TABLE deploy_records ADD COLUMN commit_message TEXT');
  }
  if (!recordColumns.includes('commit_author')) {
    dbInstance.exec('ALTER TABLE deploy_records ADD COLUMN commit_author TEXT');
  }
  const hadRecordActionColumn = recordColumns.includes('action');
  if (!hadRecordActionColumn) {
    dbInstance.exec("ALTER TABLE deploy_records ADD COLUMN action TEXT NOT NULL DEFAULT 'deploy'");
  }
  if (!recordColumns.includes('source_record_id')) {
    dbInstance.exec('ALTER TABLE deploy_records ADD COLUMN source_record_id INTEGER');
  }
  if (!recordColumns.includes('restored_record_id')) {
    dbInstance.exec('ALTER TABLE deploy_records ADD COLUMN restored_record_id INTEGER');
  }
  if (!recordColumns.includes('backup_record_id')) {
    dbInstance.exec('ALTER TABLE deploy_records ADD COLUMN backup_record_id INTEGER');
  }
  normalizeDeployRecordVersionFields(dbInstance, { inferLegacyAction: !hadRecordActionColumn });
  applyBackendSchemaMigration(dbInstance);
  await backupDeployDbBeforeMultiTenantMigration(dbInstance);
  applyMultiTenantSchemaMigration(dbInstance);
  normalizeServerSortOrder(dbInstance);
  await reconcileInterruptedDeployExecutions(dbInstance);
  initializeDefaultJdks(dbInstance);
  return dbInstance;
}

/**
 * 将中央数据库升级为全员共享部署工作区。
 * @description 该方法必须只由独立中央服务启动流程调用；Tauri 本地辅助数据库不得执行。
 * @returns {Promise<{ migrated: boolean; backupPath: string; migratedRows: Record<string, number>; reencryptedCredentials: number }>} 迁移结果
 */
export async function migrateCentralDeployWorkspace() {
  const db = await getDeployDb();
  const migrated = Boolean(db.prepare('SELECT version FROM schema_migrations WHERE version = 6').get());
  if (migrated) {
    return { migrated: false, backupPath: '', migratedRows: {}, reencryptedCredentials: 0 };
  }
  const backupPath = await backupDeployDbBeforeSharedWorkspaceMigration(db);
  try {
    const result = applySharedDeployWorkspaceMigration(db);
    return { migrated: true, backupPath, ...result };
  } catch (cause) {
    const error = new Error(`中央共享部署数据迁移失败，已回滚且禁止启动：${cause instanceof Error ? cause.message : String(cause)}`);
    error.cause = cause;
    throw error;
  }
}

/**
 * 在 JDK 表为空时，自动扫描并填充当前操作系统的 JDK 配置
 * @param {any} db - 数据库实例
 */
function initializeDefaultJdks(db) {
  try {
    const jdksCount = db.prepare('SELECT count(*) as count FROM build_jdks').get().count;
    if (jdksCount > 0) return;

    const paths = [];
    if (process.platform === 'darwin') {
      try {
        const output = execSync('/usr/libexec/java_home -V 2>&1', { encoding: 'utf8' });
        const lines = output.split('\n');
        const seen = new Set();
        for (const line of lines) {
          const trimmed = line.trim();
          const homeMatch = trimmed.match(/(\/[^\s]+\/Contents\/Home)$/);
          const homePath = homeMatch?.[1] || '';
          if (!homePath || seen.has(homePath)) continue;
          seen.add(homePath);
          const versionText = trimmed.match(/^(\d+(?:[._]\d+)*)/)?.[1] || '';
          const majorVersion = parseJavaMajorVersion(versionText);
          const vendor = trimmed.match(/"([^"]+)"/)?.[1] || '';
          paths.push({
            name: `${vendor || 'JDK'}${majorVersion ? ` ${majorVersion}` : ''}`,
            homePath,
            javaVersion: versionText,
            majorVersion,
            vendor,
          });
        }
      } catch (err) {
        // 忽略执行错误
      }
    }

    if (!paths.length && process.env.JAVA_HOME) {
      paths.push({
        name: 'Default JAVA_HOME',
        homePath: process.env.JAVA_HOME,
        javaVersion: '',
        majorVersion: 0,
        vendor: '',
      });
    }

    const nowStr = new Date().toISOString();
    const insertStmt = db.prepare(
      `INSERT INTO build_jdks
       (name, home_path, java_version, major_version, vendor, arch, status, status_output, last_checked_at, remark, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of paths) {
      insertStmt.run(
        item.name,
        item.homePath,
        item.javaVersion || '',
        item.majorVersion || null,
        item.vendor || '',
        process.arch,
        item.majorVersion ? 'available' : 'unknown',
        '',
        item.majorVersion ? nowStr : '',
        '自动探测',
        nowStr,
        nowStr
      );
    }
  } catch (err) {
    console.error('Failed to initialize default JDKs:', err);
  }
}

/**
 * 生成项目过滤条件
 * @param {Object} query - 查询参数
 * @param {string} alias - 表别名
 * @returns {{conditions: string[], params: Array<string|number>}} 查询条件和参数
 */
function createProjectFilters(query = {}, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const conditions = [];
  const params = [];
  const projectId = Number(query.projectId || 0);
  const projectPath = String(query.projectPath || '').trim();
  const projectName = String(query.projectName || '').trim();
  if (projectId) {
    conditions.push(`${prefix}project_id = ?`);
    params.push(projectId);
  }
  if (projectPath) {
    conditions.push(`${prefix}project_path = ?`);
    params.push(projectPath);
  }
  if (projectName) {
    conditions.push(`${prefix}project_name = ?`);
    params.push(projectName);
  }
  return { conditions, params };
}

/**
 * 判断部署服务器是否存在
 * @param {DatabaseSync} db - 数据库实例
 * @param {number} serverId - 服务器 ID
 * @returns {boolean} 是否存在
 */
function hasServer(db, serverId) {
  return Boolean(db.prepare('SELECT id FROM deploy_servers WHERE id = ? AND team_id = ?').get(Number(serverId), getRequestTeamId()));
}

/**
 * 获取重复部署目标
 * @param {DatabaseSync} db - 数据库实例
 * @param {Object} payload - 部署目标参数
 * @param {number} excludeId - 排除的部署目标 ID
 * @returns {Object|null} 重复目标
 */
function getDuplicateTarget(db, payload, excludeId = 0) {
  const { conditions, params } = createProjectFilters(payload, 't');
  if (!conditions.length) return null;
  const sql = `
    SELECT t.id
    FROM deploy_targets t
    WHERE (${conditions.join(' OR ')})
      AND t.env_name = ?
      AND t.server_id = ?
      AND t.deploy_root = ?
      ${excludeId ? 'AND t.id != ?' : ''}
    LIMIT 1
  `;
  const queryParams = [
    ...params,
    payload.envName || '测试',
    Number(payload.serverId),
    String(payload.deployRoot || '').trim(),
  ];
  if (excludeId) queryParams.push(Number(excludeId));
  return db.prepare(sql).get(...queryParams);
}

/**
 * 获取重复监听端口的托管站点。
 * @param {DatabaseSync} db - 数据库实例
 * @param {Object} payload - 部署目标参数
 * @param {number} excludeId - 排除的部署目标 ID
 * @returns {Object|null} 重复目标
 */
function getDuplicateListenPortTarget(db, payload, excludeId = 0) {
  const listenPort = Number(payload.listenPort || 0);
  if (!payload.nginxSiteManaged || !listenPort) return null;
  const params = [Number(payload.serverId), listenPort];
  if (excludeId) params.push(Number(excludeId));
  return db
    .prepare(
      `SELECT id
       FROM deploy_targets
       WHERE server_id = ?
         AND nginx_site_managed = 1
         AND listen_port = ?
         ${excludeId ? 'AND id != ?' : ''}
      LIMIT 1`
    )
    .get(...params);
}

/**
 * 判断部署目标是否为主应用。
 * @param {Object} payload - 部署目标参数
 * @returns {boolean} 是否主应用
 */
function isMainDeployProject(payload = {}) {
  return `${payload.projectName || ''} ${payload.projectDescription || ''}`.includes('主应用');
}

/**
 * 判断端口是否已被托管 Nginx 主配置默认 server 占用。
 * @param {DatabaseSync} db - 数据库实例
 * @param {Object} payload - 部署目标参数
 * @returns {boolean} 是否占用默认 server 端口
 */
function isRuntimeDefaultListenPort(db, payload) {
  const listenPort = Number(payload.listenPort || 0);
  if (!payload.nginxSiteManaged || !listenPort) return false;
  if (isMainDeployProject(payload)) return false;
  const runtime = db.prepare("SELECT id FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' AND port_start = ?").get(Number(payload.serverId), listenPort);
  return Boolean(runtime);
}

/**
 * 获取服务器列表
 * @returns {Promise<Object[]>} 服务器列表
 */
export async function listServers() {
  const db = await getDeployDb();
  return db
    .prepare('SELECT * FROM deploy_servers WHERE team_id = ? ORDER BY sort_order ASC, updated_at DESC, id DESC')
    .all(getRequestTeamId())
    .map((row) => hydrateServer(db, row));
}

/**
 * 按完整服务器 ID 列表保存当前团队的展示顺序。
 * @param {number[]} serverIds 排序后的服务器 ID
 * @returns {Promise<Object[]>} 排序后的服务器列表
 */
export async function reorderServers(serverIds) {
  const normalizedIds = Array.isArray(serverIds) ? serverIds.map(Number) : [];
  if (!normalizedIds.length || normalizedIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('服务器排序数据无效，请刷新后重试');
  }
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new Error('服务器排序数据存在重复项，请刷新后重试');
  }

  const db = await getDeployDb();
  const teamId = getRequestTeamId();
  const currentIds = db
    .prepare('SELECT id FROM deploy_servers WHERE team_id = ?')
    .all(teamId)
    .map((row) => Number(row.id));
  const currentIdSet = new Set(currentIds);
  const matchesCurrentServers =
    currentIds.length === normalizedIds.length && normalizedIds.every((id) => currentIdSet.has(id));
  if (!matchesCurrentServers) {
    throw new Error('服务器列表已发生变化，请刷新后重新排序');
  }

  const update = db.prepare('UPDATE deploy_servers SET sort_order = ? WHERE id = ? AND team_id = ?');
  db.exec('BEGIN');
  try {
    normalizedIds.forEach((id, index) => {
      update.run(index + 1, id, teamId);
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listServers();
}

/**
 * 获取带凭据的服务器详情
 * @param {number} id - 服务器 ID
 * @returns {Promise<Object|null>} 服务器详情
 */
export async function getServerWithCredential(id) {
  const db = await getDeployDb();
  const row = db.prepare('SELECT * FROM deploy_servers WHERE id = ? AND team_id = ?').get(Number(id), getRequestTeamId());
  if (!row) return null;
  return {
    ...hydrateServer(db, row),
    credential: decryptCredential(row.encrypted_secret),
  };
}

/**
 * 创建服务器
 * @param {Object} payload - 服务器参数
 * @returns {Promise<Object>} 创建后的服务器
 */
export async function createServer(payload) {
  const db = await getDeployDb();
  const ts = now();
  const teamId = getRequestTeamId();
  const sortOrder = Number(
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM deploy_servers WHERE team_id = ?').get(teamId)?.value || 1
  );
  const credential = encryptCredential({
    password: payload.password || '',
    privateKey: payload.privateKey || '',
    passphrase: payload.passphrase || '',
  });
  const result = db
    .prepare(
      `INSERT INTO deploy_servers
       (team_id, sort_order, name, host, port, username, auth_type, encrypted_secret, use_sudo, default_deploy_root, default_backend_root,
        default_nginx_conf_path, nginx_work_dir, nginx_test_command, nginx_reload_command, remark, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      teamId,
      sortOrder,
      payload.name,
      payload.host,
      Number(payload.port || 22),
      payload.username,
      payload.authType || 'password',
      credential,
      payload.useSudo ? 1 : 0,
      payload.defaultDeployRoot || '',
      payload.defaultBackendRoot || '',
      payload.defaultNginxConfPath || '',
      payload.nginxWorkDir || '',
      payload.nginxTestCommand || 'nginx -t',
      payload.nginxReloadCommand || 'nginx -s reload',
      payload.remark || '',
      payload.createdBy || '',
      ts,
      ts
    );
  const serverId = Number(result.lastInsertRowid);
  return hydrateServer(db, db.prepare('SELECT * FROM deploy_servers WHERE id = ?').get(serverId));
}

/**
 * 更新服务器
 * @param {number} id - 服务器 ID
 * @param {Object} payload - 更新参数
 * @returns {Promise<Object|null>} 更新后的服务器
 */
export async function updateServer(id, payload) {
  const db = await getDeployDb();
  const teamId = getRequestTeamId();
  const current = db.prepare('SELECT * FROM deploy_servers WHERE id = ? AND team_id = ?').get(Number(id), teamId);
  if (!current) return null;
  const shouldUpdateCredential = Boolean(payload.password || payload.privateKey || payload.passphrase);
  const credential = shouldUpdateCredential
    ? encryptCredential({
        password: payload.password || '',
        privateKey: payload.privateKey || '',
        passphrase: payload.passphrase || '',
      })
    : current.encrypted_secret;
  db.prepare(
    `UPDATE deploy_servers
     SET name = ?, host = ?, port = ?, username = ?, auth_type = ?, encrypted_secret = ?, use_sudo = ?,
         default_deploy_root = ?, default_backend_root = ?, default_nginx_conf_path = ?, nginx_work_dir = ?, nginx_test_command = ?,
         nginx_reload_command = ?, remark = ?, updated_at = ?
     WHERE id = ? AND team_id = ?`
  ).run(
    payload.name,
    payload.host,
    Number(payload.port || 22),
    payload.username,
    payload.authType || current.auth_type,
    credential,
    payload.useSudo ? 1 : 0,
    payload.defaultDeployRoot || current.default_deploy_root || '',
    payload.defaultBackendRoot || current.default_backend_root || '',
    payload.defaultNginxConfPath || current.default_nginx_conf_path || '',
    payload.nginxWorkDir || current.nginx_work_dir || '',
    payload.nginxTestCommand || current.nginx_test_command || 'nginx -t',
    payload.nginxReloadCommand || current.nginx_reload_command || 'nginx -s reload',
    payload.remark || '',
    now(),
    Number(id),
    teamId
  );
  const updated = db.prepare('SELECT * FROM deploy_servers WHERE id = ? AND team_id = ?').get(Number(id), teamId);
  const systemInstance = db
    .prepare("SELECT id FROM nginx_instances WHERE server_id = ? AND instance_type = 'external' AND name = ? LIMIT 1")
    .get(Number(id), DEFAULT_EXTERNAL_NGINX_INSTANCE_NAME);
  if (systemInstance) {
    db.prepare(
      `UPDATE nginx_instances
       SET default_deploy_root = ?, default_nginx_conf_path = ?, nginx_work_dir = ?, nginx_test_command = ?,
           nginx_reload_command = ?, use_sudo = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      updated.default_deploy_root || '',
      updated.default_nginx_conf_path || '',
      updated.nginx_work_dir || '',
      updated.nginx_test_command || 'nginx -t',
      updated.nginx_reload_command || 'nginx -s reload',
      updated.use_sudo ? 1 : 0,
      now(),
      systemInstance.id
    );
  }
  return hydrateServer(db, updated);
}

/**
 * 判断 Nginx 实例是否属于服务器。
 * @param {DatabaseSync} db - 数据库实例
 * @param {number} serverId - 服务器 ID
 * @param {number} instanceId - Nginx 实例 ID
 * @returns {boolean} 是否存在
 */
function hasNginxInstanceForServer(db, serverId, instanceId) {
  return Boolean(db.prepare('SELECT id FROM nginx_instances WHERE id = ? AND server_id = ?').get(Number(instanceId), Number(serverId)));
}

/**
 * 获取服务器默认 Nginx 实例。
 * @param {number} serverId - 服务器 ID
 * @returns {Promise<Object|null>} Nginx 实例
 */
export async function getDefaultNginxInstanceByServerId(serverId) {
  const db = await getDeployDb();
  const managedInstance = db
    .prepare("SELECT * FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' ORDER BY initialized_at IS NOT NULL DESC, id ASC LIMIT 1")
    .get(Number(serverId));
  if (managedInstance) return mapNginxInstance(managedInstance);
  const server = db.prepare('SELECT default_nginx_instance_id FROM deploy_servers WHERE id = ?').get(Number(serverId));
  if (server?.default_nginx_instance_id) {
    const instance = db.prepare('SELECT * FROM nginx_instances WHERE id = ? AND server_id = ?').get(Number(server.default_nginx_instance_id), Number(serverId));
    if (instance) return mapNginxInstance(instance);
  }
  return mapNginxInstance(db.prepare('SELECT * FROM nginx_instances WHERE server_id = ? ORDER BY instance_type = \'managed\' DESC, id ASC LIMIT 1').get(Number(serverId)));
}

/**
 * 获取托管 Nginx 实例。
 * @param {number} serverId - 服务器 ID
 * @returns {Promise<Object|null>} 托管实例
 */
export async function getManagedNginxInstanceByServerId(serverId) {
  const db = await getDeployDb();
  return mapNginxInstance(
    db
      .prepare("SELECT * FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' ORDER BY initialized_at IS NOT NULL DESC, id ASC LIMIT 1")
      .get(Number(serverId))
  );
}

/**
 * 获取 Nginx 实例详情。
 * @param {number} id - 实例 ID
 * @returns {Promise<Object|null>} Nginx 实例
 */
export async function getNginxInstance(id) {
  const db = await getDeployDb();
  return mapNginxInstance(db.prepare('SELECT *, (SELECT COUNT(*) FROM deploy_targets WHERE nginx_instance_id = nginx_instances.id) AS target_count FROM nginx_instances WHERE id = ?').get(Number(id)));
}

/**
 * 获取带服务器凭据 of Nginx 实例上下文。
 * @param {number} id - 实例 ID
 * @returns {Promise<{instance: Object, server: Object}>} 实例和服务器
 */
export async function getNginxInstanceContext(id) {
  const db = await getDeployDb();
  const instance = mapNginxInstance(db.prepare('SELECT *, (SELECT COUNT(*) FROM deploy_targets WHERE nginx_instance_id = nginx_instances.id) AS target_count FROM nginx_instances WHERE id = ?').get(Number(id)));
  if (!instance) throw new Error('Nginx 实例不存在');
  const server = await getServerWithCredential(instance.serverId);
  if (!server) throw new Error('部署服务器不存在');
  return { instance, server };
}

/**
 * 获取服务器下 Nginx 实例列表。
 * @param {number} serverId - 服务器 ID
 * @returns {Promise<Object[]>} 实例列表
 */
export async function listNginxInstances(serverId) {
  const db = await getDeployDb();
  if (!hasServer(db, serverId)) throw new Error('部署服务器不存在');
  return listNginxInstancesByServerId(db, serverId);
}

/**
 * 创建 Nginx 实例。
 * @param {number} serverId - 服务器 ID
 * @param {Object} payload - 实例参数
 * @returns {Promise<Object>} 创建后的实例
 */
export async function createNginxInstance(serverId, payload = {}) {
  const db = await getDeployDb();
  if (!hasServer(db, serverId)) throw new Error('部署服务器不存在');
  const instanceType = payload.instanceType === 'managed' ? 'managed' : 'external';
  if (instanceType === 'managed') {
    const existingManaged = db.prepare("SELECT id FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' LIMIT 1").get(Number(serverId));
    if (existingManaged) throw new Error('同一服务器只能新增一个托管 Nginx；多个 yuyan 主应用请在当前 nginx.conf 中新增 server 配置');
  }
  const paths = instanceType === 'managed' ? deriveNginxRuntimePaths(payload.baseRoot || DEFAULT_NGINX_RUNTIME_BASE_ROOT) : {};
  const instanceId = insertNginxInstance(db, serverId, {
    ...payload,
    name: payload.name || (instanceType === 'managed' ? DEFAULT_MANAGED_NGINX_INSTANCE_NAME : DEFAULT_EXTERNAL_NGINX_INSTANCE_NAME),
    instanceType,
    defaultDeployRoot: payload.defaultDeployRoot || (instanceType === 'managed' ? paths.htmlRoot : '/data/webapps/{appName}'),
    defaultNginxConfPath: payload.defaultNginxConfPath || (instanceType === 'managed' ? getManagedMainConfPath(paths) : '/etc/nginx/conf.d/{appName}.conf'),
    baseRoot: paths.baseRoot || payload.baseRoot || '',
    nginxRoot: paths.nginxRoot || payload.nginxRoot || '',
    htmlRoot: paths.htmlRoot || payload.htmlRoot || '',
    sitesDir: paths.sitesDir || payload.sitesDir || '',
    logsDir: paths.logsDir || payload.logsDir || '',
    scriptPath: paths.scriptPath || payload.scriptPath || '',
    nginxTestCommand: payload.nginxTestCommand || (paths.scriptPath ? `${paths.scriptPath} test` : 'nginx -t'),
    nginxReloadCommand: payload.nginxReloadCommand || (paths.scriptPath ? `${paths.scriptPath} reload` : 'nginx -s reload'),
  });
  const server = db.prepare('SELECT default_nginx_instance_id FROM deploy_servers WHERE id = ?').get(Number(serverId));
  if (instanceType === 'managed' || !Number(server?.default_nginx_instance_id || 0)) {
    db.prepare('UPDATE deploy_servers SET default_nginx_instance_id = ? WHERE id = ?').run(instanceId, Number(serverId));
  }
  return mapNginxInstance(db.prepare('SELECT *, (SELECT COUNT(*) FROM deploy_targets WHERE nginx_instance_id = nginx_instances.id) AS target_count FROM nginx_instances WHERE id = ?').get(instanceId));
}

/**
 * 更新 Nginx 实例。
 * @param {number} id - 实例 ID
 * @param {Object} payload - 更新参数
 * @returns {Promise<Object|null>} 更新后的实例
 */
export async function updateNginxInstance(id, payload = {}) {
  const db = await getDeployDb();
  const current = db.prepare('SELECT * FROM nginx_instances WHERE id = ?').get(Number(id));
  if (!current) return null;
  const instanceType = payload.instanceType === 'managed' || current.instance_type === 'managed' ? 'managed' : 'external';
  const paths = instanceType === 'managed' ? deriveNginxRuntimePaths(payload.baseRoot || current.base_root || DEFAULT_NGINX_RUNTIME_BASE_ROOT) : {};
  const managedTestCommand = paths.scriptPath ? `${paths.scriptPath} test` : 'nginx -t';
  const managedReloadCommand = paths.scriptPath ? `${paths.scriptPath} reload` : 'nginx -s reload';
  const useManagedCommandDefaults = instanceType === 'managed' && Boolean(payload.baseRoot);
  const nextTestCommand = instanceType === 'managed' && isGenericNginxCommand(payload.nginxTestCommand, 'test') ? managedTestCommand : payload.nginxTestCommand;
  const nextReloadCommand = instanceType === 'managed' && isGenericNginxCommand(payload.nginxReloadCommand, 'reload') ? managedReloadCommand : payload.nginxReloadCommand;
  db.prepare(
    `UPDATE nginx_instances
     SET name = ?, instance_type = ?, default_deploy_root = ?, default_nginx_conf_path = ?, nginx_work_dir = ?,
         nginx_test_command = ?, nginx_reload_command = ?, base_root = ?, nginx_root = ?, html_root = ?,
         sites_dir = ?, logs_dir = ?, script_path = ?, port_start = ?, use_sudo = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    payload.name || current.name,
    instanceType,
    payload.defaultDeployRoot ?? current.default_deploy_root ?? '',
    payload.defaultNginxConfPath ?? current.default_nginx_conf_path ?? '',
    payload.nginxWorkDir ?? current.nginx_work_dir ?? '',
    nextTestCommand ?? (useManagedCommandDefaults ? managedTestCommand : current.nginx_test_command || managedTestCommand),
    nextReloadCommand ?? (useManagedCommandDefaults ? managedReloadCommand : current.nginx_reload_command || managedReloadCommand),
    paths.baseRoot || payload.baseRoot || current.base_root || '',
    paths.nginxRoot || payload.nginxRoot || current.nginx_root || '',
    paths.htmlRoot || payload.htmlRoot || current.html_root || '',
    paths.sitesDir || payload.sitesDir || current.sites_dir || '',
    paths.logsDir || payload.logsDir || current.logs_dir || '',
    paths.scriptPath || payload.scriptPath || current.script_path || '',
    Number(payload.portStart || current.port_start || 8080),
    (payload.useSudo ?? Boolean(current.use_sudo)) ? 1 : 0,
    now(),
    Number(id)
  );
  return mapNginxInstance(db.prepare('SELECT *, (SELECT COUNT(*) FROM deploy_targets WHERE nginx_instance_id = nginx_instances.id) AS target_count FROM nginx_instances WHERE id = ?').get(Number(id)));
}

/**
 * 更新 Nginx 实例运行状态。
 * @param {number} id - 实例 ID
 * @param {Object} payload - 状态补丁
 * @returns {Promise<Object|null>} 更新后的实例
 */
export async function updateNginxInstanceState(id, payload = {}) {
  const db = await getDeployDb();
  const current = db.prepare('SELECT id FROM nginx_instances WHERE id = ?').get(Number(id));
  if (!current) return null;
  db.prepare(
    `UPDATE nginx_instances
     SET runtime_version = COALESCE(?, runtime_version),
         package_sha256 = COALESCE(?, package_sha256),
         package_variant = COALESCE(?, package_variant),
         status = COALESCE(?, status),
         status_output = COALESCE(?, status_output),
         initialized_at = COALESCE(?, initialized_at),
         updated_at = ?
     WHERE id = ?`
  ).run(
    payload.runtimeVersion ?? null,
    payload.packageSha256 ?? null,
    payload.packageVariant ?? null,
    payload.status ?? null,
    payload.statusOutput ?? null,
    payload.initializedAt ?? null,
    now(),
    Number(id)
  );
  return getNginxInstance(id);
}

/**
 * 删除 Nginx 实例。
 * @param {number} id - 实例 ID
 * @returns {Promise<Object>} 删除结果
 */
export async function deleteNginxInstance(id) {
  const db = await getDeployDb();
  const instance = db.prepare('SELECT * FROM nginx_instances WHERE id = ?').get(Number(id));
  if (!instance) return { deletedInstances: 0 };
  if (instance.name === DEFAULT_EXTERNAL_NGINX_INSTANCE_NAME) {
    throw new Error('系统内置 Nginx 实例不允许删除');
  }
  const targetCount = Number(db.prepare('SELECT COUNT(*) AS count FROM deploy_targets WHERE nginx_instance_id = ?').get(Number(id))?.count || 0);
  if (targetCount > 0) throw new Error(`当前 Nginx 实例已绑定 ${targetCount} 个部署目标，请先调整目标后再删除`);
  const result = db.prepare('DELETE FROM nginx_instances WHERE id = ?').run(Number(id));
  const serverDefault = db.prepare('SELECT default_nginx_instance_id FROM deploy_servers WHERE id = ?').get(Number(instance.server_id));
  if (Number(serverDefault?.default_nginx_instance_id || 0) === Number(id)) {
    const next = db.prepare('SELECT id FROM nginx_instances WHERE server_id = ? ORDER BY id ASC LIMIT 1').get(Number(instance.server_id));
    db.prepare('UPDATE deploy_servers SET default_nginx_instance_id = ? WHERE id = ?').run(next?.id || null, Number(instance.server_id));
  }
  return { deletedInstances: result.changes || 0 };
}

/**
 * 获取服务器托管 Nginx 运行时。
 * @param {number} serverId - 服务器 ID
 * @returns {Promise<Object|null>} 运行时配置
 */
export async function getNginxRuntimeByServerId(serverId) {
  return mapRuntimeFromInstance(await getManagedNginxInstanceByServerId(serverId));
}

/**
 * 新增或更新服务器托管 Nginx 运行时。
 * @param {number} serverId - 服务器 ID
 * @param {Object} payload - 运行时配置
 * @returns {Promise<Object>} 运行时配置
 */
export async function upsertNginxRuntime(serverId, payload = {}) {
  const db = await getDeployDb();
  if (!hasServer(db, serverId)) throw new Error('部署服务器不存在');
  const paths = deriveNginxRuntimePaths(payload.baseRoot);
  const portStart = Number(payload.portStart || 8082);
  const mainConfPath = getManagedMainConfPath(paths);
  const ts = now();
  const current = db.prepare("SELECT id FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' ORDER BY id ASC LIMIT 1").get(Number(serverId));
  if (current) {
    db.prepare(
      `UPDATE nginx_instances
       SET base_root = ?, nginx_root = ?, html_root = ?, sites_dir = ?, logs_dir = ?, script_path = ?,
           default_deploy_root = ?, default_nginx_conf_path = ?, nginx_test_command = ?, nginx_reload_command = ?,
           port_start = ?, use_sudo = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      paths.baseRoot,
      paths.nginxRoot,
      paths.htmlRoot,
      paths.sitesDir,
      paths.logsDir,
      paths.scriptPath,
      paths.htmlRoot,
      mainConfPath,
      `${paths.scriptPath} test`,
      `${paths.scriptPath} reload`,
      Number.isFinite(portStart) && portStart > 0 ? portStart : 8082,
      payload.useSudo ? 1 : 0,
      ts,
      Number(current.id)
    );
  } else {
    const instanceId = insertNginxInstance(db, serverId, {
      name: DEFAULT_MANAGED_NGINX_INSTANCE_NAME,
      instanceType: 'managed',
      defaultDeployRoot: paths.htmlRoot,
      defaultNginxConfPath: mainConfPath,
      nginxTestCommand: `${paths.scriptPath} test`,
      nginxReloadCommand: `${paths.scriptPath} reload`,
      baseRoot: paths.baseRoot,
      nginxRoot: paths.nginxRoot,
      htmlRoot: paths.htmlRoot,
      sitesDir: paths.sitesDir,
      logsDir: paths.logsDir,
      scriptPath: paths.scriptPath,
      portStart: Number.isFinite(portStart) && portStart > 0 ? portStart : 8082,
      useSudo: Boolean(payload.useSudo),
      status: 'unknown',
    });
    db.prepare('UPDATE deploy_servers SET default_nginx_instance_id = ? WHERE id = ?').run(instanceId, Number(serverId));
    return getNginxRuntimeByServerId(serverId);
  }
  db.prepare('UPDATE deploy_servers SET default_nginx_instance_id = ? WHERE id = ?').run(Number(current.id), Number(serverId));
  return getNginxRuntimeByServerId(serverId);
}

/**
 * 更新服务器托管 Nginx 运行时状态。
 * @param {number} serverId - 服务器 ID
 * @param {Object} payload - 状态补丁
 * @returns {Promise<Object|null>} 运行时配置
 */
export async function updateNginxRuntimeState(serverId, payload = {}) {
  const db = await getDeployDb();
  const current = db.prepare("SELECT id FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' ORDER BY id ASC LIMIT 1").get(Number(serverId));
  if (!current) return null;
  const ts = now();
  db.prepare(
    `UPDATE nginx_instances
     SET runtime_version = COALESCE(?, runtime_version),
         package_sha256 = COALESCE(?, package_sha256),
         package_variant = COALESCE(?, package_variant),
         status = COALESCE(?, status),
         status_output = COALESCE(?, status_output),
         initialized_at = COALESCE(?, initialized_at),
         updated_at = ?
     WHERE id = ?`
  ).run(
    payload.runtimeVersion ?? null,
    payload.packageSha256 ?? null,
    payload.packageVariant ?? null,
    payload.status ?? null,
    payload.statusOutput ?? null,
    payload.initializedAt ?? null,
    ts,
    Number(current.id)
  );
  return getNginxRuntimeByServerId(serverId);
}

/**
 * 删除服务器
 * @param {number} id - 服务器 ID
 * @param {{requireEmpty?: boolean}} options 安全删除选项
 * @returns {Promise<Object>} 删除结果
 */
export async function deleteServer(id, options = {}) {
  const db = await getDeployDb();
  const serverId = Number(id);
  const teamId = getRequestTeamId();
  const ownedServer = db.prepare('SELECT id FROM deploy_servers WHERE id = ? AND team_id = ?').get(serverId, teamId);
  if (!ownedServer) return { deletedServers: 0, deletedTargets: 0, deletedInstances: 0, deletedRuntimes: 0, deletedRecords: 0 };
  const targets = db.prepare('SELECT id FROM deploy_targets WHERE server_id = ?').all(serverId);
  if (options.requireEmpty && targets.length) {
    throw new Error(`服务器仍被 ${targets.length} 个部署目标引用，请先逐个删除目标`);
  }
  const recordRows = db
    .prepare(
      `SELECT r.log_path
       FROM deploy_records r
       INNER JOIN deploy_targets t ON t.id = r.target_id
       WHERE t.server_id = ?`
    )
    .all(serverId);
  db.exec('BEGIN');
  try {
    let deletedRecords = 0;
    for (const target of targets) {
      const recordResult = db.prepare('DELETE FROM deploy_records WHERE target_id = ?').run(Number(target.id));
      deletedRecords += recordResult.changes || 0;
    }
    const targetResult = db.prepare('DELETE FROM deploy_targets WHERE server_id = ?').run(serverId);
    const instanceResult = db.prepare('DELETE FROM nginx_instances WHERE server_id = ?').run(serverId);
    const runtimeResult = db.prepare('DELETE FROM nginx_runtimes WHERE server_id = ?').run(serverId);
    const serverResult = db.prepare('DELETE FROM deploy_servers WHERE id = ? AND team_id = ?').run(serverId, teamId);
    db.exec('COMMIT');
    await Promise.all(recordRows.map((row) => deleteRecordLogFile(row.log_path)));
    return {
      deletedServers: serverResult.changes || 0,
      deletedTargets: targetResult.changes || 0,
      deletedInstances: instanceResult.changes || 0,
      deletedRuntimes: runtimeResult.changes || 0,
      deletedRecords,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 获取部署目标列表
 * @param {Object} query - 查询参数
 * @returns {Promise<Object[]>} 部署目标列表
 */
export async function listTargets(query = {}) {
  const db = await getDeployDb();
  const { conditions, params } = createProjectFilters(query, 't');
  const whereParts = ['t.team_id = ?'];
  const queryParams = [getRequestTeamId(), ...params];
  const projectKeyword = String(query.projectKeyword || query.keyword || query.search || '').trim();
  const branch = String(query.branch || query.defaultBranch || '').trim();
  const serverId = Number(query.serverId || 0);
  let sql = `
    SELECT t.*, b.*, s.name AS deploy_server_name,
           s.host AS deploy_server_host,
           e.name AS environment_name,
           e.nacos_server_addr AS environment_nacos_server_addr,
           e.nacos_console_url AS environment_nacos_console_url,
           e.nacos_namespace AS environment_nacos_namespace,
           e.nacos_group AS environment_nacos_group,
           e.gateway_public_url AS environment_gateway_public_url,
           e.status AS environment_status,
           i.name AS nginx_instance_name,
           i.instance_type AS nginx_instance_type
    FROM deploy_targets t
    LEFT JOIN deploy_servers s ON s.id = t.server_id
    LEFT JOIN nginx_instances i ON i.id = t.nginx_instance_id
    LEFT JOIN backend_target_configs b ON b.target_id = t.id
    LEFT JOIN deploy_environments e ON e.id = b.environment_id
  `;
  if (conditions.length) {
    whereParts.push(`(${conditions.join(' OR ')})`);
  }
  if (projectKeyword) {
    whereParts.push('(t.project_name LIKE ? OR t.project_path LIKE ? OR t.project_description LIKE ?)');
    queryParams.push(`%${projectKeyword}%`, `%${projectKeyword}%`, `%${projectKeyword}%`);
  }
  if (branch) {
    whereParts.push('t.default_branch = ?');
    queryParams.push(branch);
  }
  if (serverId) {
    whereParts.push('t.server_id = ?');
    queryParams.push(serverId);
  }
  const projectType = String(query.projectType || '').trim();
  if (projectType && projectType !== 'all') {
    whereParts.push('t.project_type = ?');
    queryParams.push(projectType);
  }
  if (whereParts.length) sql += ` WHERE ${whereParts.join(' AND ')}`;
  sql += ' ORDER BY t.updated_at DESC, t.id DESC';
  return db.prepare(sql).all(...queryParams).map(mapTarget);
}

/**
 * 轻量列出当前团队部署目标运行态索引。
 * @returns {Promise<Array<{id: number, projectType: string}>>} 目标 ID 与项目类型
 */
export async function listTargetRuntimeIndex() {
  const db = await getDeployDb();
  return db.prepare('SELECT id, project_type FROM deploy_targets WHERE team_id = ? ORDER BY id ASC')
    .all(getRequestTeamId())
    .map((row) => ({ id: Number(row.id), projectType: String(row.project_type || 'frontend') }));
}

/**
 * 解析服务器下一个可用托管站点端口。
 * @param {number} serverId - 服务器 ID
 * @param {number} excludeTargetId - 排除的部署目标 ID
 * @returns {Promise<number>} 下一个可用端口
 */
export async function resolveNextManagedListenPort(serverId, excludeTargetId = 0) {
  const db = await getDeployDb();
  if (!hasServer(db, serverId)) throw new Error('部署服务器不存在');
  const instanceId = Number(
    excludeTargetId
      ? db.prepare('SELECT nginx_instance_id FROM deploy_targets WHERE id = ?').get(Number(excludeTargetId))?.nginx_instance_id || 0
      : 0
  );
  const runtime =
    (instanceId ? db.prepare('SELECT port_start FROM nginx_instances WHERE id = ?').get(instanceId) : null) ||
    db.prepare("SELECT port_start FROM nginx_instances WHERE server_id = ? AND instance_type = 'managed' ORDER BY id ASC LIMIT 1").get(Number(serverId));
  const defaultPort = Math.max(1, Number(runtime?.port_start || 8080));
  if (defaultPort >= 65535) throw new Error('默认监听端口已是 65535，无法继续自动分配托管站点端口');
  const start = defaultPort + 1;
  const rows = db
    .prepare(
      `SELECT listen_port
       FROM deploy_targets
       WHERE server_id = ?
         AND nginx_site_managed = 1
         AND listen_port IS NOT NULL
         ${excludeTargetId ? 'AND id != ?' : ''}`
    )
    .all(...(excludeTargetId ? [Number(serverId), Number(excludeTargetId)] : [Number(serverId)]));
  const usedPorts = new Set(rows.map((row) => Number(row.listen_port || 0)).filter(Boolean));
  for (let port = start; port <= 65535; port += 1) {
    if (!usedPorts.has(port)) return port;
  }
  throw new Error('当前服务器没有可用监听端口');
}

/**
 * 解析 Nginx 实例所在服务器的下一个可用托管站点端口。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {number} excludeTargetId - 排除的部署目标 ID
 * @returns {Promise<number>} 下一个可用端口
 */
export async function resolveNextManagedListenPortByInstance(instanceId, excludeTargetId = 0) {
  const db = await getDeployDb();
  const instance = db.prepare('SELECT * FROM nginx_instances WHERE id = ?').get(Number(instanceId));
  if (!instance) throw new Error('Nginx 实例不存在');
  const defaultPort = Math.max(1, Number(instance.port_start || 8080));
  if (defaultPort >= 65535) throw new Error('默认监听端口已是 65535，无法继续自动分配托管站点端口');
  const rows = db
    .prepare(
      `SELECT listen_port
       FROM deploy_targets
       WHERE server_id = ?
         AND nginx_site_managed = 1
         AND listen_port IS NOT NULL
         ${excludeTargetId ? 'AND id != ?' : ''}`
    )
    .all(...(excludeTargetId ? [Number(instance.server_id), Number(excludeTargetId)] : [Number(instance.server_id)]));
  const usedPorts = new Set(rows.map((row) => Number(row.listen_port || 0)).filter(Boolean));
  for (let port = defaultPort + 1; port <= 65535; port += 1) {
    if (!usedPorts.has(port)) return port;
  }
  throw new Error('当前服务器没有可用监听端口');
}

/**
 * 获取部署目标详情
 * @param {number} id - 部署目标 ID
 * @returns {Promise<Object|null>} 部署目标详情
 */
export async function getTarget(id) {
  const db = await getDeployDb();
  return mapTarget(
    db
      .prepare(
        `SELECT t.*, b.*, s.name AS deploy_server_name,
                s.host AS deploy_server_host,
                e.name AS environment_name,
                e.nacos_server_addr AS environment_nacos_server_addr,
                e.nacos_console_url AS environment_nacos_console_url,
                e.nacos_namespace AS environment_nacos_namespace,
                e.nacos_group AS environment_nacos_group,
                e.gateway_public_url AS environment_gateway_public_url,
                e.status AS environment_status,
                i.name AS nginx_instance_name,
                i.instance_type AS nginx_instance_type
         FROM deploy_targets t
         LEFT JOIN deploy_servers s ON s.id = t.server_id
         LEFT JOIN nginx_instances i ON i.id = t.nginx_instance_id
         LEFT JOIN backend_target_configs b ON b.target_id = t.id
         LEFT JOIN deploy_environments e ON e.id = b.environment_id
         WHERE t.id = ? AND t.team_id = ?`
      )
      .get(Number(id), getRequestTeamId())
  );
}

/**
 * 查询同一服务器上的后端端口冲突。
 * @param {DatabaseSync} db 数据库实例
 * @param {Object} payload 部署目标参数
 * @param {number} excludeTargetId 排除的目标 ID
 * @returns {Object|null} 冲突目标
 */
function getDuplicateBackendPort(db, payload, excludeTargetId = 0) {
  if (payload.projectType !== 'backend') return null;
  const serverPort = Number(payload.serverPort || 0);
  if (!serverPort) return null;
  const params = [Number(payload.serverId), serverPort];
  if (excludeTargetId) params.push(Number(excludeTargetId));
  return db
    .prepare(
      `SELECT t.id, t.project_name
       FROM deploy_targets t
       INNER JOIN backend_target_configs b ON b.target_id = t.id
       WHERE t.server_id = ? AND b.server_port = ? ${excludeTargetId ? 'AND t.id != ?' : ''}
       LIMIT 1`
    )
    .get(...params);
}

/**
 * 在写入目标前校验后端根目录和全部后端配置，避免部分写入。
 * @param {DatabaseSync} db 数据库实例
 * @param {Object} payload 目标参数
 */
function validateBackendTargetBeforeWrite(db, payload) {
  if (payload.projectType !== 'backend') return;
  const server = db.prepare('SELECT use_sudo, default_backend_root FROM deploy_servers WHERE id = ?').get(Number(payload.serverId)) || {};
  const backendRoot = String(server.default_backend_root || '').trim();
  if (!backendRoot) throw new Error('请先在服务器配置中设置后端项目根目录');
  validateBackendDeployRoot(payload.deployRoot, backendRoot);
  if (payload.serverJavaRuntimeId) {
    const runtime = db.prepare('SELECT server_id, home_path, java_version, major_version, status FROM server_java_runtimes WHERE id = ?').get(Number(payload.serverJavaRuntimeId));
    if (!runtime || Number(runtime.server_id) !== Number(payload.serverId)) throw new Error('服务器运行 JDK 不属于当前部署服务器');
    if (runtime.status !== 'available') throw new Error('服务器运行 JDK 未检测通过');
    payload.runtimeJavaHome = runtime.home_path;
    payload.runtimeJavaVersion = runtime.java_version || String(runtime.major_version || '');
  }
  normalizeBackendConfig(payload, { useSudo: Boolean(server.use_sudo) });
}

/**
 * 新增或更新后端目标的一对一配置。
 * @param {DatabaseSync} db 数据库实例
 * @param {number} targetId 部署目标 ID
 * @param {Object} payload 部署目标参数
 */
function upsertBackendTargetConfig(db, targetId, payload) {
  if (payload.projectType !== 'backend') {
    db.prepare('DELETE FROM backend_target_configs WHERE target_id = ?').run(Number(targetId));
    return;
  }
  const server = db.prepare('SELECT use_sudo FROM deploy_servers WHERE id = ?').get(Number(payload.serverId)) || {};
  const config = normalizeBackendConfig(payload, { useSudo: Boolean(server.use_sudo) });
  const ts = now();

  // 防护性存在校验：防止本地自增 ID 在远程不存在引起物理外键冲突
  let validatedBuildJdkId = config.buildJdkId || null;
  if (validatedBuildJdkId) {
    const hasJdk = db.prepare('SELECT id FROM build_jdks WHERE id = ?').get(validatedBuildJdkId);
    if (!hasJdk) validatedBuildJdkId = null;
  }
  let validatedEnvironmentId = config.environmentId || null;
  if (validatedEnvironmentId) {
    const hasEnv = db.prepare('SELECT id FROM deploy_environments WHERE id = ?').get(validatedEnvironmentId);
    if (!hasEnv) validatedEnvironmentId = null;
  }

  db.prepare(
    `INSERT INTO backend_target_configs
     (target_id, environment_id, service_role, service_name, build_jdk_id, required_jdk_alias, server_java_runtime_id, runtime_java_home, runtime_java_version, server_port,
      spring_profiles, external_config_path, jvm_options, app_args, process_mode, stop_timeout_seconds,
      startup_timeout_seconds, health_check_path, nacos_server_addr, nacos_console_url, nacos_namespace,
      nacos_group, require_nacos_registration, gateway_url, gateway_probe_path, artifact_pattern, openapi_command, openapi_output_path,
      legacy_start_command, legacy_stop_command, needs_review, service_status, last_status_output,
      last_status_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET
       environment_id = excluded.environment_id,
       service_role = excluded.service_role,
       service_name = excluded.service_name,
       build_jdk_id = excluded.build_jdk_id,
       required_jdk_alias = excluded.required_jdk_alias,
       server_java_runtime_id = excluded.server_java_runtime_id,
       runtime_java_home = excluded.runtime_java_home,
       runtime_java_version = excluded.runtime_java_version,
       server_port = excluded.server_port,
       spring_profiles = excluded.spring_profiles,
       external_config_path = excluded.external_config_path,
       jvm_options = excluded.jvm_options,
       app_args = excluded.app_args,
       process_mode = excluded.process_mode,
       stop_timeout_seconds = excluded.stop_timeout_seconds,
       startup_timeout_seconds = excluded.startup_timeout_seconds,
       health_check_path = excluded.health_check_path,
       nacos_server_addr = excluded.nacos_server_addr,
       nacos_console_url = excluded.nacos_console_url,
       nacos_namespace = excluded.nacos_namespace,
       nacos_group = excluded.nacos_group,
       require_nacos_registration = excluded.require_nacos_registration,
       gateway_url = excluded.gateway_url,
       gateway_probe_path = excluded.gateway_probe_path,
       artifact_pattern = excluded.artifact_pattern,
       openapi_command = excluded.openapi_command,
       openapi_output_path = excluded.openapi_output_path,
       legacy_start_command = excluded.legacy_start_command,
       legacy_stop_command = excluded.legacy_stop_command,
       needs_review = excluded.needs_review,
       updated_at = excluded.updated_at`
  ).run(
    Number(targetId),
    validatedEnvironmentId,
    config.serviceRole,
    config.serviceName,
    validatedBuildJdkId,
    config.requiredJdkAlias || '',
    config.serverJavaRuntimeId || null,
    config.runtimeJavaHome,
    config.runtimeJavaVersion,
    config.serverPort,
    config.springProfiles,
    config.externalConfigPath,
    config.jvmOptions,
    config.appArgs,
    config.processMode,
    config.stopTimeoutSeconds,
    config.startupTimeoutSeconds,
    config.healthCheckPath,
    config.nacosServerAddr,
    config.nacosConsoleUrl,
    config.nacosNamespace,
    config.nacosGroup,
    config.requireNacosRegistration ? 1 : 0,
    config.gatewayUrl,
    config.gatewayProbePath,
    config.artifactPattern,
    config.openapiCommand,
    config.openapiOutputPath,
    config.legacyStartCommand,
    config.legacyStopCommand,
    config.needsReview ? 1 : 0,
    'unknown',
    '',
    '',
    ts,
    ts
  );
}

/**
 * 创建部署目标
 * @param {Object} payload - 部署目标参数
 * @returns {Promise<Object>} 创建后的部署目标
 */
export async function createTarget(payload) {
  const db = await getDeployDb();
  if (!hasServer(db, payload.serverId)) {
    throw new Error('部署服务器不存在，请先新增独立服务器');
  }
  const isBackend = payload.projectType === 'backend';
  validateBackendTargetBeforeWrite(db, payload);
  if (!isBackend && !hasNginxInstanceForServer(db, payload.serverId, payload.nginxInstanceId)) {
    throw new Error('Nginx 实例不存在，请重新选择部署服务器和 Nginx 实例');
  }
  if (getDuplicateTarget(db, payload)) {
    throw new Error('该项目在当前服务器和部署根目录下已存在部署目标，请编辑已有目标或更换部署根目录');
  }
  if (!isBackend && getDuplicateListenPortTarget(db, payload)) {
    throw new Error(`当前服务器已存在监听端口 ${payload.listenPort} 的托管站点，请更换端口`);
  }
  if (!isBackend && isRuntimeDefaultListenPort(db, payload)) {
    throw new Error(`端口 ${payload.listenPort} 已被托管 Nginx 默认 server 占用，请更换端口`);
  }
  const duplicateBackendPort = getDuplicateBackendPort(db, payload);
  if (duplicateBackendPort) throw new Error(`端口 ${payload.serverPort} 已被后端项目 ${duplicateBackendPort.project_name} 占用`);
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO deploy_targets
       (project_id, project_source, project_name, project_description, project_path, repository_url, default_branch, env_name, server_id, deploy_root,
        nginx_instance_id, nginx_conf_path, nginx_site_managed, listen_port, server_name, enable_nginx_test, enable_nginx_reload, install_command, build_command, artifact_dir,
        preserve_sub_dirs, upload_strategy, visit_url, remark, created_by, created_at, updated_at,
        project_type, jdk_id, stop_command, start_command, health_check_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(payload.projectId),
      payload.projectSource === 'gitlab' ? 'gitlab' : 'ops',
      payload.projectName,
      payload.projectDescription || '',
      payload.projectPath,
      payload.repositoryUrl,
      payload.defaultBranch || 'dev',
      payload.envName,
      Number(payload.serverId),
      payload.deployRoot,
      payload.nginxInstanceId ? Number(payload.nginxInstanceId) : null,
      payload.nginxConfPath || '',
      payload.nginxSiteManaged ? 1 : 0,
      payload.listenPort ? Number(payload.listenPort) : null,
      payload.serverName || '',
      payload.enableNginxTest ? 1 : 0,
      payload.enableNginxReload ? 1 : 0,
      payload.installCommand || '',
      payload.buildCommand || '',
      payload.artifactDir || '',
      payload.preserveSubDirs || '',
      payload.uploadStrategy || 'overlayKeepAssets',
      payload.visitUrl || '',
      payload.remark || '',
      payload.createdBy || '',
      ts,
      ts,
      payload.projectType || 'frontend',
      payload.jdkId ? Number(payload.jdkId) : null,
      payload.stopCommand || '',
      payload.startCommand || '',
      payload.healthCheckUrl || ''
    );
  const targetId = Number(result.lastInsertRowid);
  upsertBackendTargetConfig(db, targetId, payload);
  return getTarget(targetId);
}

/**
 * 更新部署目标
 * @param {number} id - 部署目标 ID
 * @param {Object} payload - 更新参数
 * @returns {Promise<Object|null>} 更新后的部署目标
 */
export async function updateTarget(id, payload) {
  const db = await getDeployDb();
  const teamId = getRequestTeamId();
  if (!db.prepare('SELECT id FROM deploy_targets WHERE id = ? AND team_id = ?').get(Number(id), teamId)) return null;
  if (!hasServer(db, payload.serverId)) {
    throw new Error('部署服务器不存在，请先新增独立服务器');
  }
  const isBackend = payload.projectType === 'backend';
  validateBackendTargetBeforeWrite(db, payload);
  if (!isBackend && !hasNginxInstanceForServer(db, payload.serverId, payload.nginxInstanceId)) {
    throw new Error('Nginx 实例不存在，请重新选择部署服务器和 Nginx 实例');
  }
  if (getDuplicateTarget(db, payload, Number(id))) {
    throw new Error('该项目在当前服务器和部署根目录下已存在部署目标，请编辑已有目标或更换部署根目录');
  }
  if (!isBackend && getDuplicateListenPortTarget(db, payload, Number(id))) {
    throw new Error(`当前服务器已存在监听端口 ${payload.listenPort} 的托管站点，请更换端口`);
  }
  if (!isBackend && isRuntimeDefaultListenPort(db, payload)) {
    throw new Error(`端口 ${payload.listenPort} 已被托管 Nginx 默认 server 占用，请更换端口`);
  }
  const duplicateBackendPort = getDuplicateBackendPort(db, payload, Number(id));
  if (duplicateBackendPort) throw new Error(`端口 ${payload.serverPort} 已被后端项目 ${duplicateBackendPort.project_name} 占用`);
  db.prepare(
    `UPDATE deploy_targets
     SET project_id = ?, project_source = ?, project_name = ?, project_description = ?, project_path = ?, repository_url = ?, default_branch = ?, env_name = ?,
         server_id = ?, nginx_instance_id = ?, deploy_root = ?, nginx_conf_path = ?, nginx_site_managed = ?, listen_port = ?, server_name = ?,
         enable_nginx_test = ?, enable_nginx_reload = ?, install_command = ?, build_command = ?,
         artifact_dir = ?, preserve_sub_dirs = ?, upload_strategy = ?, visit_url = ?, remark = ?, updated_at = ?,
         project_type = ?, jdk_id = ?, stop_command = ?, start_command = ?, health_check_url = ?
     WHERE id = ? AND team_id = ?`
  ).run(
    Number(payload.projectId),
    payload.projectSource === 'gitlab' ? 'gitlab' : 'ops',
    payload.projectName,
    payload.projectDescription || '',
    payload.projectPath,
    payload.repositoryUrl,
    payload.defaultBranch || 'dev',
    payload.envName,
    Number(payload.serverId),
    payload.nginxInstanceId ? Number(payload.nginxInstanceId) : null,
    payload.deployRoot,
    payload.nginxConfPath || '',
    payload.nginxSiteManaged ? 1 : 0,
    payload.listenPort ? Number(payload.listenPort) : null,
    payload.serverName || '',
    payload.enableNginxTest ? 1 : 0,
    payload.enableNginxReload ? 1 : 0,
    payload.installCommand || '',
    payload.buildCommand || '',
    payload.artifactDir || '',
    payload.preserveSubDirs || '',
    payload.uploadStrategy || 'overlayKeepAssets',
    payload.visitUrl || '',
    payload.remark || '',
    now(),
    payload.projectType || 'frontend',
    payload.jdkId ? Number(payload.jdkId) : null,
    payload.stopCommand || '',
    payload.startCommand || '',
    payload.healthCheckUrl || '',
    Number(id),
    teamId
  );
  upsertBackendTargetConfig(db, Number(id), payload);
  return getTarget(id);
}

/**
 * 删除部署目标
 * @param {number} id - 部署目标 ID
 * @param {{rejectRunning?: boolean}} options 安全删除选项
 * @returns {Promise<Object>} 删除结果
 */
export async function deleteTarget(id, options = {}) {
  const db = await getDeployDb();
  const targetId = Number(id);
  const teamId = getRequestTeamId();
  if (!db.prepare('SELECT id FROM deploy_targets WHERE id = ? AND team_id = ?').get(targetId, teamId)) {
    return { deletedTargets: 0, deletedRecords: 0 };
  }
  if (options.rejectRunning) {
    const runningTask = db.prepare("SELECT id FROM deploy_tasks WHERE target_id = ? AND status = 'running' LIMIT 1").get(targetId);
    if (runningTask) throw new Error('部署目标仍有运行中的发布或生成任务，无法删除');
  }
  const recordRows = db.prepare('SELECT log_path FROM deploy_records WHERE target_id = ?').all(targetId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM openapi_artifacts WHERE target_id = ?').run(targetId);
    db.prepare('DELETE FROM deploy_tasks WHERE target_id = ?').run(targetId);
    db.prepare('DELETE FROM backend_releases WHERE target_id = ?').run(targetId);
    db.prepare('DELETE FROM backend_target_configs WHERE target_id = ?').run(targetId);
    const recordResult = db.prepare('DELETE FROM deploy_records WHERE target_id = ?').run(targetId);
    const targetResult = db.prepare('DELETE FROM deploy_targets WHERE id = ? AND team_id = ?').run(targetId, teamId);
    db.exec('COMMIT');
    await Promise.all(recordRows.map((row) => deleteRecordLogFile(row.log_path)));
    return {
      deletedTargets: targetResult.changes || 0,
      deletedRecords: recordResult.changes || 0,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 创建发布记录
 * @param {Object} payload - 发布记录参数
 * @returns {Promise<Object>} 发布记录
 */
export async function createRecord(payload) {
  const db = await getDeployDb();
  const ts = payload.startedAt || now();
  const result = db
    .prepare(
      `INSERT INTO deploy_records
       (target_id, project_id, project_name, env_name, branch, commit_sha, commit_message, commit_author, status, release_path, backup_path,
        action, source_record_id, restored_record_id, backup_record_id, logs, log_path, operator, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(payload.targetId),
      Number(payload.projectId),
      payload.projectName,
      payload.envName,
      payload.branch,
      payload.commitSha || '',
      payload.commitMessage || '',
      payload.commitAuthor || '',
      payload.status || 'running',
      payload.releasePath || '',
      payload.backupPath || '',
      payload.action || 'deploy',
      normalizeRecordId(payload.sourceRecordId) || null,
      normalizeRecordId(payload.restoredRecordId) || null,
      normalizeRecordId(payload.backupRecordId) || null,
      '[]',
      '',
      payload.operator || '',
      ts,
      payload.finishedAt || '',
      ts
    );
  const recordId = Number(result.lastInsertRowid);
  const logPath = await writeRecordLogs(recordId, payload.logs || []);
  db.prepare('UPDATE deploy_records SET log_path = ? WHERE id = ?').run(logPath, recordId);
  return getRecord(recordId);
}

/**
 * 更新发布记录
 * @param {number} id - 发布记录 ID
 * @param {Object} patch - 更新字段
 * @returns {Promise<Object|null>} 更新后的发布记录
 */
export async function updateRecord(id, patch) {
  const db = await getDeployDb();
  const current = await getRecord(id);
  if (!current) return null;
  let nextLogPath = current.logPath || '';
  if (patch.logs) {
    nextLogPath = await writeRecordLogs(id, patch.logs);
  }
  db.prepare(
    `UPDATE deploy_records
     SET commit_sha = ?, commit_message = ?, commit_author = ?, status = ?, release_path = ?, backup_path = ?,
         action = ?, source_record_id = ?, restored_record_id = ?, backup_record_id = ?, logs = ?, log_path = ?, finished_at = ?
     WHERE id = ?`
  ).run(
    patch.commitSha ?? current.commitSha,
    patch.commitMessage ?? current.commitMessage,
    patch.commitAuthor ?? current.commitAuthor,
    patch.status ?? current.status,
    patch.releasePath ?? current.releasePath,
    patch.backupPath ?? current.backupPath,
    patch.action ?? current.action,
    patch.sourceRecordId !== undefined ? normalizeRecordId(patch.sourceRecordId) || null : normalizeRecordId(current.sourceRecordId) || null,
    patch.restoredRecordId !== undefined ? normalizeRecordId(patch.restoredRecordId) || null : normalizeRecordId(current.restoredRecordId) || null,
    patch.backupRecordId !== undefined ? normalizeRecordId(patch.backupRecordId) || null : normalizeRecordId(current.backupRecordId) || null,
    '[]',
    nextLogPath,
    patch.finishedAt ?? current.finishedAt ?? '',
    Number(id)
  );
  return getRecord(id);
}

/**
 * 获取发布记录详情
 * @param {number} id - 发布记录 ID
 * @param {Object} options - 查询选项
 * @returns {Promise<Object|null>} 发布记录
 */
export async function getRecord(id, options = {}) {
  const db = await getDeployDb();
  const row = db
    .prepare(
      `SELECT r.*, t.project_path, t.repository_url
       FROM deploy_records r
       LEFT JOIN deploy_targets t ON t.id = r.target_id
       WHERE r.id = ? AND r.team_id = ?`
    )
    .get(Number(id), getRequestTeamId());
  const record = mapRecord(row, { includeLogs: false });
  if (!record) return null;
  record.logs = await readRecordLogs(row);
  await hydrateRecordCommitMessages([record], options);
  return decorateRecordState(db, [record])[0] || record;
}

/**
 * 获取部署目标当前最新成功发布记录。
 * @param {number} targetId - 部署目标 ID
 * @param {Object} options - 查询选项
 * @returns {Promise<Object|null>} 当前成功记录
 */
export async function getLatestSuccessfulRecord(targetId, options = {}) {
  const db = await getDeployDb();
  const row = db
    .prepare(
      `SELECT r.*, t.project_path, t.repository_url
       FROM deploy_records r
       LEFT JOIN deploy_targets t ON t.id = r.target_id
       WHERE r.target_id = ? AND r.status = 'success'
       ORDER BY r.started_at DESC, r.id DESC
       LIMIT 1`
    )
    .get(Number(targetId));
  const record = mapRecord(row, { includeLogs: false });
  if (!record) return null;
  await hydrateRecordCommitMessages([record], options);
  return decorateRecordState(db, [record])[0] || record;
}

/**
 * 清理指定项目超过保留上限的历史记录
 * @param {number} projectId - 项目 ID
 * @param {number} keepCount - 保留条数
 * @returns {Promise<{deletedRecords: number}>} 清理结果
 */
export async function pruneProjectRecords(projectId, keepCount = DEPLOY_RECORD_KEEP_PER_PROJECT) {
  const db = await getDeployDb();
  const safeProjectId = Number(projectId || 0);
  const safeKeepCount = Math.max(1, Number(keepCount || DEPLOY_RECORD_KEEP_PER_PROJECT || 20));
  if (!safeProjectId) return { deletedRecords: 0 };

  const rows = db
    .prepare(
      `SELECT id, log_path
       FROM deploy_records
       WHERE project_id = ? AND status != 'running'
       ORDER BY started_at DESC, id DESC
       LIMIT -1 OFFSET ?`
    )
    .all(safeProjectId, safeKeepCount);

  if (!rows.length) return { deletedRecords: 0 };

  const ids = rows.map((row) => Number(row.id)).filter(Boolean);
  db.prepare(`DELETE FROM deploy_records WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  await Promise.all(rows.map((row) => deleteRecordLogFile(row.log_path)));
  return { deletedRecords: ids.length };
}

/**
 * 清理指定部署目标超过备份保留上限的回滚引用。
 * @param {number} targetId - 部署目标 ID
 * @param {number} keepCount - 可回滚版本保留数量
 * @returns {Promise<{clearedRecords: number}>} 清理结果
 */
export async function pruneTargetBackupReferences(targetId, keepCount) {
  const db = await getDeployDb();
  const safeTargetId = Number(targetId || 0);
  const safeKeepCount = Math.max(1, Number(keepCount || 8));
  if (!safeTargetId) return { clearedRecords: 0 };

  const rows = db
    .prepare(
      `SELECT id
       FROM deploy_records
       WHERE target_id = ? AND status != 'running' AND backup_path != ''
       ORDER BY started_at DESC, id DESC
       LIMIT -1 OFFSET ?`
    )
    .all(safeTargetId, safeKeepCount);

  if (!rows.length) return { clearedRecords: 0 };

  const ids = rows.map((row) => Number(row.id)).filter(Boolean);
  db.prepare(`UPDATE deploy_records SET backup_path = '', backup_record_id = NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  return { clearedRecords: ids.length };
}

/**
 * 获取发布记录列表
 * @param {Object} query - 查询参数
 * @returns {Promise<{items: Object[], total: number, page: number, pageSize: number}>} 发布记录分页
 */
export async function listRecords(query = {}) {
  const db = await getDeployDb();
  const params = [getRequestTeamId()];
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || query.perPage || 10)));
  const offset = (page - 1) * pageSize;
  const whereParts = ['r.team_id = ?'];
  let fromSql = `
    SELECT r.*, t.project_path, t.repository_url, t.project_type
    FROM deploy_records r
    LEFT JOIN deploy_targets t ON t.id = r.target_id
  `;
  let countSql = `
    SELECT COUNT(*) AS total
    FROM deploy_records r
    LEFT JOIN deploy_targets t ON t.id = r.target_id
  `;
  if (query.targetId) {
    whereParts.push('r.target_id = ?');
    params.push(Number(query.targetId));
  } else {
    const conditions = [];
    const projectId = Number(query.projectId || 0);
    const projectPath = String(query.projectPath || '').trim();
    const projectName = String(query.projectName || '').trim();
    if (projectId) {
      conditions.push('r.project_id = ?', 't.project_id = ?');
      params.push(projectId, projectId);
    }
    if (projectPath) {
      conditions.push('t.project_path = ?');
      params.push(projectPath);
    }
    if (projectName) {
      conditions.push('r.project_name = ?', 't.project_name = ?');
      params.push(projectName, projectName);
    }
    if (conditions.length) {
      whereParts.push(`(${conditions.join(' OR ')})`);
    }
  }
  const serverId = Number(query.serverId || 0);
  if (serverId) {
    whereParts.push('t.server_id = ?');
    params.push(serverId);
  }
  const projectType = String(query.projectType || '').trim();
  if (projectType === 'frontend' || projectType === 'backend') {
    whereParts.push('t.project_type = ?');
    params.push(projectType);
  }
  const branch = String(query.branch || '').trim();
  if (branch) {
    whereParts.push('r.branch = ?');
    params.push(branch);
  }
  if (whereParts.length) {
    const whereSql = ` WHERE ${whereParts.join(' AND ')}`;
    fromSql += whereSql;
    countSql += whereSql;
  }
  const total = Number(db.prepare(countSql).get(...params)?.total || 0);
  const items = db
    .prepare(`${fromSql} ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset)
    .map((row) => mapRecord(row, { includeLogs: false }));
  await hydrateRecordCommitMessages(items, { gitlabToken: query.gitlabToken, gitlabHost: query.gitlabHost });
  decorateRecordState(db, items);
  return { items, total, page, pageSize };
}

/**
 * 关闭并释放当前数据库连接，用于数据库同步替换
 * @returns {void}
 */
export function closeDeployDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
      console.log('[deploy-store] 数据库连接已安全关闭释放');
    } catch (e) {
      console.error('[deploy-store] 关闭数据库连接失败:', e);
    }
    dbInstance = null;
  }
}

/**
 * 获取 JDK 列表
 * @returns {Promise<Object[]>} JDK 列表
 */
export async function listJdks() {
  const db = await getDeployDb();
  return db
    .prepare('SELECT * FROM build_jdks WHERE team_id = ? ORDER BY name ASC, id DESC')
    .all(getRequestTeamId())
    .map(mapJdk);
}

/**
 * 转换本机构建 JDK 数据。
 * @param {Object} row 数据库行
 * @returns {Object|null} JDK 配置
 */
function mapJdk(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id || 'legacy-team',
    name: row.name,
    homePath: row.home_path,
    javaVersion: row.java_version || '',
    majorVersion: Number(row.major_version || 0),
    vendor: row.vendor || '',
    arch: row.arch || '',
    status: row.status || 'unknown',
    statusOutput: row.status_output || '',
    lastCheckedAt: row.last_checked_at || '',
    remark: row.remark || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 获取 JDK 详情
 * @param {number} id - JDK ID
 * @returns {Promise<Object|null>} JDK 详情
 */
export async function getJdk(id) {
  const db = await getDeployDb();
  const row = db.prepare('SELECT * FROM build_jdks WHERE id = ? AND team_id = ?').get(Number(id), getRequestTeamId());
  return mapJdk(row);
}

/**
 * 从别名中提取 Java 主版本号
 * @param {string} alias - JDK 别名或版本号
 * @returns {number|null} Java 主版本号
 */
function parseMajorVersionFromAlias(alias) {
  const str = String(alias || '').trim();
  if (!str) return null;
  // 兼容 1.8 -> 8, 1.7 -> 7, 1.6 -> 6
  if (/^1\.[678]$/.test(str)) {
    return Number(str.split('.')[1]);
  }
  // 匹配类似 "Java 8", "JDK 8", "8" 等中的版本号数字
  const match = str.match(/(?:java|openjdk|jdk)?\s*(\d+)/i);
  if (match) {
    const num = Number(match[1]);
    // 兼容 1.8.x 的前缀情况
    if (num === 1) {
      const matchSub = str.match(/1\.([6789])/);
      if (matchSub) return Number(matchSub[1]);
    }
    return num;
  }
  return null;
}

/**
 * 根据别名获取本地首个检测通过的可用 JDK，支持主版本自动匹配和向下兼容
 * @param {string} alias - JDK 别名
 * @returns {Promise<Object|null>} JDK 详情
 */
export async function findJdkByAlias(alias) {
  if (!alias) return null;
  const db = await getDeployDb();
  
  // 1. 尝试完全匹配名称
  const exactRow = db.prepare("SELECT * FROM build_jdks WHERE name = ? AND status = 'available' LIMIT 1").get(String(alias).trim());
  if (exactRow) return mapJdk(exactRow);

  // 2. 提取所要求的主版本
  const reqVer = parseMajorVersionFromAlias(alias);
  if (!reqVer) return null;

  // 查询所有本地可用的 JDK
  const rows = db.prepare("SELECT * FROM build_jdks WHERE status = 'available'").all();
  const jdks = rows.map(mapJdk);

  // 3. 寻找精确匹配主版本的 JDK
  const exactMatch = jdks.find(j => j.majorVersion === reqVer);
  if (exactMatch) return exactMatch;

  // 4. 寻找比项目要求高、且相差最小的 JDK (向下兼容)
  const higherJdks = jdks
    .filter(j => j.majorVersion > reqVer)
    .sort((a, b) => a.majorVersion - b.majorVersion);
  if (higherJdks.length > 0) {
    const selected = { ...higherJdks[0] };
    selected.isDownwardCompatible = true;
    selected.originalRequiredVersion = reqVer;
    return selected;
  }

  return null;
}

/**
 * 新增 JDK 配置
 * @param {Object} payload - JDK 参数
 * @returns {Promise<Object>} 新增后的 JDK 配置
 */
export async function createJdk(payload) {
  if (!payload.name || !payload.homePath) {
    throw new Error('JDK 名称和路径不能为空');
  }
  if (!path.isAbsolute(String(payload.homePath)) || /[\r\n\0]/.test(String(payload.homePath))) {
    throw new Error('本机 JDK JAVA_HOME 必须使用合法绝对路径');
  }
  const db = await getDeployDb();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO build_jdks
       (team_id, name, home_path, java_version, major_version, vendor, arch, status, status_output, last_checked_at, remark, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      getRequestTeamId(),
      payload.name.trim(),
      payload.homePath.trim(),
      payload.javaVersion || '',
      Number(payload.majorVersion || 0) || null,
      payload.vendor || '',
      payload.arch || '',
      payload.status || 'unknown',
      payload.statusOutput || '',
      payload.lastCheckedAt || '',
      payload.remark || '',
      ts,
      ts
    );
  return getJdk(Number(result.lastInsertRowid));
}

/**
 * 更新 JDK 配置
 * @param {number} id - JDK ID
 * @param {Object} payload - JDK 参数
 * @returns {Promise<Object|null>} 更新后的 JDK 配置
 */
export async function updateJdk(id, payload) {
  if (!payload.name || !payload.homePath) {
    throw new Error('JDK 名称和路径不能为空');
  }
  if (!path.isAbsolute(String(payload.homePath)) || /[\r\n\0]/.test(String(payload.homePath))) {
    throw new Error('本机 JDK JAVA_HOME 必须使用合法绝对路径');
  }
  const db = await getDeployDb();
  const row = db.prepare('SELECT id FROM build_jdks WHERE id = ?').get(Number(id));
  if (!row) return null;
  db.prepare(
    `UPDATE build_jdks
     SET name = ?, home_path = ?, status = 'unknown', status_output = '', last_checked_at = '', remark = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    payload.name.trim(),
    payload.homePath.trim(),
    payload.remark || '',
    now(),
    Number(id)
  );
  return getJdk(id);
}

/**
 * 删除 JDK 配置
 * @param {number} id - JDK ID
 * @returns {Promise<Object>} 删除结果
 */
export async function deleteJdk(id) {
  const db = await getDeployDb();
  const jdkId = Number(id);
  // 检查是否有部署目标在使用此 JDK
  const target = db
    .prepare(
      `SELECT t.id, t.project_name
       FROM deploy_targets t
       LEFT JOIN backend_target_configs b ON b.target_id = t.id
       WHERE t.jdk_id = ? OR b.build_jdk_id = ? LIMIT 1`
    )
    .get(jdkId, jdkId);
  if (target) {
    throw new Error(`无法删除：部署目标 "${target.project_name}" 正在使用此 JDK 配置`);
  }
  const result = db.prepare('DELETE FROM build_jdks WHERE id = ?').run(jdkId);
  return { deletedJdks: result.changes || 0 };
}

/**
 * 更新本机构建 JDK 检测结果。
 * @param {number} id JDK ID
 * @param {Object} detection 检测结果
 * @returns {Promise<Object|null>} 更新后的 JDK
 */
export async function updateJdkDetection(id, detection) {
  const db = await getDeployDb();
  const checkedAt = now();
  const result = db
    .prepare(
      `UPDATE build_jdks
       SET java_version = ?, major_version = ?, vendor = ?, arch = ?, status = ?, status_output = ?, last_checked_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      detection.javaVersion || '',
      Number(detection.majorVersion || 0) || null,
      detection.vendor || '',
      detection.arch || '',
      detection.status || 'unknown',
      detection.statusOutput || '',
      checkedAt,
      checkedAt,
      Number(id)
    );
  return result.changes ? getJdk(id) : null;
}

/**
 * 更新后端服务运行状态缓存。
 * @param {number} targetId 部署目标 ID
 * @param {Object} status 状态信息
 * @returns {Promise<Object|null>} 更新后的目标
 */
export async function updateBackendServiceStatus(targetId, status) {
  const db = await getDeployDb();
  db.prepare(
    `UPDATE backend_target_configs
     SET service_status = ?, last_status_output = ?, last_status_at = ?, updated_at = ?
     WHERE target_id = ?`
  ).run(status.status || 'unknown', status.output || '', now(), now(), Number(targetId));
  return getTarget(targetId);
}

/**
 * 获取服务器 Java 运行时列表。
 * @param {number} serverId 服务器 ID
 * @returns {Promise<Object[]>} 运行时列表
 */
export async function listServerJavaRuntimes(serverId) {
  const db = await getDeployDb();
  return db
    .prepare('SELECT * FROM server_java_runtimes WHERE server_id = ? ORDER BY major_version ASC, name ASC, id ASC')
    .all(Number(serverId))
    .map(mapServerJavaRuntime);
}

/**
 * 转换服务器 Java 运行时。
 * @param {Object} row 数据库行
 * @returns {Object|null} 运行时
 */
function mapServerJavaRuntime(row) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    homePath: row.home_path,
    javaVersion: row.java_version || '',
    majorVersion: Number(row.major_version || 0),
    vendor: row.vendor || '',
    arch: row.arch || '',
    status: row.status || 'unknown',
    statusOutput: row.status_output || '',
    lastCheckedAt: row.last_checked_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 获取服务器 Java 运行时。
 * @param {number} id 运行时 ID
 * @returns {Promise<Object|null>} 运行时
 */
export async function getServerJavaRuntime(id) {
  const db = await getDeployDb();
  return mapServerJavaRuntime(db.prepare('SELECT * FROM server_java_runtimes WHERE id = ?').get(Number(id)));
}

/**
 * 保存服务器 Java 运行时。
 * @param {number} serverId 服务器 ID
 * @param {Object} payload 保存参数
 * @returns {Promise<Object>} 运行时
 */
export async function createServerJavaRuntime(serverId, payload) {
  const db = await getDeployDb();
  if (!hasServer(db, serverId)) throw new Error('部署服务器不存在');
  if (!String(payload.name || '').trim() || !String(payload.homePath || '').trim()) throw new Error('运行时名称和 JAVA_HOME 必填');
  if (!path.posix.isAbsolute(String(payload.homePath)) || /[\r\n\0]/.test(String(payload.homePath))) {
    throw new Error('服务器 JAVA_HOME 必须使用合法绝对路径');
  }
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO server_java_runtimes
       (server_id, name, home_path, java_version, major_version, vendor, arch, status, status_output, last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(Number(serverId), payload.name.trim(), payload.homePath.trim(), '', null, '', '', 'unknown', '', '', ts, ts);
  return getServerJavaRuntime(Number(result.lastInsertRowid));
}

/**
 * 删除未被后端部署目标引用的服务器 Java 运行时。
 * @param {number} id 运行时 ID
 * @returns {Promise<{deletedRuntimes: number}>} 删除结果
 */
export async function deleteServerJavaRuntime(id) {
  const db = await getDeployDb();
  const runtimeId = Number(id);
  const target = db.prepare(
    `SELECT t.project_name FROM backend_target_configs b
     INNER JOIN deploy_targets t ON t.id = b.target_id
     WHERE b.server_java_runtime_id = ? LIMIT 1`
  ).get(runtimeId);
  if (target) throw new Error(`服务器运行 JDK 正在被后端项目 ${target.project_name} 使用，无法删除`);
  const result = db.prepare('DELETE FROM server_java_runtimes WHERE id = ?').run(runtimeId);
  return { deletedRuntimes: result.changes || 0 };
}

/**
 * 更新服务器 Java 运行时检测结果。
 * @param {number} id 运行时 ID
 * @param {Object} detection 检测结果
 * @returns {Promise<Object|null>} 运行时
 */
export async function updateServerJavaRuntimeDetection(id, detection) {
  const db = await getDeployDb();
  const ts = now();
  const result = db
    .prepare(
      `UPDATE server_java_runtimes
       SET java_version = ?, major_version = ?, vendor = ?, arch = ?, status = ?, status_output = ?, last_checked_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      detection.javaVersion || '',
      Number(detection.majorVersion || 0) || null,
      detection.vendor || '',
      detection.arch || '',
      detection.status || 'unknown',
      detection.statusOutput || '',
      ts,
      ts,
      Number(id)
    );
  return result.changes ? getServerJavaRuntime(id) : null;
}

/** 转换部署环境配置，不返回明文凭据。 */
function mapDeployEnvironment(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id || 'legacy-team',
    name: row.name,
    nacosServerAddr: row.nacos_server_addr || '',
    nacosConsoleUrl: row.nacos_console_url || '',
    nacosNamespace: row.nacos_namespace || '',
    nacosGroup: row.nacos_group || '',
    gatewayTargetId: Number(row.gateway_target_id || 0),
    gatewayPublicUrl: row.gateway_public_url || '',
    status: row.status || 'unknown',
    statusOutput: row.status_output || '',
    lastCheckedAt: row.last_checked_at || '',
    hasCredential: Boolean(row.encrypted_nacos_secret),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 获取环境依赖配置列表。 */
export async function listDeployEnvironments() {
  const db = await getDeployDb();
  return db.prepare('SELECT * FROM deploy_environments WHERE team_id = ? ORDER BY name ASC, id ASC').all(getRequestTeamId()).map(mapDeployEnvironment);
}

/** 获取包含解密凭据的环境依赖配置，仅供服务端内部使用。 */
export async function getDeployEnvironmentWithCredential(id) {
  const db = await getDeployDb();
  const row = db.prepare('SELECT * FROM deploy_environments WHERE id = ? AND team_id = ?').get(Number(id), getRequestTeamId());
  if (!row) return null;
  return { ...mapDeployEnvironment(row), credential: decryptCredential(row.encrypted_nacos_secret) };
}

/** 新增环境依赖配置。 */
export async function createDeployEnvironment(payload) {
  const db = await getDeployDb();
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('环境名称必填');
  const ts = now();
  const secret = encryptCredential({
    username: String(payload.username || ''),
    password: String(payload.password || ''),
    token: String(payload.token || ''),
  });
  const result = db.prepare(
    `INSERT INTO deploy_environments
     (team_id, name, nacos_server_addr, nacos_console_url, nacos_namespace, nacos_group, encrypted_nacos_secret,
      gateway_target_id, gateway_public_url, status, status_output, last_checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', '', '', ?, ?)`
  ).run(
    getRequestTeamId(),
    name,
    String(payload.nacosServerAddr || '').trim(),
    String(payload.nacosConsoleUrl || '').trim(),
    String(payload.nacosNamespace || '').trim(),
    String(payload.nacosGroup || 'DEFAULT_GROUP').trim(),
    secret,
    Number(payload.gatewayTargetId || 0) || null,
    String(payload.gatewayPublicUrl || '').trim(),
    ts,
    ts
  );
  return mapDeployEnvironment(db.prepare('SELECT * FROM deploy_environments WHERE id = ?').get(Number(result.lastInsertRowid)));
}

/** 更新环境依赖配置。 */
export async function updateDeployEnvironment(id, payload) {
  const db = await getDeployDb();
  const teamId = getRequestTeamId();
  const current = db.prepare('SELECT * FROM deploy_environments WHERE id = ? AND team_id = ?').get(Number(id), teamId);
  if (!current) return null;
  const shouldUpdateSecret = ['username', 'password', 'token'].some((key) => String(payload[key] || '').trim());
  const secret = shouldUpdateSecret
    ? encryptCredential({ username: payload.username || '', password: payload.password || '', token: payload.token || '' })
    : current.encrypted_nacos_secret;
  db.prepare(
    `UPDATE deploy_environments
     SET name = ?, nacos_server_addr = ?, nacos_console_url = ?, nacos_namespace = ?, nacos_group = ?,
         encrypted_nacos_secret = ?, gateway_target_id = ?, gateway_public_url = ?, updated_at = ?
     WHERE id = ? AND team_id = ?`
  ).run(
    String(payload.name || current.name).trim(),
    String(payload.nacosServerAddr ?? current.nacos_server_addr ?? '').trim(),
    String(payload.nacosConsoleUrl ?? current.nacos_console_url ?? '').trim(),
    String(payload.nacosNamespace ?? current.nacos_namespace ?? '').trim(),
    String(payload.nacosGroup ?? current.nacos_group ?? 'DEFAULT_GROUP').trim(),
    secret,
    Number(payload.gatewayTargetId ?? current.gateway_target_id ?? 0) || null,
    String(payload.gatewayPublicUrl ?? current.gateway_public_url ?? '').trim(),
    now(),
    Number(id),
    teamId
  );
  return mapDeployEnvironment(db.prepare('SELECT * FROM deploy_environments WHERE id = ? AND team_id = ?').get(Number(id), teamId));
}

/** 删除未被后端目标引用的环境依赖配置。 */
export async function deleteDeployEnvironment(id) {
  const db = await getDeployDb();
  const teamId = getRequestTeamId();
  if (!db.prepare('SELECT id FROM deploy_environments WHERE id = ? AND team_id = ?').get(Number(id), teamId)) return { deletedEnvironments: 0 };
  const target = db.prepare(
    `SELECT t.project_name FROM backend_target_configs b
     INNER JOIN deploy_targets t ON t.id = b.target_id
     WHERE b.environment_id = ? LIMIT 1`
  ).get(Number(id));
  if (target) throw new Error(`环境正在被后端项目 ${target.project_name} 使用，无法删除`);
  const result = db.prepare('DELETE FROM deploy_environments WHERE id = ? AND team_id = ?').run(Number(id), teamId);
  return { deletedEnvironments: result.changes || 0 };
}

/** 更新共享环境在线状态。 */
export async function updateDeployEnvironmentStatus(id, status, output = '') {
  const db = await getDeployDb();
  db.prepare(
    `UPDATE deploy_environments SET status = ?, status_output = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`
  ).run(status || 'unknown', output || '', now(), now(), Number(id));
}

/**
 * 创建部署任务持久化记录。
 * @param {Object} payload 任务参数
 * @returns {Promise<Object>} 任务记录
 */
export async function createPersistentDeployTask(payload) {
  const db = await getDeployDb();
  const ts = payload.startedAt || now();
  const result = db
    .prepare(
      `INSERT INTO deploy_tasks
       (target_id, action, status, stage, percent, operator, log_path, result_ref, error, started_at, heartbeat_at, finished_at)
       VALUES (?, ?, 'running', ?, 0, ?, '', '', '', ?, ?, '')`
    )
    .run(Number(payload.targetId), payload.action, payload.stage || 'validate', payload.operator || '', ts, ts);
  return getPersistentDeployTask(Number(result.lastInsertRowid));
}

/**
 * 获取持久化部署任务。
 * @param {number} id 任务 ID
 * @returns {Promise<Object|null>} 任务记录
 */
export async function getPersistentDeployTask(id) {
  const db = await getDeployDb();
  const row = db.prepare('SELECT * FROM deploy_tasks WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    id: row.id,
    targetId: row.target_id,
    action: row.action,
    status: row.status,
    stage: row.stage || '',
    percent: Number(row.percent || 0),
    operator: row.operator || '',
    logPath: row.log_path || '',
    resultRef: row.result_ref || '',
    error: row.error || '',
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at || '',
  };
}

/**
 * 更新持久化部署任务。
 * @param {number} id 任务 ID
 * @param {Object} patch 更新字段
 * @returns {Promise<Object|null>} 任务记录
 */
export async function updatePersistentDeployTask(id, patch) {
  const db = await getDeployDb();
  const current = await getPersistentDeployTask(id);
  if (!current) return null;
  const status = patch.status ?? current.status;
  const finishedAt = patch.finishedAt ?? (['success', 'failed', 'stopped', 'interrupted'].includes(status) ? now() : current.finishedAt);
  db.prepare(
    `UPDATE deploy_tasks
     SET status = ?, stage = ?, percent = ?, log_path = ?, result_ref = ?, error = ?, heartbeat_at = ?, finished_at = ?
     WHERE id = ?`
  ).run(
    status,
    patch.stage ?? current.stage,
    Number(patch.percent ?? current.percent),
    patch.logPath ?? current.logPath,
    patch.resultRef ?? current.resultRef,
    patch.error ?? current.error,
    now(),
    finishedAt || '',
    Number(id)
  );
  return getPersistentDeployTask(id);
}

/**
 * 创建后端版本记录。
 * @param {Object} payload 版本参数
 * @returns {Promise<Object>} 版本记录
 */
export async function createBackendRelease(payload) {
  const db = await getDeployDb();
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO backend_releases
       (target_id, record_id, release_name, release_dir, jar_name, artifact_sha256, commit_sha, status, is_current, created_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '')`
    )
    .run(
      Number(payload.targetId),
      Number(payload.recordId || 0) || null,
      payload.releaseName,
      payload.releaseDir,
      payload.jarName,
      payload.artifactSha256,
      payload.commitSha || '',
      payload.status || 'uploaded',
      ts
    );
  return getBackendRelease(Number(result.lastInsertRowid));
}

/**
 * 获取后端版本记录。
 * @param {number} id 版本 ID
 * @returns {Promise<Object|null>} 版本记录
 */
export async function getBackendRelease(id) {
  const db = await getDeployDb();
  const row = db.prepare('SELECT * FROM backend_releases WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    id: row.id,
    targetId: row.target_id,
    recordId: Number(row.record_id || 0),
    releaseName: row.release_name,
    releaseDir: row.release_dir,
    jarName: row.jar_name,
    artifactSha256: row.artifact_sha256,
    commitSha: row.commit_sha || '',
    status: row.status,
    isCurrent: Boolean(row.is_current),
    createdAt: row.created_at,
    activatedAt: row.activated_at || '',
  };
}

/**
 * 按发布记录获取后端版本。
 * @param {number} recordId 发布记录 ID
 * @returns {Promise<Object|null>} 后端版本
 */
export async function getBackendReleaseByRecordId(recordId) {
  const db = await getDeployDb();
  const row = db.prepare('SELECT id FROM backend_releases WHERE record_id = ? ORDER BY id DESC LIMIT 1').get(Number(recordId));
  return row ? getBackendRelease(row.id) : null;
}

/**
 * 更新后端版本状态。
 * @param {number} id 版本 ID
 * @param {string} status 状态
 * @returns {Promise<Object|null>} 后端版本
 */
export async function updateBackendReleaseStatus(id, status) {
  const db = await getDeployDb();
  const result = db.prepare('UPDATE backend_releases SET status = ? WHERE id = ?').run(status, Number(id));
  return result.changes ? getBackendRelease(id) : null;
}

/**
 * 获取目标的当前后端版本。
 * @param {number} targetId 目标 ID
 * @returns {Promise<Object|null>} 当前版本
 */
export async function getCurrentBackendRelease(targetId) {
  const db = await getDeployDb();
  const row = db
    .prepare('SELECT id FROM backend_releases WHERE target_id = ? AND is_current = 1 ORDER BY activated_at DESC, id DESC LIMIT 1')
    .get(Number(targetId));
  return row ? getBackendRelease(row.id) : null;
}

/**
 * 激活后端版本。
 * @param {number} releaseId 版本 ID
 * @returns {Promise<Object|null>} 激活版本
 */
export async function activateBackendRelease(releaseId) {
  const db = await getDeployDb();
  const release = await getBackendRelease(releaseId);
  if (!release) return null;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE backend_releases SET is_current = 0, status = CASE WHEN status = 'active' THEN 'inactive' ELSE status END WHERE target_id = ?").run(release.targetId);
    db.prepare("UPDATE backend_releases SET is_current = 1, status = 'active', activated_at = ? WHERE id = ?").run(now(), Number(releaseId));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getBackendRelease(releaseId);
}

/**
 * 列出目标后端版本。
 * @param {number} targetId 目标 ID
 * @returns {Promise<Object[]>} 版本列表
 */
export async function listBackendReleases(targetId) {
  const db = await getDeployDb();
  const rows = db.prepare('SELECT id FROM backend_releases WHERE target_id = ? ORDER BY created_at DESC, id DESC').all(Number(targetId));
  return Promise.all(rows.map((row) => getBackendRelease(row.id)));
}

/**
 * 创建 OpenAPI 产物元数据。
 * @param {Object} payload 产物参数
 * @returns {Promise<Object>} 产物元数据
 */
export async function createOpenApiArtifact(payload) {
  const db = await getDeployDb();
  const ts = payload.generatedAt || now();
  const result = db
    .prepare(
      `INSERT INTO openapi_artifacts
       (target_id, branch, commit_sha, file_name, file_path, sha256, size_bytes, status, generated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, ?)`
    )
    .run(
      Number(payload.targetId),
      payload.branch,
      payload.commitSha,
      payload.fileName,
      payload.filePath,
      payload.sha256,
      Number(payload.sizeBytes),
      ts,
      ts
    );
  return getOpenApiArtifact(Number(result.lastInsertRowid));
}

/**
 * 获取 OpenAPI 产物元数据。
 * @param {number} id 产物 ID
 * @returns {Promise<Object|null>} 产物元数据
 */
export async function getOpenApiArtifact(id) {
  const db = await getDeployDb();
  const row = db
    .prepare(
      `SELECT a.*, t.project_name
       FROM openapi_artifacts a LEFT JOIN deploy_targets t ON t.id = a.target_id
       WHERE a.id = ?`
    )
    .get(Number(id));
  if (!row) return null;
  return {
    id: row.id,
    targetId: row.target_id,
    projectName: row.project_name || '',
    branch: row.branch,
    commitSha: row.commit_sha,
    fileName: row.file_name,
    filePath: row.file_path,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes || 0),
    status: row.status,
    generatedAt: row.generated_at,
  };
}

/**
 * 获取目标最新 OpenAPI 产物。
 * @param {number} targetId 目标 ID
 * @param {string} branch 分支
 * @param {string} commitSha 可选提交 SHA
 * @returns {Promise<Object|null>} 最新产物
 */
export async function getLatestOpenApiArtifact(targetId, branch = '', commitSha = '') {
  const db = await getDeployDb();
  const conditions = ['target_id = ?', "status = 'success'"];
  const params = [Number(targetId)];
  if (branch) {
    conditions.push('branch = ?');
    params.push(branch);
  }
  if (commitSha) {
    conditions.push('commit_sha = ?');
    params.push(commitSha);
  }
  const row = db
    .prepare(`SELECT id FROM openapi_artifacts WHERE ${conditions.join(' AND ')} ORDER BY generated_at DESC, id DESC LIMIT 1`)
    .get(...params);
  return row ? getOpenApiArtifact(row.id) : null;
}
