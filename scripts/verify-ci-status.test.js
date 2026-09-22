import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCiStatus } from './verify-ci-status.mjs';

test('verifyCiStatus: CI 运行成功时秒级放行', async () => {
  const logs = [];
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: [
        {
          id: 1001,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/1001',
          created_at: '2026-09-22T10:00:00Z',
        },
      ],
    }),
  });

  const result = await verifyCiStatus({
    targetSha: '0123456789abcdef0123456789abcdef01234567',
    repo: 'ycwang-dev/yuyan',
    token: 'test-token',
    fetchFn: mockFetch,
    logger: (msg) => logs.push(msg),
  });

  assert.equal(result.success, true);
  assert.equal(result.run?.id, 1001);
  assert.ok(logs.some((l) => l.includes('全部通过')));
});

test('verifyCiStatus: CI 运行失败时拦截阻断', async () => {
  const logs = [];
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: [
        {
          id: 1002,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/1002',
          created_at: '2026-09-22T10:00:00Z',
        },
      ],
    }),
  });

  const result = await verifyCiStatus({
    targetSha: 'abcdef0123456789abcdef0123456789abcdef01',
    repo: 'ycwang-dev/yuyan',
    token: 'test-token',
    fetchFn: mockFetch,
    logger: (msg) => logs.push(msg),
  });

  assert.equal(result.success, false);
  assert.equal(result.run?.conclusion, 'failure');
  assert.ok(logs.some((l) => l.includes('严正拦截')));
});

test('verifyCiStatus: CI 运行中时轮询等待，完成后通过', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      json: async () => ({
        workflow_runs: [
          {
            id: 1003,
            name: 'CI / CD Pipeline',
            path: '.github/workflows/ci.yml',
            status: callCount === 1 ? 'in_progress' : 'completed',
            conclusion: callCount === 1 ? null : 'success',
            html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/1003',
            created_at: '2026-09-22T10:00:00Z',
          },
        ],
      }),
    };
  };

  const result = await verifyCiStatus({
    targetSha: '1111222233334444555566667777888899990000',
    repo: 'ycwang-dev/yuyan',
    pollIntervalMs: 10,
    maxWaitSeconds: 5,
    fetchFn: mockFetch,
    logger: () => {},
  });

  assert.equal(result.success, true);
  assert.equal(callCount, 2);
});

test('verifyCiStatus: 超过最长等待时间时超时退出', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: [
        {
          id: 1004,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'in_progress',
          conclusion: null,
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/1004',
          created_at: '2026-09-22T10:00:00Z',
        },
      ],
    }),
  });

  const result = await verifyCiStatus({
    targetSha: '9999888877776666555544443333222211110000',
    repo: 'ycwang-dev/yuyan',
    pollIntervalMs: 50,
    maxWaitSeconds: 0, // 立即超时
    fetchFn: mockFetch,
    logger: () => {},
  });

  assert.equal(result.success, false);
  assert.ok(result.message?.includes('超时'));
});
