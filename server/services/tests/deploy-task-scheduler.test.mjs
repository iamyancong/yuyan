import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDeployTaskScheduler,
  DEFAULT_MAX_RUNNING_DEPLOY_TASKS,
  DeployQueueFullError,
  DeployTargetBusyError,
  deployTaskScheduler,
  estimateQueueWaitMinutes,
  isLightweightDeployAction,
} from '../deploy-task-scheduler.mjs';

/**
 * 创建测试用可控延迟任务。
 * @returns {{promise: Promise<any>, resolve: (val?: any) => void, reject: (err?: any) => void}}
 */
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 创建最小任务上下文对象。
 * @param {number} targetId 部署目标 ID
 * @returns {Object}
 */
function createMockTask(targetId) {
  return {
    targetId,
    action: 'deploy',
    operator: `user-${targetId}`,
    controller: new AbortController(),
    currentStage: 'validate',
    queued: false,
    queuePosition: 0,
    completed: false,
  };
}

test('默认并发运行上限为 7，支持 FIFO 排队与名次动态推进', async () => {
  assert.equal(DEFAULT_MAX_RUNNING_DEPLOY_TASKS, 7);

  const scheduler = createDeployTaskScheduler({ maxRunning: 2, maxQueued: 3 });
  const d1 = createDeferred();
  const d2 = createDeferred();
  const d3 = createDeferred();
  const d4 = createDeferred();

  const t1 = createMockTask(101);
  const t2 = createMockTask(102);
  const t3 = createMockTask(103);
  const t4 = createMockTask(104);

  const positionEvents = [];
  const startedIds = [];

  const p1 = scheduler.scheduleTask(t1, () => {
    startedIds.push(101);
    return d1.promise;
  });
  const p2 = scheduler.scheduleTask(t2, () => {
    startedIds.push(102);
    return d2.promise;
  });
  const p3 = scheduler.scheduleTask(
    t3,
    () => {
      startedIds.push(103);
      return d3.promise;
    },
    {
      onQueued: (task, pos) => positionEvents.push(`queued:${task.targetId}:${pos}`),
      onPositionChanged: (task, pos) => positionEvents.push(`move:${task.targetId}:${pos}`),
      onStartExecution: (task) => positionEvents.push(`start:${task.targetId}`),
    }
  );
  const p4 = scheduler.scheduleTask(
    t4,
    () => {
      startedIds.push(104);
      return d4.promise;
    },
    {
      onQueued: (task, pos) => positionEvents.push(`queued:${task.targetId}:${pos}`),
      onPositionChanged: (task, pos) => positionEvents.push(`move:${task.targetId}:${pos}`),
      onStartExecution: (task) => positionEvents.push(`start:${task.targetId}`),
    }
  );

  // t1、t2 立即执行，t3、t4 进入排队
  assert.deepEqual(startedIds, [101, 102]);
  assert.equal(t1.queued, false);
  assert.equal(t3.queued, true);
  assert.equal(t3.currentStage, 'queued');
  assert.equal(t3.queuePosition, 1);
  assert.equal(t4.queued, true);
  assert.equal(t4.queuePosition, 2);
  assert.deepEqual(scheduler.getStats(), {
    runningCount: 2,
    queuedCount: 2,
    activeCount: 4,
    maxConcurrent: 2,
    maxQueueSize: 3,
  });

  // 完成 t1 -> t3 自动补位执行，t4 排队名次从 2 推进到 1
  d1.resolve({ id: 1, status: 'success' });
  await p1;
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(startedIds, [101, 102, 103]);
  assert.equal(t3.queued, false);
  assert.equal(t3.queuePosition, 0);
  assert.equal(t4.queued, true);
  assert.equal(t4.queuePosition, 1);
  assert.ok(positionEvents.includes('start:103'));
  assert.ok(positionEvents.includes('move:104:1'));

  // 完成 t2、t3、t4
  d2.resolve({ id: 2, status: 'success' });
  d3.resolve({ id: 3, status: 'success' });
  d4.resolve({ id: 4, status: 'success' });
  await Promise.all([p2, p3, p4]);

  assert.deepEqual(startedIds, [101, 102, 103, 104]);
  assert.equal(scheduler.getStats().activeCount, 0);
});

test('排队期间取消任务不会执行 runner，且后续任务名次立即前移', async () => {
  const scheduler = createDeployTaskScheduler({ maxRunning: 1, maxQueued: 3 });
  const d1 = createDeferred();
  const d3 = createDeferred();

  const t1 = createMockTask(201);
  const t2 = createMockTask(202);
  const t3 = createMockTask(203);

  let t2RunnerCalled = false;
  const t3Positions = [];

  const p1 = scheduler.scheduleTask(t1, () => d1.promise);
  const p2 = scheduler.scheduleTask(
    t2,
    async () => {
      t2RunnerCalled = true;
      return { id: 2 };
    },
    {
      onAbortedWhileQueued: async (task) => ({
        targetId: task.targetId,
        status: 'stopped',
      }),
    }
  );
  const p3 = scheduler.scheduleTask(t3, () => d3.promise, {
    onQueued: (_task, pos) => t3Positions.push(pos),
    onPositionChanged: (_task, pos) => t3Positions.push(pos),
  });

  assert.equal(t2.queuePosition, 1);
  assert.equal(t3.queuePosition, 2);

  // 取消排在第 1 位的 t2
  t2.controller.abort(new Error('用户取消排队'));
  const t2Result = await p2;
  assert.equal(t2Result.status, 'stopped');
  assert.equal(t2RunnerCalled, false);
  assert.equal(scheduler.getTask(202), undefined);

  // t3 名次已从 2 推进到 1
  assert.equal(t3.queuePosition, 1);
  assert.deepEqual(t3Positions, [2, 1]);

  d1.resolve({ id: 1 });
  d3.resolve({ id: 3 });
  await Promise.all([p1, p3]);
});

test('等待队列已满时抛出 429 DeployQueueFullError，排队超时自动中止', async () => {
  const scheduler = createDeployTaskScheduler({
    maxRunning: 1,
    maxQueued: 1,
    queueTimeoutMs: 40,
  });
  const d1 = createDeferred();
  const t1 = createMockTask(301);
  const t2 = createMockTask(302);
  const t3 = createMockTask(303);

  const p1 = scheduler.scheduleTask(t1, () => d1.promise);
  const p2 = scheduler.scheduleTask(t2, async () => ({ id: 2 }));

  assert.equal(scheduler.canAcceptTask(), false);
  assert.throws(
    () => scheduler.scheduleTask(t3, async () => ({ id: 3 })),
    (err) => err instanceof DeployQueueFullError && err.status === 429 && err.code === 'DEPLOY_QUEUE_FULL'
  );

  // 等待 t2 排队超时
  await assert.rejects(p2, (err) => err?.code === 'DEPLOY_QUEUE_TIMEOUT' && /排队超时，未产生任何变更/.test(err.message));

  d1.resolve({ id: 1 });
  await p1;
});

test('排队超时通过 onAbortedWhileQueued 收口为 stopped 状态而非 failed，且不污染失败统计', async () => {
  const scheduler = createDeployTaskScheduler({
    maxRunning: 1,
    maxQueued: 2,
    queueTimeoutMs: 35,
  });
  const d1 = createDeferred();
  const t1 = createMockTask(401);
  const t2 = createMockTask(402);

  const p1 = scheduler.scheduleTask(t1, () => d1.promise);
  const p2 = scheduler.scheduleTask(
    t2,
    async () => ({ id: 2, status: 'success' }),
    {
      onAbortedWhileQueued: async (abortedTask, reason) => {
        assert.equal(reason?.code, 'DEPLOY_QUEUE_TIMEOUT');
        return {
          id: 0,
          targetId: abortedTask.targetId,
          action: abortedTask.action,
          status: 'stopped',
          stopReason: 'timeout',
          message: '排队超时，未产生任何变更',
        };
      },
    }
  );

  const t2Result = await p2;
  assert.equal(t2Result.status, 'stopped');
  assert.equal(t2Result.stopReason, 'timeout');
  assert.equal(t2Result.message, '排队超时，未产生任何变更');

  d1.resolve({ id: 1 });
  await p1;
});

test('轻量操作（rollback / undoRollback / start / stop / restart）绕过全局构建排队队列，队列满时仍可秒级直通执行', async () => {
  assert.equal(isLightweightDeployAction('rollback'), true);
  assert.equal(isLightweightDeployAction('undoRollback'), true);
  assert.equal(isLightweightDeployAction('start'), true);
  assert.equal(isLightweightDeployAction('stop'), true);
  assert.equal(isLightweightDeployAction('restart'), true);
  assert.equal(isLightweightDeployAction('deploy'), false);
  assert.equal(isLightweightDeployAction('openapi'), false);
  assert.equal(estimateQueueWaitMinutes(8, 7, 4), 8);

  const scheduler = createDeployTaskScheduler({
    maxRunning: 1,
    maxQueued: 1,
  });
  const dDeploy1 = createDeferred();
  const dDeploy2 = createDeferred();

  const deployTask1 = createMockTask(501);
  const deployTask2 = createMockTask(502);
  const pDeploy1 = scheduler.scheduleTask(deployTask1, () => dDeploy1.promise);
  const pDeploy2 = scheduler.scheduleTask(deployTask2, () => dDeploy2.promise);

  // 此时重型发布队列已满（1 运行 + 1 排队）
  assert.equal(scheduler.canAcceptTask(), false);

  // 另一个目标 503 发起回滚，绕过全局队列立即执行，不报 429，不占用重型槽位
  const rollbackTask = {
    ...createMockTask(503),
    action: 'rollback',
  };
  const dRollback = createDeferred();
  let rollbackStarted = false;
  const pRollback = scheduler.scheduleTask(rollbackTask, async () => {
    rollbackStarted = true;
    return await dRollback.promise;
  });

  assert.equal(rollbackStarted, true);
  assert.equal(rollbackTask.queued, false);
  // 执行期间目标 503 仍在 tasksByTargetId 中受单目标互斥保护
  assert.equal(scheduler.getTask(503), rollbackTask);
  // 重型运行槽位仍为 1（未被回滚占用）
  assert.equal(scheduler.getStats().runningCount, 1);

  dRollback.resolve({ id: 99, status: 'success', action: 'rollback' });
  const rollbackRes = await pRollback;
  assert.equal(rollbackRes.status, 'success');
  assert.equal(scheduler.getTask(503), undefined);

  dDeploy1.resolve({ id: 1 });
  dDeploy2.resolve({ id: 2 });
  await Promise.all([pDeploy1, pDeploy2]);
});

test('同一部署目标并发提交或绕过队列提交（bypassQueue）时由 scheduleTask 原子拦截，不覆盖且不误删原任务 Map 条目', async () => {
  const scheduler = createDeployTaskScheduler({
    maxRunning: 1,
    maxQueued: 2,
  });
  const dRunning = createDeferred();
  const dQueued = createDeferred();

  const runningTask = createMockTask(601);
  const queuedTask = createMockTask(602);
  const pRunning = scheduler.scheduleTask(runningTask, () => dRunning.promise);
  const pQueued = scheduler.scheduleTask(queuedTask, () => dQueued.promise);

  assert.equal(scheduler.getTask(601), runningTask);
  assert.equal(scheduler.getTask(602), queuedTask);

  // 1. 同一目标 601 并发提交 bypassQueue 回滚任务 -> 立即抛出 409 DeployTargetBusyError，不覆盖 runningTask
  const conflictingRollbackOnRunning = {
    ...createMockTask(601),
    action: 'rollback',
    operator: 'intruder-1',
  };
  let intruderRunnerCalled = false;
  assert.throws(
    () =>
      scheduler.scheduleTask(conflictingRollbackOnRunning, async () => {
        intruderRunnerCalled = true;
        return { id: 999 };
      }),
    (err) => {
      assert.ok(err instanceof DeployTargetBusyError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'DEPLOY_TARGET_BUSY');
      assert.equal(err.existingTask, runningTask);
      return true;
    }
  );
  assert.equal(intruderRunnerCalled, false);
  assert.equal(scheduler.getTask(601), runningTask);

  // 2. 同一目标 602（正处于排队等待）并发提交回滚任务 -> 报 409 且提示「可先停止排队中的发布后再操作」
  const conflictingRollbackOnQueued = {
    ...createMockTask(602),
    action: 'rollback',
    operator: 'intruder-2',
  };
  assert.throws(
    () => scheduler.scheduleTask(conflictingRollbackOnQueued, async () => ({ id: 998 })),
    (err) => {
      assert.ok(err instanceof DeployTargetBusyError);
      assert.equal(err.status, 409);
      assert.match(err.message, /可先停止排队中的发布/);
      return true;
    }
  );
  assert.equal(scheduler.getTask(602), queuedTask);

  // 3. 验证 finally 安全删除：即便外部异常篡改了 Map 引用，旧任务结束时也不会把别人的条目删掉
  const anotherTaskFor601 = createMockTask(601);
  scheduler.tasksByTargetId.set(601, anotherTaskFor601);
  dRunning.resolve({ id: 1, status: 'success' });
  await pRunning;
  // runningTask 结束时发现 get(601) !== runningTask，因此保留 anotherTaskFor601
  assert.equal(scheduler.getTask(601), anotherTaskFor601);
  scheduler.tasksByTargetId.delete(601);

  dQueued.resolve({ id: 2, status: 'success' });
  await pQueued;
  assert.equal(scheduler.getTask(602), undefined);
});

test('cleanupAndRespondScheduleError、构建内存重置/封顶与构建峰值持久化（updateTarget、updateTargetBuildMemoryMb、updateTargetBuildPeakMb）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-schedule-cleanup-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'deploy-schedule-cleanup-secret';

  const store = await import('../deploy-store.mjs');
  const { runRequestContext } = await import('../request-context.mjs');
  const { cleanupAndRespondScheduleError } = await import('../../controllers/deploy-controller.mjs');

  t.after(async () => {
    deployTaskScheduler.tasksByTargetId.delete(701);
    deployTaskScheduler.tasksByTargetId.delete(702);
    store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = {
    accountId: 'account-cleanup',
    userId: 'user-cleanup',
    deviceId: 'device-cleanup',
    teamId: 'workspace-cleanup',
    role: 'admin',
    client: 'desktop',
    requestId: 'cleanup-test',
  };

  // 1. 先创建服务器、Nginx 实例与部署目标，验证 updateTarget、updateTargetBuildMemoryMb（取整 + 65536 封顶 + 重置为 0）与 updateTargetBuildPeakMb
  const server = await runRequestContext(context, () =>
    store.createServer({
      name: '构建内存测试服务器',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'secret',
      defaultDeployRoot: '/home/app/frontend/html',
      defaultNginxConfPath: '/home/nginx/conf/nginx.conf',
    })
  );
  const instance = await runRequestContext(context, () =>
    store.createNginxInstance(server.id, {
      name: '构建内存测试 Nginx',
      instanceType: 'external',
      defaultDeployRoot: '/home/app/frontend/html',
      defaultNginxConfPath: '/home/nginx/conf/nginx.conf',
      nginxTestCommand: 'nginx -t',
      nginxReloadCommand: 'nginx -s reload',
    })
  );

  const baseTargetPayload = {
    projectId: 2001,
    projectSource: 'gitlab',
    projectName: 'Build Memory App',
    projectDescription: '构建内存测试应用',
    projectPath: 'group/build-memory-app',
    repositoryUrl: 'https://gitlab.example/group/build-memory-app.git',
    defaultBranch: 'dev',
    envName: '测试',
    serverId: server.id,
    nginxInstanceId: instance.id,
    deployRoot: '/home/app/frontend/html/build-memory-app',
    nginxConfPath: '/home/nginx/conf/nginx.conf',
    installCommand: 'pnpm install',
    buildCommand: 'pnpm build',
    buildMemoryMb: 4096.9,
    projectType: 'frontend',
  };

  const createdTarget = await runRequestContext(context, () => store.createTarget(baseTargetPayload));
  assert.equal(createdTarget.buildMemoryMb, 4096);
  assert.equal(createdTarget.buildPeakMb, 0);

  // OOM 扩容记住 8192MB，且支持超大值封顶 65536MB 与浮点数取整
  const updatedMem = await store.updateTargetBuildMemoryMb(createdTarget.id, 8192.7);
  assert.equal(updatedMem, 8192);
  const cappedMem = await store.updateTargetBuildMemoryMb(createdTarget.id, 100000);
  assert.equal(cappedMem, 65536);
  await store.updateTargetBuildMemoryMb(createdTarget.id, 8192);

  // 编辑目标时若未传 buildMemoryMb（undefined），保留已记住的 8192MB
  const updatedWithoutMemoryField = await runRequestContext(context, () =>
    store.updateTarget(createdTarget.id, {
      ...baseTargetPayload,
      remark: '仅修改备注',
      buildMemoryMb: undefined,
    })
  );
  assert.equal(updatedWithoutMemoryField.buildMemoryMb, 8192);

  // 编辑目标时显式将 buildMemoryMb 重置为 0（自动模式）
  const resetTarget = await runRequestContext(context, () =>
    store.updateTarget(createdTarget.id, {
      ...baseTargetPayload,
      buildMemoryMb: 0,
    })
  );
  assert.equal(resetTarget.buildMemoryMb, 0);

  // 记录构建实际 RSS 峰值（build_peak_mb）：成功构建覆盖旧值，失败/取消构建仅在新值更大时更新
  const savedPeak = await store.updateTargetBuildPeakMb(createdTarget.id, 5120.8, { succeeded: true });
  assert.equal(savedPeak, 5120);
  const peakAfterEarlyFail = await store.updateTargetBuildPeakMb(createdTarget.id, 1024, { succeeded: false });
  assert.equal(peakAfterEarlyFail, 5120);
  const peakAfterHighFail = await store.updateTargetBuildPeakMb(createdTarget.id, 6144, { succeeded: false });
  assert.equal(peakAfterHighFail, 6144);
  const peakAfterSmallerSuccess = await store.updateTargetBuildPeakMb(createdTarget.id, 3584, { succeeded: true });
  assert.equal(peakAfterSmallerSuccess, 3584);
  const targetWithPeak = await runRequestContext(context, () => store.getTarget(createdTarget.id));
  assert.equal(targetWithPeak.buildPeakMb, 3584);

  // 2. 验证 cleanupAndRespondScheduleError：入队同步抛错时同时回收 Map 条目、目标租约与持久化 running 任务行
  let leaseReleased = false;
  const persistentTask = await runRequestContext(context, () =>
    store.createPersistentDeployTask({
      targetId: createdTarget.id,
      action: 'deploy',
      branch: 'dev',
      operator: 'tester',
    })
  );
  const orphanTask = {
    ...createMockTask(createdTarget.id),
    teamId: 'workspace-cleanup',
    persistentId: persistentTask.id,
    currentStage: 'validate',
    releaseTargetLease() {
      leaseReleased = true;
    },
  };
  deployTaskScheduler.tasksByTargetId.set(createdTarget.id, orphanTask);

  let respondedStatus = 0;
  let respondedPayload = null;
  const mockRes = {
    status(code) {
      respondedStatus = code;
      return this;
    },
    json(body) {
      respondedPayload = body;
      return this;
    },
  };

  await cleanupAndRespondScheduleError(orphanTask, new DeployQueueFullError(7, 20), mockRes);

  assert.equal(orphanTask.completed, true);
  assert.equal(leaseReleased, true);
  assert.equal(deployTaskScheduler.tasksByTargetId.has(createdTarget.id), false);
  assert.equal(respondedStatus, 429);
  assert.equal(respondedPayload?.code, 'DEPLOY_QUEUE_FULL');

  const storedAfterCleanup = await runRequestContext(context, () =>
    store.getPersistentDeployTask(persistentTask.id)
  );
  assert.equal(storedAfterCleanup?.status, 'stopped');
});
