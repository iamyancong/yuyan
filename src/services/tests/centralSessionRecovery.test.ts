import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCentralAuthError,
  createSerialTaskQueue,
  recoverCentralSession,
  type RecoverableSessionState,
} from '../centralSessionRecovery.ts';

interface State extends RecoverableSessionState { label: string }

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 1_000).toISOString();

/** 构造带 status/code 的中央错误。 */
function centralError(status: number | undefined, code?: string) {
  return Object.assign(new Error(code || `HTTP ${status}`), { status, code });
}

/** 构造可观测调用的依赖。 */
function deps(stored: State | null, impl: { refresh?: () => Promise<State>; exchange?: () => Promise<State> } = {}) {
  const calls: string[] = [];
  let saved: State | null = null;
  return {
    calls,
    get saved() { return saved; },
    loadStored: async () => stored,
    refresh: async () => { calls.push('refresh'); return impl.refresh ? impl.refresh() : { ...stored!, accessToken: 'refreshed', label: 'refresh' }; },
    exchange: async () => { calls.push('exchange'); return impl.exchange ? impl.exchange() : { ...stored!, accessToken: 'exchanged', label: 'exchange' }; },
    save: async (state: State) => { calls.push('save'); saved = state; },
  };
}

const base: State = { label: 'stored', accessToken: 'cur', refreshToken: 'r'.repeat(40), refreshExpiresAt: FUTURE, gitlabHost: 'http://192.168.167.142:8081', gitlabToken: 'pat-xxxxxxxx' };

test('错误分类：白名单拒绝单独提示，身份拒绝才重新登录，其余都是临时错误', () => {
  assert.equal(classifyCentralAuthError(centralError(403, 'gitlab_host_not_allowed')), 'host_not_allowed');
  for (const code of ['gitlab_token_invalid', 'device_revoked', 'device_key_mismatch', 'session_expired', 'device_signature_expired']) {
    assert.equal(classifyCentralAuthError(centralError(401, code)), 'rejected', code);
  }
  assert.equal(classifyCentralAuthError(centralError(403)), 'rejected');
  for (const error of [new TypeError('Failed to fetch'), centralError(500, 'identity_error'), centralError(502, 'gitlab_unavailable'), centralError(409, 'refresh_replay_detected'), centralError(429), centralError(400, 'invalid_request'), null]) {
    assert.equal(classifyCentralAuthError(error), 'transient');
  }
});

test('令牌已被定时器轮换（存储里不是失败请求的令牌）：忽略，不 refresh、不换票、不登出', async () => {
  const d = deps({ ...base, accessToken: 'rotated-by-timer' });
  assert.deepEqual(await recoverCentralSession('cur', d), { kind: 'rotated' });
  assert.deepEqual(d.calls, []);
  assert.deepEqual(await recoverCentralSession('cur', deps(null)), { kind: 'rotated' });
});

test('当前令牌失效：先用 refresh 轮换（不吊销其他会话），成功即保存，不换票', async () => {
  const d = deps(base);
  const outcome = await recoverCentralSession('cur', d);
  assert.equal(outcome.kind, 'recovered');
  assert.equal(outcome.kind === 'recovered' && outcome.via, 'refresh');
  assert.deepEqual(d.calls, ['refresh', 'save']);
  assert.equal(d.saved?.accessToken, 'refreshed');
});

test('refresh 被拒（会话过期/签名过期）才用 GitLab 凭据换票', async () => {
  const d = deps(base, { refresh: () => Promise.reject(centralError(401, 'session_expired')) });
  const outcome = await recoverCentralSession('cur', d);
  assert.equal(outcome.kind === 'recovered' && outcome.via, 'exchange');
  assert.deepEqual(d.calls, ['refresh', 'exchange', 'save']);
  const expired = deps({ ...base, refreshExpiresAt: PAST });
  await recoverCentralSession('cur', expired);
  assert.deepEqual(expired.calls, ['exchange', 'save']);
});

test('refresh 临时失败（网络/5xx）：保持登录，不换票（换票会吊销会话）', async () => {
  const d = deps(base, { refresh: () => Promise.reject(new TypeError('Failed to fetch')) });
  assert.equal((await recoverCentralSession('cur', d)).kind, 'transient');
  assert.deepEqual(d.calls, ['refresh']);
});

test('换票结果：白名单拒绝 → host_not_allowed；GitLab 令牌失效/设备撤销 → rejected；网络错误 → transient', async () => {
  const refreshRejected = () => Promise.reject(centralError(401, 'session_expired'));
  const cases: Array<[Error, string]> = [
    [centralError(403, 'gitlab_host_not_allowed'), 'host_not_allowed'],
    [centralError(401, 'gitlab_token_invalid'), 'rejected'],
    [centralError(403, 'device_revoked'), 'rejected'],
    [centralError(500, 'identity_error'), 'transient'],
    [new TypeError('Failed to fetch'), 'transient'],
  ];
  for (const [error, kind] of cases) {
    const d = deps(base, { refresh: refreshRejected, exchange: () => Promise.reject(error) });
    assert.equal((await recoverCentralSession('cur', d)).kind, kind, String(error.message));
    assert.equal(d.saved, null);
  }
});

test('没有 GitLab 凭据且 refresh 被拒：rejected（需要重新登录）', async () => {
  const d = deps({ ...base, gitlabToken: '' }, { refresh: () => Promise.reject(centralError(401, 'session_expired')) });
  assert.equal((await recoverCentralSession('cur', d)).kind, 'rejected');
  assert.deepEqual(d.calls, ['refresh']);
});

test('串行队列：续期任务依次执行，idle 等到最后一个落盘', async () => {
  const queue = createSerialTaskQueue();
  const order: string[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = queue.run(async () => { await sleep(20); order.push('maintain-refresh'); return 1; });
  const failing = queue.run(async () => { order.push('failing'); throw new Error('boom'); });
  const second = queue.run(async () => { order.push('recover'); return 2; });
  await queue.idle();
  order.push('idle');
  assert.deepEqual(order, ['maintain-refresh', 'failing', 'recover', 'idle']);
  assert.equal(await first, 1);
  await assert.rejects(failing, /boom/);
  assert.equal(await second, 2);
});

test('回归（1.3.25 约 26 分钟被踢）：定时器轮换窗口内的旧请求 401，等轮换落盘后判定为已轮换', async () => {
  const queue = createSerialTaskQueue();
  let storage: State = { ...base, accessToken: 'A' };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 定时器：服务端已轮换（A 失效），钥匙串写入需要 30ms。 */
  const maintain = queue.run(async () => { await sleep(30); storage = { ...storage, accessToken: 'A2' }; });
  /** 轮换窗口内到达的 401（用的是 A）：先等队列空闲，再在队列里恢复。 */
  await sleep(5);
  await queue.idle();
  const calls: string[] = [];
  const outcome = await queue.run(() => recoverCentralSession<State>('A', {
    loadStored: async () => storage,
    refresh: async (s) => { calls.push('refresh'); return s; },
    exchange: async (s) => { calls.push('exchange'); return s; },
    save: async () => undefined,
  }));
  await maintain;
  assert.deepEqual(outcome, { kind: 'rotated' });
  assert.deepEqual(calls, []);
});
