import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import {
  SshConnectionError,
  classifySshError,
  describeSshFailure,
  formatHostKeyFingerprint,
  formatSshFailureLogLines,
  getSshFailureEventExtra,
  logOperationFailure,
  normalizeHostKeyFingerprint,
  toSshConnectionError,
} from '../ssh-errors.mjs';
import {
  connectSsh,
  createConnectConfig,
  createKeyboardInteractiveHandler,
  probeServerConnection,
  setSshConnectionHooks,
} from '../ssh-service.mjs';
import { generateHostKey, getClosedPort, startSshTestServer } from './ssh-test-server.mjs';

const { utils } = ssh2;
const servers = [];
after(async () => {
  setSshConnectionHooks({});
  await Promise.all(servers.map((item) => item.close()));
});

/** 计算私钥对应公钥的 OpenSSH 指纹。 */
function fingerprintOf(privateKey) {
  return formatHostKeyFingerprint(utils.parseKey(privateKey).getPublicSSH());
}

test('classifySshError: 按 ssh2 / socket 错误归类', () => {
  assert.equal(classifySshError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' })), 'auth_failed');
  assert.equal(classifySshError(new Error('Cannot parse privateKey: Unsupported key format')), 'auth_failed');
  assert.equal(classifySshError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED', level: 'client-socket' })), 'refused');
  assert.equal(classifySshError(Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' })), 'timeout');
  assert.equal(classifySshError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), 'timeout');
  assert.equal(classifySshError(Object.assign(new Error('getaddrinfo ENOTFOUND bad.host'), { code: 'ENOTFOUND' })), 'unreachable');
  assert.equal(classifySshError(Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })), 'unreachable');
  assert.equal(classifySshError(new Error('something odd')), 'ssh_error');
});

test('SshConnectionError: 中文提示、定位字段与可重试标记；不再有 host_key_changed', () => {
  const auth = toSshConnectionError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }), { id: 3, name: '测试机', host: '10.0.0.8', port: 22 });
  assert.equal(auth.code, 'auth_failed');
  assert.equal(auth.field, 'password');
  assert.equal(auth.retryable, false);
  assert.match(auth.message, /登录服务器「测试机」失败/);
  assert.equal(auth.details.serverId, 3);

  const refused = toSshConnectionError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.8:22'), { code: 'ECONNREFUSED' }), { name: '测试机', host: '10.0.0.8' });
  assert.equal(refused.retryable, true);
  assert.equal(refused.field, 'port');
  assert.equal('expectedFingerprint' in refused.details, false);
  const lines = formatSshFailureLogLines(refused);
  assert.equal(lines.some((line) => line.includes('指纹')), false);
  assert.equal(lines.some((line) => line.startsWith('原始错误：')), true);

  const timeout = new SshConnectionError('timeout', { serverName: '测试机' });
  assert.equal(timeout.retryable, true);
  assert.match(describeSshFailure('timeout').reasons.join(','), /VPN/);
  assert.deepEqual(getSshFailureEventExtra(new Error('普通错误')), {});
  assert.equal(getSshFailureEventExtra(auth).code, 'auth_failed');

  const logs = [];
  logOperationFailure((...args) => logs.push(args), auth, 'error');
  assert.equal(logs.every(([level]) => level === 'error'), true);
  assert.equal(logs.every((entry) => entry[4]?.code === 'auth_failed'), true);
});

test('指纹格式与 ssh-keygen -lf 一致并可规范化', () => {
  const key = generateHostKey();
  const fingerprint = fingerprintOf(key);
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(normalizeHostKeyFingerprint(`${fingerprint}=`), fingerprint);
  assert.equal(normalizeHostKeyFingerprint('SHA256:short'), '');
});

test('createConnectConfig: 密码登录开启 tryKeyboard 并去掉首尾空格', () => {
  const config = createConnectConfig({ host: ' 10.0.0.1 ', port: 22, username: ' root ', authType: 'password', credential: { password: 'pwd' } });
  assert.equal(config.host, '10.0.0.1');
  assert.equal(config.username, 'root');
  assert.equal(config.tryKeyboard, true);
  assert.equal(typeof config.hostVerifier, 'function');
  const keyConfig = createConnectConfig({ host: 'h', authType: 'privateKey', credential: { privateKey: 'k', passphrase: 'p' } });
  assert.equal(keyConfig.tryKeyboard, undefined);
  assert.equal(keyConfig.passphrase, 'p');

  const answers = [];
  createKeyboardInteractiveHandler({ credential: { password: 'pwd' } })('', '', '', [{ prompt: 'Password:' }, { prompt: 'OTP' }], (values) => answers.push(values));
  assert.deepEqual(answers[0], ['pwd', 'pwd']);
});

test('真实 SSH：仅 keyboard-interactive 的服务器可用密码登录', async () => {
  const sshServer = await startSshTestServer({ mode: 'keyboard', password: 'kbd-secret' });
  servers.push(sshServer);
  const result = await probeServerConnection({
    host: '127.0.0.1', port: sshServer.port, username: 'tester', authType: 'password', credential: { password: 'kbd-secret' },
  });
  assert.equal(result.account, 'tester');
  assert.equal(result.hostKeySha256, fingerprintOf(sshServer.hostKey));
  assert.equal(sshServer.attempts.includes('keyboard-interactive'), true);
});

test('真实 SSH：密码错误归类为 auth_failed，端口无人监听归类为 refused', async () => {
  const sshServer = await startSshTestServer({ password: 'right' });
  servers.push(sshServer);
  await assert.rejects(
    probeServerConnection({ host: '127.0.0.1', port: sshServer.port, username: 'tester', authType: 'password', credential: { password: 'wrong' } }),
    (error) => error instanceof SshConnectionError && error.code === 'auth_failed',
  );
  const closedPort = await getClosedPort();
  await assert.rejects(
    probeServerConnection({ host: '127.0.0.1', port: closedPort, username: 'tester', authType: 'password', credential: { password: 'x' } }),
    (error) => error.code === 'refused' && error.field === 'port',
  );
});

test('真实 SSH：sudo 不可用只作为提示，不影响登录结果', async () => {
  const sshServer = await startSshTestServer({ sudoOk: false });
  servers.push(sshServer);
  const result = await probeServerConnection(
    { host: '127.0.0.1', port: sshServer.port, username: 'tester', authType: 'password', credential: { password: 'secret' } },
    { useSudo: true },
  );
  assert.equal(result.sudo.checked, true);
  assert.equal(result.sudo.ok, false);
  assert.match(result.sudo.message, /sudo 不可用/);
});

test('真实 SSH：首次连接记录指纹；主机密钥变化后照常登录并触发自动更新钩子', async () => {
  const sshServer = await startSshTestServer();
  servers.push(sshServer);
  const firstSeen = [];
  const changed = [];
  const results = [];
  setSshConnectionHooks({
    onHostKeyFirstSeen: (server, fingerprint) => firstSeen.push([server.id, fingerprint]),
    onHostKeyChanged: (server, previous, next) => changed.push([server.id, previous, next]),
    onConnectionResult: (server, result) => results.push([server.id, result.ok, result.error?.code || '']),
  });
  const server = { id: 41, name: '指纹机', host: '127.0.0.1', port: sshServer.port, username: 'tester', authType: 'password', credential: { password: 'secret' } };
  const oldFingerprint = fingerprintOf(sshServer.hostKey);
  const conn = await connectSsh(server);
  conn.end();
  assert.deepEqual(firstSeen, [[41, oldFingerprint]]);
  assert.equal(server.hostKeySha256, oldFingerprint);

  const newKey = generateHostKey();
  await sshServer.setHostKey(newKey);
  const second = await connectSsh(server);
  second.end();
  assert.equal(firstSeen.length, 1, '已有指纹时不再走首次记录');
  assert.deepEqual(changed, [[41, oldFingerprint, fingerprintOf(newKey)]]);
  assert.equal(server.hostKeySha256, fingerprintOf(newKey));
  assert.deepEqual(results.at(-1), [41, true, '']);

  // 指纹已更新后再次连接不再重复触发。
  const third = await connectSsh(server);
  third.end();
  assert.equal(changed.length, 1);

  // 换了密钥且密码错误：仍按登录失败处理。
  await sshServer.setHostKey(generateHostKey());
  await assert.rejects(connectSsh({ ...server, credential: { password: 'wrong' } }), (error) => error.code === 'auth_failed');
  assert.equal(changed.length, 1, '登录失败不更新指纹');
  setSshConnectionHooks({});
});
