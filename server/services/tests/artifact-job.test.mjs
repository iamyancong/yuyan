import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-artifact-job-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'artifact-job-test-key';

const store = await import('../deploy-store.mjs');
const jobs = await import('../artifact-job-service.mjs');
const { runRequestContext } = await import('../request-context.mjs');

after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

const context = { accountId: 'user-a', userId: 'user-a', deviceId: 'device-a', teamId: 'team-a', role: 'operator', client: 'codex', requestId: 'request-a' };

/** 在固定账号隔离上下文中执行。 */
const inContext = (callback) => runRequestContext(context, callback);

/** 创建最小后端部署目标。 */
async function createBackendTarget() {
  return inContext(async () => {
    const server = await store.createServer({
      name: '测试服务器', host: '127.0.0.1', port: 22, username: 'tester', authType: 'password', password: 'secret',
      defaultDeployRoot: '/opt/yuyan/frontend', defaultBackendRoot: '/opt/yuyan/backend',
    });
    return store.createTarget({
      projectId: 1, projectSource: 'gitlab', projectName: 'backend-demo', projectPath: 'team/backend-demo',
      repositoryUrl: 'https://git.example.com/team/backend-demo.git', defaultBranch: 'dev', envName: '测试', serverId: server.id,
      deployRoot: '/opt/yuyan/backend/backend-demo', projectType: 'backend', buildCommand: './mvnw package',
      artifactDir: 'target/app.jar', artifactPattern: 'target/app.jar', requiredJdkAlias: 'Java 17', runtimeJavaHome: '/usr/lib/jvm/java-17',
      runtimeJavaVersion: '17', serverPort: 18080, processMode: 'pid', healthCheckPath: '/actuator/health', serviceName: 'backend-demo',
    });
  });
}

test('产物任务支持幂等、顺序断点上传、同目标锁和哈希失败隔离', async () => {
  const target = await createBackendTarget();
  const bytes = Buffer.from('not-a-real-jar-but-valid-upload-boundary');
  const expectedHash = crypto.createHash('sha256').update(Buffer.from('different')).digest('hex');
  const input = {
    targetId: target.id, fileName: 'backend-demo.jar', sizeBytes: bytes.length, sha256: expectedHash,
    commitSha: 'abcdef1234567890', branch: 'dev', idempotencyKey: 'artifact-idempotency-0001',
  };
  const job = await inContext(() => jobs.createArtifactJob(input));
  assert.equal((await inContext(() => jobs.createArtifactJob(input))).id, job.id);
  await assert.rejects(
    () => inContext(() => jobs.createArtifactJob({ ...input, idempotencyKey: 'artifact-idempotency-0002' })),
    (error) => error.code === 'target_locked',
  );

  const first = bytes.subarray(0, 10);
  const second = bytes.subarray(10);
  const afterFirst = await inContext(() => jobs.appendArtifactChunk(job.id, `bytes 0-9/${bytes.length}`, first));
  assert.equal(afterFirst.uploadedSize, 10);
  assert.equal((await inContext(() => jobs.appendArtifactChunk(job.id, `bytes 0-9/${bytes.length}`, first))).uploadedSize, 10);
  await assert.rejects(
    () => inContext(() => jobs.appendArtifactChunk(job.id, `bytes 11-${bytes.length - 1}/${bytes.length}`, second.subarray(1))),
    (error) => error.code === 'chunk_offset_mismatch' && error.expectedOffset === 10,
  );
  await inContext(() => jobs.appendArtifactChunk(job.id, `bytes 10-${bytes.length - 1}/${bytes.length}`, second));
  await assert.rejects(() => inContext(() => jobs.finalizeArtifactJob(job.id)), (error) => error.code === 'artifact_hash_mismatch');

  const operation = await inContext(() => jobs.getCentralOperation(job.operationId));
  assert.equal(operation.status, 'failed');
  const db = await store.getDeployDb();
  assert.equal(db.prepare('SELECT status FROM artifact_jobs WHERE id = ?').get(job.id).status, 'failed');
  assert.equal(JSON.stringify(operation).includes('secret'), false);
});

test('另一账号空间无法读取产物任务和中央 operation', async () => {
  const foreignContext = { ...context, accountId: 'user-b', userId: 'user-b', deviceId: 'device-b', teamId: 'team-b', requestId: 'request-b' };
  const db = await store.getDeployDb();
  const operationId = db.prepare('SELECT operation_id FROM artifact_jobs LIMIT 1').get().operation_id;
  await assert.rejects(
    () => runRequestContext(foreignContext, () => jobs.getCentralOperation(operationId)),
    (error) => error.code === 'operation_not_found',
  );
});

test('两个账号空间可存在同名项目但列表与 ID 查询互不可见', async () => {
  const teamB = { ...context, accountId: 'user-b', userId: 'user-b', deviceId: 'device-b', teamId: 'team-b', requestId: 'request-team-b' };
  const targetB = await runRequestContext(teamB, async () => {
    const server = await store.createServer({
      name: 'B 服务器', host: '127.0.0.2', port: 22, username: 'tester', authType: 'password', password: 'team-b-secret',
      defaultDeployRoot: '/opt/yuyan/frontend', defaultBackendRoot: '/opt/yuyan/backend',
    });
    return store.createTarget({
      projectId: 1, projectSource: 'gitlab', projectName: 'backend-demo', projectPath: 'team/backend-demo',
      repositoryUrl: 'https://git.example.com/team/backend-demo.git', defaultBranch: 'dev', envName: '测试', serverId: server.id,
      deployRoot: '/opt/yuyan/backend/backend-demo', projectType: 'backend', buildCommand: './mvnw package', artifactDir: 'target/app.jar',
      artifactPattern: 'target/app.jar', requiredJdkAlias: 'Java 17', runtimeJavaHome: '/usr/lib/jvm/java-17', runtimeJavaVersion: '17',
      serverPort: 18080, processMode: 'pid', healthCheckPath: '/actuator/health', serviceName: 'backend-demo',
    });
  });
  const teamBTargets = await runRequestContext(teamB, () => store.listTargets({}));
  const teamATargets = await inContext(() => store.listTargets({}));
  assert.deepEqual(teamBTargets.map((item) => item.id), [targetB.id]);
  assert.equal(teamATargets.length, 1);
  assert.equal(await inContext(() => store.getTarget(targetB.id)), null);
});

test('服务重启会收口遗留的中央部署 operation 和发布记录', async () => {
  const [target] = await inContext(() => store.listTargets({}));
  const job = await inContext(() => jobs.createArtifactJob({
    targetId: target.id,
    fileName: 'backend-restart.jar',
    sizeBytes: 16,
    sha256: '0'.repeat(64),
    commitSha: 'abcdef1234567890',
    branch: 'restart-test',
    idempotencyKey: 'artifact-restart-test-0001',
  }));
  const record = await inContext(() => store.createRecord({
    targetId: target.id,
    projectId: target.projectId,
    projectName: target.projectName,
    envName: target.envName,
    branch: 'restart-test',
    status: 'running',
    operator: 'tester',
    logs: [],
  }));
  const db = await store.getDeployDb();
  const timestamp = new Date().toISOString();
  db.prepare("UPDATE artifact_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(timestamp, job.id);
  db.prepare("UPDATE central_agent_operations SET status = 'running', updated_at = ? WHERE id = ?").run(timestamp, job.operationId);
  store.closeDeployDb();

  const operation = await inContext(() => jobs.getCentralOperation(job.operationId));
  const recoveredRecord = await inContext(() => store.getRecord(record.id));
  const reopenedDb = await store.getDeployDb();
  const recoveredJob = reopenedDb.prepare('SELECT status, error_json FROM artifact_jobs WHERE id = ?').get(job.id);

  assert.equal(operation.status, 'failed');
  assert.equal(operation.error.code, 'service_restarted');
  assert.equal(recoveredJob.status, 'failed');
  assert.equal(JSON.parse(recoveredJob.error_json).code, 'service_restarted');
  assert.equal(recoveredRecord.status, 'stopped');
  assert.equal(Boolean(recoveredRecord.finishedAt), true);
  assert.equal(recoveredRecord.logs.some((item) => item.stage === 'interrupted'), true);
});
