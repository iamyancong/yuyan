import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findDuplicateDeployTarget,
  getDuplicateDeployTargetId,
  isDuplicateDeployTargetError,
} from '../deployTargetSavePolicy.ts';

test('只从部署目标重复冲突中提取已有目标 ID', () => {
  assert.equal(getDuplicateDeployTargetId({
    response: {
      data: {
        code: 'deploy_target_exists',
        details: { targetId: 42 },
      },
    },
  }), '42');
  assert.equal(getDuplicateDeployTargetId({ response: { data: { code: 'other_error' } } }), '');
  assert.equal(getDuplicateDeployTargetId(new Error('网络失败')), '');
  assert.equal(isDuplicateDeployTargetError({ response: { data: { code: 'deploy_target_exists' } } }), true);
  assert.equal(isDuplicateDeployTargetError({ response: { data: { error: '该项目已存在部署目标' } } }), true);
  assert.equal(isDuplicateDeployTargetError({ response: { data: { error: '服务器连接失败' } } }), false);
});

test('新版目标 ID 和旧版业务字段都能定位已保存的部署目标', () => {
  const targets = [{
    id: 7,
    projectId: 1001,
    projectPath: 'group/main-app',
    projectName: '主应用',
    envName: '测试',
    serverId: 3,
    deployRoot: '/home/app/frontend/html',
  }];
  assert.equal(findDuplicateDeployTarget(targets, {}, '7')?.id, 7);
  assert.equal(findDuplicateDeployTarget(targets, {
    projectId: 1001,
    envName: '测试',
    serverId: 3,
    deployRoot: '/home/app/frontend/html/',
  })?.id, 7);
  assert.equal(findDuplicateDeployTarget(targets, {
    projectId: 2002,
    envName: '测试',
    serverId: 3,
    deployRoot: '/home/app/frontend/html/other',
  }), undefined);
});
