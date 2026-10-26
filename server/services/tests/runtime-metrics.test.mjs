import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { getMetricsSnapshot, httpMetricsMiddleware, incrementCounter, measure, recordTiming, resetMetrics } from '../runtime-metrics.mjs';

test('耗时分位、错误与超时统计', async () => {
  resetMetrics();
  for (let index = 1; index <= 100; index += 1) recordTiming('gitlab.commit_meta', index);
  recordTiming('gitlab.commit_meta', 3000, { error: true, timeout: true });
  await assert.rejects(measure('ssh.backend_status_probe', async () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  }));
  incrementCounter('backend_status.cache_hit');
  incrementCounter('backend_status.cache_hit');

  const snapshot = getMetricsSnapshot({ extra: { ok: true } });
  const gitlab = snapshot.timings.find((item) => item.name === 'gitlab.commit_meta');
  assert.equal(gitlab.count, 101);
  assert.equal(gitlab.errors, 1);
  assert.equal(gitlab.timeouts, 1);
  assert.equal(gitlab.p50Ms, 51);
  assert.equal(gitlab.maxMs, 3000);
  const ssh = snapshot.timings.find((item) => item.name === 'ssh.backend_status_probe');
  assert.equal(ssh.timeouts, 1);
  assert.equal(snapshot.counters['backend_status.cache_hit'], 2);
  assert.deepEqual(snapshot.extra, { ok: true });
  assert.equal(snapshot.timings[0].name, 'gitlab.commit_meta', '按 p95 降序，最慢的排在最前');
});

test('HTTP 中间件按路由模板聚合，不记录具体 ID', async (context) => {
  resetMetrics();
  const app = express();
  const router = express.Router();
  router.get('/targets/:id/service-status', (_req, res) => res.json({ ok: true }));
  router.get('/boom', (_req, res) => res.status(500).json({ ok: false }));
  app.use('/deploy-api', httpMetricsMiddleware);
  app.use('/deploy-api/v2', router);
  const server = app.listen(0, '127.0.0.1');
  context.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/deploy-api/v2/targets/101/service-status`);
  await fetch(`${base}/deploy-api/v2/targets/202/service-status`);
  await fetch(`${base}/deploy-api/v2/boom`);

  const names = getMetricsSnapshot().timings.map((item) => item.name);
  assert.ok(names.includes('http GET /deploy-api/v2/targets/:id/service-status'));
  assert.ok(!names.some((name) => /101|202/.test(name)));
  const statusSeries = getMetricsSnapshot().timings.find((item) => item.name === 'http GET /deploy-api/v2/targets/:id/service-status');
  assert.equal(statusSeries.count, 2);
  assert.equal(getMetricsSnapshot().timings.find((item) => item.name === 'http GET /deploy-api/v2/boom').errors, 1);
});
