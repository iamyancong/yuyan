/**
 * 中央数据库每日异地备份服务（#69）
 * @description 通过 VACUUM INTO 生成一致性快照 → PRAGMA integrity_check → gzip(level 6) + sha256 →
 * SFTP 上传至临时文件并校验大小/哈希 → 原子 rename → 按「最近 7 份 + 近 3 个月每月 1 号」保留清理。
 * 注意：不包含 DEPLOY_SECRET_KEY，恢复后必须使用原密钥启动服务。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { DEPLOY_DATA_DIR, DEPLOY_SECRET_KEY } from '../config/constants.mjs';
import { createDeployDbSnapshot, getDeployDb, getServerWithCredential } from './deploy-store.mjs';
import { isNginxConfigPatrolRunning, patrolNginxConfigSnapshots } from './nginx-config-snapshot-service.mjs';
import { runRequestContext, SHARED_DEPLOY_WORKSPACE_ID } from './request-context.mjs';
import { execSsh, getSftp, shellQuote, withSsh } from './ssh-service.mjs';
import { getTestHooks } from './test-hooks.mjs';

/** 默认远端备份目录 */
export const DEFAULT_CENTRAL_BACKUP_REMOTE_DIR = '/bak/wangyancong-yuyan';

/** 默认每日调度时间（服务器本地时间 HH:mm） */
export const DEFAULT_CENTRAL_BACKUP_TIME = '02:30';

/** 备份总超时时间（10 分钟） */
export const DEFAULT_CENTRAL_BACKUP_TIMEOUT_MS = 10 * 60 * 1000;

/** 孤立临时文件最大保留时间（24 小时） */
export const CENTRAL_BACKUP_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 严格备份文件名正则：yuyan-deploy-YYYYMMDD-HHmmss.sqlite.gz */
export const CENTRAL_BACKUP_FILE_RE = /^yuyan-deploy-(\d{8})-(\d{6})\.sqlite\.gz$/;

/** 严格 sha256 文件名正则 */
export const CENTRAL_BACKUP_SHA_RE = /^yuyan-deploy-(\d{8})-(\d{6})\.sqlite\.gz\.sha256$/;

/** 严格临时文件名正则 */
export const CENTRAL_BACKUP_TMP_RE = /^yuyan-deploy-(\d{8})-(\d{6})\.sqlite\.gz\.tmp-[a-f0-9]{12}$/;

/** 严格 sha256 临时文件名正则 */
export const CENTRAL_BACKUP_SHA_TMP_RE = /^yuyan-deploy-(\d{8})-(\d{6})\.sqlite\.gz\.sha256\.tmp-[a-f0-9]{12}$/;

/** 禁止落盘的系统关键目录（等于或位于其下均拒绝） */
const FORBIDDEN_SYSTEM_ROOTS = [
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/run',
  '/var/run',
];

/** 进程内备份互斥锁 */
let activeBackupPromise = null;

/**
 * 清理错误信息中的敏感凭据与 DEPLOY_SECRET_KEY，禁止写入日志或数据库。
 * @param {unknown} error - 原始错误
 * @param {Object|null} [server] - 服务器配置（含凭据）
 * @returns {string} 脱敏后的错误消息
 */
function sanitizeBackupErrorMessage(error, server = null) {
  let msg = error instanceof Error ? error.message : String(error || '中央备份失败');
  const secrets = [
    DEPLOY_SECRET_KEY,
    server?.credential?.password,
    server?.credential?.privateKey,
    server?.credential?.passphrase,
  ].filter((item) => typeof item === 'string' && item.length >= 4);
  for (const secret of secrets) {
    msg = msg.split(secret).join('[REDACTED]');
  }
  return msg;
}

/**
 * 校验并规范化远端备份目录。
 * @param {string} input - 原始目录路径
 * @returns {string} 规范化后不带尾斜杠的目录路径
 */
export function normalizeBackupRemoteDir(input) {
  if (typeof input !== 'string') {
    throw Object.assign(new Error('远端备份目录必须是字符串'), { statusCode: 400, code: 'INVALID_BACKUP_DIR' });
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw Object.assign(new Error('远端备份目录不能为空'), { statusCode: 400, code: 'INVALID_BACKUP_DIR' });
  }
  if (!trimmed.startsWith('/')) {
    throw Object.assign(new Error('远端备份目录必须以 / 开头'), { statusCode: 400, code: 'INVALID_BACKUP_DIR' });
  }
  if (trimmed.includes('//')) {
    throw Object.assign(new Error('远端备份目录不能包含连续斜杠 //'), { statusCode: 400, code: 'INVALID_BACKUP_DIR' });
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(trimmed)) {
    throw Object.assign(new Error('远端备份目录仅允许字母、数字、点、下划线、连字符与 /，禁止空白、引号及特殊符号'), {
      statusCode: 400,
      code: 'INVALID_BACKUP_DIR',
    });
  }
  const rawSegments = trimmed.replace(/\/+$/, '').split('/').filter(Boolean);
  if (rawSegments.some((seg) => seg === '.' || seg === '..')) {
    throw Object.assign(new Error('远端备份目录不能包含 . 或 .. 路径段'), { statusCode: 400, code: 'INVALID_BACKUP_DIR' });
  }
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, '');
  if (!normalized || normalized === '/') {
    throw Object.assign(new Error('远端备份目录不能为根目录 /'), { statusCode: 400, code: 'INVALID_BACKUP_DIR' });
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw Object.assign(new Error('远端备份目录至少需要两级路径（例如 /bak/yuyan）'), {
      statusCode: 400,
      code: 'INVALID_BACKUP_DIR',
    });
  }
  if (normalized === '/root') {
    throw Object.assign(new Error('远端备份目录不能直接放在 /root'), { statusCode: 400, code: 'INVALID_BACKUP_DIR' });
  }
  for (const forbidden of FORBIDDEN_SYSTEM_ROOTS) {
    if (normalized === forbidden || normalized.startsWith(`${forbidden}/`)) {
      throw Object.assign(new Error(`远端备份目录不能位于系统目录 ${forbidden} 下`), {
        statusCode: 400,
        code: 'INVALID_BACKUP_DIR',
      });
    }
  }
  return normalized;
}

/**
 * 解析调度时间 `HH:mm`，非法值回退默认值 `02:30` 并输出告警。
 * @param {string} [raw] - 环境变量原值
 * @returns {string} 合法 `HH:mm`
 */
export function parseCentralBackupScheduleTime(raw = process.env.YUYAN_CENTRAL_BACKUP_TIME) {
  const text = String(raw ?? '').trim();
  if (!text) return DEFAULT_CENTRAL_BACKUP_TIME;
  const matched = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!matched) {
    console.warn(`[central-backup] YUYAN_CENTRAL_BACKUP_TIME="${text}" 非法，回退默认 ${DEFAULT_CENTRAL_BACKUP_TIME}`);
    return DEFAULT_CENTRAL_BACKUP_TIME;
  }
  return `${matched[1]}:${matched[2]}`;
}

/**
 * 计算距离下一次调度时刻的毫秒数（本地时区）。
 * @param {string} timeStr - `HH:mm`
 * @param {Date} [now=new Date()] - 当前时间
 * @returns {number} 延迟毫秒数（至少 1000ms）
 */
export function computeNextScheduleDelayMs(timeStr, now = new Date()) {
  const [hourStr, minStr] = parseCentralBackupScheduleTime(timeStr).split(':');
  const hour = Number(hourStr);
  const minute = Number(minStr);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(1000, next.getTime() - now.getTime());
}

/**
 * 生成本地时区备份文件名时间戳 `YYYYMMDD-HHmmss`。
 * @param {Date} [date=new Date()] - 日期
 * @returns {string}
 */
export function formatCentralBackupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/**
 * 解析严格命名的备份文件（支持主文件、sha256、tmp 名字前缀）。
 * @param {string} name - 文件名
 * @param {RegExp} regex - 正则
 * @returns {{ name: string, year: number, month: number, day: number, hour: number, minute: number, second: number, sortKey: string, timestampMs: number }|null}
 */
function parseBackupNameByRegex(name, regex) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return null;
  }
  const matched = name.match(regex);
  if (!matched) return null;
  const datePart = matched[1];
  const timePart = matched[2];
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6));
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  const second = Number(timePart.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const d = new Date(year, month - 1, day, hour, minute, second, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return {
    name,
    year,
    month,
    day,
    hour,
    minute,
    second,
    sortKey: `${datePart}-${timePart}`,
    timestampMs: d.getTime(),
  };
}

/**
 * 纯函数：计算中央库备份保留与清理清单。
 * @description 仅处理严格匹配 `CENTRAL_BACKUP_FILE_RE` 的正式文件：
 * 1) 保留按时间最新的 `keepDaily`（默认 7）份；
 * 2) 在「now 所在月及往前 keepMonthlyMonths - 1 个月」（默认共 3 个自然月）内，每月保留日期为 1 号的最新 1 份；
 * 3) 其余匹配正则的正式文件进入 `remove`；任何不匹配正则的文件绝不会出现在结果中。
 * @param {string[]} fileNames - 目录中的文件名列表
 * @param {Date|number|string} [now=new Date()] - 当前时间
 * @param {{ keepDaily?: number, keepMonthlyMonths?: number }} [options] - 保留参数
 * @returns {{ keep: string[], remove: string[] }}
 */
export function planBackupRetention(fileNames, now = new Date(), options = {}) {
  const keepDaily = Math.max(1, Number(options.keepDaily ?? 7));
  const keepMonthlyMonths = Math.max(0, Number(options.keepMonthlyMonths ?? 3));
  const nowDate = now instanceof Date ? now : new Date(now ?? Date.now());
  const nowMonthIndex = nowDate.getFullYear() * 12 + nowDate.getMonth();

  const seen = new Set();
  const parsed = [];
  for (const name of Array.isArray(fileNames) ? fileNames : []) {
    if (seen.has(name)) continue;
    const item = parseBackupNameByRegex(name, CENTRAL_BACKUP_FILE_RE);
    if (!item) continue;
    seen.add(name);
    parsed.push(item);
  }

  // 按时间戳倒序排列
  parsed.sort((a, b) => (a.sortKey === b.sortKey ? b.name.localeCompare(a.name) : a.sortKey < b.sortKey ? 1 : -1));

  const keepSet = new Set();
  for (let i = 0; i < Math.min(keepDaily, parsed.length); i += 1) {
    keepSet.add(parsed[i].name);
  }

  if (keepMonthlyMonths > 0) {
    const keptMonths = new Set();
    for (const item of parsed) {
      if (item.day !== 1) continue;
      const itemMonthIndex = item.year * 12 + (item.month - 1);
      const monthDiff = nowMonthIndex - itemMonthIndex;
      if (monthDiff < 0 || monthDiff >= keepMonthlyMonths) continue;
      const monthKey = `${item.year}-${item.month}`;
      if (keptMonths.has(monthKey)) continue;
      keptMonths.add(monthKey);
      keepSet.add(item.name);
    }
  }

  const keep = [];
  const remove = [];
  for (const item of parsed) {
    if (keepSet.has(item.name)) keep.push(item.name);
    else remove.push(item.name);
  }
  return { keep, remove };
}

/**
 * 结合目录条目规划完整清理列表（含跟随删除的 `.sha256`、孤儿 `.sha256`、超过 24 小时的 `.tmp-*`）。
 * @param {Array<{ filename: string, attrs?: { mtime?: number, isDirectory?: () => boolean } }>} entries - SFTP readdir 条目
 * @param {Date|number} [now=new Date()] - 当前时间
 * @param {{ keepDaily?: number, keepMonthlyMonths?: number, tmpMaxAgeMs?: number }} [options]
 * @returns {{ keep: string[], remove: string[] }}
 */
export function planBackupDirectoryCleanup(entries, now = new Date(), options = {}) {
  const nowDate = now instanceof Date ? now : new Date(now ?? Date.now());
  const nowMs = nowDate.getTime();
  const tmpMaxAgeMs = Math.max(60_000, Number(options.tmpMaxAgeMs ?? CENTRAL_BACKUP_TMP_MAX_AGE_MS));

  const regularFiles = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const filename = String(entry?.filename || '');
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..') || /[\u0000-\u001f\u007f]/.test(filename)) {
      continue;
    }
    if (entry?.attrs?.isDirectory?.()) continue;
    regularFiles.push({ filename, mtime: Number(entry?.attrs?.mtime || 0) });
  }

  const retention = planBackupRetention(
    regularFiles.map((item) => item.filename),
    nowDate,
    options
  );
  const keepGzSet = new Set(retention.keep);
  const removeSet = new Set(retention.remove);

  for (const file of regularFiles) {
    const { filename, mtime } = file;
    if (CENTRAL_BACKUP_SHA_RE.test(filename)) {
      const parsedSha = parseBackupNameByRegex(filename, CENTRAL_BACKUP_SHA_RE);
      if (!parsedSha) continue;
      const baseGz = filename.slice(0, -'.sha256'.length);
      if (!keepGzSet.has(baseGz)) {
        removeSet.add(filename);
      }
      continue;
    }

    const tmpParsed =
      parseBackupNameByRegex(filename, CENTRAL_BACKUP_TMP_RE) ||
      parseBackupNameByRegex(filename, CENTRAL_BACKUP_SHA_TMP_RE);
    if (tmpParsed) {
      const mtimeMs = Number.isFinite(mtime) && mtime > 0 ? mtime * 1000 : tmpParsed.timestampMs;
      const refMs = Math.min(tmpParsed.timestampMs, mtimeMs);
      if (nowMs - refMs > tmpMaxAgeMs) {
        removeSet.add(filename);
      }
    }
  }

  const safeRemove = Array.from(removeSet).filter(
    (name) =>
      !name.includes('/') &&
      !name.includes('..') &&
      (CENTRAL_BACKUP_FILE_RE.test(name) ||
        CENTRAL_BACKUP_SHA_RE.test(name) ||
        CENTRAL_BACKUP_TMP_RE.test(name) ||
        CENTRAL_BACKUP_SHA_TMP_RE.test(name))
  );

  return { keep: retention.keep, remove: safeRemove };
}

/**
 * 解析 JSON 字段。
 * @param {string|null|undefined} raw - JSON 字符串
 * @returns {Object|null}
 */
function parseJsonSafe(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 确保 `central_backup_settings` 存在第 1 行配置记录。
 * @param {import('node:sqlite').DatabaseSync} db - 数据库实例
 */
function ensureCentralBackupSettingsRow(db) {
  db.prepare(
    `INSERT OR IGNORE INTO central_backup_settings (id, remote_dir, enabled, last_status)
     VALUES (1, ?, 0, '')`
  ).run(DEFAULT_CENTRAL_BACKUP_REMOTE_DIR);
}

/**
 * 读取当前中央库备份配置与最近状态（不返回任何服务器凭据）。
 * @returns {Promise<Object>}
 */
export async function getCentralBackupStatus() {
  const db = await getDeployDb();
  ensureCentralBackupSettingsRow(db);
  const row = db
    .prepare(
      `SELECT s.*, srv.name AS server_name, srv.host AS server_host, srv.port AS server_port
       FROM central_backup_settings s
       LEFT JOIN deploy_servers srv ON srv.id = s.server_id AND srv.team_id = ?
       WHERE s.id = 1`
    )
    .get(SHARED_DEPLOY_WORKSPACE_ID);

  return {
    settings: {
      serverId: row?.server_id ? Number(row.server_id) : null,
      serverName: row?.server_name || '',
      serverHost: row?.server_host || '',
      serverPort: row?.server_port ? Number(row.server_port) : null,
      remoteDir: row?.remote_dir || DEFAULT_CENTRAL_BACKUP_REMOTE_DIR,
      enabled: Boolean(row?.enabled),
      scheduleTime: parseCentralBackupScheduleTime(),
      updatedBy: row?.updated_by || '',
      updatedAt: row?.updated_at || '',
    },
    last: {
      runAt: row?.last_run_at || '',
      status: row?.last_status || '',
      trigger: row?.last_trigger || '',
      operator: row?.last_operator || '',
      fileName: row?.last_file_name || '',
      fileSize: Number(row?.last_file_size || 0),
      sha256: row?.last_sha256 || '',
      error: row?.last_error || '',
      durationMs: Number(row?.last_duration_ms || 0),
    },
    lastSuccessAt: row?.last_success_at || '',
    running: Boolean(activeBackupPromise),
    patrolRunning: isNginxConfigPatrolRunning(),
    patrol: parseJsonSafe(row?.last_patrol_json),
  };
}

/**
 * 更新中央库备份设置（仅管理员可调用）。
 * @param {Object} payload - 请求参数 { serverId, remoteDir, enabled }
 * @param {string} [operator=''] - 操作人
 * @returns {Promise<Object>} 更新后的状态
 */
export async function updateCentralBackupSettings(payload = {}, operator = '') {
  const db = await getDeployDb();
  ensureCentralBackupSettingsRow(db);

  const rawServerId = payload.serverId;
  let serverId = null;
  if (rawServerId !== null && rawServerId !== undefined && rawServerId !== '') {
    const parsedId = Number(rawServerId);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      throw Object.assign(new Error('备份服务器 ID 无效'), { statusCode: 400, code: 'INVALID_SERVER_ID' });
    }
    const exists = db
      .prepare('SELECT id FROM deploy_servers WHERE id = ? AND team_id = ?')
      .get(parsedId, SHARED_DEPLOY_WORKSPACE_ID);
    if (!exists) {
      throw Object.assign(new Error('所选备份服务器不存在或不属于共享部署工作区'), {
        statusCode: 404,
        code: 'BACKUP_SERVER_NOT_FOUND',
      });
    }
    serverId = parsedId;
  }

  const remoteDir = normalizeBackupRemoteDir(
    payload.remoteDir !== undefined ? String(payload.remoteDir) : DEFAULT_CENTRAL_BACKUP_REMOTE_DIR
  );
  const enabled = Boolean(payload.enabled);
  if (enabled && !serverId) {
    throw Object.assign(new Error('启用每日定时备份前请先选择备份服务器'), {
      statusCode: 400,
      code: 'BACKUP_SERVER_REQUIRED',
    });
  }

  const ts = new Date().toISOString();
  db.prepare(
    `UPDATE central_backup_settings
     SET server_id = ?, remote_dir = ?, enabled = ?, updated_by = ?, updated_at = ?
     WHERE id = 1`
  ).run(serverId, remoteDir, enabled ? 1 : 0, String(operator || '').trim(), ts);

  return getCentralBackupStatus();
}

/**
 * Promise 化的 SFTP fastPut。
 */
function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Promise 化的 SFTP stat（不存在时返回 null）。
 */
function sftpStatOptional(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (!error) return resolve(stats);
      if (error.code === 2 || error.code === 'ENOENT' || /no such file/i.test(error.message || '')) {
        return resolve(null);
      }
      return reject(error);
    });
  });
}

/**
 * Promise 化的 SFTP rename。
 */
function sftpRename(sftp, oldPath, newPath) {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Promise 化的 SFTP unlink（尽力清理）。
 */
function sftpUnlink(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Promise 化的 SFTP readdir。
 */
function sftpReaddir(sftp, remoteDir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remoteDir, (error, entries) => {
      if (error) reject(error);
      else resolve(Array.isArray(entries) ? entries : []);
    });
  });
}

/**
 * 生成本地一致性快照、校验 integrity_check 并压缩为 gzip + sha256。
 * @param {string} snapshotPath - 临时 sqlite 快照路径
 * @param {string} gzPath - 输出 gzip 路径
 * @returns {Promise<{ sha256: string, size: number }>}
 */
async function createVerifiedGzipBackup(snapshotPath, gzPath) {
  await createDeployDbSnapshot(snapshotPath);

  const checkDb = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const rows = checkDb.prepare('PRAGMA integrity_check').all();
    const ok = rows.length === 1 && String(rows[0]?.integrity_check || '').toLowerCase() === 'ok';
    if (!ok) {
      throw new Error(`中央库完整性校验未通过: ${JSON.stringify(rows)}`);
    }
  } finally {
    checkDb.close();
  }

  const hash = crypto.createHash('sha256');
  const hashTap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(
    createReadStream(snapshotPath),
    zlib.createGzip({ level: 6 }),
    hashTap,
    createWriteStream(gzPath, { mode: 0o600 })
  );

  const stat = await fs.stat(gzPath);
  return {
    sha256: hash.digest('hex'),
    size: stat.size,
  };
}

/**
 * 执行一次中央库异地备份（带进程内并发锁、临时文件清理、远端大小与 sha256 校验及保留策略清理）。
 * @param {{ trigger?: 'manual'|'schedule', operator?: string }} [params] - 触发来源与操作人
 * @param {{ timeoutMs?: number, withSsh?: Function, now?: () => Date, keepDaily?: number, keepMonthlyMonths?: number }} [options] - 运行选项
 * @returns {Promise<Object>} 备份结果
 */
export async function runCentralBackup(params = {}, options = {}) {
  if (activeBackupPromise) {
    throw Object.assign(new Error('中央库备份正在执行，请等待本次完成后再试'), {
      statusCode: 409,
      status: 409,
      code: 'central_backup_running',
    });
  }

  const trigger = params.trigger === 'schedule' ? 'schedule' : 'manual';
  const operator = String(params.operator || (trigger === 'schedule' ? 'system' : '')).trim() || 'system';
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? DEFAULT_CENTRAL_BACKUP_TIMEOUT_MS));
  const testHooks = getTestHooks();
  const sshRunner = options.withSsh || testHooks?.withSsh || withSsh;
  const nowFn = options.now || (() => new Date());

  const execute = async () => {
    const startMs = Date.now();
    const startedAt = new Date(startMs).toISOString();
    const db = await getDeployDb();
    ensureCentralBackupSettingsRow(db);

    const settingsRow = db.prepare('SELECT * FROM central_backup_settings WHERE id = 1').get();
    const recordFailure = (error, server = null) => {
      const durationMs = Math.max(0, Date.now() - startMs);
      const message = sanitizeBackupErrorMessage(error, server);
      console.warn(`[central-backup] 备份失败（trigger=${trigger}，耗时 ${durationMs}ms）: ${message}`);
      try {
        db.prepare(
          `UPDATE central_backup_settings
           SET last_run_at = ?, last_status = 'failed', last_trigger = ?, last_operator = ?,
               last_error = ?, last_duration_ms = ?
           WHERE id = 1`
        ).run(startedAt, trigger, operator, message, durationMs);
      } catch (dbErr) {
        console.warn('[central-backup] 回写失败状态异常:', dbErr?.message || dbErr);
      }
      return message;
    };

    if (!settingsRow?.server_id) {
      const err = Object.assign(new Error('尚未配置备份服务器，请先在「中央灾备」中选择备份服务器'), {
        statusCode: 400,
        code: 'central_backup_server_not_configured',
      });
      recordFailure(err);
      throw err;
    }

    let server = null;
    try {
      server = await runRequestContext(
        {
          teamId: SHARED_DEPLOY_WORKSPACE_ID,
          role: 'admin',
          accountId: operator,
          userId: operator,
          deviceId: 'central-backup',
          client: trigger,
        },
        () => getServerWithCredential(Number(settingsRow.server_id))
      );
    } catch (credError) {
      const sanitizedMsg = recordFailure(credError);
      const wrapped = new Error(sanitizedMsg);
      wrapped.statusCode = 400;
      wrapped.code = 'central_backup_credential_error';
      throw wrapped;
    }

    if (!server) {
      const err = Object.assign(new Error('配置的备份服务器不存在或已被删除'), {
        statusCode: 400,
        code: 'central_backup_server_not_found',
      });
      recordFailure(err);
      throw err;
    }

    let remoteDir;
    try {
      remoteDir = normalizeBackupRemoteDir(settingsRow.remote_dir || DEFAULT_CENTRAL_BACKUP_REMOTE_DIR);
    } catch (dirError) {
      recordFailure(dirError, server);
      throw dirError;
    }

    db.prepare(
      `UPDATE central_backup_settings
       SET last_run_at = ?, last_status = 'running', last_trigger = ?, last_operator = ?, last_error = ''
       WHERE id = 1`
    ).run(startedAt, trigger, operator);

    const tmpDir = await fs.mkdtemp(path.join(DEPLOY_DATA_DIR, '.central-backup-tmp-'));
    await fs.chmod(tmpDir, 0o700).catch(() => {});
    const warnings = [];

    try {
      let stampDate = nowFn();
      let fileName = `yuyan-deploy-${formatCentralBackupTimestamp(stampDate)}.sqlite.gz`;
      // 若同一秒内连续触发且未提供自定义时钟，推进 1 秒窗口避免与上一次同名冲突
      if (!options.now && settingsRow.last_file_name === fileName) {
        await new Promise((resolve) => setTimeout(resolve, 1050));
        stampDate = nowFn();
        fileName = `yuyan-deploy-${formatCentralBackupTimestamp(stampDate)}.sqlite.gz`;
      }

      const shaFileName = `${fileName}.sha256`;
      const randomHex = crypto.randomBytes(6).toString('hex');
      const tmpFileName = `${fileName}.tmp-${randomHex}`;
      const shaTmpFileName = `${shaFileName}.tmp-${randomHex}`;

      const localSnapshotPath = path.join(tmpDir, 'deploy.snapshot.sqlite');
      const localGzPath = path.join(tmpDir, fileName);
      const localShaPath = path.join(tmpDir, shaFileName);

      const { sha256, size } = await createVerifiedGzipBackup(localSnapshotPath, localGzPath);
      await fs.writeFile(localShaPath, `${sha256}  ${fileName}\n`, { encoding: 'utf8', mode: 0o600 });

      const remoteTmpPath = `${remoteDir}/${tmpFileName}`;
      const remoteShaTmpPath = `${remoteDir}/${shaTmpFileName}`;
      const remoteFinalPath = `${remoteDir}/${fileName}`;
      const remoteShaFinalPath = `${remoteDir}/${shaFileName}`;

      const controller = new AbortController();
      let activeConn = null;
      let timeoutHandle = null;

      const assertNotAborted = () => {
        if (controller.signal.aborted) {
          throw new Error(`中央库备份已超时中止（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
        }
      };

      const sshTask = sshRunner(server, async (conn) => {
        activeConn = conn;
        await execSsh(conn, `mkdir -p -- ${shellQuote(remoteDir)}`, {
          label: `创建中央备份目录 ${remoteDir}`,
          signal: controller.signal,
          timeoutMs: 30_000,
        });

        const sftp = await getSftp(conn);
        let gzTmpUploaded = false;
        let shaTmpUploaded = false;
        let gzFinalUploaded = false;

        try {
          const existingFinal = await sftpStatOptional(sftp, remoteFinalPath);
          if (existingFinal) {
            throw new Error(`远端备份文件 ${fileName} 已存在，已拒绝覆盖`);
          }

          assertNotAborted();
          // 在 fastPut 前置位，确保中途写入失败也能触发远端 tmp 清理
          gzTmpUploaded = true;
          await sftpFastPut(sftp, localGzPath, remoteTmpPath);

          const remoteTmpStat = await sftpStatOptional(sftp, remoteTmpPath);
          if (!remoteTmpStat || Number(remoteTmpStat.size) !== size) {
            throw new Error(
              `远端备份文件大小校验失败：本地 ${size} 字节，远端 ${remoteTmpStat ? remoteTmpStat.size : '缺失'} 字节`
            );
          }

          const shaCheckResult = await execSsh(conn, `sha256sum -- ${shellQuote(remoteTmpPath)}`, {
            label: '校验远端备份文件 SHA-256',
            allowFailure: true,
            signal: controller.signal,
            timeoutMs: 60_000,
          });
          if (shaCheckResult.code === 0) {
            const matched = String(shaCheckResult.stdout || '').trim().match(/^([a-f0-9]{64})\b/i);
            const remoteHex = matched ? matched[1].toLowerCase() : '';
            if (!remoteHex || remoteHex !== sha256) {
              throw new Error(`远端备份 SHA-256 校验不一致（期望 ${sha256}，实际 ${remoteHex || '未知'}）`);
            }
          } else if (shaCheckResult.code === 127 || /not found/i.test(shaCheckResult.stderr || '')) {
            const warnMsg = '远端服务器未安装 sha256sum，跳过远端哈希校验（已校验文件大小）';
            warnings.push(warnMsg);
            console.warn(`[central-backup] ${warnMsg}`);
          } else {
            throw new Error(`远端 sha256sum 执行失败（退出码 ${shaCheckResult.code}）：${shaCheckResult.stderr || shaCheckResult.stdout}`);
          }

          assertNotAborted();
          shaTmpUploaded = true;
          await sftpFastPut(sftp, localShaPath, remoteShaTmpPath);

          // 落盘前再检查是否已被超时中止及目标名不存在，防止竞争覆盖或超时后落盘
          assertNotAborted();
          if (await sftpStatOptional(sftp, remoteFinalPath)) {
            throw new Error(`远端备份文件 ${fileName} 已存在，已拒绝覆盖`);
          }

          assertNotAborted();
          await sftpRename(sftp, remoteTmpPath, remoteFinalPath);
          gzTmpUploaded = false;
          gzFinalUploaded = true;
          assertNotAborted();
          await sftpRename(sftp, remoteShaTmpPath, remoteShaFinalPath);
          shaTmpUploaded = false;
          gzFinalUploaded = false;
        } catch (uploadError) {
          if (gzTmpUploaded) {
            await sftpUnlink(sftp, remoteTmpPath).catch(() => {});
          }
          if (shaTmpUploaded) {
            await sftpUnlink(sftp, remoteShaTmpPath).catch(() => {});
          }
          // 正式 gz 已落地但 sha 文件尚未配对时，删除不完整的正式文件，避免留下无法校验的备份
          if (gzFinalUploaded) {
            await sftpUnlink(sftp, remoteFinalPath).catch(() => {});
          }
          throw uploadError;
        }

        // 保留策略清理（失败只记 warning，不判定备份失败）
        try {
          assertNotAborted();
          const entries = await sftpReaddir(sftp, remoteDir);
          const cleanupPlan = planBackupDirectoryCleanup(entries, stampDate, {
            keepDaily: options.keepDaily,
            keepMonthlyMonths: options.keepMonthlyMonths,
          });
          for (const removeName of cleanupPlan.remove) {
            assertNotAborted();
            if (
              !CENTRAL_BACKUP_FILE_RE.test(removeName) &&
              !CENTRAL_BACKUP_SHA_RE.test(removeName) &&
              !CENTRAL_BACKUP_TMP_RE.test(removeName) &&
              !CENTRAL_BACKUP_SHA_TMP_RE.test(removeName)
            ) {
              continue;
            }
            await sftpUnlink(sftp, `${remoteDir}/${removeName}`);
          }
        } catch (cleanupError) {
          const warnMsg = `清理远端过期备份警告: ${sanitizeBackupErrorMessage(cleanupError, server)}`;
          warnings.push(warnMsg);
          console.warn(`[central-backup] ${warnMsg}`);
        }
      });

      await Promise.race([
        sshTask,
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            try {
              activeConn?.end?.();
            } catch {}
            reject(new Error(`中央库备份超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`));
          }, timeoutMs);
        }),
      ]).finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      });

      const durationMs = Math.max(0, Date.now() - startMs);
      const finishedAt = new Date().toISOString();
      db.prepare(
        `UPDATE central_backup_settings
         SET last_status = 'success',
             last_file_name = ?,
             last_file_size = ?,
             last_sha256 = ?,
             last_error = '',
             last_duration_ms = ?,
             last_success_at = ?,
             last_operator = ?
         WHERE id = 1`
      ).run(fileName, size, sha256, durationMs, finishedAt, operator);

      console.log(`[central-backup] 备份完成：${remoteDir}/${fileName}（${size} 字节，耗时 ${durationMs}ms）`);

      return {
        fileName,
        fileSize: size,
        sha256,
        durationMs,
        remoteDir,
        warnings,
      };
    } catch (error) {
      const sanitizedMsg = recordFailure(error, server);
      const wrapped = new Error(sanitizedMsg);
      wrapped.statusCode = Number(error?.statusCode || error?.status || 500);
      if (error?.code) wrapped.code = error.code;
      throw wrapped;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  activeBackupPromise = execute().finally(() => {
    activeBackupPromise = null;
  });
  return activeBackupPromise;
}

/**
 * 启动中央灾备每日定时调度（先执行 Nginx 配置巡检，再在 enabled=1 时执行中央库备份）。
 * @param {{ scheduleTime?: string, onPatrol?: Function, onBackup?: Function, computeDelayMs?: Function }} [options]
 * @returns {() => void} 停止调度器函数
 */
export function startCentralBackupScheduler(options = {}) {
  const scheduleTime = parseCentralBackupScheduleTime(options.scheduleTime);
  const runPatrol = options.onPatrol || (() => patrolNginxConfigSnapshots());
  const runBackup = options.onBackup || (() => runCentralBackup({ trigger: 'schedule', operator: 'system' }));
  const delayCalculator = options.computeDelayMs || computeNextScheduleDelayMs;

  let timer = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const delayMs = Math.max(10, Number(delayCalculator(scheduleTime, new Date())));
    timer = setTimeout(() => {
      if (stopped) return;
      void runScheduledCycle().finally(() => {
        scheduleNext();
      });
    }, delayMs);
    timer.unref?.();
  };

  const runScheduledCycle = async () => {
    await runRequestContext(
      {
        teamId: SHARED_DEPLOY_WORKSPACE_ID,
        role: 'admin',
        accountId: 'system',
        userId: 'system',
        deviceId: 'central-backup',
        client: 'scheduler',
      },
      async () => {
        if (isNginxConfigPatrolRunning()) {
          console.log('[central-backup] Nginx 配置巡检正在执行，本次定时调度跳过巡检直接检查备份');
        } else {
          try {
            await runPatrol();
          } catch (error) {
            console.warn('[central-backup] 每日 Nginx 配置巡检失败:', sanitizeBackupErrorMessage(error));
          }
        }

        try {
          const status = await getCentralBackupStatus();
          if (status.settings.enabled && status.settings.serverId) {
            await runBackup();
          }
        } catch (error) {
          console.warn('[central-backup] 每日定时备份失败:', sanitizeBackupErrorMessage(error));
        }
      }
    );
  };

  scheduleNext();
  console.log(`[central-backup] 每日灾备调度已启动（每天 ${scheduleTime} 执行配置巡检与中央库备份）`);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
