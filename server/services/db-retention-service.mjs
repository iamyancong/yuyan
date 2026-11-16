/**
 * 数据库保留策略（#42 P2）
 * @description 只清理「日志/过程类」数据，按保留天数删除已经结束、且没有任何功能再依赖的行：
 * - deploy_tasks：已结束（非 queued / running）的部署任务过程记录；
 * - backend_releases：远程目录已清理（status = pruned）且不是当前版本的后端版本行，这类版本本来就不能回滚；
 * - artifact_jobs：已过期（status = expired，文件早已删除）的产物上传任务；
 * - auth_sessions / auth_refresh_nonces：已吊销或刷新令牌已过期的会话及其 nonce（中央模式才有这两张表）。
 *
 * 明确不动：deploy_records（发布记录本身由 DEPLOY_RECORD_KEEP_PER_PROJECT 按数量保留，当前版本 / 回滚依赖它）、
 * 未 pruned 的 backend_releases、openapi_artifacts（有文件下载依赖）、agent_audit / central_audit（哈希链审计，保留策略待定）。
 * 不执行 VACUUM：大库 VACUUM 会长时间锁库并临时占用一倍磁盘，删除后的空闲页 SQLite 会自动复用。
 */
import { getDeployDb } from './deploy-store.mjs';

/** 默认保留天数 */
export const DEFAULT_DB_LOG_RETENTION_DAYS = 90;
/** 默认清理间隔（小时） */
export const DEFAULT_DB_RETENTION_INTERVAL_HOURS = 24;
/** 启动后首次清理延迟：避开启动高峰 */
const DB_RETENTION_INITIAL_DELAY_MS = 3 * 60 * 1000;

/**
 * 解析保留天数，非法值回退默认值；0 表示关闭。
 * @param {string|undefined} raw 环境变量原值
 * @returns {number}
 */
export function parseDbLogRetentionDays(raw = process.env.YUYAN_DB_LOG_RETENTION_DAYS) {
  const text = String(raw ?? '').trim();
  if (!text) return DEFAULT_DB_LOG_RETENTION_DAYS;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DB_LOG_RETENTION_DAYS;
  return value;
}

/**
 * 解析清理间隔小时数，非法值回退默认值，最低 1 小时。
 * @param {string|undefined} raw 环境变量原值
 * @returns {number}
 */
export function parseDbRetentionIntervalHours(raw = process.env.YUYAN_DB_RETENTION_INTERVAL_HOURS) {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DB_RETENTION_INTERVAL_HOURS;
  return Math.max(1, value);
}

/**
 * 判断数据表是否存在。
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {string} name 表名
 * @returns {boolean}
 */
function hasTable(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** 各表的清理规则：where 中的 ? 都是截止时间（ISO 字符串） */
const RULES = [
  {
    table: 'deploy_tasks',
    label: '已结束的部署任务过程记录',
    where: "status NOT IN ('queued', 'running') AND COALESCE(NULLIF(finished_at, ''), heartbeat_at, started_at) < ?",
  },
  {
    table: 'backend_releases',
    label: '已清理远程目录的后端版本行',
    where: "status = 'pruned' AND is_current = 0 AND COALESCE(NULLIF(activated_at, ''), created_at) < ?",
  },
  {
    table: 'artifact_jobs',
    label: '已过期的产物上传任务',
    where: "status = 'expired' AND updated_at < ?",
  },
];

/** 失效会话：已吊销 / 非 active 且最后更新早于截止时间，或刷新令牌在截止时间前就已过期 */
const DEAD_SESSION_WHERE = "(status <> 'active' AND COALESCE(revoked_at, updated_at) < ?) OR refresh_expires_at < ?";

/**
 * 按保留天数清理日志/过程类数据。
 * @param {import('node:sqlite').DatabaseSync} db 数据库
 * @param {{ retentionDays?: number, now?: number, log?: (message: string) => void }} [options]
 * @returns {{ cutoff: string, deleted: Record<string, number>, total: number }}
 */
export function cleanupExpiredDbRows(db, options = {}) {
  const retentionDays = options.retentionDays ?? parseDbLogRetentionDays();
  const log = options.log || ((message) => console.log(`[db-retention] ${message}`));
  const deleted = {};
  if (!(retentionDays > 0)) return { cutoff: '', deleted, total: 0 };
  const cutoff = new Date((options.now ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const rule of RULES) {
      if (!hasTable(db, rule.table)) continue;
      deleted[rule.table] = Number(db.prepare(`DELETE FROM ${rule.table} WHERE ${rule.where}`).run(cutoff).changes || 0);
    }
    if (hasTable(db, 'auth_sessions')) {
      if (hasTable(db, 'auth_refresh_nonces')) {
        deleted.auth_refresh_nonces = Number(
          db.prepare(`DELETE FROM auth_refresh_nonces WHERE session_id IN (SELECT id FROM auth_sessions WHERE ${DEAD_SESSION_WHERE})`).run(cutoff, cutoff).changes || 0
        );
      }
      deleted.auth_sessions = Number(db.prepare(`DELETE FROM auth_sessions WHERE ${DEAD_SESSION_WHERE}`).run(cutoff, cutoff).changes || 0);
    }
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已结束
    }
    throw error;
  }

  const labels = Object.fromEntries(RULES.map((rule) => [rule.table, rule.label]));
  labels.auth_refresh_nonces = '失效会话的刷新 nonce';
  labels.auth_sessions = '已吊销或过期的登录会话';
  const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
  for (const [table, count] of Object.entries(deleted)) {
    if (count > 0) log(`已清理 ${labels[table]} ${count} 行（${table}，早于 ${cutoff}）`);
  }
  log(total > 0 ? `本轮共清理 ${total} 行（保留 ${retentionDays} 天）` : `没有需要清理的数据（保留 ${retentionDays} 天）`);
  return { cutoff, deleted, total };
}

/**
 * 启动数据库保留策略定时任务。
 * @param {{ initialDelayMs?: number, getDb?: () => Promise<import('node:sqlite').DatabaseSync> }} [options]
 * @returns {() => void} 停止函数
 */
export function startDbRetentionScheduler(options = {}) {
  const retentionDays = parseDbLogRetentionDays();
  if (!(retentionDays > 0)) {
    console.log('[db-retention] YUYAN_DB_LOG_RETENTION_DAYS=0，已关闭数据库过程数据清理');
    return () => {};
  }
  const intervalMs = parseDbRetentionIntervalHours() * 60 * 60 * 1000;
  const getDb = options.getDb || getDeployDb;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      cleanupExpiredDbRows(await getDb(), { retentionDays });
    } catch (error) {
      console.warn('[db-retention] 数据库清理失败:', error);
    } finally {
      running = false;
    }
  };
  const initialTimer = setTimeout(run, options.initialDelayMs ?? DB_RETENTION_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  console.log(`[db-retention] 数据库过程数据清理已启动（保留 ${retentionDays} 天，间隔 ${intervalMs / 3600000} 小时）`);
  return () => {
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
