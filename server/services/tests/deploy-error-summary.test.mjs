import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeFailedRecordLogs, parseErrorSummary } from '../deploy-error-summary.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-error-summary-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'error-summary-test';
process.env.GITLAB_TOKEN = '';

const store = await import('../deploy-store.mjs');
const { runRequestContext } = await import('../request-context.mjs');
const inTeam = (callback) => runRequestContext({ accountId: 'a', userId: 'a', teamId: 'team-a', role: 'operator' }, callback);

after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

const TS = '2026-11-16T03:00:00.000Z';
const WS = '/data/yuyan-ops/deploy-data/cache/workspaces/42/9f2c1a7b3e4d5f60/repo';

/** 一次真实形态的构建失败日志：工具输出 + 雨燕失败汇总 */
const buildFailureLogs = () => [
  { level: 'info', message: '操作人 ryan 发起发布', stage: 'validate', timestamp: TS },
  { level: 'info', message: '> vite build', stage: 'build', source: 'tool', timestamp: TS },
  { level: 'error', message: `[vite]: Rollup failed to resolve import "axios" from "${WS}/src/api/index.ts".`, stage: 'build', source: 'tool', timestamp: TS },
  {
    level: 'error',
    message: `构建产物 执行失败，退出码 1\n[vite]: Rollup failed to resolve import "axios" from "${WS}/src/api/index.ts".`,
    stage: 'error',
    timestamp: TS,
  },
];

/** 上传阶段失败（非命令失败） */
const uploadFailureLogs = () => [
  { level: 'info', message: '开始上传', stage: 'upload', timestamp: TS },
  { level: 'error', message: 'SFTP 上传中断：Connection reset by peer\n  at Socket.onEnd', stage: 'upload', timestamp: TS },
];

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
    repositoryUrl: 'http://127.0.0.1/team/test.git',
    serverId: server.id,
    deployRoot: '/tmp/test',
    projectType: 'backend',
    artifactPattern: 'target/app.jar',
    serverPort: 18080,
    processMode: 'pid',
  });
});

const createRunningRecord = () =>
  inTeam(() =>
    store.createRecord({
      targetId: target.id,
      projectId: 1,
      projectName: 'test',
      envName: '测试',
      branch: 'dev',
      commitSha: 'abc',
      commitMessage: '',
      commitAuthor: 'ryan',
      status: 'running',
      operator: 'tester',
      startedAt: new Date().toISOString(),
    })
  );

test('构建失败日志：产出精简根因，不带摘录与行号', () => {
  const summary = summarizeFailedRecordLogs(buildFailureLogs());
  assert.ok(summary, '应识别出根因');
  assert.ok(summary.category);
  assert.ok(summary.title);
  assert.equal(summary.violation, 'axios');
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.excerpt, undefined);
  assert.equal(summary.rawDetail, undefined);
  assert.equal(summary.lineIndex, undefined);
});

test('上传等非构建失败：标题用最后一条错误日志的首行', () => {
  const summary = summarizeFailedRecordLogs(uploadFailureLogs());
  assert.equal(summary.category, '执行失败');
  assert.equal(summary.title, 'SFTP 上传中断：Connection reset by peer');
});

test('空日志与超长字段', () => {
  assert.equal(summarizeFailedRecordLogs([]), null);
  assert.equal(summarizeFailedRecordLogs(null), null);
  const long = summarizeFailedRecordLogs([{ level: 'error', message: 'x'.repeat(5000), timestamp: TS }]);
  assert.ok(long.title.length <= 301);
  assert.equal(parseErrorSummary('not json'), null);
  assert.equal(parseErrorSummary('{"title":"缺 category"}'), null);
});

test('发布以 failed 结束时落库根因，列表与详情都能读到；补写日志不丢', async () => {
  const record = await createRunningRecord();
  assert.equal(record.errorSummary, null);

  const failed = await inTeam(() => store.updateRecord(record.id, { status: 'failed', logs: buildFailureLogs(), finishedAt: new Date().toISOString() }));
  assert.equal(failed.errorSummary?.violation, 'axios');

  // 清理旧记录后只补写日志（deploy-service 的 pruneLocalRecords 分支），根因保持
  const again = await inTeam(() => store.updateRecord(record.id, { logs: buildFailureLogs() }));
  assert.equal(again.errorSummary?.violation, 'axios');
  const relisted = await inTeam(() => store.updateRecord(record.id, { finishedAt: new Date().toISOString() }));
  assert.equal(relisted.errorSummary?.violation, 'axios', '不带日志的更新不应清空根因');

  const page = await inTeam(() => store.listRecords({ pageSize: 20 }));
  const item = page.items.find((row) => row.id === record.id);
  assert.equal(item.errorSummary?.violation, 'axios', '列表接口直接带出失败原因');
  assert.deepEqual(item.logs, [], '列表仍不带日志');
});

test('成功的发布不写根因', async () => {
  const record = await createRunningRecord();
  const done = await inTeam(() => store.updateRecord(record.id, { status: 'success', logs: buildFailureLogs(), finishedAt: new Date().toISOString() }));
  assert.equal(done.errorSummary, null);
});

test('数据库带 error_summary 列', async () => {
  const db = await store.getDeployDb();
  const columns = db.prepare('PRAGMA table_info(deploy_records)').all().map((row) => row.name);
  assert.ok(columns.includes('error_summary'));
});
