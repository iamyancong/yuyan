import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDeployTargetRuntimeStatus,
  getDeployTargetRuntimeHeadline,
  publishStages,
} from '../../constant.ts';
import {
  getTargetRuntimePollDelay,
  isTargetRuntimeBatchUnsupported,
  isTargetRuntimeSseUnsupported,
  mapWithConcurrency,
  resolveStoppedDeployProgressPresentation,
  shouldScheduleRuntimePoll,
  TARGET_RUNTIME_ACTIVE_INTERVAL,
  TARGET_RUNTIME_ERROR_MAX_INTERVAL,
  TARGET_RUNTIME_IDLE_INTERVAL,
} from '../targetRuntimePolicy.ts';

test('部署运行态间隔在空闲、运行与失败时自适应，且 SSE 连接就绪时跳过定时轮询', () => {
  assert.equal(getTargetRuntimePollDelay(false, 0), TARGET_RUNTIME_IDLE_INTERVAL);
  assert.equal(getTargetRuntimePollDelay(true, 0), TARGET_RUNTIME_ACTIVE_INTERVAL);
  assert.equal(getTargetRuntimePollDelay(false, 1), 5_000);
  assert.equal(getTargetRuntimePollDelay(true, 2), 10_000);
  assert.equal(getTargetRuntimePollDelay(true, 10), TARGET_RUNTIME_ERROR_MAX_INTERVAL);
  assert.equal(getTargetRuntimePollDelay(true, 0, true), TARGET_RUNTIME_IDLE_INTERVAL);
  assert.equal(isTargetRuntimeBatchUnsupported({ response: { status: 404 } }), true);
  assert.equal(isTargetRuntimeBatchUnsupported({ status: 501 }), true);
  assert.equal(isTargetRuntimeBatchUnsupported({ response: { status: 500 } }), false);
  assert.equal(isTargetRuntimeSseUnsupported({ status: 404 }), true);
  assert.equal(isTargetRuntimeSseUnsupported({ response: { status: 501 } }), true);
  assert.equal(isTargetRuntimeSseUnsupported({ status: 503 }), false);

  assert.equal(
    shouldScheduleRuntimePoll({ pollingEnabled: true, pageHidden: false, targetCount: 3, sseConnected: true }),
    false,
  );
  assert.equal(
    shouldScheduleRuntimePoll({ pollingEnabled: true, pageHidden: false, targetCount: 3, sseConnected: false }),
    true,
  );
  assert.equal(
    shouldScheduleRuntimePoll({ pollingEnabled: true, pageHidden: true, targetCount: 3, sseConnected: false }),
    false,
  );
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

test('getDeployTargetRuntimeHeadline 区分排队第 N 位、等待构建资源与正在执行，且 publishStages 包含 waiting-build-slot', () => {
  assert.equal(getDeployTargetRuntimeHeadline(null), '空闲');
  assert.equal(getDeployTargetRuntimeHeadline({ running: false, events: [] } as any), '空闲');

  assert.equal(
    getDeployTargetRuntimeHeadline({
      running: true,
      queued: true,
      queuePosition: 3,
      currentStage: 'queued',
      action: 'deploy',
      events: [],
    } as any),
    '排队第 3 位',
  );
  assert.equal(
    getDeployTargetRuntimeHeadline({
      running: true,
      queued: true,
      queuePosition: 0,
      currentStage: 'queued',
      action: 'deploy',
      events: [],
    } as any),
    '排队等待',
  );
  assert.equal(
    getDeployTargetRuntimeHeadline({
      running: true,
      queued: false,
      currentStage: 'waiting-build-slot',
      action: 'deploy',
      events: [],
    } as any),
    '等待构建资源',
  );
  assert.equal(
    getDeployTargetRuntimeHeadline({
      running: true,
      queued: false,
      currentStage: 'build',
      action: 'deploy',
      events: [],
    } as any),
    '正在发布',
  );
  assert.equal(
    getDeployTargetRuntimeHeadline({
      running: true,
      queued: false,
      currentStage: 'rollback',
      action: 'rollback',
      events: [],
    } as any),
    '正在回滚',
  );
  assert.equal(
    formatDeployTargetRuntimeStatus({
      running: true,
      queued: false,
      currentStage: 'waiting-build-slot',
      action: 'deploy',
      events: [{ type: 'stage', stage: 'waiting-build-slot', percent: 26, message: '等待构建资源（内存）…', timestamp: '' }],
    } as any),
    '等待构建资源 · 等待构建资源（内存）…',
  );

  const waitingStage = publishStages.find((stage) => stage.key === 'waiting-build-slot');
  assert.ok(waitingStage, 'publishStages 应包含 waiting-build-slot 步骤');
  assert.equal(waitingStage?.title, '等待构建资源');
  assert.equal(waitingStage?.percent, 26);
});

test('排队超时与手动取消停止态标题区分：stopReason=timeout 显示「排队超时」', () => {
  const timeoutStop = resolveStoppedDeployProgressPresentation({
    stopReason: 'timeout',
    message: '排队超时，未产生任何变更',
  });
  assert.deepEqual(timeoutStop, {
    isQueueTimeout: true,
    title: '排队超时',
    detail: '排队超时，未产生任何变更',
  });

  const stageTimeoutStop = resolveStoppedDeployProgressPresentation({
    stageMessage: '排队超时已停止',
  });
  assert.equal(stageTimeoutStop.isQueueTimeout, true);
  assert.equal(stageTimeoutStop.title, '排队超时');
  assert.equal(stageTimeoutStop.detail, '排队超时，未产生任何变更');

  const manualStop = resolveStoppedDeployProgressPresentation({
    stopReason: 'cancelled',
    message: '任务已在排队阶段取消，未产生构建或发布变更',
  });
  assert.deepEqual(manualStop, {
    isQueueTimeout: false,
    title: '已停止',
    detail: '任务已在排队阶段取消，未产生构建或发布变更',
  });
});
