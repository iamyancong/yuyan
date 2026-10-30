import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-server-duplicate-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'server-duplicate-test-key';

const store = await import('../deploy-store.mjs');
const connection = await import('../server-connection-service.mjs');
const controller = await import('../../controllers/deploy-controller.mjs');
const { runRequestContext } = await import('../request-context.mjs');

after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

/** 记录调用次数的假探测器：一旦被调用就说明发起了 SSH 登录。 */
function createProbe() {
  const calls = [];
  const probe = async (server) => {
    calls.push(server.host);
    return { account: server.username, output: 'ok', hostKeySha256: `SHA256:${'C'.repeat(43)}`, sudo: { checked: false, ok: true, message: '' } };
  };
  probe.calls = calls;
  return probe;
}

const createRes = () => ({
  statusCode: 200, body: null, headersSent: false, writableEnded: false,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
  on() {}, off() {},
});
const createReq = (params, body = {}) => ({ params, body, query: {}, headers: {}, on() {}, off() {} });
const server = (name, host, extra = {}) => ({ name, host, port: 22, username: 'root', authType: 'password', password: 'secret', ...extra });
const countServers = async () => (await store.listServers()).length;
const catchError = (promise) => promise.then(() => null, (error) => error);

test('纯函数：host 去首尾空格且不区分大小写；端口或账号不同允许；名称 trim 后比较', () => {
  const list = [{ id: 1, name: '估值-生产', host: 'Web-01.Example.com', port: 22, username: 'root' }];
  assert.equal(connection.findServerDuplicate(list, { name: '新', host: '  web-01.EXAMPLE.com ', port: '22', username: ' root ' })?.code, 'server_duplicate');
  assert.equal(connection.findServerDuplicate(list, { name: '新', host: 'web-01.example.com', port: 2222, username: 'root' }), null, '端口不同允许');
  assert.equal(connection.findServerDuplicate(list, { name: '新', host: 'web-01.example.com', port: 22, username: 'deploy' }), null, '账号不同允许');
  assert.equal(connection.findServerDuplicate(list, { name: '  估值-生产 ', host: '10.0.0.9', port: 22, username: 'root' })?.code, 'server_name_duplicate');
  assert.equal(connection.findServerDuplicate(list, { name: '估值-生产', host: 'web-01.example.com', port: 22, username: 'root' }, list[0]), null, '编辑排除自己');
  const legacy = [...list, { id: 2, name: '估值-生产', host: 'web-01.example.com', port: 22, username: 'root' }];
  assert.equal(connection.findServerDuplicate(legacy, { name: '估值-生产', host: 'web-01.example.com', port: 22, username: 'root' }, legacy[1]), null, '旧重复记录没改地址和名称不拦');
  assert.equal(connection.findServerDuplicate(legacy, { name: '估值-生产', host: 'WEB-01.example.com ', port: 22, username: 'root' }, legacy[1]), null, '只改 host 大小写不算改地址');
  assert.equal(connection.findServerDuplicate(legacy, { name: '估值-生产', host: 'web-01.example.com', port: 22, username: 'root' }, { ...legacy[1], port: 2222 })?.code, 'server_duplicate', '改了端口撞上别人要拦');
});

test('新增重复服务器：409 server_duplicate，带已有服务器 id / 名称，不发起 SSH、不写库', async () => {
  const probe = createProbe();
  const existing = await connection.createServerWithVerification(server('华贵委外-测试', 'Web-01.Example.com'), { probe });
  assert.equal(probe.calls.length, 1);
  const before = await countServers();
  const error = await catchError(connection.createServerWithVerification(server('另一个名字', '  web-01.EXAMPLE.com  '), { probe }));
  assert.equal(error?.status, 409);
  assert.equal(error.code, 'server_duplicate');
  assert.equal(error.message, '该服务器已存在：华贵委外-测试（Web-01.Example.com:22 / root）');
  assert.deepEqual([error.details.existingServerId, error.details.existingServerName, error.details.field], [existing.id, '华贵委外-测试', 'host']);
  assert.equal(probe.calls.length, 1, '重复时不发起 SSH 登录');
  assert.equal(await countServers(), before);

  const otherPort = await connection.createServerWithVerification(server('同机另一端口', 'web-01.example.com', { port: 2222 }), { probe });
  const otherUser = await connection.createServerWithVerification(server('同机另一账号', 'web-01.example.com', { username: 'deploy' }), { probe });
  assert.ok(otherPort.id && otherUser.id, 'host 相同但端口或账号不同允许保存');
});

test('新增重名服务器：409 server_name_duplicate，不发起 SSH', async () => {
  const probe = createProbe();
  await connection.createServerWithVerification(server('报表-备机', '10.30.0.1'), { probe });
  const error = await catchError(connection.createServerWithVerification(server('  报表-备机 ', '10.30.0.2'), { probe }));
  assert.equal(error?.status, 409);
  assert.equal(error.code, 'server_name_duplicate');
  assert.equal(error.details.field, 'name');
  assert.equal(probe.calls.length, 1);
});

test('编辑：排除自己；改成别人的地址或名称被拦且不发起 SSH；只改名称也查重', async () => {
  const probe = createProbe();
  const a = await connection.createServerWithVerification(server('编辑-A', '10.40.0.1'), { probe });
  const b = await connection.createServerWithVerification(server('编辑-B', '10.40.0.2'), { probe });
  const callsBefore = probe.calls.length;

  const self = await connection.updateServerWithVerification(a.id, { name: ' 编辑-A ', host: '10.40.0.1', port: 22, username: 'root', password: 'new-secret' }, { probe });
  assert.equal(self.name, '编辑-A', '和自己相同不算重复');
  assert.equal(probe.calls.length, callsBefore + 1, '改了密码照常登录校验');

  const hostError = await catchError(connection.updateServerWithVerification(a.id, { host: ' 10.40.0.2 ' }, { probe }));
  assert.deepEqual([hostError?.status, hostError?.code, hostError?.details?.existingServerId], [409, 'server_duplicate', b.id]);
  const nameError = await catchError(connection.updateServerWithVerification(a.id, { name: '编辑-B' }, { probe }));
  assert.deepEqual([nameError?.status, nameError?.code], [409, 'server_name_duplicate']);
  assert.equal(probe.calls.length, callsBefore + 1, '重复时都没有发起 SSH 登录');
  assert.equal((await store.getServerWithCredential(a.id)).host, '10.40.0.1', '没有写库');
});

test('库里已有的重复旧记录：只改无关字段或密码不拦，改名撞名才拦', async () => {
  const probe = createProbe();
  const first = await store.createServer(server('旧重复-1', '10.50.0.1'));
  const second = await store.createServer(server('旧重复-1', '10.50.0.1'));
  const remark = await connection.updateServerWithVerification(second.id, { remark: '历史数据', defaultDeployRoot: '/home/app/html' }, { probe });
  assert.equal(remark.remark, '历史数据');
  const password = await connection.updateServerWithVerification(second.id, { name: '旧重复-1', host: '10.50.0.1', port: 22, username: 'root', password: 'changed' }, { probe });
  assert.ok(password, '没改 host / port / username 和名称，不拦');
  assert.equal(probe.calls.length, 1, '改密码照常登录校验');
  const renamed = await connection.updateServerWithVerification(second.id, { name: '旧重复-2' }, { probe });
  assert.equal(renamed.name, '旧重复-2');
  const back = await catchError(connection.updateServerWithVerification(second.id, { name: '旧重复-1' }, { probe }));
  assert.equal(back?.code, 'server_name_duplicate');
  assert.ok(await store.getServerWithCredential(first.id), '旧数据不动');
});

test('跨团队不算重复', async () => {
  const probe = createProbe();
  const context = (teamId) => ({ accountId: `a-${teamId}`, userId: `u-${teamId}`, deviceId: 'd', teamId, role: 'admin', client: 'desktop', requestId: `r-${teamId}` });
  const a = await runRequestContext(context('team-a'), () => connection.createServerWithVerification(server('共享机器', '10.60.0.1'), { probe }));
  const b = await runRequestContext(context('team-b'), () => connection.createServerWithVerification(server('共享机器', '10.60.0.1'), { probe }));
  assert.ok(a.id && b.id && a.id !== b.id);
  const again = await runRequestContext(context('team-a'), () => catchError(connection.createServerWithVerification(server('共享机器2', '10.60.0.1'), { probe })));
  assert.equal(again?.code, 'server_duplicate');
});

test('控制器：新增重复服务器返回 409 + code + details', async () => {
  const probe = createProbe();
  await connection.createServerWithVerification(server('控制器-已有', '10.70.0.1'), { probe });
  const res = createRes();
  await controller.handleCreateServer(createReq({}, server('控制器-新', ' 10.70.0.1 ')), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'server_duplicate');
  assert.equal(res.body.error, '该服务器已存在：控制器-已有（10.70.0.1:22 / root）');
  assert.equal(res.body.details.existingServerName, '控制器-已有');
});
