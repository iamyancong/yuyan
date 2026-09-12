import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canStopDeployTask,
  formatDeployDuration,
  resolveRuntimeLockState,
} from '../runtimeLockPolicy.ts';

test('formatDeployDuration 格式化部署耗时正确覆盖各边界场景', () => {
  assert.equal(formatDeployDuration(), '-');
  assert.equal(formatDeployDuration('2026-09-12T10:00:00.000Z'), '进行中');
  assert.equal(formatDeployDuration('invalid-date', '2026-09-12T10:00:10.000Z'), '-');
  assert.equal(formatDeployDuration('2026-09-12T10:05:00.000Z', '2026-09-12T10:00:00.000Z'), '-');

  // 小于 1 秒
  assert.equal(
    formatDeployDuration('2026-09-12T10:00:00.000Z', '2026-09-12T10:00:00.500Z'),
    '< 1秒'
  );

  // 纯秒数
  assert.equal(
    formatDeployDuration('2026-09-12T10:00:00.000Z', '2026-09-12T10:00:25.000Z'),
    '25秒'
  );

  // 分钟与秒数组合
  assert.equal(
    formatDeployDuration('2026-09-12T10:00:00.000Z', '2026-09-12T10:02:15.000Z'),
    '2分15秒'
  );

  // 整数分钟
  assert.equal(
    formatDeployDuration('2026-09-12T10:00:00.000Z', '2026-09-12T10:03:00.000Z'),
    '3分钟'
  );
});

test('canStopDeployTask 权限判断符合安全隔离策略', () => {
  // 未知或空操作人默认兜底允许
  assert.equal(canStopDeployTask('', 'alice', 'operator'), true);
  assert.equal(canStopDeployTask('未知操作人', 'alice', 'operator'), true);

  // 本人操作人可停止
  assert.equal(canStopDeployTask('alice', 'alice', 'operator'), true);
  assert.equal(canStopDeployTask('alice', 'alice', 'viewer'), true);

  // 他人且无 admin 权限禁止停止
  assert.equal(canStopDeployTask('alice', 'bob', 'operator'), false);
  assert.equal(canStopDeployTask('alice', 'bob', 'viewer'), false);
  assert.equal(canStopDeployTask('alice', '', 'operator'), false);

  // 管理员(admin)可跨人干预停止
  assert.equal(canStopDeployTask('alice', 'bob', 'admin'), true);
  assert.equal(canStopDeployTask('alice', 'adminUser', 'admin'), true);
});

test('resolveRuntimeLockState 解析未运行与本人运行态', () => {
  // 未运行
  const idleState = resolveRuntimeLockState({
    currentUserName: 'alice',
    userRole: 'operator',
    running: false,
    stoppable: false,
  });
  assert.equal(idleState.isLocked, false);
  assert.equal(idleState.isSubscriberMode, false);
  assert.equal(idleState.canStop, false);

  // 本人运行且可停止
  const selfRunningState = resolveRuntimeLockState({
    currentUserName: 'alice',
    userRole: 'operator',
    taskOperator: 'alice',
    startedAt: '2026-09-12T10:00:00.000Z',
    running: true,
    stoppable: true,
  });
  assert.equal(selfRunningState.isLocked, true);
  assert.equal(selfRunningState.isSelfOperator, true);
  assert.equal(selfRunningState.isSubscriberMode, false);
  assert.equal(selfRunningState.canStop, true);
  assert.equal(selfRunningState.canPreempt, false);
  assert.equal(selfRunningState.stopButtonText, '停止');

  // 本人运行但已进入产物上传（不可停止）
  const selfUnstoppableState = resolveRuntimeLockState({
    currentUserName: 'alice',
    userRole: 'operator',
    taskOperator: 'alice',
    running: true,
    stoppable: false,
  });
  assert.equal(selfUnstoppableState.canStop, false);
  assert.equal(selfUnstoppableState.stopButtonText, '上传后不可停止');
});

test('resolveRuntimeLockState 解析他人运行与协同观察/管理员抢占态', () => {
  // 普通操作人查看他人任务：协同观察模式，禁用停止
  const subscriberState = resolveRuntimeLockState({
    currentUserName: 'bob',
    userRole: 'operator',
    taskOperator: 'alice',
    startedAt: '2026-09-12T10:00:00.000Z',
    running: true,
    stoppable: true,
  });
  assert.equal(subscriberState.isLocked, true);
  assert.equal(subscriberState.isSelfOperator, false);
  assert.equal(subscriberState.isSubscriberMode, true);
  assert.equal(subscriberState.canStop, false);
  assert.equal(subscriberState.canPreempt, false);
  assert.equal(subscriberState.stopButtonText, '仅本人或管理员可停止');

  // 管理员查看他人任务：协同观察模式，支持强制抢占停止
  const adminPreemptState = resolveRuntimeLockState({
    currentUserName: 'superAdmin',
    userRole: 'admin',
    taskOperator: 'alice',
    startedAt: '2026-09-12T10:00:00.000Z',
    running: true,
    stoppable: true,
  });
  assert.equal(adminPreemptState.isLocked, true);
  assert.equal(adminPreemptState.isSelfOperator, false);
  assert.equal(adminPreemptState.isSubscriberMode, true);
  assert.equal(adminPreemptState.isAdmin, true);
  assert.equal(adminPreemptState.canStop, true);
  assert.equal(adminPreemptState.canPreempt, true);
  assert.equal(adminPreemptState.stopButtonText, '强制停止 (Admin)');
});
