import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createSseFrameParser, getAgentReconnectDelay, waitForReconnect, type SseFrame } from '../agentStream.ts';

test('SSE 解析器支持跨 chunk、CRLF、注释心跳和多行数据', () => {
  const frames: SseFrame[] = [];
  const parser = createSseFrameParser((frame) => frames.push(frame));
  parser.push(': heartbeat\r\n\r\nid: 7\r\nevent: cha');
  parser.push('nge\r\ndata: {"revision":7,\r\ndata: "domains":["approvals"]}\r\n\r\n');
  parser.finish();

  assert.deepEqual(frames, [{
    id: '7',
    event: 'change',
    data: '{"revision":7,\n"domains":["approvals"]}',
  }]);
});

test('SSE 解析器忽略无 data 帧并消费流尾完整帧', () => {
  const frames: SseFrame[] = [];
  const parser = createSseFrameParser((frame) => frames.push(frame));
  parser.push('event: malformed\n\nevent: ready\ndata: {"revision":0,"domains":[]}');
  parser.finish();

  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'ready');
});

test('SSE 重连按 1、2、5、10、30 秒退避并带可控抖动', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 10].map((attempt) => getAgentReconnectDelay(attempt, () => 0.5)),
    [1_000, 2_000, 5_000, 10_000, 30_000, 30_000],
  );
  assert.equal(getAgentReconnectDelay(0, () => 0), 900);
  assert.equal(getAgentReconnectDelay(0, () => 1), 1_100);
});

test('waitForReconnect：信号已中止时立即 resolve 且不挂监听', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await waitForReconnect(10_000, controller.signal);
  assert.ok(Date.now() - started < 100, '已中止的信号应立即结束等待');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('waitForReconnect：正常超时后移除 abort 监听（泄漏回归）', async () => {
  const controller = new AbortController();
  const started = Date.now();
  await waitForReconnect(30, controller.signal);
  assert.ok(Date.now() - started >= 25, '应按指定延时等待');
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    '正常超时路径必须移除 abort 监听，否则同一 controller 上随重连次数堆积闭包'
  );
});

test('waitForReconnect：等待期间被 abort 时提前结束并清理监听器', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = waitForReconnect(10_000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `abort 应提前结束等待，实际耗时 ${elapsed}ms`);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('waitForReconnect：同一 controller 连续多轮重连后监听器净增为零（旧实现缺陷场景）', async () => {
  const controller = new AbortController();
  for (let i = 0; i < 5; i += 1) {
    await waitForReconnect(10, controller.signal);
  }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
