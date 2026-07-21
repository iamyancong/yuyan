import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-agent-identities-'));
process.env.YUYAN_AGENT_DB_PATH = path.join(root, 'agent.sqlite');
process.env.DEPLOY_SECRET_KEY = 'agent-multi-identity-test-key';

const runtime = await import('../agent-runtime-service.mjs');
const store = await import('../agent-store.mjs');
const security = await import('../agent-security.mjs');

after(() => {
  store.closeAgentDb();
  fs.rmSync(root, { recursive: true, force: true });
});

/** 切换测试用活动身份。 */
function switchIdentity(accountId, deviceId, teamId) {
  runtime.updateAgentRuntimeSettings({ accountId, deviceId, teamId, role: 'operator' });
}

test('同账号双设备共享账号空间但不继承目录授权、设备策略和幂等任务', () => {
  const payload = { targetId: 8, branch: 'dev' };
  const operation = {
    toolName: 'yuyan_deploy_target',
    client: 'codex',
    workspacePath: '/workspace/project',
    riskLevel: 'external_effect',
    executionScope: 'server',
    idempotencyKey: 'same-device-key-0001',
    payloadHash: security.hashAgentPayload(payload),
    payload,
  };

  switchIdentity('gitlab:host:101', 'device-a', 'team-a');
  store.upsertProjectGrant({ client: 'codex', workspacePath: '/workspace/project', remoteUrl: 'git.example/team/project' });
  store.updateAgentApprovalPolicy({ autoApproveGrantedProjects: false });
  const deviceAOperation = store.createAgentOperation(operation);
  store.saveDeviceOpenApiArtifact({
    id: 'artifact-device-a', targetId: 8, projectName: 'project', branch: 'dev', commitSha: 'abc123',
    fileName: 'openapi.json', filePath: '/device-a/openapi.json', sha256: 'sha-device-a', sizeBytes: 10,
  });

  switchIdentity('gitlab:host:101', 'device-b', 'team-a');
  assert.equal(store.listProjectGrants().total, 0);
  assert.equal(store.getAgentApprovalPolicy().autoApproveGrantedProjects, true);
  assert.equal(store.getLatestDeviceOpenApiArtifact(8), null);
  const deviceBOperation = store.createAgentOperation(operation);
  assert.notEqual(deviceAOperation.id, deviceBOperation.id);

  switchIdentity('gitlab:host:101', 'device-a', 'team-a');
  assert.equal(store.listProjectGrants().total, 1);
  assert.equal(store.getAgentApprovalPolicy().autoApproveGrantedProjects, false);
  assert.equal(store.getLatestDeviceOpenApiArtifact(8).id, 'artifact-device-a');
  assert.equal(store.createAgentOperation(operation).id, deviceAOperation.id);
});

test('同一系统设备切换 GitLab 账号后授权、任务和审计完全不可见', () => {
  switchIdentity('gitlab:host:202', 'device-a', 'team-b');
  assert.equal(store.listProjectGrants().total, 0);
  assert.equal(store.listAgentOperations().total, 0);
  assert.equal(store.listAgentAudit().total, 0);
  assert.equal(store.getLatestDeviceOpenApiArtifact(8), null);
  store.appendAgentAudit({ action: 'account-b-event' });

  switchIdentity('gitlab:host:101', 'device-a', 'team-a');
  assert.equal(store.listProjectGrants().total, 1);
  assert.equal(store.listAgentOperations().total, 1);
  assert.equal(store.listAgentAudit().total, 0);
});
