import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import {
  getAgentEventRevision,
  publishAgentChange,
  resetAgentEventState,
  subscribeAgentChanges,
} from '../agent-event-service.mjs';

/** 等待事件总线完成 100ms 合并窗口。 */
const waitForFlush = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeEach(resetAgentEventState);
afterEach(resetAgentEventState);

test('Agent 变更事件在 100ms 内合并并递增版本', async () => {
  const events = [];
  const unsubscribe = subscribeAgentChanges((event) => events.push(event));
  publishAgentChange('operations');
  publishAgentChange(['approvals', 'audit', 'unknown-domain']);
  await waitForFlush();

  assert.equal(events.length, 1);
  assert.equal(events[0].revision, 1);
  assert.deepEqual(new Set(events[0].domains), new Set(['operations', 'approvals', 'audit']));
  assert.equal(getAgentEventRevision(), 1);

  unsubscribe();
  publishAgentChange('policy');
  await waitForFlush();
  assert.equal(events.length, 1);
  assert.equal(getAgentEventRevision(), 2);
});
