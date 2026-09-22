import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recoverCentralOperationRead } from '../../utils/central-read-recovery.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-task-reconciliation-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'task-reconciliation-test';
const store = await import('../deploy-store.mjs');
const { getDeployTaskReconciliation } = await import('../deploy-task-reconciliation.mjs');
const { runRequestContext } = await import('../request-context.mjs');
const context = { accountId: 'a', userId: 'a', teamId: 'team-a', role: 'operator' };
const inTeam = (callback) => runRequestContext(context, callback);
after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

test('任务成功结果跨重启持久化，对账验证目标及团队隔离', async () => {
  const target = await inTeam(async () => {
    const server = await store.createServer({
      name: 'test',
      host: '127.0.0.1',
      port: 22,
      username: 'test',
      authType: 'password',
      password: 'test',
      defaultBackendRoot: '/tmp',
    });
    return store.createTarget({
      projectId: 1,
      projectName: 'test',
      envName: '测试',
      projectPath: 'team/test',
      repositoryUrl: 'https://git.example/test',
      serverId: server.id,
      deployRoot: '/tmp/test',
      projectType: 'backend',
      artifactPattern: 'target/app.jar',
      serverPort: 18080,
      processMode: 'pid',
    });
  });
  const task = await inTeam(() => store.createPersistentDeployTask({ targetId: target.id, action: 'restart', operator: 'test' }));
  const result = { targetId: target.id, status: 'online', checkedAt: new Date().toISOString() };
  await inTeam(() => store.updatePersistentDeployTask(task.id, { status: 'success', result }));
  store.closeDeployDb();
  const snapshot = await inTeam(() => getDeployTaskReconciliation(target.id, task.id));
  assert.equal(snapshot.running, false);
  assert.deepEqual(snapshot.result, result);
  assert.equal(await inTeam(() => getDeployTaskReconciliation(target.id + 100, task.id)), null);
  assert.equal(await runRequestContext({ ...context, teamId: 'team-b' }, () => getDeployTaskReconciliation(target.id, task.id)), null);

  const interrupted = await inTeam(() => store.createPersistentDeployTask({ targetId: target.id, action: 'deploy' }));
  store.closeDeployDb();
  const recovered = await inTeam(() => getDeployTaskReconciliation(target.id, interrupted.id));
  assert.equal(recovered.running, false);
  assert.ok(recovered.error);
  assert.equal(recovered.result, null);
});

test('Agent 中央查询恢复网络错误且不重试权限错误', async () => {
  let attempts = 0;
  const result = await recoverCentralOperationRead(
    async () => {
      if (++attempts < 3) throw { code: 'central_unavailable' };
      return { status: 'succeeded' };
    },
    { delays: [1, 1] }
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(attempts, 3);
  await assert.rejects(
    recoverCentralOperationRead(async () => {
      throw Object.assign(new Error('权限不足'), { details: { status: 403 } });
    }),
    /权限不足/
  );
  await assert.rejects(
    recoverCentralOperationRead(
      async () => {
        throw { details: { status: 503 } };
      },
      { delays: [] }
    ),
    { code: 'central_result_unconfirmed' }
  );
});

test('中央响应体中断时按读取异常恢复，不把空响应作为执行失败', async () => {
  let attempts = 0;
  const result = await recoverCentralOperationRead(async () => (++attempts === 1 ? null : { status: 'succeeded' }), { delays: [1] });
  assert.equal(result.status, 'succeeded');
  assert.equal(attempts, 2);
});
