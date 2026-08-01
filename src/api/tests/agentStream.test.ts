import assert from 'node:assert/strict';
import test from 'node:test';
import { createSseFrameParser, getAgentReconnectDelay, type SseFrame } from '../agentStream.ts';

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
