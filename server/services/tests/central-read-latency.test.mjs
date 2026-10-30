import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { flushAllProgressStreams, writeProgressStreamEvent } from '../progress-stream-writer.mjs';
import { createRuntimeSnapshotCache } from '../runtime-snapshot-cache.mjs';
import { findLatestStageEvent } from '../deploy-runtime-snapshot-service.mjs';
import { getEventLoopDelayStats, getMetricsSnapshot } from '../runtime-metrics.mjs';

/** 模拟 Express 响应：记录每次 write。 */
function createFakeResponse() {
  const res = new EventEmitter();
  res.writes = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.write = (text) => res.writes.push(text);
  res.end = (text) => {
    if (text) res.writes.push(text);
    res.writableEnded = true;
  };
  return res;
}
const lines = (res) => res.writes.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('日志行在窗口内合并为一次写入，顺序不变', async () => {
  const res = createFakeResponse();
  for (let index = 0; index < 500; index += 1) writeProgressStreamEvent(res, { type: 'log', message: `line ${index}` }, { flushMs: 20 });
  assert.equal(res.writes.length, 0, '窗口内不立即写出');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(res.writes.length, 1);
  assert.deepEqual(lines(res).map((event) => event.message), Array.from({ length: 500 }, (_, index) => `line ${index}`));
});

test('阶段/结果/错误事件先刷出缓冲再立即写出', () => {
  const res = createFakeResponse();
  writeProgressStreamEvent(res, { type: 'log', message: 'a' }, { flushMs: 1000 });
  writeProgressStreamEvent(res, { type: 'log', message: 'b' }, { flushMs: 1000 });
  writeProgressStreamEvent(res, { type: 'stage', stage: 'build' }, { flushMs: 1000 });
  assert.equal(res.writes.length, 1);
  assert.deepEqual(lines(res).map((event) => event.message || event.stage), ['a', 'b', 'build']);
  writeProgressStreamEvent(res, { type: 'log', message: 'c' }, { flushMs: 1000 });
  writeProgressStreamEvent(res, { type: 'result', data: { id: 1 } }, { flushMs: 1000 });
  assert.deepEqual(lines(res).map((event) => event.type), ['log', 'log', 'stage', 'log', 'result']);
});

test('res.end 前与进程退出前刷出，不丢日志', () => {
  const ended = createFakeResponse();
  writeProgressStreamEvent(ended, { type: 'log', message: 'tail' }, { flushMs: 1000 });
  ended.end();
  assert.deepEqual(lines(ended).map((event) => event.message), ['tail']);

  const pending = createFakeResponse();
  writeProgressStreamEvent(pending, { type: 'log', message: 'exit' }, { flushMs: 1000 });
  flushAllProgressStreams();
  assert.deepEqual(lines(pending).map((event) => event.message), ['exit']);
});

test('已关闭的响应不再写入', () => {
  const res = createFakeResponse();
  res.destroyed = true;
  writeProgressStreamEvent(res, { type: 'stage', stage: 'x' });
  assert.equal(res.writes.length, 0);
});

test('快照缓存：同修订号 TTL 内命中，修订号变化或过期重新计算，并发合并', async () => {
  let clock = 0;
  let computed = 0;
  const cache = createRuntimeSnapshotCache({ ttlMs: 1500, now: () => clock });
  const compute = async () => ({ n: ++computed });
  const [first, joined] = await Promise.all([cache.get('team', 1, compute), cache.get('team', 1, compute)]);
  assert.equal(computed, 1);
  assert.equal(first, joined);
  clock = 1000;
  assert.equal((await cache.get('team', 1, compute)).n, 1, 'TTL 内命中');
  assert.equal((await cache.get('team', 2, compute)).n, 2, '修订号变化立即失效');
  clock = 3000;
  assert.equal((await cache.get('team', 2, compute)).n, 3, '过期重新计算');
  assert.equal((await cache.get('other', 2, compute)).n, 4, '按团队隔离');
  const stats = cache.getStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.joined, 1);
});

test('快照缓存：计算失败不缓存', async () => {
  const cache = createRuntimeSnapshotCache({ ttlMs: 1500 });
  await assert.rejects(cache.get('team', 1, async () => { throw new Error('boom'); }));
  assert.deepEqual(await cache.get('team', 1, async () => ({ ok: true })), { ok: true });
});

test('从尾部查找最近阶段事件，不复制数组', () => {
  const events = [{ type: 'stage', stage: 'a' }, ...Array.from({ length: 1000 }, () => ({ type: 'log' })), { type: 'stage', stage: 'b' }, { type: 'log' }];
  assert.equal(findLatestStageEvent(events).stage, 'b');
  assert.equal(findLatestStageEvent([{ type: 'log' }]), undefined);
  assert.equal(findLatestStageEvent(), undefined);
});

test('事件循环延迟统计接入 /metrics', async () => {
  const started = Date.now();
  while (Date.now() - started < 120) { /* 人为阻塞事件循环 */ }
  await new Promise((resolve) => setTimeout(resolve, 60));
  const stats = getEventLoopDelayStats();
  assert.equal(stats.enabled, true);
  assert.ok(stats.current.maxMs >= 80, `max=${stats.current.maxMs}`);
  assert.ok(getMetricsSnapshot().eventLoopDelay.current.maxMs >= 80);
});
