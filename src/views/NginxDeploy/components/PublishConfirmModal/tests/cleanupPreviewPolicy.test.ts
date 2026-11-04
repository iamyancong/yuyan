import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSharedDeployRoot,
  groupCleanupPreviewItems,
  canStartPublishWithCleanup,
  resolveDefaultUploadStrategy,
} from '../cleanupPreviewPolicy.ts';

test('isSharedDeployRoot: 准确识别主应用、托管实例根及嵌套子应用场景', () => {
  // 1. 项目名称或描述包含“主应用”
  assert.equal(
    isSharedDeployRoot({
      target: { projectName: '财务协同主应用', deployRoot: '/data/web/main' },
    }),
    true
  );
  assert.equal(
    isSharedDeployRoot({
      target: { projectName: 'portal', projectDescription: '核心门户（主应用）', deployRoot: '/data/web/portal' },
    }),
    true
  );

  // 2. 等于所选托管 Nginx 实例的 htmlRoot
  assert.equal(
    isSharedDeployRoot({
      target: { projectName: 'custom-web', deployRoot: '/data/custom/nginx/html' },
      nginxInstance: { instanceType: 'managed', htmlRoot: '/data/custom/nginx/html' },
    }),
    true
  );

  // 3. 同服务器下有嵌套在当前部署目录内的其他部署目标
  assert.equal(
    isSharedDeployRoot({
      target: { id: 1, projectName: 'parent-app', deployRoot: '/data/www/base' },
      allServerTargets: [
        { id: 2, projectName: 'sub-app-1', deployRoot: '/data/www/base/sub1' },
        { id: 3, projectName: 'other-app', deployRoot: '/data/www/other' },
      ],
    }),
    true
  );

  // 4. 独立专属部署目录，无嵌套子应用
  assert.equal(
    isSharedDeployRoot({
      target: { id: 10, projectName: 'standalone-app', deployRoot: '/data/apps/unique-app' },
      allServerTargets: [
        { id: 11, projectName: 'another-app', deployRoot: '/data/apps/another-app' },
      ],
    }),
    false
  );
});

test('groupCleanupPreviewItems: 准确整理三组分类条目并安全容错', () => {
  // 1. 正常数据整理
  const grouped = groupCleanupPreviewItems({
    realRoot: '/data/www/html',
    configuredRoot: '/data/www/html',
    riskLevel: 'ok',
    riskReason: '',
    manifestFound: true,
    willReplaceOrClean: ['index.html', 'assets', 'favicon.ico'],
    protected: [
      { name: 'sub-risk', source: 'nested', reason: '已登记子应用: sub-risk' },
      { name: 'keep.txt', source: 'manual', reason: '手填保留: keep.txt' },
    ],
    reserved: ['.yuyan-backups', '.yuyan-manifests'],
    unknown: ['manual.pdf', 'temp.zip'],
    isSharedRoot: true,
  });

  assert.deepEqual(grouped.replaceOrCleanItems, ['assets', 'favicon.ico', 'index.html']);
  assert.equal(grouped.protectedItems.length, 2);
  assert.equal(grouped.protectedItems[0].name, 'sub-risk');
  assert.equal(grouped.protectedItems[0].source, 'nested');
  assert.equal(grouped.protectedItems[0].reason, '已登记子应用: sub-risk');
  assert.deepEqual(grouped.unknownItems, ['manual.pdf', 'temp.zip']);
  assert.deepEqual(grouped.reservedItems, ['.yuyan-backups', '.yuyan-manifests']);

  // 2. 空对象或 null 容错
  const empty = groupCleanupPreviewItems(null);
  assert.deepEqual(empty.replaceOrCleanItems, []);
  assert.deepEqual(empty.protectedItems, []);
  assert.deepEqual(empty.unknownItems, []);
  assert.deepEqual(empty.reservedItems, []);
});

test('canStartPublishWithCleanup: 严格遵循共享根二次确认与安全门禁', () => {
  // 1. 风险为 block 时硬阻断
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: false,
      cleanReplaceConfirmed: true,
      hasSelectedExtra: false,
      previewLoading: false,
      previewError: false,
      riskLevel: 'block',
    }),
    false
  );

  // 2. 覆盖上传保留旧资源模式（!isCleanReplace）不阻断
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: false,
      isSharedRoot: true,
      cleanReplaceConfirmed: false,
      hasSelectedExtra: false,
      previewLoading: false,
      previewError: false,
      riskLevel: 'ok',
    }),
    true
  );

  // 3. 预览加载中不可开始
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: false,
      cleanReplaceConfirmed: false,
      hasSelectedExtra: false,
      previewLoading: true,
      previewError: false,
    }),
    false
  );

  // 4. 预览失败处理：共享根阻断，非共享根放行
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: true,
      cleanReplaceConfirmed: false,
      hasSelectedExtra: false,
      previewLoading: false,
      previewError: true,
    }),
    false
  );
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: false,
      cleanReplaceConfirmed: false,
      hasSelectedExtra: false,
      previewLoading: false,
      previewError: true,
    }),
    true
  );

  // 5. 共享根未勾选二次确认阻断，勾选后放行
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: true,
      cleanReplaceConfirmed: false,
      hasSelectedExtra: false,
      previewLoading: false,
      previewError: false,
    }),
    false
  );
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: true,
      cleanReplaceConfirmed: true,
      hasSelectedExtra: false,
      previewLoading: false,
      previewError: false,
    }),
    true
  );

  // 6. 非共享根但勾选了额外清理项：必须二次确认
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: false,
      cleanReplaceConfirmed: false,
      hasSelectedExtra: true,
      previewLoading: false,
      previewError: false,
    }),
    false
  );
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: false,
      cleanReplaceConfirmed: true,
      hasSelectedExtra: true,
      previewLoading: false,
      previewError: false,
    }),
    true
  );

  // 7. 普通非共享根且无额外项直接放行
  assert.equal(
    canStartPublishWithCleanup({
      isCleanReplace: true,
      isSharedRoot: false,
      cleanReplaceConfirmed: false,
      hasSelectedExtra: false,
      previewLoading: false,
      previewError: false,
    }),
    true
  );
});

test('resolveDefaultUploadStrategy: 共享根默认推荐覆盖保留旧资源', () => {
  // 1. 新建共享根目标默认推荐 overlayKeepAssets
  const sharedStrategy = resolveDefaultUploadStrategy({
    target: { projectName: '运营协同主应用', deployRoot: '/opt/yuyan/html' },
    isNewTarget: true,
  });
  assert.equal(sharedStrategy, 'overlayKeepAssets');

  // 2. 编辑已有目标保留原有策略（即使原来是 cleanReplace）
  const editStrategy = resolveDefaultUploadStrategy({
    target: { projectName: '运营协同主应用', deployRoot: '/opt/yuyan/html', uploadStrategy: 'cleanReplace' },
    isNewTarget: false,
  });
  assert.equal(editStrategy, 'cleanReplace');
});
