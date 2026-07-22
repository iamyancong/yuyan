import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-central-identity-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'central-identity-test-key';

let gitlabServer;
let gitlabHost;

before(async () => {
  gitlabServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = String(req.headers['private-token'] || '');
    const user = token === 'token-user-a' ? { id: 101, username: 'alice', name: 'Alice' }
      : token === 'token-user-b' ? { id: 202, username: 'bob', name: 'Bob' }
        : null;
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v4/user') {
      if (!user) { res.statusCode = 401; res.end('{}'); return; }
      res.end(JSON.stringify(user));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => gitlabServer.listen(0, '127.0.0.1', resolve));
  gitlabHost = `http://127.0.0.1:${gitlabServer.address().port}`;
});

const identity = await import('../central-identity-service.mjs');
const store = await import('../deploy-store.mjs');
const { runRequestContext } = await import('../request-context.mjs');

after(async () => {
  await new Promise((resolve) => gitlabServer.close(resolve));
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

/** 生成测试 Ed25519 设备及私钥。 */
function createDevice(deviceId, name) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { privateKey, device: { deviceId, publicKey: rawPublicKey, deviceName: name, platform: 'macos' } };
}

test('同一账号支持多设备、签名刷新、跨设备审批与撤销', async () => {
  const db = await identity.ensureCentralIdentitySchema();
  const initializedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO teams (id, name, status, migration_state, created_at, updated_at)
    VALUES ('bootstrap-sentinel', '已有身份空间', 'active', 'bound', ?, ?)
  `).run(initializedAt, initializedAt);

  const first = createDevice('11111111-1111-4111-8111-111111111111', 'Mac A');
  const second = createDevice('22222222-2222-4222-8222-222222222222', 'Mac B');
  const sessionA = await identity.exchangeGitlabIdentity({ gitlabHost, gitlabToken: 'token-user-a', device: first.device });
  const sessionB = await identity.exchangeGitlabIdentity({ gitlabHost, gitlabToken: 'token-user-a', device: second.device });
  assert.equal(sessionA.accountId, sessionB.accountId);
  assert.equal(sessionA.teamId, sessionB.teamId);
  assert.notEqual(sessionA.teamId, 'legacy-team');
  assert.equal(sessionA.role, 'admin');
  assert.equal((await identity.listUserDevices(sessionA.accountId)).length, 2);

  const legacyServer = await store.createServer({
    name: '旧部署服务器',
    host: '127.0.0.1',
    port: 22,
    username: 'guest',
    authType: 'password',
    password: 'legacy-password',
    defaultBackendRoot: '/opt/apps',
  });
  const legacyTarget = await store.createTarget({
    projectId: 101,
    projectSource: 'gitlab',
    projectName: '旧部署目标',
    projectDescription: '身份空间迁移回归数据',
    projectPath: 'group/legacy-app',
    repositoryUrl: 'http://gitlab.example/legacy-app.git',
    defaultBranch: 'dev',
    envName: '测试',
    serverId: legacyServer.id,
    deployRoot: '/opt/apps/legacy-app',
    projectType: 'backend',
    serviceName: 'legacy-app',
    serviceRole: 'application',
    serverPort: 18080,
    artifactPattern: 'target/*.jar',
    processMode: 'pid',
    healthCheckPath: '/actuator/health',
  });
  const principalA = await identity.resolveAccessPrincipal(sessionA.accessToken);
  const principalB = await identity.resolveAccessPrincipal(sessionB.accessToken);
  assert.equal(principalA.teamId, 'legacy-team');
  assert.equal(principalB.teamId, 'legacy-team');
  const restoredServer = await runRequestContext(
    { ...principalA, client: 'desktop', requestId: 'legacy-server-read' },
    () => store.getServerWithCredential(legacyServer.id),
  );
  assert.equal(restoredServer.teamId, 'legacy-team');
  assert.equal(restoredServer.credential.password, 'legacy-password');
  const restoredTargets = await runRequestContext(
    { ...principalA, client: 'desktop', requestId: 'legacy-target-list' },
    () => store.listTargets({}),
  );
  assert.deepEqual(restoredTargets.map((target) => target.id), [legacyTarget.id]);
  assert.equal(restoredTargets[0].teamId, 'legacy-team');
  assert.equal(db.prepare('SELECT team_id FROM deploy_servers WHERE id = ?').get(legacyServer.id).team_id, 'legacy-team');
  assert.equal(db.prepare('SELECT team_id FROM deploy_targets WHERE id = ?').get(legacyTarget.id).team_id, 'legacy-team');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM team_members WHERE team_id = 'legacy-team' AND user_id = ? AND status = 'active'").get(sessionA.accountId).count, 1);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT team_id) AS count FROM auth_sessions WHERE user_id = ? AND status = 'active'").get(sessionA.accountId).count, 1);
  assert.equal((await identity.resolveAccessPrincipal(sessionA.accessToken)).teamId, 'legacy-team');

  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signedPayload = `${first.device.deviceId}.${timestamp}.${nonce}.${sessionA.refreshToken}`;
  const signature = crypto.sign(null, Buffer.from(signedPayload), first.privateKey).toString('base64');
  const refreshed = await identity.refreshDeviceSession({ deviceId: first.device.deviceId, refreshToken: sessionA.refreshToken, timestamp, nonce, signature });
  assert.notEqual(refreshed.refreshToken, sessionA.refreshToken);
  assert.equal(refreshed.teamId, 'legacy-team');

  const accountContext = {
    userId: sessionA.accountId,
    accountId: sessionA.accountId,
    deviceId: first.device.deviceId,
    teamId: refreshed.teamId,
    role: 'admin',
    client: 'desktop',
    requestId: 'account-policy-1',
  };
  assert.deepEqual((await identity.getAccountApprovalPolicy(accountContext)).forcedTools, []);
  const approvalPolicy = await identity.replaceAccountApprovalPolicy(accountContext, {
    forcedTools: ['yuyan_deploy_target', 'yuyan_control_service'],
  });
  assert.deepEqual(approvalPolicy.forcedTools, ['yuyan_control_service', 'yuyan_deploy_target']);
  assert.deepEqual((await identity.getAccountApprovalPolicy(accountContext)).forcedTools, ['yuyan_control_service', 'yuyan_deploy_target']);

  const auditSnapshot = await identity.getCentralAuditSnapshot(accountContext, { limit: 20 });
  assert.equal(auditSnapshot.chain.valid, true);
  assert.ok(auditSnapshot.items.some((item) => item.action === 'account_approval_policy_updated'));

  db.exec('PRAGMA wal_checkpoint(FULL)');
  const persistedBytes = Buffer.concat(await Promise.all(
    [process.env.DEPLOY_DB_PATH, `${process.env.DEPLOY_DB_PATH}-wal`]
      .map(async (filePath) => fs.readFile(filePath).catch(() => Buffer.alloc(0))),
  )).toString('utf8');
  assert.doesNotMatch(persistedBytes, /token-user-a|token-user-b/);

  await identity.revokeUserDevice(sessionA.accountId, second.device.deviceId);
  assert.equal(await identity.resolveAccessPrincipal(sessionB.accessToken), null);
  await assert.rejects(
    () => identity.exchangeGitlabIdentity({ gitlabHost, gitlabToken: 'token-user-a', device: second.device }),
    (error) => error.code === 'device_revoked',
  );

  const latestAudit = db.prepare('SELECT id, body_json FROM central_audit WHERE team_id = ? ORDER BY id DESC LIMIT 1').get(accountContext.teamId);
  db.prepare("UPDATE central_audit SET body_json = '{invalid' WHERE id = ?").run(latestAudit.id);
  assert.equal((await identity.getCentralAuditSnapshot(accountContext)).chain.valid, false);
  db.prepare('UPDATE central_audit SET body_json = ? WHERE id = ?').run(latestAudit.body_json, latestAudit.id);
  assert.equal((await identity.getCentralAuditSnapshot(accountContext)).chain.valid, true);
});

test('相同 deviceId 的不同 GitLab 用户仍按账号隔离', async () => {
  const device = createDevice('11111111-1111-4111-8111-111111111111', 'Shared OS Device');
  const session = await identity.exchangeGitlabIdentity({ gitlabHost, gitlabToken: 'token-user-b', device: device.device });
  assert.equal(session.role, 'admin');
  assert.equal((await identity.listUserDevices(session.accountId)).length, 1);

  const principal = await identity.resolveAccessPrincipal(session.accessToken);
  assert.equal(principal.accountId, session.accountId);
  assert.equal(principal.deviceId, device.device.deviceId);
  assert.notEqual(principal.teamId, 'legacy-team');

  const accountContext = { ...principal, client: 'desktop', requestId: 'account-b-policy' };
  assert.deepEqual((await identity.getAccountApprovalPolicy(accountContext)).forcedTools, []);

  const db = await store.getDeployDb();
  db.prepare("UPDATE team_members SET status = 'removed', updated_at = ? WHERE team_id = 'legacy-team'")
    .run(new Date().toISOString());
  const orphanedLegacyPrincipal = await identity.resolveAccessPrincipal(session.accessToken);
  assert.equal(orphanedLegacyPrincipal.teamId, principal.teamId);
  assert.notEqual(orphanedLegacyPrincipal.teamId, 'legacy-team');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deploy_servers WHERE team_id = 'legacy-team'").get().count, 1);
});

test('网页 GitLab 凭据校验不要求创建设备身份', async () => {
  const result = await identity.verifyGitlabCredential({
    gitlabHost: `${gitlabHost}/api/v4`,
    gitlabToken: 'token-user-a',
  });
  assert.equal(result.gitlabHost, gitlabHost);
  assert.equal(result.user.username, 'alice');
  await assert.rejects(
    () => identity.verifyGitlabCredential({ gitlabHost, gitlabToken: 'invalid-token' }),
    (error) => error.code === 'gitlab_token_invalid',
  );
});
