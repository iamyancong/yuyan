import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** 模拟 GitLab：记录每个路径的请求次数，可按 SHA 控制延迟、挂起与返回内容 */
const requestCounts = new Map();
const COMMITS = {
  zh: { delay: 120, body: { title: 'feat: 中文名补全', author_name: 'HomminLee', author_email: 'hommin@example.com' } },
  en: { delay: 50, body: { title: 'fix: english only', author_name: 'Bob', author_email: 'bob@example.com' } },
};
const gitlab = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requestCounts.set(url.pathname + url.search, (requestCounts.get(url.pathname + url.search) || 0) + 1);
  const commitMatch = url.pathname.match(/\/repository\/commits\/([^/]+)$/);
  if (commitMatch) {
    const sha = decodeURIComponent(commitMatch[1]);
    if (sha === 'hang') return; // 永不响应，验证超时
    const commit = COMMITS[sha];
    if (!commit) {
      res.writeHead(404).end('{}');
      return;
    }
    setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(commit.body)), commit.delay);
    return;
  }
  const keyword = url.searchParams.get('query') || url.searchParams.get('search') || url.searchParams.get('username') || '';
  const users = keyword.toLowerCase().startsWith('hommin') && url.pathname.includes('/members/all') ? [{ name: '李汉明' }] : keyword.toLowerCase().startsWith('bob') ? [{ name: 'Bob' }] : [];
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(users));
});
await new Promise((resolve) => gitlab.listen(0, '127.0.0.1', resolve));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-commit-meta-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'commit-meta-test';
process.env.GITLAB_HOST = `http://127.0.0.1:${gitlab.address().port}`;
process.env.GITLAB_TOKEN = '';
process.env.YUYAN_GITLAB_REQUEST_TIMEOUT_MS = '200';

const store = await import('../deploy-store.mjs');
const commitMeta = await import('../commit-meta-service.mjs');
const { runRequestContext } = await import('../request-context.mjs');
const inTeam = (callback) => runRequestContext({ accountId: 'a', userId: 'a', teamId: 'team-a', role: 'operator' }, callback);

after(async () => {
  store.closeDeployDb();
  gitlab.closeAllConnections();
  await new Promise((resolve) => gitlab.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

/** 统计提交详情接口的请求次数 */
const countCommitRequests = (sha) =>
  [...requestCounts.entries()].filter(([key]) => key.endsWith(`/repository/commits/${sha}`)).reduce((sum, [, count]) => sum + count, 0);

/** 等待后台补全队列清空 */
async function waitForHydrationIdle(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (commitMeta.getCommitMetaHydrationStats().pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('后台补全队列未在预期时间内完成');
}

const target = await inTeam(async () => {
  const server = await store.createServer({
    name: 'test',
    host: '127.0.0.1',
    port: 22,
    username: 'test',
    authType: 'password',
    password: 'test',
    defaultBackendRoot: '/tmp',
  });
  return store.createTarget({
    projectId: 1,
    projectName: 'test',
    envName: '测试',
    projectPath: 'team/test',
    repositoryUrl: process.env.GITLAB_HOST + '/team/test.git',
    serverId: server.id,
    deployRoot: '/tmp/test',
    projectType: 'backend',
    artifactPattern: 'target/app.jar',
    serverPort: 18080,
    processMode: 'pid',
  });
});

/** 创建一条发布记录 */
const createRecord = (commitSha, commitAuthor) =>
  inTeam(() =>
    store.createRecord({
      targetId: target.id,
      projectId: 1,
      projectName: 'test',
      envName: '测试',
      branch: 'dev',
      commitSha,
      commitMessage: '',
      commitAuthor,
      status: 'success',
      operator: 'tester',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    })
  );

test('发布历史列表不等待 GitLab，后台补全后回写且同一提交并发只请求一次', async () => {
  const record = await createRecord('zh', 'HomminLee');
  assert.equal(countCommitRequests('zh'), 0, '创建记录不应触发 GitLab 请求');

  const startedAt = Date.now();
  const pages = await Promise.all(Array.from({ length: 5 }, () => inTeam(() => store.listRecords({ pageSize: 20, gitlabToken: 'token' }))));
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 250, `列表应立即返回，实际耗时 ${elapsed}ms`);
  assert.equal(pages[0].items.find((item) => item.id === record.id).commitAuthor, 'HomminLee');

  await waitForHydrationIdle();
  assert.equal(countCommitRequests('zh'), 1, '多人并发访问同一提交只请求 GitLab 一次');

  const refreshed = await inTeam(() => store.listRecords({ pageSize: 20, gitlabToken: 'token' }));
  const hydrated = refreshed.items.find((item) => item.id === record.id);
  assert.equal(hydrated.commitAuthor, '李汉明');
  assert.equal(hydrated.commitMessage, 'feat: 中文名补全');
  assert.ok(hydrated.commitMetaCheckedAt);
});

test('探测过仍无中文名的提交人不再重复请求 GitLab', async () => {
  const record = await createRecord('en', 'Bob');
  await inTeam(() => store.listRecords({ pageSize: 20, gitlabToken: 'token' }));
  await waitForHydrationIdle();
  const requestsAfterFirstProbe = [...requestCounts.values()].reduce((sum, count) => sum + count, 0);
  commitMeta.resetCommitMetaCaches();

  for (let index = 0; index < 3; index += 1) {
    await inTeam(() => store.listRecords({ pageSize: 20, gitlabToken: 'token' }));
    await inTeam(() => store.getRecord(record.id, { gitlabToken: 'token', scheduleCommitHydration: true }));
  }
  await waitForHydrationIdle();
  const totalRequests = [...requestCounts.values()].reduce((sum, count) => sum + count, 0);
  assert.equal(totalRequests, requestsAfterFirstProbe, '已探测记录即使缓存失效也不应再次请求');

  const detail = await inTeam(() => store.getRecord(record.id));
  assert.equal(detail.commitAuthor, 'Bob');
  assert.equal(detail.commitMessage, 'fix: english only');
});

test('GitLab 超时不阻塞读接口，失败进入退避且不标记已探测', async () => {
  const record = await createRecord('hang', 'Someone');
  const startedAt = Date.now();
  await inTeam(() => store.listRecords({ pageSize: 20, gitlabToken: 'token' }));
  assert.ok(Date.now() - startedAt < 250);

  await waitForHydrationIdle();
  assert.equal(countCommitRequests('hang'), 1);
  const detail = await inTeam(() => store.getRecord(record.id));
  assert.equal(detail.commitMetaCheckedAt, '', '临时失败允许退避期后重新补全');

  await inTeam(() => store.listRecords({ pageSize: 20, gitlabToken: 'token' }));
  await waitForHydrationIdle();
  assert.equal(countCommitRequests('hang'), 1, '退避期内不再重复请求 GitLab');
});

test('无 GitLab 令牌时不入队，内部发布流程读取记录不触发补全', async () => {
  await createRecord('zh-internal', 'Nobody');
  await inTeam(() => store.listRecords({ pageSize: 20 }));
  assert.equal(commitMeta.getCommitMetaHydrationStats().pending, 0);
  assert.equal(countCommitRequests('zh-internal'), 0);
});

test('默认列表计数不关联目标表，筛选条件仍然正确', async () => {
  const all = await inTeam(() => store.listRecords({ pageSize: 2 }));
  assert.equal(all.items.length, 2);
  assert.ok(all.total >= 4);
  const byType = await inTeam(() => store.listRecords({ pageSize: 20, projectType: 'backend' }));
  assert.equal(byType.total, all.total);
  const byFrontend = await inTeam(() => store.listRecords({ pageSize: 20, projectType: 'frontend' }));
  assert.equal(byFrontend.total, 0);
  const db = await store.getDeployDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deploy_records'").all().map((row) => row.name);
  assert.ok(indexes.includes('idx_deploy_records_team_started'));
  assert.ok(indexes.includes('idx_deploy_records_target_status_started'));
});
