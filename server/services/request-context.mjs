/**
 * 中央请求身份上下文。
 * @description 使用 AsyncLocalStorage 在控制器与存储层之间传递账号、设备和内部数据边界。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const requestContextStorage = new AsyncLocalStorage();

/** 全员共享的中央部署工作区 ID。 */
export const SHARED_DEPLOY_WORKSPACE_ID = 'legacy-team';

/** 在当前异步调用链中运行身份上下文。 */
export function runRequestContext(context, callback) {
  return requestContextStorage.run(Object.freeze({ ...context }), callback);
}

/** 读取当前请求身份；旧接口进入不可继承的兼容隔离空间。 */
export function getRequestContext() {
  return requestContextStorage.getStore() || {
    accountId: 'legacy-disabled',
    userId: 'legacy-disabled',
    deviceId: 'legacy-device',
    teamId: 'legacy-team',
    role: 'viewer',
    client: 'desktop',
    requestId: '',
    legacy: true,
  };
}

/** 读取当前账号的数据隔离 ID。 */
export function getRequestTeamId() {
  return String(getRequestContext().teamId || SHARED_DEPLOY_WORKSPACE_ID);
}

/**
 * 将已认证账号切换到全员共享的中央部署工作区。
 * @description 仅挂载在部署 v2 路由，不改变账号、设备、Agent 或其他中央 API 的身份作用域。
 * @param {import('express').Request} _req Express 请求
 * @param {import('express').Response} _res Express 响应
 * @param {import('express').NextFunction} next 后续中间件
 * @returns {void}
 */
export function useSharedDeployWorkspace(_req, _res, next) {
  const context = getRequestContext();
  runRequestContext(
    {
      ...context,
      teamId: SHARED_DEPLOY_WORKSPACE_ID,
      role: 'admin',
    },
    next,
  );
}

/** 断言当前请求具备指定角色。 */
export function requireRequestRole(allowedRoles) {
  const context = getRequestContext();
  if (!allowedRoles.includes(context.role)) {
    const error = new Error(`当前角色 ${context.role || 'unknown'} 无权执行此操作`);
    error.code = 'forbidden_role';
    error.status = 403;
    throw error;
  }
  return context;
}
