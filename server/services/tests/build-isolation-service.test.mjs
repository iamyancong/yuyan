import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyLowProcessPriority,
  buildIsolatedCommandEnv,
  createBuildSlotLimiter,
  DEFAULT_MAX_CONCURRENT_BUILDS,
} from '../build-isolation-service.mjs';

/**
 * 创建测试用可控 Promise。
 * @returns {{promise: Promise<any>, resolve: (val?: any) => void}}
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('默认本地构建并发槽位位于 3~5 区间，支持 FIFO 等待与取消', async () => {
  assert.ok(
    DEFAULT_MAX_CONCURRENT_BUILDS >= 3 && DEFAULT_MAX_CONCURRENT_BUILDS <= 5,
    `期望默认构建槽位在 3~5 之间，实际为 ${DEFAULT_MAX_CONCURRENT_BUILDS}`
  );

  const limiter = createBuildSlotLimiter({ maxConcurrent: 2 });
  const d1 = createDeferred();
  const d2 = createDeferred();
  const d3 = createDeferred();

  const waitRecords = [];
  const executionOrder = [];

  const p1 = limiter.withBuildSlot(async () => {
    executionOrder.push('start-1');
    await d1.promise;
    executionOrder.push('end-1');
    return 'res-1';
  });

  const p2 = limiter.withBuildSlot(async () => {
    executionOrder.push('start-2');
    await d2.promise;
    executionOrder.push('end-2');
    return 'res-2';
  });

  const abortController3 = new AbortController();
  const p3 = limiter.withBuildSlot(
    async () => {
      executionOrder.push('start-3');
      await d3.promise;
      return 'res-3';
    },
    {
      signal: abortController3.signal,
      onWait: (info) => waitRecords.push({ id: 3, ...info }),
    }
  );

  const p4 = limiter.withBuildSlot(
    async () => {
      executionOrder.push('start-4');
      return 'res-4';
    },
    {
      onWait: (info) => waitRecords.push({ id: 4, ...info }),
    }
  );

  assert.deepEqual(limiter.getStats(), {
    activeBuilds: 2,
    waitingBuilds: 2,
    maxConcurrentBuilds: 2,
  });
  assert.deepEqual(waitRecords, [
    { id: 3, waitingPosition: 1, activeBuilds: 2, maxConcurrentBuilds: 2 },
    { id: 4, waitingPosition: 2, activeBuilds: 2, maxConcurrentBuilds: 2 },
  ]);

  // 等待期间取消第 3 个构建任务
  abortController3.abort(new Error('用户取消构建等待'));
  await assert.rejects(p3, /用户取消构建等待/);
  assert.equal(limiter.getStats().waitingBuilds, 1);

  // 释放第 1 个槽位 -> 第 4 个任务立即补位执行
  d1.resolve();
  await p1;
  const res4 = await p4;
  assert.equal(res4, 'res-4');
  assert.ok(!executionOrder.includes('start-3'));
  assert.ok(executionOrder.includes('start-4'));

  d2.resolve();
  await p2;
  assert.deepEqual(limiter.getStats(), {
    activeBuilds: 0,
    waitingBuilds: 0,
    maxConcurrentBuilds: 2,
  });
});

test('buildIsolatedCommandEnv 注入内存上限、线程池收敛与 CI 标志且不覆盖已有配置', () => {
  const defaultEnv = buildIsolatedCommandEnv({ CUSTOM_VAR: '1', NODE_OPTIONS: '' });
  assert.equal(defaultEnv.CUSTOM_VAR, '1');
  assert.equal(defaultEnv.CI, 'true');
  assert.equal(defaultEnv.UV_THREADPOOL_SIZE, '2');
  assert.match(defaultEnv.NODE_OPTIONS, /--max-old-space-size=2048/);

  // 保留已有的其他 NODE_OPTIONS 参数并追加堆上限
  const mergedNodeOpts = buildIsolatedCommandEnv({ NODE_OPTIONS: '--no-warnings' }, { maxOldSpaceMb: 3072 });
  assert.equal(mergedNodeOpts.NODE_OPTIONS, '--no-warnings --max-old-space-size=3072');

  // 已显式配置 --max-old-space-size 时不重复追加
  const customHeapEnv = buildIsolatedCommandEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
  assert.equal(customHeapEnv.NODE_OPTIONS, '--max-old-space-size=4096');

  // 后端 Maven 构建关闭 Node 堆限制注入
  const mavenEnv = buildIsolatedCommandEnv({ NODE_OPTIONS: '' }, { injectNodeHeapLimit: false });
  assert.equal(mavenEnv.NODE_OPTIONS, '');
  assert.equal(mavenEnv.CI, 'true');
});

test('applyLowProcessPriority 对无效 PID 安全降级不抛异常', () => {
  assert.equal(applyLowProcessPriority(0), false);
  assert.equal(applyLowProcessPriority(-1), false);
  assert.equal(applyLowProcessPriority(undefined), false);
});
