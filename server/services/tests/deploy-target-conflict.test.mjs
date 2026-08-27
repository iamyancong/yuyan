import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('重复目标返回可恢复 ID，其他工作区的历史目标不阻止当前工作区接管', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-target-conflict-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'deploy-target-conflict-test-secret';

  const store = await import('../deploy-store.mjs');
  const { runRequestContext } = await import('../request-context.mjs');
  t.after(async () => {
    store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = {
    accountId: 'account-a',
    userId: 'user-a',
    deviceId: 'device-a',
    teamId: 'workspace-a',
    role: 'admin',
    client: 'desktop',
    requestId: 'target-conflict-test',
  };
  const server = await runRequestContext(context, () => store.createServer({
    name: '已有项目服务器',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
    defaultDeployRoot: '/home/app/frontend/html',
    defaultNginxConfPath: '/home/nginx/conf/nginx.conf',
  }));
  const instance = await runRequestContext(context, () => store.createNginxInstance(server.id, {
    name: '已有 Nginx',
    instanceType: 'external',
    defaultDeployRoot: '/home/app/frontend/html',
    defaultNginxConfPath: '/home/nginx/conf/nginx.conf',
    nginxTestCommand: '/home/nginx/sbin/nginx -t',
    nginxReloadCommand: '/home/nginx/sbin/nginx -s reload',
  }));
  const payload = {
    projectId: 1001,
    projectSource: 'gitlab',
    projectName: 'Yss Datamiddle Frontend Ai',
    projectDescription: '数据中台主应用',
    projectPath: 'group/yss-datamiddle-frontend-ai',
    repositoryUrl: 'https://gitlab.example/group/yss-datamiddle-frontend-ai.git',
    defaultBranch: 'dev',
    envName: '测试',
    serverId: server.id,
    nginxInstanceId: instance.id,
    deployRoot: '/home/app/frontend/html',
    nginxConfPath: '/home/nginx/conf/nginx.conf',
    nginxSiteManaged: true,
    listenPort: 9999,
    projectType: 'frontend',
  };

  const first = await runRequestContext(context, () => store.createTarget(payload));
  await assert.rejects(
    () => runRequestContext(context, () => store.createTarget(payload)),
    (error) => {
      assert.equal(error.code, 'deploy_target_exists');
      assert.equal(error.status, 409);
      assert.equal(error.details.targetId, first.id);
      return true;
    },
  );

  const db = await store.getDeployDb();
  db.prepare("UPDATE deploy_targets SET team_id = 'stale-workspace' WHERE id = ?").run(first.id);
  const adopted = await runRequestContext(context, () => store.createTarget(payload));
  assert.notEqual(adopted.id, first.id);
  const visibleTargets = await runRequestContext(context, () => store.listTargets({}));
  assert.deepEqual(visibleTargets.map((target) => target.id), [adopted.id]);
});
