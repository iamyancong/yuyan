import assert from 'node:assert/strict';
import test from 'node:test';
import { filterDeployTargets } from '../targetFilterPolicy.ts';

const targets = [
  { id: 1, projectName: 'Yss-System-Manage', projectPath: 'group/yss-system-manage', projectDescription: '新版系统管理', defaultBranch: 'dev', serverId: 1, projectType: 'frontend' as const },
  { id: 2, projectName: 'valuation', projectPath: 'group/valuation', projectDescription: '估值外包', defaultBranch: 'main', serverId: 2, projectType: 'backend' as const },
  { id: 3, projectName: 'scheduler', projectPath: 'group/scheduler', projectDescription: '统一调度中心', defaultBranch: 'dev', serverId: 2, projectType: 'frontend' as const },
];

test('无筛选条件时返回原数组引用', () => {
  assert.equal(filterDeployTargets(targets, {}), targets);
  assert.equal(filterDeployTargets(targets, { projectType: 'all' }), targets);
});

test('关键字不区分大小写匹配名称、路径与描述', () => {
  assert.deepEqual(filterDeployTargets(targets, { projectKeyword: 'SYSTEM' }).map((item) => item.id), [1]);
  assert.deepEqual(filterDeployTargets(targets, { projectKeyword: 'group/val' }).map((item) => item.id), [2]);
  assert.deepEqual(filterDeployTargets(targets, { projectKeyword: '调度' }).map((item) => item.id), [3]);
});

test('分支、服务器、项目类型精确组合筛选并保持顺序与引用', () => {
  const result = filterDeployTargets(targets, { branch: 'dev', serverId: 2, projectType: 'frontend' });
  assert.deepEqual(result.map((item) => item.id), [3]);
  assert.equal(result[0], targets[2]);
  assert.deepEqual(filterDeployTargets(targets, { serverId: 2 }).map((item) => item.id), [2, 3]);
  assert.deepEqual(filterDeployTargets(targets, { projectType: 'backend' }).map((item) => item.id), [2]);
});

test('按 Nginx 实例筛选：同一服务器多个实例时区分（#47）', () => {
  const withInstances = [
    { ...targets[0], nginxInstanceId: 11 },
    { ...targets[2], serverId: 1, nginxInstanceId: 12 },
    { ...targets[1], serverId: 1, nginxInstanceId: undefined },
  ];
  assert.deepEqual(filterDeployTargets(withInstances, { serverId: 1 }).map((item) => item.id), [1, 3, 2]);
  assert.deepEqual(filterDeployTargets(withInstances, { serverId: 1, nginxInstanceId: 12 }).map((item) => item.id), [3]);
  assert.deepEqual(filterDeployTargets(withInstances, { nginxInstanceId: 11 }).map((item) => item.id), [1]);
  assert.equal(filterDeployTargets(withInstances, { nginxInstanceId: 0 }), withInstances);
});
