/** 中央部署 API 的账号资源、RBAC 与设备门禁。 */

import { appendCentralAudit } from './central-identity-service.mjs';
import { getDeployDb } from './deploy-store.mjs';
import { getRequestContext } from './request-context.mjs';

/** 为中央前端发布获取跨进程目标租约。 */
async function acquireTargetLease(context, targetId) {
  const db = await getDeployDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS central_target_locks (
      team_id TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(team_id, target_id)
    )
  `);
  const timestamp = new Date().toISOString();
  db.prepare('DELETE FROM central_target_locks WHERE expires_at <= ?').run(timestamp);
  try {
    db.prepare('INSERT INTO central_target_locks (team_id, target_id, request_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(context.teamId, targetId, context.requestId, new Date(Date.now() + 2 * 60 * 60_000).toISOString(), timestamp);
  } catch {
    const error = new Error('同一部署目标已有其他设备任务执行，请等待其完成');
    error.code = 'target_locked';
    error.status = 409;
    throw error;
  }
  return () => db.prepare('DELETE FROM central_target_locks WHERE team_id = ? AND target_id = ? AND request_id = ?')
    .run(context.teamId, targetId, context.requestId);
}

/** 返回稳定权限错误。 */
function deny(res, status, code, message) {
  res.status(status).json({ success: false, error: { code, message, retryable: false } });
}

/** 根据路由解析需要验证的账号根资源。 */
function resolveResourceLookup(pathname) {
  const definitions = [
    { pattern: /^\/servers\/(\d+)/, sql: 'SELECT id, name FROM deploy_servers WHERE id = ? AND team_id = ?', type: 'server' },
    { pattern: /^\/targets\/(\d+)/, sql: 'SELECT id, project_name AS name FROM deploy_targets WHERE id = ? AND team_id = ?', type: 'target' },
    { pattern: /^\/records\/(\d+)/, sql: 'SELECT id FROM deploy_records WHERE id = ? AND team_id = ?', type: 'record' },
    { pattern: /^\/jdks\/(\d+)/, sql: 'SELECT id FROM build_jdks WHERE id = ? AND team_id = ?', type: 'jdk' },
    { pattern: /^\/environments\/(\d+)/, sql: 'SELECT id FROM deploy_environments WHERE id = ? AND team_id = ?', type: 'environment' },
    { pattern: /^\/nginx-instances\/(\d+)/, sql: 'SELECT id FROM nginx_instances WHERE id = ? AND team_id = ?', type: 'nginx_instance' },
    { pattern: /^\/java-runtimes\/(\d+)/, sql: 'SELECT id FROM server_java_runtimes WHERE id = ? AND team_id = ?', type: 'java_runtime' },
    { pattern: /^\/openapi-artifacts\/(\d+)/, sql: 'SELECT id FROM openapi_artifacts WHERE id = ? AND team_id = ?', type: 'openapi_artifact' },
  ];
  for (const definition of definitions) {
    const match = pathname.match(definition.pattern);
    if (match) return { ...definition, id: Number(match[1]) };
  }
  return null;
}

/** 计算当前路由最低角色。 */
export function getRequiredRoles(method, pathname) {
  if (['GET', 'HEAD'].includes(method)) return ['viewer', 'operator', 'admin'];
  if (method === 'DELETE') return ['admin'];
  if (/^\/(?:servers|environments|jdks|nginx-instances|java-runtimes)(?:\/|$)/.test(pathname)) return ['admin'];
  return ['operator', 'admin'];
}

/** 校验中央删除请求是否携带与当前资源完全一致的二次确认名称。 */
export function isDestructiveNameConfirmed(method, resourceType, expectedName, currentName) {
  if (method !== 'DELETE' || !['server', 'target'].includes(resourceType)) return true;
  const expected = String(expectedName || '').trim();
  return Boolean(expected && expected === String(currentName || '').trim());
}

/** 中央 v2 部署接口统一门禁。 */
export async function guardCentralDeployRequest(req, res, next) {
  try {
    const context = getRequestContext();
    if (/^\/jdks(?:\/|$)/.test(req.path)) {
      deny(res, 410, 'device_local_resource', '本机构建 JDK 按设备管理，请使用雨燕桌面端本地服务');
      return;
    }
    if (req.method === 'POST' && /^\/targets\/\d+\/openapi\/generate$/.test(req.path)) {
      deny(res, 410, 'device_local_resource', 'OpenAPI 必须由发起设备构建并写入设备隔离缓存');
      return;
    }
    const roles = getRequiredRoles(req.method, req.path);
    if (!roles.includes(context.role)) {
      deny(res, 403, 'forbidden_role', `当前 ${context.role} 角色无权执行此操作`);
      return;
    }
    const lookup = resolveResourceLookup(req.path);
    if (lookup) {
      const db = await getDeployDb();
      const resource = db.prepare(lookup.sql).get(lookup.id, context.teamId);
      if (!resource) {
        deny(res, 404, 'resource_not_found', '资源不存在或不属于当前账号');
        return;
      }
      if (!isDestructiveNameConfirmed(req.method, lookup.type, req.query?.expectedName, resource.name)) {
        deny(res, 409, 'destructive_confirmation_mismatch', '删除确认名称与当前资源不一致，请刷新后重新确认');
        return;
      }
    }
    let releaseTargetLease = null;
    if (req.method === 'POST' && /^\/targets\/\d+\/deploy$/.test(req.path)) {
      releaseTargetLease = await acquireTargetLease(context, lookup.id);
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        releaseTargetLease?.();
      };
      res.once('finish', releaseOnce);
      res.once('close', releaseOnce);
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400 && !['GET', 'HEAD'].includes(req.method)) {
        void appendCentralAudit(context, {
          action: `${req.method} ${req.path}`,
          resourceType: lookup?.type || 'collection',
          resourceId: lookup?.id || null,
          result: 'accepted',
        }).catch(() => undefined);
      }
      return originalJson(body);
    };
    next();
  } catch (error) {
    if (error?.status) {
      deny(res, error.status, error.code || 'central_guard_failed', error.message);
      return;
    }
    next(error);
  }
}
