import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDeployRuntimeSnapshots } from '../deploy-runtime-snapshot-service.mjs';

test('部署运行态聚合优先进程任务、补充中央任务并隔离不可见目标', () => {
  const items = mergeDeployRuntimeSnapshots({
    targetIds: [1, 2],
    inMemorySnapshots: [
      { targetId: 1, action: 'rollback', running: true, currentStage: 'publish', events: [] },
      { targetId: 4, action: 'deploy', running: true, currentStage: 'build', events: [] },
    ],
    centralOperations: [
      {
        id: 'central-duplicate', resourceType: 'deploy_target', resourceId: '1', status: 'running',
        actor: { accountId: 'account-a' }, result: { progress: { stage: 'upload', percent: 20 } },
        createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:01:00.000Z',
      },
      {
        id: 'central-visible', resourceType: 'deploy_target', resourceId: '2', status: 'queued',
        actor: { accountId: 'account-a' }, createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:01:00.000Z',
      },
      {
        id: 'central-other-team', resourceType: 'deploy_target', resourceId: '3', status: 'running',
        actor: { accountId: 'account-b' }, createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:01:00.000Z',
      },
      {
        id: 'central-finished', resourceType: 'deploy_target', resourceId: '2', status: 'succeeded',
        createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:01:00.000Z',
      },
    ],
  });

  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.targetId === 1)?.action, 'rollback');
  assert.equal(items.find((item) => item.targetId === 2)?.operationId, 'central-visible');
  assert.ok(items.every((item) => item.runningCount === 2));
  assert.equal(items.some((item) => item.targetId === 3 || item.targetId === 4), false);
});
