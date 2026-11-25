/**
 * Nginx 配置中央快照与每日巡检服务（#69）
 * @description 仅保存每份纳管配置文件的最新快照（按 server_id + file_path 唯一覆盖），
 * 不保存历史版本、不读私钥，巡检时同时探测 ssl_certificate 证书到期时间。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import {
  getDeployDb,
  getServerWithCredential,
} from './deploy-store.mjs';
import { isSudoUnavailable, readRemoteTextSafe } from './nginx-conf-history.mjs';
import { getRequestTeamId, SHARED_DEPLOY_WORKSPACE_ID } from './request-context.mjs';
import { execSsh, getSftp, shellQuote, withSsh } from './ssh-service.mjs';

/** 单个配置快照大小上限（1MB） */
export const NGINX_SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** 托管实例 sitesDir 单次最多列举的站点配置文件数 */
const PATROL_SITES_DIR_LIMIT = 200;

/** 巡检结果列表截断上限，防止 last_patrol_json 膨胀 */
const PATROL_MAX_SKIPPED = 100;
const PATROL_MAX_FAILURES = 50;
const PATROL_MAX_CERTS = 200;

/** 进程内巡检互斥锁 */
let activePatrolPromise = null;

/**
 * 当前是否有 Nginx 配置巡检任务正在执行。
 * @returns {boolean}
 */
export function isNginxConfigPatrolRunning() {
  return Boolean(activePatrolPromise);
}

/**
 * 校验并规范化 Nginx 配置文件 POSIX 绝对路径。
 * @param {string} filePath - 原始文件路径
 * @returns {string} 规范化路径
 */
export function normalizeSnapshotFilePath(filePath) {
  if (typeof filePath !== 'string') {
    throw Object.assign(new Error('配置文件路径必须是字符串'), { statusCode: 400, code: 'NGINX_CONF_PATH_INVALID' });
  }
  const trimmed = filePath.trim();
  if (!trimmed || !trimmed.startsWith('/') || trimmed.includes('\\') || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw Object.assign(new Error('配置文件路径无效'), { statusCode: 400, code: 'NGINX_CONF_PATH_INVALID' });
  }
  const rawSegments = trimmed.split('/').filter(Boolean);
  if (rawSegments.some((seg) => seg === '.' || seg === '..')) {
    throw Object.assign(new Error('配置文件路径不能包含 . 或 .. 段'), { statusCode: 400, code: 'NGINX_CONF_PATH_INVALID' });
  }
  const normalized = path.posix.normalize(trimmed);
  if (!normalized || normalized === '/' || normalized.endsWith('/')) {
    throw Object.assign(new Error('配置文件路径不能是根目录或目录路径'), { statusCode: 400, code: 'NGINX_CONF_PATH_INVALID' });
  }
  return normalized;
}

/**
 * 剥离单行中的 Nginx `#` 注释（保留引号内字符）。
 * @param {string} line - 单行配置
 * @returns {string} 去除注释后的文本
 */
function stripNginxLineComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && i + 1 < line.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * 从 Nginx 配置文本中提取 `ssl_certificate <path>;` 路径（绝不匹配 `ssl_certificate_key`）。
 * @param {string} content - Nginx 配置内容
 * @returns {string[]} 去重后的证书绝对路径列表
 */
export function extractSslCertificatePaths(content) {
  const seen = new Set();
  const paths = [];
  const directiveRe = /(?:^|[;\s{}])ssl_certificate\s+(?:"([^"]+)"|'([^']+)'|([^\s;{}'"]+))\s*;/g;
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = stripNginxLineComment(rawLine);
    if (!line.includes('ssl_certificate')) continue;
    directiveRe.lastIndex = 0;
    let match;
    while ((match = directiveRe.exec(line)) !== null) {
      const candidate = String(match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (!candidate || candidate.includes('$')) continue;
      try {
        const normalized = normalizeSnapshotFilePath(candidate);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          paths.push(normalized);
        }
      } catch {
        // 忽略相对路径或含非法字符的占位路径
      }
    }
  }
  return paths;
}

/**
 * 解析 `openssl x509 -enddate -noout` 输出中的到期时间为 ISO 字符串。
 * @param {string} stdout - openssl 命令标准输出
 * @returns {string|null} ISO 时间字符串，解析失败返回 null
 */
export function parseOpenSslEndDate(stdout) {
  const text = String(stdout || '');
  const matched = text.match(/notAfter\s*=\s*([^\r\n]+)/i);
  if (!matched) return null;
  const parsed = Date.parse(matched[1].trim());
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * 解析部署目标可编辑的 Nginx 配置文件路径。
 * @param {Object} targetRow - 部署目标行（snake_case 或 camelCase）
 * @param {Object|null} nginxInstance - 关联 Nginx 实例
 * @returns {string} 配置文件路径
 */
function resolveTargetEditableNginxConfPath(targetRow, nginxInstance) {
  const rawPath = String(targetRow?.nginx_conf_path ?? targetRow?.nginxConfPath ?? '').trim();
  if (rawPath) return rawPath;
  const instanceType = nginxInstance?.instance_type ?? nginxInstance?.instanceType;
  if (instanceType === 'managed') {
    const nginxRoot = String(nginxInstance?.nginx_root ?? nginxInstance?.nginxRoot ?? '/opt/yuyan/nginx').replace(/\/+$/, '');
    return `${nginxRoot}/conf/nginx.conf`;
  }
  return '';
}

/**
 * 解析托管实例主配置路径与 sitesDir。
 * @param {Object} instanceRow - 实例数据库行
 * @returns {{ mainConfPath: string, sitesDir: string }}
 */
function resolveManagedInstancePaths(instanceRow) {
  const baseRoot = String(instanceRow?.base_root || '/opt/yuyan').trim().replace(/\/+$/, '');
  const nginxRoot = String(instanceRow?.nginx_root || `${baseRoot}/nginx`).trim().replace(/\/+$/, '');
  const sitesDir = String(instanceRow?.sites_dir || `${nginxRoot}/conf/conf.d`).trim().replace(/\/+$/, '');
  return {
    mainConfPath: `${nginxRoot}/conf/nginx.conf`,
    sitesDir,
  };
}

/**
 * 解析 JSON 数组字段。
 * @param {string|null|undefined} raw - JSON 字符串
 * @returns {Array}
 */
function parseCertInfoJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 写入或更新一条 Nginx 配置中央快照。
 * @description 内容超过 1MB 跳过；SHA-256 未变化时仅在 instanceId/targetId 关联变化时更新关联列，不重复写入正文与更新时间。
 * @param {Object} params - 快照参数
 * @param {number} params.serverId - 服务器 ID
 * @param {number|null} [params.instanceId=null] - Nginx 实例 ID
 * @param {number|null} [params.targetId=null] - 部署目标 ID
 * @param {string} params.filePath - 配置文件绝对路径
 * @param {string} params.content - 配置文件正文
 * @param {string} params.source - 来源（save | sync | init | patrol | refresh）
 * @param {string} [params.operator=''] - 操作人
 * @param {Array<{path: string, notAfter: string|null}>} [params.certInfo] - 证书到期摘要
 * @param {string} [params.teamId] - 工作区 ID
 * @returns {Promise<{ changed: boolean, skipped?: string, sha256?: string, size?: number, filePath: string }>}
 */
export async function upsertNginxConfigSnapshot({
  serverId,
  instanceId = null,
  targetId = null,
  filePath,
  content,
  source,
  operator = '',
  certInfo,
  teamId,
}) {
  const numericServerId = Number(serverId);
  if (!Number.isInteger(numericServerId) || numericServerId <= 0) {
    throw Object.assign(new Error('serverId 必须是正整数'), { statusCode: 400, code: 'INVALID_SERVER_ID' });
  }
  const normalizedPath = normalizeSnapshotFilePath(filePath);
  if (typeof content !== 'string') {
    throw Object.assign(new Error('配置快照内容必须是字符串'), { statusCode: 400, code: 'INVALID_SNAPSHOT_CONTENT' });
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > NGINX_SNAPSHOT_MAX_BYTES) {
    return { changed: false, skipped: 'too_large', size, filePath: normalizedPath };
  }

  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const db = await getDeployDb();
  const effectiveTeamId = String(teamId || getRequestTeamId() || SHARED_DEPLOY_WORKSPACE_ID);
  const nextInstanceId = Number(instanceId || 0) > 0 ? Number(instanceId) : null;
  const nextTargetId = Number(targetId || 0) > 0 ? Number(targetId) : null;
  const existing = db
    .prepare(
      `SELECT id, sha256, instance_id, target_id, cert_info_json
       FROM nginx_config_snapshots
       WHERE server_id = ? AND file_path = ?`
    )
    .get(numericServerId, normalizedPath);

  if (existing && existing.sha256 === sha256) {
    const resolvedInstanceId = nextInstanceId ?? (existing.instance_id ?? null);
    const resolvedTargetId = nextTargetId ?? (existing.target_id ?? null);
    if (resolvedInstanceId !== (existing.instance_id ?? null) || resolvedTargetId !== (existing.target_id ?? null)) {
      db.prepare(
        `UPDATE nginx_config_snapshots
         SET instance_id = ?, target_id = ?
         WHERE id = ?`
      ).run(resolvedInstanceId, resolvedTargetId, Number(existing.id));
    }
    return { changed: false, sha256, size, filePath: normalizedPath };
  }

  const ts = new Date().toISOString();
  const normalizedSource = String(source || 'patrol').trim() || 'patrol';
  const normalizedOperator = String(operator || '').trim();
  const certInfoJson = Array.isArray(certInfo) ? JSON.stringify(certInfo) : (existing?.cert_info_json ?? null);

  db.prepare(
    `INSERT INTO nginx_config_snapshots
     (server_id, instance_id, target_id, file_path, content, sha256, size, source, cert_info_json, team_id, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, file_path) DO UPDATE SET
       instance_id = COALESCE(excluded.instance_id, nginx_config_snapshots.instance_id),
       target_id = COALESCE(excluded.target_id, nginx_config_snapshots.target_id),
       content = excluded.content,
       sha256 = excluded.sha256,
       size = excluded.size,
       source = excluded.source,
       cert_info_json = CASE
         WHEN excluded.cert_info_json IS NOT NULL THEN excluded.cert_info_json
         ELSE nginx_config_snapshots.cert_info_json
       END,
       team_id = excluded.team_id,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).run(
    numericServerId,
    nextInstanceId,
    nextTargetId,
    normalizedPath,
    content,
    sha256,
    size,
    normalizedSource,
    certInfoJson,
    effectiveTeamId,
    ts,
    normalizedOperator
  );

  return { changed: true, sha256, size, filePath: normalizedPath };
}

/**
 * 在远端使用 sudo 感知方式检测单个 SSL 证书到期时间（绝不读取私钥）。
 * @param {Object} conn - SSH 连接
 * @param {{ certPath: string, useSudo: boolean, signal?: AbortSignal }} params - 参数
 * @returns {Promise<string|null>} ISO 到期时间或 null
 */
async function probeCertificateExpiry(conn, { certPath, useSudo, signal }) {
  const run = (sudo) =>
    execSsh(
      conn,
      `${sudo ? 'sudo -n ' : ''}openssl x509 -enddate -noout -in ${shellQuote(certPath)}`,
      {
        label: `读取证书到期时间 ${certPath}`,
        allowFailure: true,
        timeoutMs: 10_000,
        signal,
      }
    );
  let result = await run(Boolean(useSudo));
  if (useSudo && isSudoUnavailable(result)) {
    result = await run(false);
  }
  if (result.code !== 0) return null;
  return parseOpenSslEndDate(result.stdout);
}

/**
 * 列出托管实例 sitesDir 下的 `*.conf` 普通文件名。
 * @param {Object} sftp - SFTP 会话
 * @param {string} sitesDir - 站点配置目录
 * @returns {Promise<string[]>} 安全文件名列表
 */
async function listManagedSiteConfNames(sftp, sitesDir) {
  const entries = await new Promise((resolve, reject) => {
    sftp.readdir(sitesDir, (error, list) => {
      if (error) reject(error);
      else resolve(Array.isArray(list) ? list : []);
    });
  }).catch(() => []);
  const names = [];
  for (const entry of entries) {
    const name = String(entry?.filename || '');
    if (!name || name.startsWith('.')) continue;
    if (!name.endsWith('.conf')) continue;
    if (name.includes('/') || name.includes('\\') || name.includes('..') || /[\u0000-\u001f\u007f]/.test(name)) continue;
    if (entry?.attrs?.isDirectory?.() || entry?.attrs?.isSymbolicLink?.()) continue;
    names.push(name);
    if (names.length >= PATROL_SITES_DIR_LIMIT) break;
  }
  return names;
}

/**
 * 为单台服务器执行 Promise 超时封装。
 * @param {Promise<*>} taskPromise - 任务 Promise
 * @param {number} timeoutMs - 超时毫秒
 * @param {AbortController} controller - 取消控制器
 * @param {() => void} [onTimeout] - 超时钩子
 * @returns {Promise<*>}
 */
function withPatrolTimeout(taskPromise, timeoutMs, controller, onTimeout) {
  if (!(timeoutMs > 0)) return taskPromise;
  let timer;
  return Promise.race([
    taskPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        try {
          onTimeout?.();
        } catch {}
        reject(new Error(`服务器巡检超时（${timeoutMs}ms）`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 巡检全部已登记服务器的纳管 Nginx 配置与证书到期时间。
 * @param {{ concurrency?: number, perServerTimeoutMs?: number, withSsh?: Function, teamId?: string }} [options]
 * @returns {Promise<Object>} 巡检摘要
 */
export async function patrolNginxConfigSnapshots(options = {}) {
  if (activePatrolPromise) {
    throw Object.assign(new Error('Nginx 配置巡检正在执行'), {
      statusCode: 409,
      status: 409,
      code: 'nginx_patrol_running',
    });
  }

  const execute = async () => {
    const concurrency = Math.max(1, Math.min(Number(options.concurrency || 3), 8));
    const perServerTimeoutMs = Math.max(1000, Number(options.perServerTimeoutMs || 60_000));
    const sshRunner = options.withSsh || withSsh;
    const effectiveTeamId = String(options.teamId || getRequestTeamId() || SHARED_DEPLOY_WORKSPACE_ID);
    const startedAt = new Date().toISOString();
    const db = await getDeployDb();

    const servers = db
      .prepare('SELECT id, name, host, port, use_sudo FROM deploy_servers WHERE team_id = ? ORDER BY sort_order ASC, id ASC')
      .all(effectiveTeamId);
    const instances = db
      .prepare('SELECT * FROM nginx_instances WHERE team_id = ?')
      .all(effectiveTeamId);
    const targets = db
      .prepare('SELECT * FROM deploy_targets WHERE team_id = ?')
      .all(effectiveTeamId);

    const instancesById = new Map(instances.map((row) => [Number(row.id), row]));
    const instancesByServer = new Map();
    for (const inst of instances) {
      const sid = Number(inst.server_id);
      if (!instancesByServer.has(sid)) instancesByServer.set(sid, []);
      instancesByServer.get(sid).push(inst);
    }
    const targetsByServer = new Map();
    for (const t of targets) {
      const sid = Number(t.server_id);
      if (!targetsByServer.has(sid)) targetsByServer.set(sid, []);
      targetsByServer.get(sid).push(t);
    }

    let filesChecked = 0;
    let filesUpdated = 0;
    const filesSkipped = [];
    const failures = [];
    const certs = [];
    const certDedupKeys = new Set();

    const processServer = async (serverRow) => {
      const serverId = Number(serverRow.id);
      const serverInstances = instancesByServer.get(serverId) || [];
      const serverTargets = targetsByServer.get(serverId) || [];
      const managedInstances = serverInstances.filter((inst) => inst.instance_type === 'managed');

      // 收集去重后的待巡检文件路径 map: filePath -> { filePath, instanceId, targetId, useSudo }
      const fileMap = new Map();
      const addCandidate = (rawPath, meta) => {
        try {
          const normalized = normalizeSnapshotFilePath(rawPath);
          const existing = fileMap.get(normalized);
          if (!existing) {
            fileMap.set(normalized, {
              filePath: normalized,
              instanceId: meta.instanceId ?? null,
              targetId: meta.targetId ?? null,
              useSudo: Boolean(meta.useSudo),
            });
          } else {
            if (!existing.instanceId && meta.instanceId) existing.instanceId = meta.instanceId;
            if (!existing.targetId && meta.targetId) existing.targetId = meta.targetId;
            if (meta.useSudo) existing.useSudo = true;
          }
        } catch {
          // 非法路径忽略
        }
      };

      for (const inst of serverInstances) {
        const instSudo = Boolean(inst.use_sudo || serverRow.use_sudo);
        if (inst.instance_type === 'managed') {
          const { mainConfPath } = resolveManagedInstancePaths(inst);
          addCandidate(mainConfPath, { instanceId: Number(inst.id), useSudo: instSudo });
        } else if (inst.default_nginx_conf_path) {
          addCandidate(inst.default_nginx_conf_path, { instanceId: Number(inst.id), useSudo: instSudo });
        }
      }

      const defaultManaged = managedInstances[0] || null;
      for (const target of serverTargets) {
        let inst = target.nginx_instance_id ? instancesById.get(Number(target.nginx_instance_id)) || null : null;
        if (inst && inst.instance_type !== 'managed' && defaultManaged) {
          const baseRoot = String(defaultManaged.base_root || '/opt/yuyan');
          const confRaw = String(target.nginx_conf_path || '').trim();
          if (confRaw.startsWith(baseRoot) || confRaw.startsWith('/opt/yuyan')) {
            inst = defaultManaged;
          }
        }
        const confPath = resolveTargetEditableNginxConfPath(target, inst);
        if (confPath) {
          addCandidate(confPath, {
            instanceId: inst ? Number(inst.id) : (target.nginx_instance_id ? Number(target.nginx_instance_id) : null),
            targetId: Number(target.id),
            useSudo: Boolean(inst?.use_sudo || serverRow.use_sudo),
          });
        }
      }

      if (fileMap.size === 0 && managedInstances.length === 0) return;

      const serverWithCredential = await getServerWithCredential(serverId);
      if (!serverWithCredential) return;

      const controller = new AbortController();
      let activeConn = null;
      const certCache = new Map();

      try {
        await withPatrolTimeout(
          sshRunner(serverWithCredential, async (conn) => {
            activeConn = conn;
            if (managedInstances.length > 0) {
              const sftp = await getSftp(conn).catch(() => null);
              if (sftp) {
                for (const inst of managedInstances) {
                  if (controller.signal.aborted) break;
                  const { sitesDir } = resolveManagedInstancePaths(inst);
                  const confNames = await listManagedSiteConfNames(sftp, sitesDir);
                  for (const name of confNames) {
                    addCandidate(path.posix.join(sitesDir, name), {
                      instanceId: Number(inst.id),
                      useSudo: Boolean(inst.use_sudo || serverRow.use_sudo),
                    });
                  }
                }
              }
            }

            for (const item of fileMap.values()) {
              if (controller.signal.aborted) break;
              let readResult;
              try {
                readResult = await readRemoteTextSafe(conn, {
                  filePath: item.filePath,
                  useSudo: item.useSudo,
                  maxBytes: NGINX_SNAPSHOT_MAX_BYTES,
                  allowMissing: true,
                });
              } catch (readError) {
                const reason = readError?.code === 'ERR_FILE_TOO_LARGE'
                  ? 'too_large'
                  : String(readError?.code || readError?.message || 'read_failed');
                if (filesSkipped.length < PATROL_MAX_SKIPPED) {
                  filesSkipped.push({ path: item.filePath, reason });
                }
                continue;
              }

              if (!readResult.exists) {
                // 目标文件不存在时保留已有快照不删除
                continue;
              }

              filesChecked += 1;
              const certPaths = extractSslCertificatePaths(readResult.content);
              const certInfo = [];
              for (const certPath of certPaths) {
                if (!certCache.has(certPath)) {
                  const notAfter = await probeCertificateExpiry(conn, {
                    certPath,
                    useSudo: item.useSudo,
                    signal: controller.signal,
                  }).catch(() => null);
                  certCache.set(certPath, notAfter);
                }
                const notAfter = certCache.get(certPath) ?? null;
                certInfo.push({ path: certPath, notAfter });
                const dedupKey = `${serverId}:${certPath}`;
                if (!certDedupKeys.has(dedupKey) && certs.length < PATROL_MAX_CERTS) {
                  certDedupKeys.add(dedupKey);
                  certs.push({
                    serverId,
                    serverName: serverRow.name || '',
                    path: certPath,
                    notAfter,
                  });
                }
              }

              const upsertResult = await upsertNginxConfigSnapshot({
                serverId,
                instanceId: item.instanceId,
                targetId: item.targetId,
                filePath: item.filePath,
                content: readResult.content,
                source: 'patrol',
                operator: 'patrol',
                certInfo,
                teamId: effectiveTeamId,
              });
              if (upsertResult.changed) {
                filesUpdated += 1;
              }
            }
          }),
          perServerTimeoutMs,
          controller,
          () => activeConn?.end?.()
        );
      } catch (error) {
        if (failures.length < PATROL_MAX_FAILURES) {
          failures.push({
            serverId,
            serverName: serverRow.name || `服务器 #${serverId}`,
            error: String(error?.message || error || '巡检失败'),
          });
        }
      }
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, servers.length || 1) }, async () => {
      while (cursor < servers.length) {
        const index = cursor;
        cursor += 1;
        await processServer(servers[index]);
      }
    });
    await Promise.all(workers);

    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      servers: servers.length,
      filesChecked,
      filesUpdated,
      filesSkipped,
      failures,
      certs,
    };

    try {
      db.prepare(
        `INSERT INTO central_backup_settings (id, remote_dir, enabled, last_status)
         VALUES (1, '/bak/wangyancong-yuyan', 0, '')
         ON CONFLICT(id) DO NOTHING`
      ).run();
      db.prepare('UPDATE central_backup_settings SET last_patrol_json = ? WHERE id = 1').run(JSON.stringify(summary));
    } catch (err) {
      console.warn('[nginx-config-snapshot] 写入巡检摘要失败:', err?.message || err);
    }

    return summary;
  };

  activePatrolPromise = execute().finally(() => {
    activePatrolPromise = null;
  });
  return activePatrolPromise;
}

/**
 * 纯查库读取指定服务器和路径对应的 Nginx 配置中央快照（只读、不连 SSH）。
 * @param {{ serverId: number, filePath: string, teamId?: string }} params - 查询参数
 * @returns {Promise<Object>} 快照信息
 */
export async function readNginxConfigSnapshot({ serverId, filePath, teamId }) {
  const numericServerId = Number(serverId);
  const rawConfPath = String(filePath || '').trim();
  if (!Number.isInteger(numericServerId) || numericServerId <= 0 || !rawConfPath) {
    return { exists: false, path: rawConfPath };
  }
  let normalizedPath;
  try {
    normalizedPath = normalizeSnapshotFilePath(rawConfPath);
  } catch {
    return { exists: false, path: rawConfPath };
  }

  const db = await getDeployDb();
  const effectiveTeamId = String(teamId || getRequestTeamId() || SHARED_DEPLOY_WORKSPACE_ID);
  const row = db
    .prepare(
      `SELECT file_path, content, sha256, size, source, cert_info_json, updated_at, updated_by
       FROM nginx_config_snapshots
       WHERE server_id = ? AND file_path = ? AND team_id = ?`
    )
    .get(numericServerId, normalizedPath, effectiveTeamId);

  if (!row) {
    return { exists: false, path: normalizedPath };
  }

  return {
    exists: true,
    path: row.file_path,
    content: row.content,
    sha256: row.sha256,
    size: Number(row.size || 0),
    source: row.source || '',
    updatedAt: row.updated_at || '',
    updatedBy: row.updated_by || '',
    certInfo: parseCertInfoJson(row.cert_info_json),
  };
}
