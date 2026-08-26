import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeployRootSelectOptions,
  createRecommendedDeployRoot,
  normalizeDeployRoot,
  shouldWriteDeployRootRecommendation,
} from '../deployRootRecommendationPolicy.ts';

test('主应用使用服务器根目录，微应用追加安全目录名', () => {
  assert.equal(normalizeDeployRoot(' /opt//yuyan/html/ '), '/opt/yuyan/html');
  assert.equal(
    createRecommendedDeployRoot('/opt/yuyan/html', {
      status: 'resolved',
      kind: 'main',
      mode: 'production',
      reason: '主应用',
    }),
    '/opt/yuyan/html'
  );
  assert.equal(
    createRecommendedDeployRoot('/opt/yuyan/html/', {
      status: 'resolved',
      kind: 'micro',
      appName: 'outsourced',
      mode: 'production',
      reason: '微应用',
    }),
    '/opt/yuyan/html/outsourced'
  );
});

test('推荐目录不存在时标记发布时创建，被占用时禁用', () => {
  const detection = {
    status: 'resolved' as const,
    kind: 'micro' as const,
    appName: 'outsourced',
    mode: 'production',
    reason: '微应用',
  };
  const baseResult = {
    configuredRoot: '/opt/yuyan/html',
    nginxInstanceId: 1,
    truncated: false,
    items: [],
  };
  const creatable = createDeployRootSelectOptions(baseResult, '/opt/yuyan/html/outsourced', detection)[0];
  const occupied = createDeployRootSelectOptions(
    {
      ...baseResult,
      items: [{
        kind: 'application' as const,
        name: 'outsourced',
        path: '/opt/yuyan/html/outsourced',
        exists: false,
        hasIndexHtml: false,
        occupied: true,
        occupiedBy: [{ targetId: 1, projectName: '委外', branch: 'dev', envName: '测试' }],
      }],
    },
    '/opt/yuyan/html/outsourced',
    detection
  )[0];

  assert.equal(creatable.description.includes('发布时创建'), true);
  assert.equal(creatable.disabled, false);
  assert.equal(occupied.section, '已占用');
  assert.equal(occupied.disabled, true);
});

test('配置根目录暂不可读取时仍保留为可选路径且不伪报已存在', () => {
  const options = createDeployRootSelectOptions(
    {
      configuredRoot: '/home/app/frontend/html',
      nginxInstanceId: 3,
      truncated: false,
      scanWarning: '目录不存在或无权限',
      items: [{
        kind: 'root',
        name: 'html',
        path: '/home/app/frontend/html',
        exists: false,
        hasIndexHtml: false,
        occupied: false,
        occupiedBy: [],
      }],
    },
    '/home/app/frontend/html',
    { status: 'resolved', kind: 'main', mode: 'production', reason: '主应用' }
  );

  assert.equal(options[0].disabled, false);
  assert.match(options[0].description, /按已配置路径使用/);
});

test('旧响应、手动输入、首次编辑和占用路径都禁止自动覆盖', () => {
  const baseContext = {
    responseSequence: 2,
    activeSequence: 2,
    autoManaged: true,
    preserveInitialEditValue: false,
    recommendation: '/opt/yuyan/html/outsourced',
    recommendationDisabled: false,
  };
  assert.equal(shouldWriteDeployRootRecommendation(baseContext), true);
  assert.equal(shouldWriteDeployRootRecommendation({ ...baseContext, responseSequence: 1 }), false);
  assert.equal(shouldWriteDeployRootRecommendation({ ...baseContext, autoManaged: false }), false);
  assert.equal(shouldWriteDeployRootRecommendation({ ...baseContext, preserveInitialEditValue: true }), false);
  assert.equal(shouldWriteDeployRootRecommendation({ ...baseContext, recommendationDisabled: true }), false);
});
