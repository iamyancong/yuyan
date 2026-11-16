import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-deploy-task-events-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'deploy-task-events-test-key';

const { appendTaskEvent, getTaskEventTail, getTaskEventsAfter } = await import('../deploy-task-events.mjs');
const store = await import('../deploy-store.mjs');
const controller = await import('../../controllers/deploy-controller.mjs');
const { deployTaskScheduler } = await import('../deploy-task-scheduler.mjs');

after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

const logEvent = (i, stage = 'build') => ({ type: 'log', level: 'info', stage, message: `line ${i}`, timestamp: new Date(1_700_000_000_000 + i).toISOString() });

test('事件带递增 seq；超过上限后保留开头 + 最近窗口，中间日志折叠成省略标记，阶段与错误事件不丢', () => {
  const task = { events: [] };
  appendTaskEvent(task, { type: 'stage', stage: 'queued', percent: 2, message: '排队等待执行' });
  appendTaskEvent(task, { type: 'stage', stage: 'build', percent: 48, message: '构建产物' });
  for (let i = 0; i < 30_000; i += 1) {
    appendTaskEvent(task, logEvent(i), { head: 500, tail: 5000 });
    if (i === 12_000) appendTaskEvent(task, { type: 'error', stage: 'build', message: '中途错误' }, { head: 500, tail: 5000 });
    if (i === 15_000) appendTaskEvent(task, { type: 'stage', stage: 'build', percent: 52, message: '构建产物（扩容重试）' }, { head: 500, tail: 5000 });
  }
  assert.equal(task.eventSeq, 30_004);
  assert.ok(task.events.length <= 500 + 1 + 5000 + 500 + 10, `内存事件数受限：${task.events.length}`);
  const marker = task.events[500];
  assert.equal(marker.omittedMarker, true);
  assert.match(marker.message, /中间已省略 \d+ 行日志/);
  assert.ok(task.events.some((item) => item.type === 'error' && item.message === '中途错误'), '错误事件保留');
  assert.ok(task.events.some((item) => item.type === 'stage' && item.message === '构建产物（扩容重试）'), '阶段事件保留');
  assert.equal(task.hasErrorEvent, true);
  assert.equal(task.wasQueued, true);
  assert.equal(task.latestStageEvent.message, '构建产物（扩容重试）');
  assert.equal(task.events.at(-1).message, 'line 29999');

  const tail = getTaskEventTail(task, 200);
  assert.equal(tail.events.length, 201, '最近 200 条 + 补上的最新阶段');
  assert.equal(tail.events[0], task.latestStageEvent);
  assert.equal(tail.lastSeq, 30_004);
  assert.ok(tail.omittedEventCount > 29_000);

  const after = getTaskEventsAfter(task, tail.lastSeq - 3);
  assert.deepEqual(after.map((item) => item.message), ['line 29997', 'line 29998', 'line 29999']);
});

/** 收集流式输出的假响应 */
const createStreamRes = () => {
  const res = {
    statusCode: 200,
    chunks: [],
    headers: {},
    writableEnded: false,
    destroyed: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() {},
    write(text) { this.chunks.push(text); return true; },
    json(body) { this.body = body; this.writableEnded = true; return this; },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  return res;
};

test('deploy-progress：非流式只返回状态 + 最近 200 条；流式按 afterSeq 只补发之后的事件', async () => {
  const targetId = 990_001;
  const task = {
    targetId,
    persistentId: 'task-tail',
    action: 'deploy',
    operator: '程述强',
    startedAt: '2026-11-16T02:29:27.000Z',
    currentStage: 'build',
    queued: false,
    queuePosition: 0,
    queueReason: '',
    events: [],
    subscribers: new Set(),
    completed: false,
    controller: new AbortController(),
  };
  appendTaskEvent(task, { type: 'stage', stage: 'build', percent: 48, message: '构建产物' });
  for (let i = 0; i < 20_000; i += 1) appendTaskEvent(task, logEvent(i));
  deployTaskScheduler.tasksByTargetId.set(targetId, task);
  try {
    const res = createStreamRes();
    await controller.handleGetTargetDeployProgress({ params: { id: String(targetId) }, query: {}, headers: {}, on() {}, off() {} }, res);
    const data = res.body.data;
    assert.equal(data.running, true);
    assert.equal(data.operator, '程述强');
    assert.equal(data.events.length, 201);
    assert.equal(data.lastSeq, task.eventSeq);
    assert.ok(data.omittedEventCount > 19_000);
    assert.ok(JSON.stringify(res.body).length < 60_000, '快照体积不随日志增长');

    // 期间又来了 2 条
    appendTaskEvent(task, logEvent(20_000));
    appendTaskEvent(task, logEvent(20_001));
    const streamRes = createStreamRes();
    await controller.handleGetTargetDeployProgress(
      { params: { id: String(targetId) }, query: { stream: '1', afterSeq: String(data.lastSeq) }, headers: {}, on() {}, off() {} },
      streamRes
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const lines = streamRes.chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
    const messages = lines.filter((item) => item.stage !== 'connection').map((item) => item.message);
    assert.deepEqual(messages, ['line 20000', 'line 20001'], '只补发快照之后的事件，不再重发整份日志');
    task.subscribers.clear();
  } finally {
    deployTaskScheduler.tasksByTargetId.delete(targetId);
  }
});
