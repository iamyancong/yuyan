import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  closeAllDeployEventStreams,
  getDeployEventRevision,
  getDeployEventStats,
  publishDeployEvent,
  resetDeployEventState,
  setDeployRuntimeSnapshotResolver,
  subscribeDeployEvents,
} from '../deploy-event-service.mjs';

afterEach(() => {
  setDeployRuntimeSnapshotResolver(null);
  resetDeployEventState();
});

test('deploy-event-service 按 teamId 隔离广播并在时间窗口内合并高频变更域与目标 ID', async () => {
  const teamAEvents = [];
  const teamBEvents = [];

  setDeployRuntimeSnapshotResolver(async (teamId) => ({
    items: [{ targetId: teamId === 'team-a' ? 101 : 202, running: true }],
    checkedAt: '2026-10-26T00:00:00.000Z',
  }));

  const unsubA = subscribeDeployEvents({
    teamId: 'team-a',
    onEvent: (eventName, payload) => teamAEvents.push({ eventName, payload }),
  });
  const unsubB = subscribeDeployEvents({
    teamId: 'team-b',
    onEvent: (eventName, payload) => teamBEvents.push({ eventName, payload }),
  });

  assert.equal(getDeployEventStats().activeConnections, 2);
  assert.equal(getDeployEventStats().activeTeams, 2);

  publishDeployEvent({ teamId: 'team-a', domains: ['runtime'], targetIds: [1], coalesceMs: 30 });
  publishDeployEvent({ teamId: 'team-a', domains: ['targets', 'records'], targetIds: [2, 1], coalesceMs: 30 });

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(teamAEvents.length, 1);
  assert.equal(teamAEvents[0].eventName, 'change');
  assert.equal(teamAEvents[0].payload.revision, 1);
  assert.deepEqual(teamAEvents[0].payload.domains, ['runtime', 'targets', 'records']);
  assert.deepEqual(teamAEvents[0].payload.targetIds, [1, 2]);
  assert.deepEqual(teamAEvents[0].payload.runtime?.items, [{ targetId: 101, running: true }]);
  assert.equal(teamBEvents.length, 0);
  assert.equal(getDeployEventRevision('team-a'), 1);
  assert.equal(getDeployEventRevision('team-b'), 0);

  unsubA();
  unsubB();
  assert.equal(getDeployEventStats().activeConnections, 0);
});

test('deploy-event-service 支持关闭所有活跃流并触发 close 回调', () => {
  let closedCount = 0;
  subscribeDeployEvents({
    teamId: 'team-close',
    onEvent: () => {},
    close: () => {
      closedCount += 1;
    },
  });
  subscribeDeployEvents({
    teamId: 'team-close',
    onEvent: () => {},
    close: () => {
      closedCount += 1;
    },
  });

  assert.equal(getDeployEventStats().activeConnections, 2);
  closeAllDeployEventStreams();
  assert.equal(closedCount, 2);
  assert.equal(getDeployEventStats().activeConnections, 0);
});
