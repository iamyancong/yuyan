import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { disableDynamicApiCache } from '../http-cache-policy.mjs';

/** 创建可记录响应头的最小响应对象。 */
function createResponse() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
  };
}

test('动态部署 API 忽略条件缓存并返回 no-store', () => {
  const req = {
    path: '/deploy-api/v2/targets',
    headers: {
      'if-none-match': '"stale-targets"',
      'if-modified-since': 'Wed, 22 Jul 2026 00:00:00 GMT',
    },
  };
  const res = createResponse();
  let nextCalled = false;

  disableDynamicApiCache(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.headers['if-none-match'], undefined);
  assert.equal(req.headers['if-modified-since'], undefined);
  assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');
  assert.equal(res.headers.get('pragma'), 'no-cache');
  assert.equal(res.headers.get('expires'), '0');
});

test('静态资源保留自身缓存策略', () => {
  const req = { path: '/assets/index.js', headers: { 'if-none-match': '"asset"' } };
  const res = createResponse();

  disableDynamicApiCache(req, res, () => undefined);

  assert.equal(req.headers['if-none-match'], '"asset"');
  assert.equal(res.headers.size, 0);
});

test('Express 收到旧 ETag 时仍返回带正文的 200', async (context) => {
  const app = express();
  app.use(disableDynamicApiCache);
  app.get('/deploy-api/v2/targets', (_req, res) => {
    res.json({ success: true, data: [{ id: 1, projectName: '雨燕平台' }] });
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${address.port}/deploy-api/v2/targets`;

  const initial = await fetch(url);
  const etag = initial.headers.get('etag');
  assert.equal(initial.status, 200);
  assert.ok(etag);

  const conditional = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(conditional.status, 200);
  assert.deepEqual(await conditional.json(), {
    success: true,
    data: [{ id: 1, projectName: '雨燕平台' }],
  });
});
