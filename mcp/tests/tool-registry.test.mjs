import assert from 'node:assert/strict';
import test from 'node:test';
import { YUYAN_TOOL_DEFINITIONS } from '../dist/tool-registry.js';
import { getRuntimeDescriptorCandidates } from '../dist/runtime-client.js';

test('一期 MCP 工具集完整且工具名唯一', () => {
  const names = YUYAN_TOOL_DEFINITIONS.map((item) => item.name);
  assert.equal(names.length, 20);
  assert.equal(new Set(names).size, names.length);
  for (const requiredName of [
    'yuyan_inspect_workspace',
    'yuyan_plan_project_config',
    'yuyan_apply_project_config',
    'yuyan_deploy_target',
    'yuyan_delete_deploy_target',
    'yuyan_delete_deploy_server',
    'yuyan_get_operation',
  ]) {
    assert.ok(names.includes(requiredName));
  }
});

test('输入 Schema 严格拒绝未知字段并强制写操作幂等键', () => {
  const inspect = YUYAN_TOOL_DEFINITIONS.find((item) => item.name === 'yuyan_inspect_workspace');
  assert.equal(inspect.schema.safeParse({ workspacePath: '/tmp/demo' }).success, true);
  assert.equal(inspect.schema.safeParse({ workspacePath: '/tmp/demo', token: 'forbidden' }).success, false);

  const deploy = YUYAN_TOOL_DEFINITIONS.find((item) => item.name === 'yuyan_deploy_target');
  assert.equal(deploy.schema.safeParse({ workspacePath: '/tmp/demo', targetId: 1 }).success, false);
  assert.equal(deploy.schema.safeParse({ workspacePath: '/tmp/demo', targetId: 1, idempotencyKey: 'deploy-0001' }).success, true);

  const deleteTarget = YUYAN_TOOL_DEFINITIONS.find((item) => item.name === 'yuyan_delete_deploy_target');
  assert.equal(deleteTarget.schema.safeParse({ workspacePath: '/tmp/demo', targetId: 1, idempotencyKey: 'delete-0001' }).success, false);
  assert.equal(deleteTarget.schema.safeParse({ workspacePath: '/tmp/demo', targetId: 1, expectedProjectName: 'demo', idempotencyKey: 'delete-0001' }).success, true);
});

test('运行时描述文件优先使用显式路径', () => {
  const previous = process.env.YUYAN_RUNTIME_DESCRIPTOR;
  process.env.YUYAN_RUNTIME_DESCRIPTOR = '/tmp/yuyan-agent-runtime-test.json';
  assert.equal(getRuntimeDescriptorCandidates()[0], '/tmp/yuyan-agent-runtime-test.json');
  if (previous === undefined) delete process.env.YUYAN_RUNTIME_DESCRIPTOR;
  else process.env.YUYAN_RUNTIME_DESCRIPTOR = previous;
});
