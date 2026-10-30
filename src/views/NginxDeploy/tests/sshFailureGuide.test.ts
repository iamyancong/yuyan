import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSshFailure,
  extractSshFailureFromLogs,
  formatScanErrorMessage,
  getScanStatusTag,
  getServerConnectionStatusTag,
  getSshFailureGuide,
  normalizeSshFailure,
} from '../sshFailureGuide.ts';

test('auth_failed：只给「更新登录凭据」并聚焦密码，不允许重试', () => {
  const failure = normalizeSshFailure({ code: 'auth_failed', message: '登录 10.0.0.8 失败：账号或密码不正确', field: 'password', retryable: false })!;
  const guide = getSshFailureGuide(failure);
  assert.equal(guide.title, '登录服务器失败');
  assert.equal(guide.retryable, false);
  assert.deepEqual(guide.actions.map((item) => [item.key, item.label, item.focusField]), [['editCredential', '更新登录凭据', 'password']]);
  assert.ok(guide.reasons.includes('服务器密码已更换'));
});

test('auth_failed 使用私钥时聚焦私钥字段', () => {
  const guide = getSshFailureGuide(normalizeSshFailure({ code: 'auth_failed', field: 'privateKey' })!);
  assert.equal(guide.actions[0].focusField, 'privateKey');
});

test('主机密钥变化不再是失败：host_key_changed 不识别为 SSH 失败、没有引导条目', () => {
  assert.equal(normalizeSshFailure({ code: 'host_key_changed', message: '服务器主机密钥已变化' }), null);
  assert.equal(extractSshFailure({ response: { data: { error: 'x', code: 'host_key_changed' } } }), null);
  assert.equal(getServerConnectionStatusTag({ connectionStatus: 'host_key_changed' }).text, '未检测', '旧数据里的状态按未检测展示');
});

test('refused / timeout / unreachable / sudo_unavailable 的引导动作', () => {
  const keys = (code: string) => getSshFailureGuide(normalizeSshFailure({ code })!).actions.map((item) => `${item.key}:${item.focusField || ''}`);
  assert.deepEqual(keys('refused'), ['editEndpoint:port']);
  assert.deepEqual(keys('timeout'), ['retry:', 'editHost:host']);
  assert.deepEqual(keys('unreachable'), ['retry:', 'editHost:host']);
  assert.deepEqual(keys('sudo_unavailable'), ['editSudo:useSudo']);
  assert.equal(normalizeSshFailure({ code: 'timeout' })!.retryable, true);
  assert.match(getSshFailureGuide(normalizeSshFailure({ code: 'timeout' })!).hint, /VPN/);
});

test('非 SSH 错误码返回 null', () => {
  assert.equal(normalizeSshFailure({ code: 'conflict' }), null);
  assert.equal(extractSshFailure(new Error('boom')), null);
  assert.equal(extractSshFailure(null), null);
});

test('extractSshFailure 兼容 axios、流式错误和失败事件', () => {
  const axiosError = { message: 'Request failed', response: { data: { error: '登录失败', code: 'auth_failed', details: { code: 'auth_failed', field: 'password' } } } };
  assert.equal(extractSshFailure(axiosError)?.code, 'auth_failed');
  assert.equal(extractSshFailure(axiosError)?.message, '登录失败');
  const streamError = Object.assign(new Error('连接被拒绝'), { code: 'refused', details: { code: 'refused', serverId: 7, host: '10.0.0.8', port: 2222 } });
  assert.deepEqual([extractSshFailure(streamError)?.code, extractSshFailure(streamError)?.serverId, extractSshFailure(streamError)?.port], ['refused', 7, 2222]);
  const eventError = { message: '连接超时', failure: { code: 'timeout', message: '连接超时' } };
  assert.equal(extractSshFailure(eventError)?.code, 'timeout');
  const codeOnly = { response: { data: { error: '拒绝连接', code: 'refused' } } };
  assert.equal(extractSshFailure(codeOnly)?.field, 'port');
});

test('extractSshFailureFromLogs 从发布日志还原失败原因', () => {
  const failure = extractSshFailureFromLogs([
    { level: 'info', message: '开始发布' },
    { level: 'error', message: '登录 10.0.0.8 失败：账号或密码不正确', code: 'auth_failed' },
    { level: 'error', message: '可能原因：服务器密码已更换', code: 'auth_failed' },
  ]);
  assert.equal(failure?.code, 'auth_failed');
  assert.equal(failure?.message, '登录 10.0.0.8 失败：账号或密码不正确');
  assert.equal(failure?.retryable, false);
  assert.equal(extractSshFailureFromLogs([{ level: 'error', message: 'npm ERR' }]), null);
});

test('服务器连接状态标签', () => {
  const formatTime = (value: string) => `T(${value})`;
  assert.deepEqual(getServerConnectionStatusTag({ connectionStatus: 'ok', connectionCheckedAt: 'x' }, { formatTime }), { text: '连接正常', color: 'success', tooltip: '最近检测：T(x)' });
  assert.equal(getServerConnectionStatusTag({ connectionStatus: 'auth_failed', connectionError: '密码错误' }).text, '登录失败');
  assert.match(getServerConnectionStatusTag({ connectionStatus: 'auth_failed', connectionError: '密码错误' }).tooltip, /密码错误/);
  assert.equal(getServerConnectionStatusTag({ connectionStatus: 'refused' }).text, '拒绝连接');
  assert.equal(getServerConnectionStatusTag({ connectionStatus: 'timeout' }).text, '连接超时');
  assert.equal(getServerConnectionStatusTag({ connectionStatus: 'unreachable' }).text, '网络不可达');
  assert.equal(getServerConnectionStatusTag({}).text, '未检测');
});

test('扫描状态标签：失败时不再显示「扫描中」', () => {
  assert.deepEqual(getScanStatusTag({ scanning: true, error: 'x' }), { text: '扫描中', color: 'processing' });
  assert.deepEqual(getScanStatusTag({ scanning: false, error: '登录失败' }), { text: '扫描失败', color: 'error' });
  assert.deepEqual(getScanStatusTag({ scannedAt: '2026-10-30T00:00:00Z', formatTime: () => '08:00:00 扫描' }), { text: '08:00:00 扫描', color: 'default' });
  assert.equal(getScanStatusTag({}), null);
});

test('扫描错误提示：英文底层错误转为中文兜底', () => {
  assert.equal(formatScanErrorMessage(new Error('All configured authentication methods failed')), '扫描失败，请稍后重试或使用手动接入');
  assert.equal(formatScanErrorMessage({ response: { data: { error: '未找到 Nginx' } } }), '未找到 Nginx');
  assert.equal(formatScanErrorMessage({ response: { data: { error: '登录 1.1.1.1 失败', code: 'auth_failed' } } }), '登录 1.1.1.1 失败');
});
