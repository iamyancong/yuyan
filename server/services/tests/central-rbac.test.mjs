import assert from 'node:assert/strict';
import test from 'node:test';
import { getRequiredRoles, guardCentralDeployRequest, isDestructiveNameConfirmed } from '../central-deploy-guard.mjs';
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
  assert.deepEqual(getRequiredRoles('POST', '/servers/1/fs/download-ticket'), ['viewer', 'operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/servers/1/fs/size'), ['viewer', 'operator', 'admin']);
  assert.deepEqual(getRequiredRoles('PUT', '/environments/1'), ['admin']);
  assert.deepEqual(getRequiredRoles('DELETE', '/targets/1'), ['admin']);
  assert.deepEqual(getRequiredRoles('GET', '/central-backup'), ['viewer', 'operator', 'admin']);
  assert.deepEqual(getRequiredRoles('GET', '/central-backup/access'), ['viewer', 'operator', 'admin']);
  assert.deepEqual(getRequiredRoles('GET', '/targets/1/nginx-conf/central-snapshot'), ['viewer', 'operator', 'admin']);
  assert.deepEqual(getRequiredRoles('PUT', '/central-backup/settings'), ['admin']);
  assert.deepEqual(getRequiredRoles('POST', '/central-backup/run'), ['operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/central-backup/patrol'), ['operator', 'admin']);
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

function withAllowlist(value, fn) {
  const previous = process.env.YUYAN_SYSTEM_ADMINS;
  if (value == null) delete process.env.YUYAN_SYSTEM_ADMINS;
  else process.env.YUYAN_SYSTEM_ADMINS = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous == null) delete process.env.YUYAN_SYSTEM_ADMINS;
      else process.env.YUYAN_SYSTEM_ADMINS = previous;
    });
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

async function invokeGuard(req) {
  const res = createMockRes();
  let nextCalled = false;
  await new Promise((resolve, reject) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const out = originalJson(body);
      queueMicrotask(resolve);
      return out;
    };
    Promise.resolve(guardCentralDeployRequest(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }
      nextCalled = true;
      resolve();
    })).catch(reject);
  });
  return { res, nextCalled };
}

test('中央灾备门禁：网页版白名单用户即使没有中央团队角色也可 PUT/run/patrol，非白名单 403', async () => {
  const webAdminReq = (method, path) => ({
    method,
    path,
    webGitlabUser: { username: 'yuyan-admin', email: 'yuyan-admin@example.com' },
    query: {},
  });
  const outsiderReq = (method, path) => ({
    method,
    path,
    webGitlabUser: { username: 'bob', email: 'bob@example.com' },
    query: {},
  });

  await withAllowlist('yuyan-admin', async () => {
    for (const [method, pathname] of [
      ['GET', '/central-backup'],
      ['PUT', '/central-backup/settings'],
      ['POST', '/central-backup/run'],
      ['POST', '/central-backup/patrol'],
    ]) {
      const allowed = await invokeGuard(webAdminReq(method, pathname));
      assert.equal(allowed.nextCalled, true, `allow ${method} ${pathname}`);
      assert.equal(allowed.res.statusCode, 200, `allow ${method} ${pathname} status`);

      const denied = await invokeGuard(outsiderReq(method, pathname));
      assert.equal(denied.nextCalled, false, `deny ${method} ${pathname}`);
      assert.equal(denied.res.statusCode, 403, `deny ${method} ${pathname} status`);
      assert.equal(denied.res.body?.error?.code, 'system_admin_required');
    }
  });
});

test('非灾备路由仍按团队角色拦截，viewer 不能写入', async () => {
  const req = { method: 'POST', path: '/targets', query: {} };
  const result = await invokeGuard(req);
  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body?.error?.code, 'forbidden_role');
});
