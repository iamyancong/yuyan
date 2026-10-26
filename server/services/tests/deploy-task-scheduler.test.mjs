import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeployTaskScheduler,
  DEFAULT_MAX_RUNNING_DEPLOY_TASKS,
  DeployQueueFullError,
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
  await assert.rejects(p2, (err) => err?.code === 'DEPLOY_QUEUE_TIMEOUT');

  d1.resolve({ id: 1 });
  await p1;
});
