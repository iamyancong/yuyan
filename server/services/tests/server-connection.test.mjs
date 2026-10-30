import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import ssh2 from 'ssh2';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-server-connection-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'server-connection-test-key';

const store = await import('../deploy-store.mjs');
const connection = await import('../server-connection-service.mjs');
const { SshConnectionError, formatHostKeyFingerprint } = await import('../ssh-errors.mjs');
const controller = await import('../../controllers/deploy-controller.mjs');
const { generateHostKey, getClosedPort, startSshTestServer } = await import('./ssh-test-server.mjs');

const sshServers = [];
after(async () => {
  await Promise.all(sshServers.map((item) => item.close()));
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

const FINGERPRINT_A = `SHA256:${'A'.repeat(43)}`;
const FINGERPRINT_B = `SHA256:${'B'.repeat(43)}`;

/** 计算私钥对应公钥指纹。 */
const fingerprintOf = (privateKey) => formatHostKeyFingerprint(ssh2.utils.parseKey(privateKey).getPublicSSH());

/** 记录调用的假探测器。 */
function createProbe(result = {}) {
  const calls = [];
  const probe = async (server, options) => {
    calls.push({ server: JSON.parse(JSON.stringify(server)), options });
    if (result instanceof Error) throw result;
    return { account: 'root', output: 'ok', hostKeySha256: FINGERPRINT_A, sudo: { checked: false, ok: true, message: '' }, ...result };
  };
  probe.calls = calls;
  return probe;
}

/** 认证失败的假错误。 */
const authError = () => Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });

/** 构造 Express 风格的假响应。 */
function createRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
    on() {},
    off() {},
  };
}

/** 构造假请求。 */
const createReq = (params, body = {}) => ({ params, body, query: {}, headers: {}, on() {}, off() {} });

const baseServer = (name, extra = {}) => ({
  name, host: '10.20.0.1', port: 22, username: 'root', authType: 'password', password: 'secret', ...extra,
});

/** 读取主机指纹审计事件（新在前）。 */
async function listHostKeyEvents(serverId) {
  const db = await store.getDeployDb();
  return db.prepare('SELECT action, previous_sha256 AS previousSha256, next_sha256 AS nextSha256, operator FROM server_host_key_events WHERE server_id = ? ORDER BY id DESC')
    .all(Number(serverId));
}

/** 统计任务表行数。 */
async function countTasks() {
  const db = await store.getDeployDb();
  return db.prepare('SELECT COUNT(*) AS count FROM deploy_tasks').get().count;
}

test('新增服务器：登录失败不写库，返回 422 + auth_failed + 定位字段', async () => {
  const before = (await store.listServers()).length;
  await assert.rejects(
    connection.createServerWithVerification(baseServer('登录失败机'), { probe: createProbe(authError()) }),
    (error) => {
      assert.equal(error instanceof SshConnectionError, true);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'auth_failed');
      assert.equal(error.details.field, 'password');
      return true;
    },
  );
  await assert.rejects(
    connection.createServerWithVerification(baseServer('私钥失败机', { authType: 'privateKey', password: '', privateKey: 'bad' }), { probe: createProbe(authError()) }),
    (error) => error.details.field === 'privateKey',
  );
  await assert.rejects(
    connection.createServerWithVerification(baseServer('超时机'), {
      probe: createProbe(Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' })),
    }),
    (error) => error.code === 'timeout' && error.details.field === 'host',
  );
  assert.equal((await store.listServers()).length, before);
});

test('新增服务器：密码首尾空格被去掉，成功后记录指纹与 TOFU 事件', async () => {
  const probe = createProbe({ sudo: { checked: true, ok: false, message: 'sudo 不可用' } });
  const created = await connection.createServerWithVerification(baseServer(' 新机器 ', { host: ' 10.20.0.2 ', password: '  secret \n', useSudo: true }), { probe });
  assert.equal(probe.calls[0].server.credential.password, 'secret');
  assert.equal(probe.calls[0].server.host, '10.20.0.2');
  assert.equal(probe.calls[0].options.persist, false);
  const saved = await store.getServerWithCredential(created.id);
  assert.equal(saved.credential.password, 'secret');
  assert.equal(saved.name, '新机器');
  assert.equal(saved.hostKeySha256, FINGERPRINT_A);
  assert.equal(saved.connectionStatus, 'ok');
  assert.deepEqual(created.verification.warnings, ['sudo 不可用']);
  const events = await listHostKeyEvents(created.id);
  assert.deepEqual(events.map((item) => item.action), ['tofu']);
});

test('编辑服务器：只改名称不重新校验；改密码失败不写库；只改 sudo 只提示', async () => {
  const created = await connection.createServerWithVerification(baseServer('编辑机'), { probe: createProbe() });

  const nameProbe = createProbe(authError());
  const renamed = await connection.updateServerWithVerification(created.id, { name: '编辑机-改名', remark: '备注' }, { probe: nameProbe });
  assert.equal(nameProbe.calls.length, 0);
  assert.equal(renamed.name, '编辑机-改名');
  assert.equal(renamed.verification.checked, false);

  await assert.rejects(
    connection.updateServerWithVerification(created.id, { name: '不应保存', password: 'new-wrong ' }, { probe: createProbe(authError()) }),
    (error) => error.code === 'auth_failed' && error.status === 422,
  );
  const afterFailure = await store.getServerWithCredential(created.id);
  assert.equal(afterFailure.name, '编辑机-改名');
  assert.equal(afterFailure.credential.password, 'secret');

  const passwordProbe = createProbe();
  await connection.updateServerWithVerification(created.id, { password: ' new-secret ' }, { probe: passwordProbe });
  assert.equal(passwordProbe.calls[0].server.credential.password, 'new-secret');
  assert.equal((await store.getServerWithCredential(created.id)).credential.password, 'new-secret');

  const sudoProbe = createProbe(authError());
  const sudoSaved = await connection.updateServerWithVerification(created.id, { useSudo: true }, { probe: sudoProbe });
  assert.equal(sudoProbe.calls.length, 1);
  assert.equal(sudoSaved.useSudo, true);
  assert.equal(sudoSaved.verification.warnings.length, 1);

  // 主机密钥变了只要能登录就保存成功，指纹自动更新并留 auto_updated 审计（#47 改判）。
  const hostProbe = createProbe({ hostKeySha256: FINGERPRINT_B });
  const moved = await connection.updateServerWithVerification(created.id, { password: 'secret-2' }, { probe: hostProbe });
  assert.equal(hostProbe.calls[0].server.hostKeySha256, undefined, '保存校验不带已存指纹，不按指纹拦截');
  assert.equal(moved.hostKeySha256, FINGERPRINT_B);
  const [latest] = await listHostKeyEvents(created.id);
  assert.deepEqual([latest.action, latest.previousSha256, latest.nextSha256], ['auto_updated', FINGERPRINT_A, FINGERPRINT_B]);
});

test('resolveServerVerificationPlan: 区分登录字段、sudo 与普通字段', () => {
  const current = { host: 'a', port: 22, username: 'root', authType: 'password', useSudo: false };
  assert.equal(connection.resolveServerVerificationPlan(current, { name: 'x', host: ' a ', port: '22' }).login, false);
  assert.deepEqual(connection.resolveServerVerificationPlan(current, { port: 2222 }).changedFields, ['port']);
  assert.deepEqual(connection.resolveServerVerificationPlan(current, { password: '' }).changedFields, []);
  assert.deepEqual(connection.resolveServerVerificationPlan(current, { password: 'p' }).changedFields, ['credential']);
  assert.deepEqual(connection.resolveServerVerificationPlan(current, { useSudo: true }), { login: false, sudo: true, changedFields: [] });
});

test('控制器：新增服务器校验失败返回 422 且附带 code/details', async () => {
  const sshServer = await startSshTestServer({ password: 'right' });
  sshServers.push(sshServer);
  const before = (await store.listServers()).length;
  const res = createRes();
  await controller.handleCreateServer(createReq({}, baseServer('控制器失败机', { host: '127.0.0.1', port: sshServer.port, username: 'tester', password: 'wrong' })), res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'auth_failed');
  assert.equal(res.body.details.field, 'password');
  assert.equal((await store.listServers()).length, before);

  const ok = createRes();
  await controller.handleCreateServer(createReq({}, baseServer('控制器成功机', { host: '127.0.0.1', port: sshServer.port, username: 'tester', password: ' right ' })), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data.hostKeySha256, fingerprintOf(sshServer.hostKey));
});

test('主机密钥：老服务器首次连接自动记指纹；换了密钥照常检测、照常执行，指纹自动更新并留审计', async () => {
  const sshServer = await startSshTestServer();
  sshServers.push(sshServer);
  const legacy = await store.createServer(baseServer('老服务器', { host: '127.0.0.1', port: sshServer.port, username: 'tester' }));
  assert.equal(legacy.hostKeySha256, '');

  await connection.testSavedServerConnection(legacy.id);
  const oldFingerprint = fingerprintOf(sshServer.hostKey);
  const recorded = await store.getServerWithCredential(legacy.id);
  assert.equal(recorded.hostKeySha256, oldFingerprint);
  assert.equal(recorded.connectionStatus, 'ok');

  const newKey = generateHostKey();
  await sshServer.setHostKey(newKey);
  const testRes = createRes();
  await controller.handleTestServer(createReq({ id: String(legacy.id) }), testRes);
  assert.equal(testRes.statusCode, 200, '换了主机密钥，能登录就检测成功');
  const updated = await store.getServerWithCredential(legacy.id);
  assert.equal(updated.hostKeySha256, fingerprintOf(newKey));
  assert.equal(updated.connectionStatus, 'ok');
  assert.equal('hostKeyPendingSha256' in updated, false);

  // 编辑密码同样不会因为指纹被拦。
  const edited = await connection.updateServerWithVerification(legacy.id, { password: 'secret' });
  assert.equal(edited.hostKeySha256, fingerprintOf(newKey));

  const events = await listHostKeyEvents(legacy.id);
  assert.deepEqual(events.map((item) => item.action), ['auto_updated', 'tofu']);
  assert.equal(events[0].previousSha256, oldFingerprint);
  assert.equal(events[0].nextSha256, fingerprintOf(newKey));

  // 确认接口已移除，控制器不再导出。
  assert.equal(typeof controller.handleConfirmServerHostKey, 'undefined');
  assert.equal(typeof connection.assertTargetServerHostKeyTrusted, 'undefined');
});

test('任务失败：SSH 错误写入 failureCode 并回写服务器连接状态', async () => {
  const closedPort = await getClosedPort();
  const server = await store.createServer(baseServer('拒绝连接机', {
    host: '127.0.0.1', port: closedPort, defaultDeployRoot: '/opt/yuyan/frontend', defaultBackendRoot: '/opt/yuyan/backend',
  }));
  const target = await store.createTarget({
    projectId: 48, projectSource: 'gitlab', projectName: 'backend-demo', projectPath: 'team/backend-demo',
    repositoryUrl: 'https://git.example.com/team/backend-demo.git', defaultBranch: 'dev', envName: '测试', serverId: server.id,
    deployRoot: '/opt/yuyan/backend/backend-demo', projectType: 'backend', buildCommand: './mvnw package',
    artifactDir: 'target/app.jar', artifactPattern: 'target/app.jar', requiredJdkAlias: 'Java 17', runtimeJavaHome: '/usr/lib/jvm/java-17',
    runtimeJavaVersion: '17', serverPort: 18080, processMode: 'pid', healthCheckPath: '/actuator/health', serviceName: 'backend-demo',
  });
  const res = createRes();
  await controller.handleRunBackendServiceAction(createReq({ id: String(target.id), action: 'stop' }, { operator: 'ryan' }), res);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'refused');
  const db = await store.getDeployDb();
  const row = db.prepare('SELECT id FROM deploy_tasks WHERE target_id = ? ORDER BY id DESC LIMIT 1').get(target.id);
  const task = await store.getPersistentDeployTask(row.id);
  assert.equal(task.status, 'failed');
  assert.equal(task.failureCode, 'refused');
  const savedServer = await store.getServerWithCredential(server.id);
  assert.equal(savedServer.connectionStatus, 'refused');
});

test('任务执行中发现主机密钥变化：不报 host_key_changed、不返回 409，照常执行并自动更新指纹', async () => {
  const sshServer = await startSshTestServer();
  sshServers.push(sshServer);
  const server = await store.createServer(baseServer('运行中换钥机', {
    host: '127.0.0.1', port: sshServer.port, username: 'tester', defaultBackendRoot: '/opt/yuyan/backend',
    hostKeySha256: fingerprintOf(sshServer.hostKey),
  }));
  const target = await store.createTarget({
    projectId: 49, projectSource: 'gitlab', projectName: 'backend-key', projectPath: 'team/backend-key',
    repositoryUrl: 'https://git.example.com/team/backend-key.git', defaultBranch: 'dev', envName: '测试', serverId: server.id,
    deployRoot: '/opt/yuyan/backend/backend-key', projectType: 'backend', buildCommand: './mvnw package',
    artifactDir: 'target/app.jar', artifactPattern: 'target/app.jar', requiredJdkAlias: 'Java 17', runtimeJavaHome: '/usr/lib/jvm/java-17',
    runtimeJavaVersion: '17', serverPort: 18081, processMode: 'pid', healthCheckPath: '/actuator/health', serviceName: 'backend-key',
  });
  const newKey = generateHostKey();
  await sshServer.setHostKey(newKey);

  const tasksBefore = await countTasks();
  const first = createRes();
  await controller.handleRunBackendServiceAction(createReq({ id: String(target.id), action: 'stop' }, { operator: 'ryan' }), first);
  assert.notEqual(first.statusCode, 409);
  assert.notEqual(first.body?.code, 'host_key_changed');
  assert.equal(await countTasks(), tasksBefore + 1, '照常建任务执行');
  const db = await store.getDeployDb();
  const row = db.prepare('SELECT id FROM deploy_tasks WHERE target_id = ? ORDER BY id DESC LIMIT 1').get(target.id);
  assert.notEqual((await store.getPersistentDeployTask(row.id)).failureCode, 'host_key_changed');
  assert.equal((await store.getServerWithCredential(server.id)).hostKeySha256, fingerprintOf(newKey));
  const [latest] = await listHostKeyEvents(server.id);
  assert.equal(latest.action, 'auto_updated');

  const second = createRes();
  await controller.handleRunBackendServiceAction(createReq({ id: String(target.id), action: 'stop' }, { operator: 'ryan' }), second);
  assert.notEqual(second.statusCode, 409);
  assert.equal(await countTasks(), tasksBefore + 2);
  assert.equal((await listHostKeyEvents(server.id)).filter((item) => item.action === 'auto_updated').length, 1, '指纹已更新后不重复记录');
});

test('指纹自动更新：本地写 auto_updated，中央上下文下同时写中央审计（尽量写）', async () => {
  const { runRequestContext } = await import('../request-context.mjs');
  const context = { accountId: 'a47', userId: 'u47', deviceId: 'd47', teamId: 'team-47', role: 'operator', client: 'desktop', requestId: 'r47' };
  await runRequestContext(context, async () => {
    const server = await store.createServer(baseServer('中央换钥机', { hostKeySha256: FINGERPRINT_A }));
    assert.equal(await store.recordServerHostKeyAutoUpdated(server.id, FINGERPRINT_A, FINGERPRINT_B), true);
    assert.equal(await store.recordServerHostKeyAutoUpdated(server.id, FINGERPRINT_A, FINGERPRINT_B), false, '并发重复更新只记一次');
    assert.equal((await store.getServerWithCredential(server.id)).hostKeySha256, FINGERPRINT_B);
    const [latest] = await listHostKeyEvents(server.id);
    assert.deepEqual([latest.action, latest.previousSha256, latest.nextSha256], ['auto_updated', FINGERPRINT_A, FINGERPRINT_B]);
    const db = await store.getDeployDb();
    const audit = db.prepare("SELECT body_json FROM central_audit WHERE team_id = 'team-47' ORDER BY id DESC LIMIT 1").get();
    const body = JSON.parse(audit.body_json);
    assert.equal(body.action, 'server_host_key_auto_updated');
    assert.equal(body.resourceId, server.id);
    assert.equal(body.previousFingerprint, FINGERPRINT_A);
    assert.equal(body.fingerprint, FINGERPRINT_B);
  });
});
