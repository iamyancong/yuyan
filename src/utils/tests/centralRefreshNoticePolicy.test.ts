import assert from 'node:assert/strict';
import test from 'node:test';
import { CENTRAL_NOTICE_MIN_DURATION_MS, CENTRAL_NOTICE_MIN_FAILURES, shouldShowCentralRefreshNotice } from '../centralRefreshNoticePolicy.ts';
import { CENTRAL_LIST_READ_TIMEOUT_MS } from '../centralReadRecovery.ts';

const base = { quiet: false, status: 'recovering' as const, failures: 1, failingSince: 0, now: 1000 };

test('手动刷新：单次失败且未满 8 秒不提示', () => {
  assert.equal(shouldShowCentralRefreshNotice(base), false);
  assert.equal(shouldShowCentralRefreshNotice({ ...base, now: CENTRAL_NOTICE_MIN_DURATION_MS - 1 }), false);
});

test('手动刷新：连续失败 2 次或故障满 8 秒提示', () => {
  assert.equal(CENTRAL_NOTICE_MIN_FAILURES, 2);
  assert.equal(shouldShowCentralRefreshNotice({ ...base, failures: 2 }), true);
  assert.equal(shouldShowCentralRefreshNotice({ ...base, now: CENTRAL_NOTICE_MIN_DURATION_MS }), true);
});

test('后台/静默刷新：重试期间无论多少次都不提示，最终失败才提示', () => {
  assert.equal(shouldShowCentralRefreshNotice({ ...base, quiet: true, failures: 5, now: 60_000 }), false);
  assert.equal(shouldShowCentralRefreshNotice({ ...base, quiet: true, status: 'failed' }), true);
});

test('空闲或加载中不提示；列表超时放宽到 10-15 秒', () => {
  assert.equal(shouldShowCentralRefreshNotice({ ...base, status: 'idle', failures: 3 }), false);
  assert.equal(shouldShowCentralRefreshNotice({ ...base, status: 'loading', failingSince: null, failures: 0 }), false);
  assert.ok(CENTRAL_LIST_READ_TIMEOUT_MS >= 10_000 && CENTRAL_LIST_READ_TIMEOUT_MS <= 15_000);
});
