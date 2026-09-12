import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('listRecords 支持按发布人 operator 筛选，满足协同审计追溯需求', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-record-audit-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'deploy-record-audit-test-secret';

  const store = await import('../deploy-store.mjs');
  const { runRequestContext } = await import('../request-context.mjs');
  t.after(async () => {
    store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = {
    accountId: 'account-1',
    userId: 'user-1',
    deviceId: 'device-1',
    teamId: 'team-audit-test',
    role: 'admin',
    client: 'desktop',
    requestId: 'record-audit-test',
  };

  const server = await runRequestContext(context, () => store.createServer({
    name: '审计测试服务器',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
    defaultDeployRoot: '/data/web/html',
    defaultNginxConfPath: '/etc/nginx/nginx.conf',
  }));

  const instance = await runRequestContext(context, () => store.createNginxInstance(server.id, {
    name: '测试 Nginx 实例',
    instanceType: 'external',
    defaultDeployRoot: '/data/web/html',
    defaultNginxConfPath: '/etc/nginx/nginx.conf',
    nginxTestCommand: 'nginx -t',
    nginxReloadCommand: 'nginx -s reload',
  }));

  const target = await runRequestContext(context, () => store.createTarget({
    serverId: server.id,
    nginxInstanceId: instance.id,
    projectId: 2001,
    projectSource: 'gitlab',
    projectName: 'audit-demo-project',
    projectPath: 'group/audit-demo-project',
    repositoryUrl: 'https://gitlab.example/group/audit-demo-project.git',
    envName: '生产环境',
    projectType: 'frontend',
    defaultBranch: 'main',
    deployRoot: '/data/web/audit-demo',
    uploadStrategy: 'cleanDeployRoot',
  }));

  // 创建两个不同操作人的发布记录
  await runRequestContext(context, () => store.createRecord({
    targetId: target.id,
    projectId: target.projectId,
    projectName: target.projectName,
    envName: '生产环境',
    branch: 'main',
    status: 'success',
    operator: 'alice',
    startedAt: '2026-09-12T09:00:00.000Z',
    finishedAt: '2026-09-12T09:00:30.000Z',
    action: 'deploy',
  }));

  await runRequestContext(context, () => store.createRecord({
    targetId: target.id,
    projectId: target.projectId,
    projectName: target.projectName,
    envName: '生产环境',
    branch: 'main',
    status: 'success',
    operator: 'bob',
    startedAt: '2026-09-12T09:10:00.000Z',
    finishedAt: '2026-09-12T09:11:00.000Z',
    action: 'deploy',
  }));

  // 查询全部记录
  const allRecords = await runRequestContext(context, () => store.listRecords({ targetId: target.id }));
  assert.equal(allRecords.total, 2);

  // 按 alice 筛选
  const aliceRecords = await runRequestContext(context, () => store.listRecords({
    targetId: target.id,
    operator: 'alice',
  }));
  assert.equal(aliceRecords.total, 1);
  assert.equal(aliceRecords.items[0].operator, 'alice');

  // 按 bob 筛选
  const bobRecords = await runRequestContext(context, () => store.listRecords({
    targetId: target.id,
    operator: 'bob',
  }));
  assert.equal(bobRecords.total, 1);
  assert.equal(bobRecords.items[0].operator, 'bob');

  // 模糊匹配 ali
  const partialRecords = await runRequestContext(context, () => store.listRecords({
    targetId: target.id,
    operator: 'ali',
  }));
  assert.equal(partialRecords.total, 1);
  assert.equal(partialRecords.items[0].operator, 'alice');

  // 不存在操作人
  const noneRecords = await runRequestContext(context, () => store.listRecords({
    targetId: target.id,
    operator: 'charlie',
  }));
  assert.equal(noneRecords.total, 0);
});
