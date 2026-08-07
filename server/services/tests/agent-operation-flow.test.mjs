import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

/** 读取 JSON 请求正文。 */
async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

/** 等待 operation 进入目标状态。 */
async function waitForOperation(getOperation, id, terminalStatuses = ['succeeded', 'failed', 'cancelled']) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const operation = getOperation(id);
    if (terminalStatuses.includes(operation?.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待 operation ${id} 超时`);
}

test('模拟领域接口跑通配置、发布、回滚、服务控制、OpenAPI、取消和失败', { timeout: 15_000 }, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-agent-flow-'));
  const repoDir = path.join(tempRoot, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'flow-demo', scripts: { build: 'vite build' } }));
  fs.writeFileSync(path.join(repoDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  execFileSync('git', ['init'], { cwd: repoDir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'agent-test@example.com'], { cwd: repoDir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoDir, windowsHide: true });
  execFileSync('git', ['add', '.'], { cwd: repoDir, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'test'], { cwd: repoDir, windowsHide: true });
  execFileSync('git', ['remote', 'add', 'origin', 'https://git.example.com/team/flow-demo.git'], { cwd: repoDir, windowsHide: true });

  let target = null;
  let blockDeploy = false;
  let failDeploy = false;
  const calls = [];
  const mockServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    calls.push(`${request.method} ${url.pathname}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && url.pathname === '/deploy-api/v2/servers') {
      response.end(JSON.stringify({ success: true, data: [{
        id: 1,
        name: '测试服务器',
        host: '127.0.0.1',
        defaultDeployRoot: '/opt/yuyan/frontend',
        defaultBackendRoot: '/opt/yuyan/backend',
        defaultNginxConfPath: '/etc/nginx/conf.d',
        nginxInstances: [{ id: 9, isDefault: true }],
      }] }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/deploy-api/v2/targets') {
      response.end(JSON.stringify({ success: true, data: target ? [target] : [] }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/deploy-api/v2/records/88') {
      response.end(JSON.stringify({ success: true, data: { id: 88, targetId: 11, projectName: 'flow-demo' } }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/deploy-api/v2/targets') {
      const body = await readJsonBody(request);
      target = { ...body, id: 11, serverName: '测试服务器', serverHost: '127.0.0.1' };
      response.end(JSON.stringify({ success: true, data: target }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/deploy-api/v2/targets/11/deploy') {
      const body = await readJsonBody(request);
      assert.equal(body.gitlabToken, 'runtime-only-token');
      if (failDeploy) {
        response.statusCode = 400;
        response.end(JSON.stringify({ success: false, error: '模拟构建失败' }));
        return;
      }
      if (blockDeploy) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      response.end(JSON.stringify({ success: true, data: { recordId: 88, health: 'ok' } }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/deploy-api/v2/targets/11/deploy/stop') {
      response.end(JSON.stringify({ success: true, data: { stopped: true } }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/deploy-api/v2/records/88/rollback') {
      response.end(JSON.stringify({ success: true, data: { recordId: 89, action: 'rollback' } }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/deploy-api/v2/targets/11/service-actions/restart') {
      response.end(JSON.stringify({ success: true, data: { status: 'online' } }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/deploy-api/targets/11/openapi/generate') {
      response.end(JSON.stringify({ success: true, data: { id: 3, fileName: 'openapi.json' } }));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/deploy-api/v2/targets/11') {
      assert.equal(url.searchParams.get('safe'), '1');
      target = null;
      response.end(JSON.stringify({ success: true, data: { deletedTargets: 1, deletedRecords: 2 } }));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/deploy-api/v2/servers/1') {
      assert.equal(url.searchParams.get('requireEmpty'), '1');
      response.end(JSON.stringify({ success: true, data: { deletedServers: 1 } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false, error: `未模拟 ${request.method} ${url.pathname}` }));
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  process.env.PORT = String(port);
  process.env.YUYAN_AGENT_DB_PATH = path.join(tempRoot, 'agent.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'agent-operation-flow-key';

  const store = await import('../agent-store.mjs');
  const workspaceService = await import('../agent-workspace-service.mjs');
  const runtime = await import('../agent-runtime-service.mjs');
  const commands = await import('../agent-command-service.mjs');
  try {
    runtime.updateAgentRuntimeSettings({
      centralApiBase: `http://127.0.0.1:${port}`,
      centralAccessToken: 'central-access-token',
      centralAccessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      gitlabHost: 'https://git.example.com',
      gitlabToken: 'runtime-only-token',
      accountId: 'gitlab:test:101',
      deviceId: '11111111-1111-4111-8111-111111111111',
      teamId: 'test-team',
      role: 'admin',
      forcedApprovalTools: [],
      accountApprovalPolicyReady: true,
    });
    store.updateAgentApprovalPolicy({ autoApproveGrantedProjects: false });
    const workspace = await workspaceService.inspectAgentWorkspace(repoDir);
    let grant = store.upsertProjectGrant({ client: 'codex', workspacePath: workspace.workspacePath, remoteUrl: workspace.remoteUrl });

    const plan = await commands.executeAgentTool('yuyan_plan_project_config', 'codex', {
      workspacePath: repoDir,
      projectId: 101,
      serverId: 1,
      nginxInstanceId: 9,
    });
    assert.equal(plan.readyToApply, true);
    assert.equal(plan.action, 'create');
    assert.equal(plan.proposed.enableNginxTest, false);
    assert.equal(plan.proposed.enableNginxReload, false);

    const overridePlan = await commands.executeAgentTool('yuyan_plan_project_config', 'codex', {
      workspacePath: repoDir,
      projectId: 101,
      serverId: 1,
      nginxInstanceId: 9,
      target: { enableNginxTest: true, enableNginxReload: true },
    });
    assert.equal(overridePlan.proposed.enableNginxTest, true);
    assert.equal(overridePlan.proposed.enableNginxReload, true);

    const applyOperation = await commands.executeAgentTool('yuyan_apply_project_config', 'codex', {
      workspacePath: repoDir,
      planId: plan.planId,
      idempotencyKey: 'apply-flow-0001',
    });
    commands.approveAgentOperation(applyOperation.id, 'test-user');
    assert.equal((await waitForOperation(store.getAgentOperation, applyOperation.id)).status, 'succeeded');
    assert.equal(target.id, 11);

    const preflight = await commands.executeAgentTool('yuyan_preflight_deploy_target', 'codex', { workspacePath: repoDir, targetId: 11 });
    assert.equal(preflight.workspaceCommitSha, workspace.commitSha);
    const deployOperation = await commands.executeAgentTool('yuyan_deploy_target', 'codex', {
      workspacePath: repoDir,
      targetId: 11,
      idempotencyKey: 'deploy-flow-0001',
    });
    commands.approveAgentOperation(deployOperation.id, 'test-user');
    const deployed = await waitForOperation(store.getAgentOperation, deployOperation.id);
    assert.equal(deployed.status, 'succeeded', JSON.stringify(deployed.error));
    assert.equal(deployed.result.recordId, 88);
    assert.equal(deployed.result.executionReport.action, 'yuyan_deploy_target');
    assert.equal(deployed.result.executionReport.actor.deviceId, '11111111-1111-4111-8111-111111111111');

    for (const [toolName, args, key] of [
      ['yuyan_rollback_deployment', { recordId: 88 }, 'rollback-flow-0001'],
      ['yuyan_control_service', { targetId: 11, action: 'restart' }, 'control-flow-0001'],
    ]) {
      const operation = await commands.executeAgentTool(toolName, 'codex', { workspacePath: repoDir, ...args, idempotencyKey: key });
      commands.approveAgentOperation(operation.id, 'test-user');
      const completed = await waitForOperation(store.getAgentOperation, operation.id);
      assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
    }

    const invalidOpenApi = await commands.executeAgentTool('yuyan_generate_openapi', 'codex', {
      workspacePath: repoDir, targetId: 11, idempotencyKey: 'openapi-flow-0001',
    });
    commands.approveAgentOperation(invalidOpenApi.id, 'test-user');
    const openApiResult = await waitForOperation(store.getAgentOperation, invalidOpenApi.id);
    assert.equal(openApiResult.status, 'failed');
    assert.match(openApiResult.error.message, /后端|Maven|OpenAPI/);

    failDeploy = true;
    const failedOperation = await commands.executeAgentTool('yuyan_deploy_target', 'codex', {
      workspacePath: repoDir, targetId: 11, idempotencyKey: 'deploy-fail-0001',
    });
    commands.approveAgentOperation(failedOperation.id, 'test-user');
    assert.equal((await waitForOperation(store.getAgentOperation, failedOperation.id)).error.code, 'yuyan_api_error');
    failDeploy = false;

    const tamperedOperation = await commands.executeAgentTool('yuyan_deploy_target', 'codex', {
      workspacePath: repoDir, targetId: 11, idempotencyKey: 'deploy-tamper-0001',
    });
    store.getAgentDb().prepare("UPDATE agent_operations SET payload_json = '{\"targetId\":999}' WHERE id = ?").run(tamperedOperation.id);
    commands.approveAgentOperation(tamperedOperation.id, 'test-user');
    const expired = await waitForOperation(store.getAgentOperation, tamperedOperation.id, ['expired']);
    assert.equal(expired.error.code, 'approval_payload_changed');

    blockDeploy = true;
    const cancelledOperation = await commands.executeAgentTool('yuyan_deploy_target', 'codex', {
      workspacePath: repoDir, targetId: 11, idempotencyKey: 'deploy-cancel-0001',
    });
    commands.approveAgentOperation(cancelledOperation.id, 'test-user');
    await waitForOperation(store.getAgentOperation, cancelledOperation.id, ['running']);
    await commands.cancelAgentOperation(cancelledOperation.id);
    assert.equal((await waitForOperation(store.getAgentOperation, cancelledOperation.id)).status, 'cancelled');
    assert.ok(calls.includes('POST /deploy-api/targets/11/deploy/stop'));

    blockDeploy = false;
    store.updateAgentApprovalPolicy({ autoApproveGrantedProjects: true });
    const autoOperation = await commands.executeAgentTool('yuyan_control_service', 'codex', {
      workspacePath: repoDir, targetId: 11, action: 'restart', idempotencyKey: 'control-auto-0001',
    });
    assert.equal(autoOperation.approvedBy, 'policy:trusted-project');
    assert.equal((await waitForOperation(store.getAgentOperation, autoOperation.id)).status, 'succeeded');

    runtime.updateAgentRuntimeSettings({ forcedApprovalTools: ['yuyan_control_service'], accountApprovalPolicyReady: true });
    const teamForcedOperation = await commands.executeAgentTool('yuyan_control_service', 'codex', {
      workspacePath: repoDir, targetId: 11, action: 'restart', idempotencyKey: 'control-team-forced-0001',
    });
    assert.equal(teamForcedOperation.status, 'pending_approval');
    assert.equal(teamForcedOperation.approvedBy, undefined);
    commands.rejectAgentOperation(teamForcedOperation.id, 'test-admin');
    runtime.updateAgentRuntimeSettings({ forcedApprovalTools: [], accountApprovalPolicyReady: true });

    runtime.updateAgentRuntimeSettings({ role: 'viewer' });
    await assert.rejects(
      () => commands.executeAgentTool('yuyan_control_service', 'codex', {
        workspacePath: repoDir, targetId: 11, action: 'restart', idempotencyKey: 'control-viewer-denied-0001',
      }),
      (error) => error.code === 'forbidden_role',
    );
    runtime.updateAgentRuntimeSettings({ role: 'admin' });

    const revokedOperation = await commands.executeAgentTool('yuyan_control_service', 'codex', {
      workspacePath: repoDir, targetId: 11, action: 'restart', idempotencyKey: 'control-revoked-0001',
    });
    store.revokeProjectGrant(grant.id);
    const revoked = await waitForOperation(store.getAgentOperation, revokedOperation.id, ['expired']);
    assert.equal(revoked.error.code, 'authorization_revoked');
    grant = store.upsertProjectGrant({ client: 'codex', workspacePath: workspace.workspacePath, remoteUrl: workspace.remoteUrl });

    await assert.rejects(
      () => commands.executeAgentTool('yuyan_delete_deploy_server', 'codex', {
        workspacePath: repoDir, serverId: 1, expectedServerName: '测试服务器', idempotencyKey: 'delete-server-in-use-0001',
      }),
      (error) => error.code === 'server_in_use'
    );
    await assert.rejects(
      () => commands.executeAgentTool('yuyan_delete_deploy_target', 'codex', {
        workspacePath: repoDir, targetId: 11, expectedProjectName: '错误名称', idempotencyKey: 'delete-target-wrong-name-0001',
      }),
      (error) => error.code === 'destructive_confirmation_mismatch'
    );

    const deleteTargetOperation = await commands.executeAgentTool('yuyan_delete_deploy_target', 'codex', {
      workspacePath: repoDir, targetId: 11, expectedProjectName: 'flow-demo', idempotencyKey: 'delete-target-0001',
    });
    assert.equal(deleteTargetOperation.status, 'pending_approval');
    assert.equal(deleteTargetOperation.riskLevel, 'destructive');
    commands.approveAgentOperation(deleteTargetOperation.id, 'test-user');
    assert.equal((await waitForOperation(store.getAgentOperation, deleteTargetOperation.id)).status, 'succeeded');

    const deleteServerOperation = await commands.executeAgentTool('yuyan_delete_deploy_server', 'codex', {
      workspacePath: repoDir, serverId: 1, expectedServerName: '测试服务器', idempotencyKey: 'delete-server-0001',
    });
    assert.equal(deleteServerOperation.status, 'pending_approval');
    commands.approveAgentOperation(deleteServerOperation.id, 'test-user');
    assert.equal((await waitForOperation(store.getAgentOperation, deleteServerOperation.id)).status, 'succeeded');
  } finally {
    store.closeAgentDb();
    mockServer.closeAllConnections?.();
    await new Promise((resolve) => mockServer.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
