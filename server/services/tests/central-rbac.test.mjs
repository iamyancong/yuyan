import assert from 'node:assert/strict';
import test from 'node:test';
import { getRequiredRoles, isDestructiveNameConfirmed } from '../central-deploy-guard.mjs';
import {
  getRequestContext,
  runRequestContext,
  SHARED_DEPLOY_WORKSPACE_ID,
  useSharedDeployWorkspace,
} from '../request-context.mjs';

test('viewer、operator、admin 权限矩阵覆盖查询、普通写入和管理/删除操作', () => {
  assert.deepEqual(getRequiredRoles('GET', '/targets'), ['viewer', 'operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/targets/1/deploy'), ['operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/records/1/rollback'), ['operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/servers'), ['admin']);
  assert.deepEqual(getRequiredRoles('PUT', '/environments/1'), ['admin']);
  assert.deepEqual(getRequiredRoles('DELETE', '/targets/1'), ['admin']);
  assert.equal(isDestructiveNameConfirmed('DELETE', 'target', '', 'demo'), false);
  assert.equal(isDestructiveNameConfirmed('DELETE', 'target', 'other', 'demo'), false);
  assert.equal(isDestructiveNameConfirmed('DELETE', 'target', 'demo', 'demo'), true);
});

test('部署 v2 路由只覆盖共享部署作用域并保留账号与设备身份', async () => {
  const identityContext = {
    accountId: 'account-alice',
    userId: 'user-alice',
    deviceId: 'device-mac',
    teamId: 'account-private-space',
    role: 'viewer',
    client: 'desktop',
    requestId: 'request-shared-deploy',
  };
  await runRequestContext(identityContext, () => new Promise((resolve, reject) => {
    useSharedDeployWorkspace({}, {}, () => {
      try {
        const context = getRequestContext();
        assert.equal(context.teamId, SHARED_DEPLOY_WORKSPACE_ID);
        assert.equal(context.role, 'admin');
        assert.equal(context.accountId, identityContext.accountId);
        assert.equal(context.deviceId, identityContext.deviceId);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }));
  assert.equal(getRequestContext().legacy, true);
});
