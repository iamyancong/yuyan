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

test('verifyCiStatus: 最新 CI 被取消但同 Commit 存在已成功记录时予以放行', async () => {
  const logs = [];
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: [
        {
          id: 2002,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'cancelled',
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/2002',
          created_at: '2026-11-24T03:28:57Z',
        },
        {
          id: 2001,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/2001',
          created_at: '2026-11-24T03:18:48Z',
        },
      ],
    }),
  });

  const result = await verifyCiStatus({
    targetSha: 'd0c7a9c19d38487993fe1e46c18594912960166d',
    repo: 'ycwang-dev/yuyan',
    token: 'test-token',
    fetchFn: mockFetch,
    logger: (msg) => logs.push(msg),
  });

  assert.equal(result.success, true);
  assert.equal(result.run?.id, 2001);
  assert.ok(logs.some((l) => l.includes('予以放行')));
});

test('verifyCiStatus: 最新 CI 失败时即使同 Commit 曾成功仍拦截阻断', async () => {
  const logs = [];
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: [
        {
          id: 2004,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/2004',
          created_at: '2026-11-24T03:28:57Z',
        },
        {
          id: 2003,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/2003',
          created_at: '2026-11-24T03:18:48Z',
        },
      ],
    }),
  });

  const result = await verifyCiStatus({
    targetSha: 'd0c7a9c19d38487993fe1e46c18594912960166d',
    repo: 'ycwang-dev/yuyan',
    token: 'test-token',
    fetchFn: mockFetch,
    logger: (msg) => logs.push(msg),
  });

  assert.equal(result.success, false);
  assert.equal(result.run?.id, 2004);
  assert.ok(logs.some((l) => l.includes('严正拦截')));
});

test('verifyCiStatus: 仅有被取消的 CI 记录且无成功记录时仍拦截阻断', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      workflow_runs: [
        {
          id: 2005,
          name: 'CI / CD Pipeline',
          path: '.github/workflows/ci.yml',
          status: 'completed',
          conclusion: 'cancelled',
          html_url: 'https://github.com/ycwang-dev/yuyan/actions/runs/2005',
          created_at: '2026-11-24T03:28:57Z',
        },
      ],
    }),
  });

  const result = await verifyCiStatus({
    targetSha: 'd0c7a9c19d38487993fe1e46c18594912960166d',
    repo: 'ycwang-dev/yuyan',
    token: 'test-token',
    fetchFn: mockFetch,
    logger: () => {},
  });

  assert.equal(result.success, false);
  assert.equal(result.run?.conclusion, 'cancelled');
});
