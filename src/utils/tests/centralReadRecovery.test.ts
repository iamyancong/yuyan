import assert from 'node:assert/strict';
import test from 'node:test';
import { CENTRAL_RETRY_DELAYS, isRecoverableReadError, recoverCentralRead } from '../centralReadRecovery.ts';

test('中央读取仅重试连接、超时和暂时性服务错误', () => {
  for (const status of [408, 500, 502, 503, 504]) assert.equal(isRecoverableReadError({ response: { status } }), true);
  for (const status of [400, 401, 403, 404, 409, 422, 501]) assert.equal(isRecoverableReadError({ status }), false);
  assert.equal(isRecoverableReadError({ code: 'ERR_CANCELED' }), false);
  assert.equal(isRecoverableReadError({ code: 'ERR_NETWORK' }), true);
  assert.ok(CENTRAL_RETRY_DELAYS.reduce((sum, delay) => sum + delay, 0) > 20_000);
});

test('停机 20 秒后仍有自动重试机会', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const attempts: number[] = [];
  const pending = recoverCentralRead(async () => {
    attempts.push(Date.now());
    if (Date.now() < 20_000) throw Object.assign(new Error('离线'), { code: 'ERR_NETWORK' });
    return ['cached-row'];
  });
  for (let second = 0; second < 30; second += 1) {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    t.mock.timers.tick(1000);
  }
  assert.deepEqual(await pending, ['cached-row']);
  assert.ok(attempts[attempts.length - 1] >= 20_000);
  assert.equal(attempts.length, 6);
});

test('取消退避立即结束，业务错误不重试', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = recoverCentralRead(
    async () => {
      attempts += 1;
      throw { code: 'ERR_NETWORK' };
    },
    {
      signal: controller.signal,
      onRetry: () => controller.abort(),
    }
  );
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(attempts, 1);
  await assert.rejects(
    recoverCentralRead(async () => {
      throw Object.assign(new Error('无权限'), { status: 403 });
    }),
    /无权限/
  );
});

test('挂起读取有超时上限，旧请求收到取消信号', async () => {
  const signals: AbortSignal[] = [];
  await assert.rejects(
    recoverCentralRead(
      (signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
      { delays: [1], requestTimeoutMs: 5, budgetMs: 30 }
    ),
    /超时/
  );
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
});
