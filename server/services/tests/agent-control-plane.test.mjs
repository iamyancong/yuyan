import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-agent-test-'));
process.env.YUYAN_AGENT_DB_PATH = path.join(testRoot, 'agent.sqlite');
process.env.DEPLOY_SECRET_KEY = 'agent-control-plane-test-key';

const security = await import('../agent-security.mjs');
const store = await import('../agent-store.mjs');
const runtime = await import('../agent-runtime-service.mjs');
const workspaceService = await import('../agent-workspace-service.mjs');

after(() => {
  store.closeAgentDb();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('参数哈希稳定且敏感字段和自由文本会脱敏', () => {
  assert.equal(security.hashAgentPayload({ b: 2, a: 1 }), security.hashAgentPayload({ a: 1, b: 2 }));
  const redacted = security.redactAgentValue({ token: 'secret', nested: { password: 'pwd' }, message: 'Authorization: Bearer abc123' });
  assert.equal(redacted.token, '***');
  assert.equal(redacted.nested.password, '***');
  assert.doesNotMatch(redacted.message, /abc123/);
});

test('项目授权精确绑定客户端、真实 Git 根目录和远程仓库', async () => {
  const repoDir = path.join(testRoot, 'repo');
  fs.mkdirSync(path.join(repoDir, 'packages', 'app'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'agent-demo', scripts: { build: 'vite build' } }));
  fs.writeFileSync(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  execFileSync('git', ['init'], { cwd: repoDir, windowsHide: true });
  execFileSync('git', ['remote', 'add', 'origin', 'https://user:password@git.example.com/team/agent-demo.git'], { cwd: repoDir, windowsHide: true });
  const workspace = await workspaceService.inspectAgentWorkspace(path.join(repoDir, 'packages', 'app'));
  assert.equal(workspace.workspacePath, fs.realpathSync(repoDir));
  assert.equal(workspace.remoteUrl, 'git.example.com/team/agent-demo');
  assert.equal(workspace.projectType, 'frontend');
  assert.equal(workspace.packageManager, 'pnpm');
  await assert.rejects(() => workspaceService.requireProjectGrant('codex', repoDir), (error) => error.code === 'authorization_required');
  store.upsertProjectGrant({ client: 'codex', workspacePath: workspace.workspacePath, remoteUrl: workspace.remoteUrl });
  const granted = await workspaceService.requireProjectGrant('codex', path.join(repoDir, 'packages', 'app'));
  assert.equal(granted.grant.client, 'codex');
  await assert.rejects(() => workspaceService.requireProjectGrant('cursor', repoDir), (error) => error.code === 'authorization_required');
});

test('真实路径解析拒绝通过仓库内软链接授权外部目录', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Windows 默认环境可能没有创建符号链接权限');
    return;
  }
  const repoDir = path.join(testRoot, 'symlink-repo');
  const outsideDir = path.join(testRoot, 'outside');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, windowsHide: true });
  fs.symlinkSync(outsideDir, path.join(repoDir, 'escape'));
  await assert.rejects(
    () => workspaceService.inspectAgentWorkspace(path.join(repoDir, 'escape')),
    (error) => error.code === 'git_workspace_required'
  );
});

test('写操作幂等且审计 HMAC 链可检测篡改', () => {
  const payload = { targetId: 7, branch: 'dev' };
  const common = {
    toolName: 'yuyan_deploy_target',
    client: 'codex',
    workspacePath: '/tmp/repo',
    riskLevel: 'external_effect',
    executionScope: 'server',
    idempotencyKey: 'deploy-demo-0001',
    payloadHash: security.hashAgentPayload(payload),
    payload,
    approvalSummary: { title: '测试发布' },
  };
  const first = store.createAgentOperation(common);
  const duplicate = store.createAgentOperation(common);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.status, 'pending_approval');
  const pending = store.listPendingAgentApprovals();
  const pendingItem = pending.items.find((item) => item.id === first.id);
  assert.ok(pendingItem);
  assert.deepEqual(Object.keys(pendingItem).sort(), [
    'approvalSummary', 'client', 'createdAt', 'executionScope', 'id',
    'payloadHash', 'riskLevel', 'toolName', 'updatedAt',
  ]);

  store.appendAgentAudit({ action: 'operation_requested', operationId: first.id, token: 'must-not-leak' });
  store.appendAgentAudit({ action: 'operation_approved', operationId: first.id });
  assert.deepEqual(store.verifyAgentAuditChain(), { valid: true, count: 2 });
  const audit = store.listAgentAudit({ limit: 10 });
  assert.equal(audit.items[1].token, '***');
  store.getAgentDb().prepare("UPDATE agent_audit SET body_json = '{\"tampered\":true}' WHERE id = 1").run();
  assert.equal(store.verifyAgentAuditChain().valid, false);
  assert.equal(store.expirePendingAgentOperations(0), 1);
  assert.equal(store.listPendingAgentApprovals().total, 0);
});

test('审计校验缓存按身份隔离，并能感知外部 SQLite 连接篡改', () => {
  runtime.updateAgentRuntimeSettings({ accountId: 'cache-account-a', deviceId: 'cache-device-a', teamId: 'cache-team-a' });
  store.appendAgentAudit({ action: 'cache_account_a_created' });
  const firstResult = store.verifyAgentAuditChain();
  const cachedResult = store.verifyAgentAuditChain();
  assert.equal(firstResult.valid, true);
  assert.strictEqual(cachedResult, firstResult);

  runtime.updateAgentRuntimeSettings({ accountId: 'cache-account-b', deviceId: 'cache-device-b', teamId: 'cache-team-b' });
  store.appendAgentAudit({ action: 'cache_account_b_created' });
  assert.deepEqual(store.verifyAgentAuditChain(), { valid: true, count: 1 });

  const externalDb = new DatabaseSync(process.env.YUYAN_AGENT_DB_PATH);
  try {
    externalDb.prepare("UPDATE agent_audit SET body_json = '{\"tamperedExternally\":true}' WHERE account_id = ? AND device_id = ?")
      .run('cache-account-b', 'cache-device-b');
  } finally {
    externalDb.close();
  }
  assert.equal(store.verifyAgentAuditChain().valid, false);

  runtime.updateAgentRuntimeSettings({ accountId: 'cache-account-a', deviceId: 'cache-device-a', teamId: 'cache-team-a' });
  assert.equal(store.verifyAgentAuditChain().valid, true);
  runtime.updateAgentRuntimeSettings({ accountId: '', deviceId: '', teamId: '' });
});

test('审批策略默认自动执行普通操作且可以持久化关闭', () => {
  assert.equal(store.getAgentApprovalPolicy().autoApproveGrantedProjects, true);
  assert.equal(store.updateAgentApprovalPolicy({ autoApproveGrantedProjects: false }).autoApproveGrantedProjects, false);
  assert.equal(store.getAgentApprovalPolicy().autoApproveGrantedProjects, false);
  assert.equal(store.updateAgentApprovalPolicy({ autoApproveGrantedProjects: true }).autoApproveGrantedProjects, true);
});
