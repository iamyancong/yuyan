import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeNginxArchiveSaveResponse } from './nginxArchiveSaveStream.ts';

/** 创建指定 SSE 文本的流式响应。 */
const createSseResponse = (content: string) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(content));
    controller.close();
  },
}));

test('archive-save 提前 EOF 不能进入成功态', async () => {
  await assert.rejects(
    consumeNginxArchiveSaveResponse(createSseResponse('data: {"stage":"writing","loaded":128}\n\n')),
    /未确认文件已保存/
  );
});

test('archive-save 缺少 finished 字段不能进入成功态', async () => {
  await assert.rejects(
    consumeNginxArchiveSaveResponse(createSseResponse('data: {"stage":"finished","loaded":128}\n\n')),
    /未确认文件已保存/
  );
});

test('archive-save error 事件透传真实错误', async () => {
  await assert.rejects(
    consumeNginxArchiveSaveResponse(createSseResponse('data: {"error":"服务器凭据解密失败"}\n\n')),
    /服务器凭据解密失败/
  );
});

test('archive-save 只有 finished=true 才成功', async () => {
  const events: unknown[] = [];
  await consumeNginxArchiveSaveResponse(
    createSseResponse('data: {"stage":"finished","loaded":128,"finished":true}\n\n'),
    (event) => events.push(event)
  );
  assert.equal(events.length, 1);
});
