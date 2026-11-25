import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import express from 'express';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-user-profile-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'user-profile-test-key';
delete process.env.YUYAN_SYSTEM_ADMINS;

let gitlabServer;
let gitlabHost;
let appServer;
let appBaseUrl;

before(async () => {
  gitlabServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = String(req.headers['private-token'] || '');
    const usersByToken = {
      'token-alice': {
        id: 101,
        username: 'wangyancong',
        name: '王彦聪',
        avatar_url: 'http://gitlab.test/avatars/alice.png',
        email: 'wangyancong@ysstech.com',
        created_at: '2021-05-12T08:30:00.000Z',
        web_url: `${gitlabHost}/wangyancong`,
      },
      'token-bob': {
        id: 202,
        username: 'bob',
        name: 'Bob Viewer',
        avatar_url: 'http://gitlab.test/avatars/bob.png',
        email: 'bob@ysstech.com',
        created_at: '2023-02-01T10:00:00.000Z',
        web_url: `${gitlabHost}/bob`,
      },
      'token-web-only': {
        id: 303,
        username: 'carol',
        name: 'Carol Web',
        avatar_url: 'http://gitlab.test/avatars/carol.png',
        email: 'carol@ysstech.com',
        created_at: '2024-06-15T04:00:00.000Z',
        web_url: `${gitlabHost}/carol`,
      },
    };
    const user = usersByToken[token] || null;
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v4/user') {
      if (!user) {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify(user));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => gitlabServer.listen(0, '127.0.0.1', resolve));
  gitlabHost = `http://127.0.0.1:${gitlabServer.address().port}`;
  process.env.YUYAN_ALLOWED_GITLAB_HOSTS = gitlabHost;

  const { default: authV2Routes } = await import('../../routes/auth-v2.mjs');
  const app = express();
  app.use(express.json());
  app.use('/api/v2', authV2Routes);
  appServer = http.createServer(app);
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  appBaseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

const identity = await import('../central-identity-service.mjs');
const store = await import('../deploy-store.mjs');

after(async () => {
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => gitlabServer.close(resolve));
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

function createDevice(deviceId, name, platform = 'macos') {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  return { deviceId, publicKey: rawPublicKey, deviceName: name, platform };
}

function withAllowlist(value, fn) {
  const prev = process.env.YUYAN_SYSTEM_ADMINS;
  if (value == null) delete process.env.YUYAN_SYSTEM_ADMINS;
  else process.env.YUYAN_SYSTEM_ADMINS = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev == null) delete process.env.YUYAN_SYSTEM_ADMINS;
      else process.env.YUYAN_SYSTEM_ADMINS = prev;
    });
}

async function apiJson(urlPath, options = {}) {
  const res = await fetch(`${appBaseUrl}${urlPath}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

test('未鉴权请求访问个人资料和注销会话一律返回 401', async () => {
  const profileRes = await apiJson('/api/v2/me/profile');
  assert.equal(profileRes.status, 401);
  assert.equal(profileRes.body.success, false);

  const revokeRes = await apiJson('/api/v2/me/sessions/some-session-id', { method: 'DELETE' });
  assert.equal(revokeRes.status, 401);
  assert.equal(revokeRes.body.success, false);
});

test('桌面端个人资料返回 GitLab 信息、工作区角色、系统管理员徽章、会话列表及近30天发布统计，且严格隔离其他用户', async () => {
  const db = await identity.ensureCentralIdentitySchema();
  const aliceDev1 = createDevice('aaaaaaaa-1111-4111-8111-111111111111', 'MacBook Pro', 'macos');
  const aliceDev2 = createDevice('aaaaaaaa-2222-4222-8222-222222222222', 'Windows Studio', 'windows');
  const bobDev = createDevice('bbbbbbbb-1111-4111-8111-111111111111', 'Bob Linux', 'linux');

  const aliceS1 = await identity.exchangeGitlabIdentity({ gitlabHost, gitlabToken: 'token-alice', device: aliceDev1 });
  const aliceS2 = await identity.exchangeGitlabIdentity({ gitlabHost, gitlabToken: 'token-alice', device: aliceDev2 });
  const bobSession = await identity.exchangeGitlabIdentity({ gitlabHost, gitlabToken: 'token-bob', device: bobDev });

  // 将 Bob 显式设为 viewer 角色，验证 viewer 也可正常读取自己的资料
  db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?')
    .run('viewer', bobSession.teamId, bobSession.accountId);

  // 准备服务器、目标和发布记录（包含 Alice 12 条 + 1 条 45 天前记录 + Bob 记录）
  const srv = await store.createServer({
    name: '大前端测试机',
    host: '127.0.0.1',
    port: 22,
    username: 'deploy',
    authType: 'password',
    password: 'pw',
    defaultBackendRoot: '/opt/apps',
  });
  const target = await store.createTarget({
    projectId: 10,
    projectSource: 'gitlab',
    projectName: 'yuyan-web',
    projectDescription: '雨燕前端',
    projectPath: 'fe/yuyan-web',
    repositoryUrl: `${gitlabHost}/fe/yuyan-web.git`,
    defaultBranch: 'main',
    envName: '生产',
    serverId: srv.id,
    deployRoot: '/opt/apps/yuyan-web',
    projectType: 'backend',
    serviceName: 'yuyan-web',
    serviceRole: 'application',
    serverPort: 18080,
    artifactPattern: 'target/*.jar',
    processMode: 'pid',
    healthCheckPath: '/actuator/health',
  });

  const nowMs = Date.now();
  const insertRecord = db.prepare(`
    INSERT INTO deploy_records (team_id, target_id, project_id, project_name, env_name, branch, commit_sha, commit_message, status, action, operator, started_at, finished_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 11 条 30 天内 Alice 的记录（8 success, 2 failed, 1 running）+ 1 条 45 天前（应计入最近 10? 否，11 条新的比它新，但不计入 30 天统计）
  for (let i = 0; i < 11; i++) {
    const status = i === 0 ? 'running' : i <= 2 ? 'failed' : 'success';
    const ts = new Date(nowMs - i * 3600_000).toISOString();
    const op = i % 2 === 0 ? '王彦聪' : 'WANGYANCONG';
    insertRecord.run('legacy-team', target.id, 10, 'yuyan-web', '生产', 'main', `sha${i}`, `msg ${i}`, status, 'deploy', op, ts, ts, ts);
  }
  const oldTs = new Date(nowMs - 45 * 24 * 3600_000).toISOString();
  insertRecord.run('legacy-team', target.id, 10, 'yuyan-web', '生产', 'main', 'sha-old', 'old msg', 'failed', 'deploy', '王彦聪', oldTs, oldTs, oldTs);
  // Bob 的记录（不得混入 Alice 的列表或统计）
  const bobTs = new Date(nowMs + 1000).toISOString();
  insertRecord.run(bobSession.teamId, target.id, 10, 'yuyan-web', '测试', 'dev', 'sha-bob', 'bob deploy', 'failed', 'deploy', 'Bob Viewer', bobTs, bobTs, bobTs);

  await withAllowlist('WangYanCong', async () => {
    const res = await apiJson('/api/v2/me/profile', {
      headers: { Authorization: `Bearer ${aliceS1.accessToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;

    assert.equal(data.gitlab.displayName, '王彦聪');
    assert.equal(data.gitlab.username, 'wangyancong');
    assert.equal(data.gitlab.email, 'wangyancong@ysstech.com');
    assert.equal(data.gitlab.createdAt, '2021-05-12T08:30:00.000Z');
    assert.equal(data.gitlab.webUrl, `${gitlabHost}/wangyancong`);

    assert.equal(data.identity.role, 'admin');
    assert.equal(data.identity.team.id, 'legacy-team');
    assert.equal(data.identity.isSystemAdmin, true);
    assert.equal(data.identity.sessions.length, 2);
    assert.equal(data.identity.sessions[0].sessionId, aliceS1.sessionId);
    assert.equal(data.identity.sessions[0].isCurrent, true);
    assert.equal(data.identity.sessions[1].sessionId, aliceS2.sessionId);
    assert.equal(data.identity.sessions[1].isCurrent, false);
    assert.equal('accessTokenHash' in data.identity.sessions[0], false);
    assert.equal('publicKey' in data.identity.sessions[0], false);

    // 30 天内 11 条：8 成功，2 失败，1 进行中 => 已结束 10 条，成功率 80%
    assert.equal(data.activity.stats30d.totalCount, 11);
    assert.equal(data.activity.stats30d.successCount, 8);
    assert.equal(data.activity.stats30d.failedCount, 2);
    assert.equal(data.activity.stats30d.runningCount, 1);
    assert.equal(data.activity.stats30d.finishedCount, 10);
    assert.equal(data.activity.stats30d.successRate, 80);
    assert.equal(data.activity.recentDeploys.length, 10);
    assert.ok(data.activity.recentDeploys.every((item) => item.operator !== 'Bob Viewer'));

    // Bob (viewer) 请求自己的个人资料：允许访问，非系统管理员，只看到自己的 1 条记录与 1 台会话
    const bobRes = await apiJson('/api/v2/me/profile', {
      headers: { Authorization: `Bearer ${bobSession.accessToken}` },
    });
    assert.equal(bobRes.status, 200);
    assert.equal(bobRes.body.data.identity.isSystemAdmin, false);
    assert.equal(bobRes.body.data.identity.sessions.length, 1);
    assert.equal(bobRes.body.data.activity.recentDeploys.length, 1);
    assert.equal(bobRes.body.data.activity.recentDeploys[0].commitSha, 'sha-bob');

    // 会话注销边界：不能注销当前会话
    const selfRevoke = await apiJson(`/api/v2/me/sessions/${aliceS1.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceS1.accessToken}` },
    });
    assert.equal(selfRevoke.status, 400);
    assert.equal(selfRevoke.body.error.code, 'cannot_revoke_current_session');

    // 不能注销别人的会话
    const crossRevoke = await apiJson(`/api/v2/me/sessions/${bobSession.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceS1.accessToken}` },
    });
    assert.equal(crossRevoke.status, 404);
    assert.equal(crossRevoke.body.error.code, 'session_not_found');

    // 正常注销自己的另一个设备会话
    const otherRevoke = await apiJson(`/api/v2/me/sessions/${aliceS2.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceS1.accessToken}` },
    });
    assert.equal(otherRevoke.status, 200);
    assert.equal(otherRevoke.body.data.revoked, true);

    // 被注销的会话立即失效
    const revokedProfile = await apiJson('/api/v2/me/profile', {
      headers: { Authorization: `Bearer ${aliceS2.accessToken}` },
    });
    assert.equal(revokedProfile.status, 401);
  });
});

test('旧库缺失 created_at/web_url 时若带现有 GitLab Token 则自动补全并回写，网页端会话也可安全读取', async () => {
  const db = await identity.ensureCentralIdentitySchema();
  const aliceId = identity.buildAccountId(gitlabHost, 101);
  // 模拟旧版数据库缺失字段
  db.prepare('UPDATE identity_links SET external_web_url = ?, external_created_at = ? WHERE user_id = ?')
    .run('', '', aliceId);

  const webAlice = await apiJson('/api/v2/me/profile', {
    headers: {
      'X-Yuyan-Client': 'web',
      'X-GitLab-Host': gitlabHost,
      'X-GitLab-Token': 'token-alice',
    },
  });
  assert.equal(webAlice.status, 200);
  assert.equal(webAlice.body.data.gitlab.createdAt, '2021-05-12T08:30:00.000Z');
  assert.equal(webAlice.body.data.gitlab.webUrl, `${gitlabHost}/wangyancong`);
  assert.equal(webAlice.body.data.identity.authMode, 'web_gitlab');
  assert.equal(webAlice.body.data.identity.role, 'admin');

  // 网页端纯新用户（未绑定桌面端设备）优雅降级
  await withAllowlist('carol', async () => {
    const webCarol = await apiJson('/api/v2/me/profile', {
      headers: {
        'X-Yuyan-Client': 'web',
        'X-GitLab-Host': gitlabHost,
        'X-GitLab-Token': 'token-web-only',
      },
    });
    assert.equal(webCarol.status, 200);
    assert.equal(webCarol.body.data.gitlab.displayName, 'Carol Web');
    assert.equal(webCarol.body.data.identity.team, null);
    assert.equal(webCarol.body.data.identity.role, '');
    assert.equal(webCarol.body.data.identity.isSystemAdmin, true);
    assert.deepEqual(webCarol.body.data.identity.sessions, []);
  });

  // 无效 GitLab PAT 网页请求返回 401
  const badWeb = await apiJson('/api/v2/me/profile', {
    headers: {
      'X-Yuyan-Client': 'web',
      'X-GitLab-Host': gitlabHost,
      'X-GitLab-Token': 'invalid-token',
    },
  });
  assert.equal(badWeb.status, 401);
});
