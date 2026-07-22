import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTargetRuntimePollDelay,
  isTargetRuntimeBatchUnsupported,
  mapWithConcurrency,
  TARGET_RUNTIME_ACTIVE_INTERVAL,
  TARGET_RUNTIME_ERROR_MAX_INTERVAL,
  TARGET_RUNTIME_IDLE_INTERVAL,
} from './targetRuntimePolicy.ts';

test('部署运行态间隔在空闲、运行与失败时自适应', () => {
  assert.equal(getTargetRuntimePollDelay(false, 0), TARGET_RUNTIME_IDLE_INTERVAL);
  assert.equal(getTargetRuntimePollDelay(true, 0), TARGET_RUNTIME_ACTIVE_INTERVAL);
  assert.equal(getTargetRuntimePollDelay(false, 1), 5_000);
  assert.equal(getTargetRuntimePollDelay(true, 2), 10_000);
  assert.equal(getTargetRuntimePollDelay(true, 10), TARGET_RUNTIME_ERROR_MAX_INTERVAL);
  assert.equal(getTargetRuntimePollDelay(true, 0, true), TARGET_RUNTIME_IDLE_INTERVAL);
  assert.equal(isTargetRuntimeBatchUnsupported({ response: { status: 404 } }), true);
  assert.equal(isTargetRuntimeBatchUnsupported({ status: 501 }), true);
  assert.equal(isTargetRuntimeBatchUnsupported({ response: { status: 500 } }), false);
});

test('旧接口回退映射限制并发并保持结果顺序', async () => {
  let activeWorkers = 0;
  let maxActiveWorkers = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 4, async (item) => {
    activeWorkers += 1;
    maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeWorkers -= 1;
    return item * 2;
  });

  assert.equal(maxActiveWorkers, 4);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});
