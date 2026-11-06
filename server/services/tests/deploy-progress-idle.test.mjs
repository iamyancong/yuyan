import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-deploy-progress-idle-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'deploy-progress-idle-test-key';

const store = await import('../deploy-store.mjs');
const controller = await import('../../controllers/deploy-controller.mjs');
const { runRequestContext } = await import('../request-context.mjs');

after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

const createRes = () => ({
  statusCode: 200,
  body: null,
  headersSent: false,
  writableEnded: false,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    this.headersSent = true;
    this.writableEnded = true;
    return this;
  },
  end() {
    this.writableEnded = true;
    return this;
  },
  on() {},
  off() {},
});

const createReq = ({ params = {}, query = {}, headers = {}, body = {} } = {}) => ({
  params,
  query,
  headers,
  body,
  on() {},
  off() {},
});

const context = (teamId = 'team-idle-test') => ({
  accountId: `acc-${teamId}`,
  userId: `user-${teamId}`,
  deviceId: 'device-test',
  teamId,
  role: 'admin',
  client: 'desktop',
  requestId: `req-${teamId}`,
});

test('deploy-progress 无任务且目标存在时返回 200，字段齐全且 running: false', async () => {
  const currentCtx = context('team-progress');
  const server = await runRequestContext(currentCtx, () =>
    store.createServer({
      name: '测试服务器',
      host: '10.88.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
      defaultDeployRoot: '/opt/web',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const instance = await runRequestContext(currentCtx, () =>
    store.createNginxInstance(server.id, {
      name: 'Nginx 实例',
      instanceType: 'external',
      defaultDeployRoot: '/opt/web',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const target = await runRequestContext(currentCtx, () =>
    store.createTarget({
      projectId: 1001,
      projectSource: 'gitlab',
      projectName: '空闲目标测试',
      projectPath: 'group/idle-app',
      repositoryUrl: 'https://gitlab.example/group/idle-app.git',
      defaultBranch: 'main',
      envName: '测试环境',
      serverId: server.id,
      nginxInstanceId: instance.id,
      deployRoot: '/opt/web/idle-app',
      nginxConfPath: '/etc/nginx/conf.d/idle.conf',
      projectType: 'frontend',
    })
  );

  const req = createReq({ params: { id: String(target.id) } });
  const res = createRes();

  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(req, res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.success, true);

  const snapshot = res.body?.data;
  assert.ok(snapshot, '必须返回 snapshot 数据');
  assert.equal(snapshot.targetId, target.id);
  assert.equal(snapshot.taskId, null);
  assert.equal(snapshot.action, 'deploy');
  assert.equal(snapshot.operator, '');
  assert.equal(snapshot.startedAt, '');
  assert.equal(snapshot.currentStage, '');
  assert.equal(snapshot.queued, false);
  assert.equal(snapshot.queuePosition, 0);
  assert.equal(typeof snapshot.queuedCount, 'number');
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.result, null);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.failureCode, '');
  assert.equal(snapshot.failure, null);
  assert.deepEqual(snapshot.events, []);
  assert.equal(typeof snapshot.maxConcurrent, 'number');
  assert.equal(typeof snapshot.runningCount, 'number');
});

test('deploy-progress 目标不存在或非法 targetId 返回 404', async () => {
  const currentCtx = context('team-progress');

  // 1. 目标 ID 不存在
  const reqNotFound = createReq({ params: { id: '999999' } });
  const resNotFound = createRes();
  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(reqNotFound, resNotFound));
  assert.equal(resNotFound.statusCode, 404);
  assert.match(resNotFound.body?.error || '', /部署目标不存在/);

  // 2. 目标 ID 非正整数（0 或负数）
  const reqZero = createReq({ params: { id: '0' } });
  const resZero = createRes();
  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(reqZero, resZero));
  assert.equal(resZero.statusCode, 404);
  assert.match(resZero.body?.error || '', /部署目标不存在/);

  const reqNegative = createReq({ params: { id: '-5' } });
  const resNegative = createRes();
  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(reqNegative, resNegative));
  assert.equal(resNegative.statusCode, 404);
  assert.match(resNegative.body?.error || '', /部署目标不存在/);

  // 3. 目标 ID 为非数字
  const reqInvalid = createReq({ params: { id: 'abc' } });
  const resInvalid = createRes();
  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(reqInvalid, resInvalid));
  assert.equal(resInvalid.statusCode, 404);
  assert.match(resInvalid.body?.error || '', /部署目标不存在/);
});

test('deploy-progress 流式请求或 taskId 不匹配时无任务保持 404', async () => {
  const currentCtx = context('team-progress');

  // 1. stream=1 查询参数且无运行任务 -> 404
  const reqStreamQuery = createReq({ params: { id: '1' }, query: { stream: '1' } });
  const resStreamQuery = createRes();
  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(reqStreamQuery, resStreamQuery));
  assert.equal(resStreamQuery.statusCode, 404);
  assert.match(resStreamQuery.body?.error || '', /该部署目标当前没有运行中的发布任务/);

  // 2. Accept 头为 application/x-ndjson 且无运行任务 -> 404
  const reqStreamHeader = createReq({
    params: { id: '1' },
    headers: { accept: 'application/x-ndjson' },
  });
  const resStreamHeader = createRes();
  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(reqStreamHeader, resStreamHeader));
  assert.equal(resStreamHeader.statusCode, 404);
  assert.match(resStreamHeader.body?.error || '', /该部署目标当前没有运行中的发布任务/);

  // 3. 携带 taskId 但没有对应任务 -> 404
  const reqWithTaskId = createReq({ params: { id: '1' }, query: { taskId: '9999' } });
  const resWithTaskId = createRes();
  await runRequestContext(currentCtx, () => controller.handleGetTargetDeployProgress(reqWithTaskId, resWithTaskId));
  assert.equal(resWithTaskId.statusCode, 404);
  assert.match(resWithTaskId.body?.error || '', /该部署目标当前没有运行中的发布任务/);
});

test('deploy-progress 跨团队隔离：访问其他团队的目标返回 404', async () => {
  const teamACtx = context('team-a');
  const teamBCtx = context('team-b');

  const serverA = await runRequestContext(teamACtx, () =>
    store.createServer({
      name: '团队A服务器',
      host: '10.88.0.2',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
      defaultDeployRoot: '/opt/web',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const instanceA = await runRequestContext(teamACtx, () =>
    store.createNginxInstance(serverA.id, {
      name: 'Nginx A',
      instanceType: 'external',
      defaultDeployRoot: '/opt/web',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const targetA = await runRequestContext(teamACtx, () =>
    store.createTarget({
      projectId: 2001,
      projectSource: 'gitlab',
      projectName: '团队A目标',
      projectPath: 'group/team-a-app',
      repositoryUrl: 'https://gitlab.example/group/team-a-app.git',
      defaultBranch: 'main',
      envName: '测试环境',
      serverId: serverA.id,
      nginxInstanceId: instanceA.id,
      deployRoot: '/opt/web/team-a',
      nginxConfPath: '/etc/nginx/conf.d/team-a.conf',
      projectType: 'frontend',
    })
  );

  // 团队 B 请求团队 A 的目标 -> 隔离返回 404
  const req = createReq({ params: { id: String(targetA.id) } });
  const res = createRes();
  await runRequestContext(teamBCtx, () => controller.handleGetTargetDeployProgress(req, res));

  assert.equal(res.statusCode, 404);
  assert.match(res.body?.error || '', /部署目标不存在/);
});
