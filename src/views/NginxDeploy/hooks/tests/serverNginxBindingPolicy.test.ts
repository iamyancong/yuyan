import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeployServer, DeployTarget, NginxInstance } from '../../../../api/deploy.ts';
import type { RuntimeAwareDeployTarget } from '../../types.ts';
import { calcServerNginxSummary } from '../../components/DeployServerNginxCell/constant.ts';
import { getSiteReadinessStatus } from '../../components/DeployTargetSiteSummaryCell/constant.ts';
import { calcStep2Diagnostic } from '../../components/DeployHero/constant.ts';
import { checkSiteConflict } from '../siteConflictPolicy.ts';

test('calcServerNginxSummary: 空服务器与无实例场景解析', () => {
  assert.equal(calcServerNginxSummary(null).health, 'empty');
  assert.equal(calcServerNginxSummary(undefined).health, 'empty');
  assert.equal(calcServerNginxSummary({ id: 1, name: 's1' } as unknown as DeployServer).health, 'empty');
  assert.equal(calcServerNginxSummary({ id: 1, name: 's1', nginxInstances: [] } as unknown as DeployServer).hasInstance, false);
});

test('calcServerNginxSummary: 实例类型计数与最差健康状态优先级', () => {
  const server: DeployServer = {
    id: 1,
    name: 'prod-01',
    nginxInstances: [
      { id: 101, instanceType: 'managed', status: 'running', initializedAt: '2026-01-01' } as unknown as NginxInstance,
      { id: 102, instanceType: 'external', status: 'stopped', initializedAt: '2026-01-01' } as unknown as NginxInstance,
    ],
  } as unknown as DeployServer;

  const res = calcServerNginxSummary(server);
  assert.equal(res.totalCount, 2);
  assert.equal(res.managedCount, 1);
  assert.equal(res.externalCount, 1);
  assert.equal(res.health, 'stopped'); // stopped 优先于 running

  // 增加 error 状态实例
  server.nginxInstances.push({ id: 103, instanceType: 'external', status: 'error', initializedAt: '2026-01-01' } as unknown as NginxInstance);
  assert.equal(calcServerNginxSummary(server).health, 'error'); // error 最优先
});

test('getSiteReadinessStatus: 前端部署目标就绪度四态判定', () => {
  // 1. 未关联实例
  const unlinkedTarget = { id: 1, nginxInstanceId: 0, deployRoot: '/opt/yuyan/html' } as unknown as DeployTarget;
  assert.equal(getSiteReadinessStatus(unlinkedTarget).status, 'unlinked');

  // 2. 配置未完整（缺少域名或端口）
  const incompleteTarget = {
    id: 2,
    nginxInstanceId: 10,
    nginxInstanceName: 'managed-1',
    nginxServerName: '',
    listenPort: 8080,
    deployRoot: '/opt/yuyan/html',
  } as unknown as DeployTarget;
  assert.equal(getSiteReadinessStatus(incompleteTarget).status, 'incomplete');

  // 3. 配置完整且可访问
  const accessibleTarget = {
    id: 3,
    nginxInstanceId: 10,
    nginxInstanceName: 'managed-1',
    nginxServerName: 'app.example.com',
    listenPort: 8080,
    deployRoot: '/opt/yuyan/html',
    visitUrl: 'http://app.example.com:8080',
  } as unknown as DeployTarget;
  const accessibleMeta = getSiteReadinessStatus(accessibleTarget);
  assert.equal(accessibleMeta.status, 'accessible');
  assert.equal(accessibleMeta.isAccessible, true);
  assert.equal(accessibleMeta.domainText, 'app.example.com');
  assert.equal(accessibleMeta.destinationText, '/opt/yuyan/html:8080');

  // 4. 配置完整待发布（无 visitUrl）
  const readyTarget = {
    id: 4,
    nginxInstanceId: 10,
    nginxInstanceName: 'managed-1',
    nginxServerName: 'app.example.com',
    listenPort: 8080,
    deployRoot: '/opt/yuyan/html',
    visitUrl: '',
  } as unknown as DeployTarget;
  assert.equal(getSiteReadinessStatus(readyTarget).status, 'ready');
});

test('calcStep2Diagnostic: Hero Checklist 流程状态机诊断', () => {
  // 1. 无服务器
  assert.equal(calcStep2Diagnostic([], []).state, 'no_server');

  // 2. 有服务器但无任何实例
  const serversWithoutInstances: DeployServer[] = [
    { id: 1, name: 's1', nginxInstances: [] } as unknown as DeployServer,
  ];
  assert.equal(calcStep2Diagnostic(serversWithoutInstances, []).state, 'no_instance');

  // 3. 有实例，但前端部署目标未关联实例
  const readyServers: DeployServer[] = [
    {
      id: 1,
      name: 's1',
      nginxInstances: [{ id: 101, status: 'running' } as unknown as NginxInstance],
    } as unknown as DeployServer,
  ];
  const targetsWithUnlinked: RuntimeAwareDeployTarget[] = [
    { id: 1, projectType: 'frontend', nginxInstanceId: 0 } as unknown as RuntimeAwareDeployTarget,
  ];
  const diag3 = calcStep2Diagnostic(readyServers, targetsWithUnlinked);
  assert.equal(diag3.state, 'unlinked_targets');
  assert.equal(diag3.tagColor, 'error');

  // 4. 全部就绪
  const targetsAllReady: RuntimeAwareDeployTarget[] = [
    { id: 1, projectType: 'frontend', nginxInstanceId: 101 } as unknown as RuntimeAwareDeployTarget,
    { id: 2, projectType: 'backend', nginxInstanceId: 0 } as unknown as RuntimeAwareDeployTarget, // 后端目标不需关联 Nginx
  ];
  const diag4 = calcStep2Diagnostic(readyServers, targetsAllReady);
  assert.equal(diag4.state, 'healthy');
  assert.equal(diag4.tagColor, 'success');
});

test('checkSiteConflict: Coolify 风格跨目标域名与监听端口防碰撞判定', () => {
  const allTargets: DeployTarget[] = [
    {
      id: 1,
      projectName: 'yuyan-web',
      defaultBranch: 'main',
      serverId: 1,
      nginxInstanceId: 101,
      nginxServerName: 'app.example.com',
      listenPort: 8080,
      projectType: 'frontend',
    } as unknown as DeployTarget,
    {
      id: 2,
      projectName: 'ops-admin',
      defaultBranch: 'develop',
      serverId: 1,
      nginxInstanceId: 101,
      nginxServerName: 'admin.example.com',
      listenPort: 8081,
      projectType: 'frontend',
    } as unknown as DeployTarget,
  ];

  // 1. 同实例、同端口、同域名命中冲突
  const conflictDraft = {
    id: 3,
    serverId: 1,
    nginxInstanceId: 101,
    nginxServerName: 'app.example.com',
    listenPort: 8080,
    projectType: 'frontend',
  };
  const res1 = checkSiteConflict(conflictDraft, allTargets);
  assert.equal(res1.hasConflict, true);
  assert.equal(res1.conflictedTarget?.id, 1);

  // 2. 自身编辑时不自相冲突
  const selfEditDraft = {
    id: 1,
    serverId: 1,
    nginxInstanceId: 101,
    nginxServerName: 'app.example.com',
    listenPort: 8080,
    projectType: 'frontend',
  };
  assert.equal(checkSiteConflict(selfEditDraft, allTargets).hasConflict, false);

  // 3. 不同端口或不同实例不冲突
  const diffPortDraft = {
    id: 4,
    serverId: 1,
    nginxInstanceId: 101,
    nginxServerName: 'app.example.com',
    listenPort: 8082,
    projectType: 'frontend',
  };
  assert.equal(checkSiteConflict(diffPortDraft, allTargets).hasConflict, false);

  const diffServerDraft = {
    id: 5,
    serverId: 2,
    nginxInstanceId: 101,
    nginxServerName: 'app.example.com',
    listenPort: 8080,
    projectType: 'frontend',
  };
  assert.equal(checkSiteConflict(diffServerDraft, allTargets).hasConflict, false);

  // 4. 通配域名 '_' 或 'localhost' 跳过冲突提示
  const wildcardDraft = {
    id: 6,
    serverId: 1,
    nginxInstanceId: 101,
    nginxServerName: '_',
    listenPort: 8080,
    projectType: 'frontend',
  };
  assert.equal(checkSiteConflict(wildcardDraft, allTargets).hasConflict, false);
});
