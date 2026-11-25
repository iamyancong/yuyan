import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import express from 'express';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-system-admin-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'system-admin-test-key';
delete process.env.YUYAN_SYSTEM_ADMINS;

const { runRequestContext } = await import('../request-context.mjs');
const { ensureCentralIdentitySchema } = await import('../central-identity-service.mjs');
const store = await import('../deploy-store.mjs');
const {
  parseSystemAdminAllowlist,
  isSystemAdminAllowlistConfigured,
  isPrivilegedCentralBackupPath,
  matchSystemAdminAllowlist,
  resolveSystemAdminAccess,
  assertSystemAdminAccess,
} = await import('../system-admin-service.mjs');

const ALICE_ID = 'gitlab:testhost:101';
const BOB_ID = 'gitlab:testhost:202';

before(async () => {
  const db = await ensureCentralIdentitySchema();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, display_name, username, email, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?), (?, ?, ?, ?, 'active', ?, ?)
  `).run(
    ALICE_ID, 'Alice Admin', 'alice', 'alice@example.com', now, now,
    BOB_ID, 'Bob Admin', 'bob', 'bob@example.com', now, now,
  );
  db.prepare(`
    INSERT INTO identity_links (user_id, provider, provider_host, external_user_id, external_username, created_at, updated_at)
    VALUES (?, 'gitlab', 'http://gitlab.test', '101', 'alice', ?, ?),
           (?, 'gitlab', 'http://gitlab.test', '202', 'Bob', ?, ?)
  `).run(ALICE_ID, now, now, BOB_ID, now, now);
});

after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

function withAllowlist(value, fn) {
  const previous = process.env.YUYAN_SYSTEM_ADMINS;
  if (value == null) delete process.env.YUYAN_SYSTEM_ADMINS;
  else process.env.YUYAN_SYSTEM_ADMINS = value;
  const restore = () => {
    if (previous == null) delete process.env.YUYAN_SYSTEM_ADMINS;
    else process.env.YUYAN_SYSTEM_ADMINS = previous;
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

function asUser(userId, fn, extra = {}) {
  return runRequestContext({
    accountId: userId,
    userId,
    deviceId: 'device-test',
    teamId: 'legacy-team',
    role: extra.role || 'admin',
    client: 'desktop',
    requestId: `req-${userId}`,
  }, fn);
}

test('parseSystemAdminAllowlist: 逗号分隔、忽略大小写与空白，兼容中文逗号和分号', () => {
  assert.deepEqual(parseSystemAdminAllowlist(undefined), []);
  assert.deepEqual(parseSystemAdminAllowlist(''), []);
  assert.deepEqual(parseSystemAdminAllowlist('  '), []);
  assert.deepEqual(parseSystemAdminAllowlist('Alice, bob@example.com'), ['alice', 'bob@example.com']);
  assert.deepEqual(parseSystemAdminAllowlist(' alice ，Bob；Carol\nDave '), ['alice', 'bob', 'carol', 'dave']);
  assert.equal(isSystemAdminAllowlistConfigured(''), false);
  assert.equal(isSystemAdminAllowlistConfigured('alice'), true);
});

test('isPrivilegedCentralBackupPath: 四个接口受门禁，access 探测接口不受', () => {
  assert.equal(isPrivilegedCentralBackupPath('/central-backup'), true);
  assert.equal(isPrivilegedCentralBackupPath('/central-backup/settings'), true);
  assert.equal(isPrivilegedCentralBackupPath('/central-backup/run'), true);
  assert.equal(isPrivilegedCentralBackupPath('/central-backup/patrol'), true);
  assert.equal(isPrivilegedCentralBackupPath('/central-backup/access'), false);
  assert.equal(isPrivilegedCentralBackupPath('/targets/1/nginx-conf/central-snapshot'), false);
});

test('matchSystemAdminAllowlist: 用户名与邮箱忽略大小写', () => {
  const allowlist = parseSystemAdminAllowlist('Alice, bob@example.com');
  assert.equal(matchSystemAdminAllowlist(['alice'], allowlist), true);
  assert.equal(matchSystemAdminAllowlist(['ALICE'], allowlist), true);
  assert.equal(matchSystemAdminAllowlist(['bob@EXAMPLE.com'], allowlist), true);
  assert.equal(matchSystemAdminAllowlist(['carol'], allowlist), false);
  assert.equal(matchSystemAdminAllowlist(['alice'], []), false);
});

test('未配置白名单时 fail closed：断言拒绝，探测返回未配置', async () => {
  await withAllowlist(undefined, async () => {
    const access = await asUser(ALICE_ID, () => resolveSystemAdminAccess());
    assert.deepEqual(access, { configured: false, isSystemAdmin: false });
    await assert.rejects(
      () => asUser(ALICE_ID, () => assertSystemAdminAccess()),
      (error) => {
        assert.equal(error.code, 'system_admin_unconfigured');
        assert.equal(error.status, 403);
        assert.equal(error.message, '未配置系统管理员');
        return true;
      },
    );
  });
});

test('白名单内的用户名或邮箱放行，其他 admin 拒绝', async () => {
  await withAllowlist('ALICE, other@example.com', async () => {
    const allowed = await asUser(ALICE_ID, () => resolveSystemAdminAccess());
    assert.deepEqual(allowed, { configured: true, isSystemAdmin: true });
    await asUser(ALICE_ID, () => assertSystemAdminAccess());

    const denied = await asUser(BOB_ID, () => resolveSystemAdminAccess());
    assert.deepEqual(denied, { configured: true, isSystemAdmin: false });
    await assert.rejects(
      () => asUser(BOB_ID, () => assertSystemAdminAccess()),
      (error) => {
        assert.equal(error.code, 'system_admin_required');
        assert.equal(error.status, 403);
        assert.match(error.message, /当前账号不是系统管理员/);
        return true;
      },
    );
  });

  await withAllowlist('alice@example.com', async () => {
    const allowed = await asUser(ALICE_ID, () => resolveSystemAdminAccess());
    assert.equal(allowed.isSystemAdmin, true);
  });
});

test('网页 GitLab 会话可用用户名或邮箱命中白名单', async () => {
  await withAllowlist('carol', async () => {
    const access = await resolveSystemAdminAccess({
      webGitlabUser: { username: 'Carol', email: 'carol@example.com' },
    });
    assert.deepEqual(access, { configured: true, isSystemAdmin: true });
  });
  await withAllowlist('nobody', async () => {
    const access = await resolveSystemAdminAccess({
      webGitlabUser: { username: 'Carol', email: 'carol@example.com' },
    });
    assert.equal(access.isSystemAdmin, false);
  });
});


async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('HTTP：未配置时四个接口 403，access 始终 200；白名单内放行，其他 admin 403', async () => {
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    const userId = String(req.headers['x-test-user-id'] || '');
    const role = String(req.headers['x-test-role'] || 'admin');
    if (req.headers['x-test-gitlab-user']) {
      req.webGitlabUser = JSON.parse(String(req.headers['x-test-gitlab-user']));
    }
    if (!userId) {
      next();
      return;
    }
    await runRequestContext({
      accountId: userId,
      userId,
      deviceId: 'device-http',
      teamId: 'legacy-team',
      role,
      client: 'desktop',
      requestId: 'http-test',
    }, () => new Promise((resolve) => {
      const originalEnd = _res.end.bind(_res);
      _res.end = (...args) => {
        originalEnd(...args);
        resolve();
      };
      next();
    }));
  });
  app.use(async (req, res, next) => {
    try {
      if (
        req.path === '/central-backup'
        || req.path === '/central-backup/settings'
        || req.path === '/central-backup/run'
        || req.path === '/central-backup/patrol'
      ) {
        await assertSystemAdminAccess(req);
      }
      next();
    } catch (error) {
      res.status(Number(error.status || error.statusCode || 403)).json({
        success: false,
        error: error.message,
        code: error.code,
      });
    }
  });
  app.get('/central-backup/access', async (req, res) => {
    const access = await resolveSystemAdminAccess(req);
    res.json({ success: true, data: access });
  });
  app.get('/central-backup', (_req, res) => res.json({ success: true, data: { ok: true } }));
  app.put('/central-backup/settings', (_req, res) => res.json({ success: true, data: { ok: true } }));
  app.post('/central-backup/run', (_req, res) => res.json({ success: true, data: { ok: true } }));
  app.post('/central-backup/patrol', (_req, res) => res.json({ success: true, data: { ok: true } }));

  const { base, close } = await listen(app);
  const call = async (method, pathname, headers = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { Accept: 'application/json', ...headers },
    });
    return { status: response.status, body: await response.json() };
  };
  const alice = { 'x-test-user-id': ALICE_ID, 'x-test-role': 'admin' };
  const bob = { 'x-test-user-id': BOB_ID, 'x-test-role': 'admin' };

  try {
    await withAllowlist(undefined, async () => {
      const access = await call('GET', '/central-backup/access', alice);
      assert.equal(access.status, 200);
      assert.deepEqual(access.body.data, { configured: false, isSystemAdmin: false });

      for (const [method, pathname] of [
        ['GET', '/central-backup'],
        ['PUT', '/central-backup/settings'],
        ['POST', '/central-backup/run'],
        ['POST', '/central-backup/patrol'],
      ]) {
        const result = await call(method, pathname, alice);
        assert.equal(result.status, 403, `${method} ${pathname}`);
        assert.equal(result.body.code, 'system_admin_unconfigured');
        assert.equal(result.body.error, '未配置系统管理员');
      }
    });

    await withAllowlist('alice', async () => {
      const allowedAccess = await call('GET', '/central-backup/access', alice);
      assert.equal(allowedAccess.status, 200);
      assert.deepEqual(allowedAccess.body.data, { configured: true, isSystemAdmin: true });

      const deniedAccess = await call('GET', '/central-backup/access', bob);
      assert.equal(deniedAccess.status, 200);
      assert.deepEqual(deniedAccess.body.data, { configured: true, isSystemAdmin: false });

      for (const [method, pathname] of [
        ['GET', '/central-backup'],
        ['PUT', '/central-backup/settings'],
        ['POST', '/central-backup/run'],
        ['POST', '/central-backup/patrol'],
      ]) {
        const allowed = await call(method, pathname, alice);
        assert.equal(allowed.status, 200, `alice ${method} ${pathname}`);
        const denied = await call(method, pathname, bob);
        assert.equal(denied.status, 403, `bob ${method} ${pathname}`);
        assert.equal(denied.body.code, 'system_admin_required');
      }
    });
  } finally {
    await close();
  }
});

test('定时备份/巡检源码不经过 HTTP 系统管理员门禁', async () => {
  const scheduler = await fs.readFile(path.join(import.meta.dirname, '../central-backup-service.mjs'), 'utf8');
  assert.match(scheduler, /startCentralBackupScheduler/);
  assert.doesNotMatch(scheduler, /assertSystemAdminAccess|requireSystemAdmin|YUYAN_SYSTEM_ADMINS/);
});
