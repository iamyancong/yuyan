import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CENTRAL_RECOVERY_LOOP_WINDOW_MS,
  decideCentralSessionInvalidAction,
  extractBearerToken,
  isCentralSessionInvalidError,
  registerCentralSessionInvalidHandler,
  reportCentralSessionInvalid,
  shouldResetForCentralSessionInvalid,
  waitForCentralSessionInvalidHandling,
} from '../centralSessionGuard.ts';
import { normalizeDeployHttpError } from '../../api/deployResponsePolicy.ts';

/** 构造 axios 风格的 HTTP 错误。 */
function axiosError(status: number, data: unknown, code = 'ERR_BAD_REQUEST') {
  const error: any = new Error(`Request failed with status code ${status}`);
  error.code = code;
  error.response = { status, data };
  return error;
}

const SESSION_INVALID_BODY = {
  success: false,
  error: { code: 'session_invalid', message: '雨燕账号或设备会话已失效', retryable: true },
};

test('识别中央 v2 鉴权失败：axios 原始错误、归一化错误与 requestCentral 错误', () => {
  assert.equal(isCentralSessionInvalidError(axiosError(401, SESSION_INVALID_BODY)), true);
  assert.equal(isCentralSessionInvalidError(normalizeDeployHttpError(axiosError(401, SESSION_INVALID_BODY))), true);
  const centralError = Object.assign(new Error('雨燕账号或设备会话已失效'), { status: 401, code: 'session_invalid' });
  assert.equal(isCentralSessionInvalidError(centralError), true);
});

test('不误判：部署目标/Agent Gateway/网页 PAT 的 401、403、5xx、超时与取消', () => {
  assert.equal(isCentralSessionInvalidError(axiosError(401, { success: false, error: '部署 API 鉴权失败' })), false);
  assert.equal(isCentralSessionInvalidError(axiosError(401, { success: false, error: { code: 'authorization_failed' } })), false);
  assert.equal(isCentralSessionInvalidError(axiosError(401, { success: false, error: { code: 'web_gitlab_auth_failed' } })), false);
  assert.equal(isCentralSessionInvalidError(axiosError(502, { success: false, error: { code: 'ssh_auth_failed', message: 'Permission denied' } })), false);
  assert.equal(isCentralSessionInvalidError(axiosError(403, { success: false, error: { code: 'session_invalid' } })), false);
  assert.equal(isCentralSessionInvalidError(axiosError(500, SESSION_INVALID_BODY)), false);
  assert.equal(isCentralSessionInvalidError(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })), false);
  assert.equal(isCentralSessionInvalidError(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' })), false);
  assert.equal(isCentralSessionInvalidError(null), false);
  assert.equal(isCentralSessionInvalidError('session_invalid'), false);
});

test('extractBearerToken：普通对象、小写键与带 get 的 Headers', () => {
  assert.equal(extractBearerToken({ Authorization: 'Bearer abc' }), 'abc');
  assert.equal(extractBearerToken({ authorization: 'bearer  xyz ' }), 'xyz');
  assert.equal(extractBearerToken(new Headers({ Authorization: 'Bearer h1' })), 'h1');
  assert.equal(extractBearerToken({ 'X-GitLab-Token': 'pat' }), '');
  assert.equal(extractBearerToken(undefined), '');
});

test('并发失败只触发一次处理，处理结束后可再次触发', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const unregister = registerCentralSessionInvalidHandler(async (token) => {
    calls.push(token);
    await gate;
  });
  try {
    assert.equal(reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 'old-token'), true);
    assert.equal(reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 'old-token'), true);
    assert.equal(reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 'old-token'), true);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ['old-token']);
    release();
    await waitForCentralSessionInvalidHandling();
    reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 'old-token-2');
    await waitForCentralSessionInvalidHandling();
    assert.deepEqual(calls, ['old-token', 'old-token-2']);
  } finally {
    unregister();
  }
});

test('处理器把失败请求携带的令牌原样传入，供认证层与当前令牌比对', async () => {
  const seen: string[] = [];
  const unregister = registerCentralSessionInvalidHandler((token) => { seen.push(token); });
  try {
    reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 'token-from-request');
    await waitForCentralSessionInvalidHandling();
    assert.deepEqual(seen, ['token-from-request']);
  } finally {
    unregister();
  }
});

test('非会话失效、未携带令牌或未注册处理器时不触发处理', async () => {
  let called = 0;
  const unregister = registerCentralSessionInvalidHandler(() => { called += 1; });
  try {
    assert.equal(reportCentralSessionInvalid(axiosError(503, { success: false }), 'token'), false);
    assert.equal(reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), ''), true);
    await waitForCentralSessionInvalidHandling();
    assert.equal(called, 0);
  } finally {
    unregister();
  }
  assert.equal(reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 'token'), true);
  await waitForCentralSessionInvalidHandling();
  assert.equal(called, 0);
});

test('处理器抛错不会卡死后续处理', async () => {
  let attempts = 0;
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const unregister = registerCentralSessionInvalidHandler(() => {
    attempts += 1;
    throw new Error('boom');
  });
  try {
    reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 't');
    await waitForCentralSessionInvalidHandling();
    reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 't');
    await waitForCentralSessionInvalidHandling();
    assert.equal(attempts, 2);
  } finally {
    unregister();
    console.warn = originalWarn;
  }
});

test('认证层只在桌面端、已登录且失败请求用的是当前令牌时清会话', () => {
  const base = { isDesktop: true, isAuthenticated: true, currentAccessToken: 'cur', usedAccessToken: 'cur' };
  assert.equal(shouldResetForCentralSessionInvalid(base), true);
  /** 重新登录后迟到的旧请求：不能把新会话登出。 */
  assert.equal(shouldResetForCentralSessionInvalid({ ...base, usedAccessToken: 'old' }), false);
  /** 已经登出（并发请求的第二轮）：不重复提示。 */
  assert.equal(shouldResetForCentralSessionInvalid({ ...base, isAuthenticated: false }), false);
  /** 网页端不持有中央令牌，保持原行为。 */
  assert.equal(shouldResetForCentralSessionInvalid({ ...base, isDesktop: false }), false);
  assert.equal(shouldResetForCentralSessionInvalid({ ...base, currentAccessToken: '', usedAccessToken: '' }), false);
});

test('恢复决策：令牌已轮换的迟到请求忽略，当前令牌失效先恢复', () => {
  const base = { isDesktop: true, isAuthenticated: true, currentAccessToken: 'cur', usedAccessToken: 'cur', now: 1_000_000 };
  assert.equal(decideCentralSessionInvalidAction(base), 'recover');
  /** 定时器已把令牌轮换成 next：轮换窗口内的旧请求不能触发恢复或登出。 */
  assert.equal(decideCentralSessionInvalidAction({ ...base, currentAccessToken: 'next' }), 'ignore');
  assert.equal(decideCentralSessionInvalidAction({ ...base, isDesktop: false }), 'ignore');
  assert.equal(decideCentralSessionInvalidAction({ ...base, isAuthenticated: false }), 'ignore');
});

test('恢复决策：恢复换来的令牌只在窗口内再失效才跳登录，窗口外（正常轮换）照常恢复', () => {
  const base = { isDesktop: true, isAuthenticated: true, currentAccessToken: 'fresh', usedAccessToken: 'fresh', now: 1_000_000 };
  /** 刚换来立刻又失效：循环，跳登录。 */
  assert.equal(decideCentralSessionInvalidAction({ ...base, recoveredAt: base.now - 5_000 }), 'relogin');
  /** 1.3.25 回归：恢复换来的令牌 13 分钟后在正常轮换窗口遇到 401，不能被登出。 */
  assert.equal(decideCentralSessionInvalidAction({ ...base, recoveredAt: base.now - CENTRAL_RECOVERY_LOOP_WINDOW_MS }), 'recover');
  assert.equal(decideCentralSessionInvalidAction({ ...base, recoveredAt: base.now - 13 * 60_000 }), 'recover');
});

test('并发失效共享同一轮续期：续期进行中的其他失败不会再发起续期', async () => {
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const unregister = registerCentralSessionInvalidHandler(async () => {
    attempts += 1;
    await gate;
  });
  try {
    const failures = Array.from({ length: 5 }, () => axiosError(401, SESSION_INVALID_BODY));
    failures.forEach((error) => reportCentralSessionInvalid(error, 'stale'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    reportCentralSessionInvalid(axiosError(401, SESSION_INVALID_BODY), 'stale');
    release();
    await waitForCentralSessionInvalidHandling();
    assert.equal(attempts, 1);
  } finally {
    unregister();
  }
});
