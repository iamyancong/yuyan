import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findDuplicateDeployTarget,
  getDuplicateDeployTargetId,
  isDuplicateDeployTargetError,
  resolveTargetSaveBuildMemoryMb,
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
  assert.equal(findDuplicateDeployTarget(targets, {
    projectId: 1001,
    envName: '测试',
    serverId: undefined,
    deployRoot: '/home/app/frontend/html',
  }), undefined);
});

test('编辑部署目标未改动「构建内存」时保存不带 buildMemoryMb 字段，避免覆盖 OOM 刚记住的扩容值', () => {
  // 1. 新增目标时始终携带规范化后的数值
  assert.equal(
    resolveTargetSaveBuildMemoryMb({
      isEditing: false,
      initialBuildMemoryMb: null,
      currentBuildMemoryMb: 0,
    }),
    0,
  );
  assert.equal(
    resolveTargetSaveBuildMemoryMb({
      isEditing: false,
      initialBuildMemoryMb: null,
      currentBuildMemoryMb: 4096.8,
    }),
    4096,
  );

  // 2. 编辑目标时若用户未修改（初始 0，当前仍为 0），返回 undefined
  assert.equal(
    resolveTargetSaveBuildMemoryMb({
      isEditing: true,
      initialBuildMemoryMb: 0,
      currentBuildMemoryMb: 0,
    }),
    undefined,
  );

  // 3. 编辑目标时若用户将 8192 重置为 0 或修改为 4096，则正常携带新值并封顶 65536
  assert.equal(
    resolveTargetSaveBuildMemoryMb({
      isEditing: true,
      initialBuildMemoryMb: 8192,
      currentBuildMemoryMb: 0,
    }),
    0,
  );
  assert.equal(
    resolveTargetSaveBuildMemoryMb({
      isEditing: true,
      initialBuildMemoryMb: 0,
      currentBuildMemoryMb: 999999,
    }),
    65536,
  );
});
