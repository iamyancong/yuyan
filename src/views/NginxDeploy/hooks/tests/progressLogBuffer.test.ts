import assert from 'node:assert/strict';
import test from 'node:test';
import { isReactive, reactive } from 'vue';
import { createProgressLogBuffer, getProgressEventKey, withOmittedEventsNotice } from '../progressLogBuffer.ts';
import { getDeployQueueReasonText, getDeployTargetRuntimeHeadline, publishStages } from '../../constant.ts';

const makeLog = (seq: number) => ({
  type: 'log' as const,
  level: 'info' as const,
  stage: 'build',
  message: `vite transforming module src/views/page-${seq}.vue`,
  timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
  seq,
});

/** 同步调度器：测试里手动触发合批写入 */
const createManualScheduler = () => {
  const queue: Array<() => void> = [];
  return {
    schedule: (callback: () => void) => {
      queue.push(callback);
      return queue.length;
    },
    cancel: () => undefined,
    run: () => queue.splice(0).forEach((callback) => callback()),
  };
};

test('2 万条快照 + 2 万条流式重放：去重为 O(1)，总耗时远低于旧实现（#61）', () => {
  const state = reactive({ logs: [] as any[] });
  const scheduler = createManualScheduler();
  const buffer = createProgressLogBuffer({
    read: () => state.logs,
    write: (logs) => {
      state.logs = logs;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  const events = Array.from({ length: 20_000 }, (_, index) => makeLog(index + 1));
  const startedAt = performance.now();
  buffer.replace(events);
  for (const event of events) buffer.append({ ...event });
  for (let seq = 20_001; seq <= 20_100; seq += 1) buffer.append(makeLog(seq));
  scheduler.run();
  const elapsed = performance.now() - startedAt;
  assert.equal(state.logs.length, 20_100, '重放的 2 万条全部去重，只追加新的 100 条');
  assert.equal(isReactive(state.logs), false, '日志数组不做深度响应式');
  assert.ok(elapsed < 200, `耗时 ${elapsed.toFixed(1)}ms 应小于 200ms（旧实现 1 万条约 5.8s）`);
});

test('普通日志合批写入，阶段/错误立即写入且保持顺序；外部重置后以外部为准', () => {
  const state = reactive({ logs: [] as any[] });
  const scheduler = createManualScheduler();
  let writes = 0;
  const buffer = createProgressLogBuffer({
    read: () => state.logs,
    write: (logs) => {
      writes += 1;
      state.logs = logs;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  buffer.append(makeLog(1));
  buffer.append(makeLog(2));
  assert.equal(state.logs.length, 0, '普通日志先进入待写');
  buffer.append({ type: 'stage', stage: 'upload', percent: 66, message: '上传产物', timestamp: 't', seq: 3 });
  assert.deepEqual(state.logs.map((item: any) => item.seq), [1, 2, 3]);
  assert.ok(writes <= 2, '首次对齐外部数组 + 一次合并写入');
  assert.equal(buffer.append(makeLog(2)), false, '重复事件被忽略');

  // 外部重置（例如开始新一次发布 Object.assign logs: []）
  buffer.append(makeLog(4));
  state.logs = [];
  scheduler.run();
  assert.equal(state.logs.length, 0, '旧会话的待写日志被丢弃');
  assert.equal(buffer.append(makeLog(1)), true, '重置后去重键也已清空');
});

test('无 seq 的事件按类型 + 时间 + 阶段 + 文案去重；省略说明加在开头', () => {
  const a = { type: 'log' as const, level: 'info' as const, stage: 'build', message: 'x', timestamp: 't1' };
  assert.equal(getProgressEventKey(a), getProgressEventKey({ ...a }));
  assert.notEqual(getProgressEventKey(a), getProgressEventKey({ ...a, timestamp: 't2' }));
  const withNotice = withOmittedEventsNotice([makeLog(9_801)], 9_800, '2026-11-16T02:29:27.000Z');
  assert.equal(withNotice.length, 2);
  assert.match((withNotice[0] as { message: string }).message, /更早的 9800 条日志未加载/);
  assert.equal(withOmittedEventsNotice([makeLog(1)], 0).length, 1);
});

test('排队原因与等锁提示文案（#61）', () => {
  assert.equal(
    getDeployQueueReasonText({ running: true, queued: true, queuePosition: 2, queueReason: 'slot', runningCount: 20, maxConcurrent: 20, currentStage: 'queued', events: [] } as any),
    '排队第 2 位 · 原因：并发已满 20/20'
  );
  const lockSnapshot = {
    running: true,
    queued: false,
    currentStage: 'waiting-deploy-lock',
    action: 'deploy',
    events: [{ type: 'stage', stage: 'waiting-deploy-lock', percent: 66, message: '等待同服务器目录锁…（被「星河主应用」占用）', detail: '被「星河主应用」（程述强 发布）占用 · 目录 /home/app/frontend/html', timestamp: 't' }],
  } as any;
  assert.match(getDeployQueueReasonText(lockSnapshot), /星河主应用/);
  assert.equal(getDeployTargetRuntimeHeadline(lockSnapshot), '等待目录锁');
  assert.equal(getDeployQueueReasonText({ running: true, currentStage: 'build', events: [] } as any), '');
  assert.ok(publishStages.some((stage) => stage.key === 'waiting-deploy-lock'));
});
