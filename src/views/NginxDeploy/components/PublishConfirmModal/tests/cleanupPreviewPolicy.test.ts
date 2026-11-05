import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSharedDeployRoot,
  groupCleanupPreviewItems,
  canStartPublishWithCleanup,
  resolveDefaultUploadStrategy,
  formatMicroDeployCleanupSummary,
  formatSharedRootCleanupSummary,
  formatCleanupSecondaryConfirmText,
  formatShortCleanupSummary,
  formatCleanupSummaryTooltip,
  getPublishConfirmPopupTitle,
  formatPublishConfirmPopupBody,
  needsPublishConfirmation,
  canDirectlyPublish,
  resolvePublishGate,
  buildPublishStartPayload,
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

test('formatMicroDeployCleanupSummary: 准确拼接微应用清空后替换摘要文案', () => {
  // 1. 标准场景：7 项旧文件
  assert.equal(
    formatMicroDeployCleanupSummary(7),
    '清空后替换：将替换 7 项旧文件，其他内容不受影响'
  );

  // 2. 0 项边界：无待替换旧文件
  assert.equal(
    formatMicroDeployCleanupSummary(0),
    '清空后替换：暂无待替换旧文件，其他内容不受影响'
  );

  // 3. 负数/非法参数容错
  assert.equal(
    formatMicroDeployCleanupSummary(-1),
    '清空后替换：暂无待替换旧文件，其他内容不受影响'
  );
});

test('formatSharedRootCleanupSummary: 动态拼装共享根文案并按规则省略 0 项', () => {
  // 1. 标准场景：11 待替换、4 受保护子应用、5 未识别其他目录
  assert.equal(
    formatSharedRootCleanupSummary({
      replaceCount: 11,
      nestedCount: 4,
      unknownCount: 5,
    }),
    '共享根目录：只替换 11 项雨燕旧文件，保留 4 个子应用和 5 个其他目录'
  );

  // 2. 无未识别项（unknownCount = 0 省略其他目录）
  assert.equal(
    formatSharedRootCleanupSummary({
      replaceCount: 11,
      nestedCount: 4,
      unknownCount: 0,
    }),
    '共享根目录：只替换 11 项雨燕旧文件，保留 4 个子应用'
  );

  // 3. 无子应用（nestedCount = 0 省略子应用）
  assert.equal(
    formatSharedRootCleanupSummary({
      replaceCount: 11,
      nestedCount: 0,
      unknownCount: 5,
    }),
    '共享根目录：只替换 11 项雨燕旧文件，保留 5 个其他目录'
  );

  // 4. 无待替换雨燕旧文件（replaceCount = 0 省略替换部分）
  assert.equal(
    formatSharedRootCleanupSummary({
      replaceCount: 0,
      nestedCount: 4,
      unknownCount: 5,
    }),
    '共享根目录：保留 4 个子应用和 5 个其他目录'
  );

  // 5. 仅有待替换旧文件（无子应用与未识别项）
  assert.equal(
    formatSharedRootCleanupSummary({
      replaceCount: 11,
      nestedCount: 0,
      unknownCount: 0,
    }),
    '共享根目录：只替换 11 项雨燕旧文件'
  );

  // 6. 包含手填保留项（3 种保留项连接）
  assert.equal(
    formatSharedRootCleanupSummary({
      replaceCount: 11,
      nestedCount: 4,
      manualCount: 2,
      unknownCount: 5,
    }),
    '共享根目录：只替换 11 项雨燕旧文件，保留 4 个子应用、2 个手填保留项 和 5 个其他目录'
  );

  // 7. 用户勾选了额外清理项
  assert.equal(
    formatSharedRootCleanupSummary({
      replaceCount: 11,
      nestedCount: 4,
      unknownCount: 5,
      extraCleanupCount: 2,
    }),
    '共享根目录：只替换 11 项雨燕旧文件，额外清理 2 项，保留 4 个子应用和 3 个其他目录'
  );

  // 8. 全部为 0 极端空情况
  assert.equal(
    formatSharedRootCleanupSummary({}),
    '共享根目录：无待替换或保留项'
  );
});

test('formatCleanupSecondaryConfirmText: 正确映射共享根及额外清理二次确认文案', () => {
  // 1. 共享根目录场景使用共享根文案
  assert.equal(
    formatCleanupSecondaryConfirmText({
      isSharedRoot: true,
      replaceCount: 11,
      nestedCount: 4,
      unknownCount: 5,
    }),
    '共享根目录：只替换 11 项雨燕旧文件，保留 4 个子应用和 5 个其他目录'
  );

  // 2. 非共享根微应用且勾选额外清理
  assert.equal(
    formatCleanupSecondaryConfirmText({
      isSharedRoot: false,
      extraCleanupCount: 3,
    }),
    '确认额外清理勾选的 3 项未识别文件'
  );

  // 3. 非共享根微应用未勾选额外清理兜底
  assert.equal(
    formatCleanupSecondaryConfirmText({
      isSharedRoot: false,
    }),
    '我已核对清理预览，确认执行清空后替换'
  );
});

test('formatShortCleanupSummary: 统一缩短格式为「清空后替换 · 替换 N 项」', () => {
  assert.equal(formatShortCleanupSummary(7), '清空后替换 · 替换 7 项');
  assert.equal(formatShortCleanupSummary(11), '清空后替换 · 替换 11 项');
  assert.equal(formatShortCleanupSummary(0), '清空后替换 · 替换 0 项');
  assert.equal(formatShortCleanupSummary(-2), '清空后替换 · 替换 0 项');
});

test('formatCleanupSummaryTooltip: 正确生成微应用与共享根场景的 ⓘ 说明', () => {
  // 1. 微应用场景
  assert.equal(
    formatCleanupSummaryTooltip({
      isSharedRoot: false,
      replaceCount: 7,
    }),
    '将替换 7 项雨燕旧文件，其他内容不受影响'
  );

  // 2. 共享根场景（动态保留说明，0 省略）
  assert.equal(
    formatCleanupSummaryTooltip({
      isSharedRoot: true,
      replaceCount: 11,
      nestedCount: 4,
      unknownCount: 5,
    }),
    '只替换 11 项雨燕旧文件，保留 4 个子应用和 5 个其他目录'
  );

  // 3. 共享根场景部分为 0
  assert.equal(
    formatCleanupSummaryTooltip({
      isSharedRoot: true,
      replaceCount: 11,
      nestedCount: 4,
      unknownCount: 0,
    }),
    '只替换 11 项雨燕旧文件，保留 4 个子应用'
  );
});

test('getPublishConfirmPopupTitle & formatPublishConfirmPopupBody: 准确推导气泡标题与正文', () => {
  // 1. 共享根气泡标题与正文
  assert.equal(
    getPublishConfirmPopupTitle({ isSharedRoot: true }),
    '共享根目录，确认清空发布？'
  );
  assert.equal(
    formatPublishConfirmPopupBody({
      isSharedRoot: true,
      replaceCount: 11,
      nestedCount: 4,
      unknownCount: 5,
    }),
    '只替换 11 项雨燕旧文件，保留 4 个子应用和 5 个其他目录'
  );

  // 2. 额外清理场景气泡标题与正文
  assert.equal(
    getPublishConfirmPopupTitle({ isSharedRoot: false, hasSelectedExtra: true }),
    '存在额外清理，确认清空发布？'
  );
  assert.equal(
    formatPublishConfirmPopupBody({
      isSharedRoot: false,
      extraCleanupCount: 2,
    }),
    '本次发布将额外清理勾选的 2 项未识别文件'
  );
});

test('needsPublishConfirmation & canDirectlyPublish: 判定是否需要气泡确认与能否直接发布', () => {
  // 1. 共享根且清空后替换：必须确认
  assert.equal(
    needsPublishConfirmation({ isCleanReplace: true, isSharedRoot: true, hasSelectedExtra: false }),
    true
  );
  assert.equal(
    canDirectlyPublish({ isCleanReplace: true, isSharedRoot: true, hasSelectedExtra: false }),
    false
  );

  // 2. 勾选额外清理：必须确认
  assert.equal(
    needsPublishConfirmation({ isCleanReplace: true, isSharedRoot: false, hasSelectedExtra: true }),
    true
  );
  assert.equal(
    canDirectlyPublish({ isCleanReplace: true, isSharedRoot: false, hasSelectedExtra: true }),
    false
  );

  // 3. 普通微应用无额外清理：直接发布，不弹气泡
  assert.equal(
    needsPublishConfirmation({ isCleanReplace: true, isSharedRoot: false, hasSelectedExtra: false }),
    false
  );
  assert.equal(
    canDirectlyPublish({ isCleanReplace: true, isSharedRoot: false, hasSelectedExtra: false }),
    true
  );

  // 4. 非清空后替换模式（如覆盖上传）：不弹气泡直接发布
  assert.equal(
    needsPublishConfirmation({ isCleanReplace: false, isSharedRoot: true, hasSelectedExtra: true }),
    false
  );
  assert.equal(
    canDirectlyPublish({ isCleanReplace: false, isSharedRoot: true, hasSelectedExtra: true }),
    true
  );
});

test('resolvePublishGate: 严格守门，确保未确认的共享根/额外清理不可绕过', () => {
  // 1. 共享根未确认：禁止直接发布，阻断并指示需确认
  const gate1 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: false,
    confirmed: false,
  });
  assert.equal(gate1.canPublish, false);
  assert.equal(gate1.needConfirm, true);

  // 2. 共享根在气泡中确认后：放行
  const gate2 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: false,
    confirmed: true,
  });
  assert.equal(gate2.canPublish, true);
  assert.equal(gate2.needConfirm, true);

  // 3. 普通微应用无额外清理：无需确认直接放行
  const gate3 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: false,
    hasSelectedExtra: false,
  });
  assert.equal(gate3.canPublish, true);
  assert.equal(gate3.needConfirm, false);

  // 4. 共享根 matchesConfirmed===true 且无额外清理：免确认放行直接发布
  const gate4 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: false,
    matchesConfirmed: true,
  });
  assert.equal(gate4.canPublish, true);
  assert.equal(gate4.needConfirm, false);

  // 5. 共享根 matchesConfirmed===true 但勾选了额外清理：必须确认
  const gate5 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: true,
    matchesConfirmed: true,
    confirmed: false,
  });
  assert.equal(gate5.canPublish, false);
  assert.equal(gate5.needConfirm, true);

  // 6. 共享根 matchesConfirmed===false：需要确认
  const gate6 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: false,
    matchesConfirmed: false,
    confirmed: false,
  });
  assert.equal(gate6.canPublish, false);
  assert.equal(gate6.needConfirm, true);
});

test('matchesConfirmed 摘要、Tooltip 与变化说明格式化', () => {
  // 1. 摘要文案
  assert.equal(
    formatShortCleanupSummary({ replaceCount: 11, matchesConfirmed: true }),
    '清空后替换 · 替换 11 项 · 与上次确认一致'
  );
  assert.equal(
    formatShortCleanupSummary({ replaceCount: 11, matchesConfirmed: false }),
    '清空后替换 · 替换 11 项'
  );

  // 2. Tooltip 一致时写上次确认人和时间
  assert.equal(
    formatCleanupSummaryTooltip({
      isSharedRoot: true,
      matchesConfirmed: true,
      lastConfirmedBy: '张三',
      lastConfirmedAt: '2026-11-05 10:00:00',
    }),
    '上次确认人：张三，确认时间：2026-11-05 10:00:00'
  );

  // 3. 气泡变化说明：新增未识别、受保护或减少项
  const bodyWithDiff = formatPublishConfirmPopupBody({
    isSharedRoot: true,
    replaceCount: 11,
    nestedCount: 4,
    unknownCount: 5,
    scopeDiff: {
      addedUnknown: ['x', 'y'],
      addedProtected: ['z'],
      removedItems: ['old.txt'],
      hasChanges: true,
    },
  });
  assert.equal(
    bodyWithDiff,
    '只替换 11 项雨燕旧文件，保留 4 个子应用和 5 个其他目录。和上次相比新增未识别：x、y，新增受保护：z，减少项：old.txt'
  );
});

test('buildPublishStartPayload: 纯函数组装发布参数，严格保证确认状态与指纹透传', () => {
  // 1. 未显式确认（免确认放行或普通点击）：cleanReplaceConfirmed 为 false，不带 confirmedFingerprint
  const unconfirmedPayload = buildPublishStartPayload({
    forceInstallDependencies: true,
    extraCleanupNames: ['a.txt'],
    scopeFingerprint: 'hash-abc',
    confirmed: false,
  });
  assert.deepEqual(unconfirmedPayload, {
    forceInstallDependencies: true,
    extraCleanupNames: ['a.txt'],
    cleanReplaceConfirmed: false,
    confirmedFingerprint: undefined,
  });

  // 2. 气泡中显式确认：cleanReplaceConfirmed 为 true，且附带 confirmedFingerprint
  const confirmedPayload = buildPublishStartPayload({
    forceInstallDependencies: false,
    extraCleanupNames: ['temp.log'],
    scopeFingerprint: 'hash-12345678',
    confirmed: true,
  });
  assert.deepEqual(confirmedPayload, {
    forceInstallDependencies: false,
    extraCleanupNames: ['temp.log'],
    cleanReplaceConfirmed: true,
    confirmedFingerprint: 'hash-12345678',
  });

  // 3. 容错处理：若 confirmed 但没有 scopeFingerprint，confirmedFingerprint 为 undefined
  const noFpPayload = buildPublishStartPayload({
    forceInstallDependencies: false,
    confirmed: true,
  });
  assert.deepEqual(noFpPayload, {
    forceInstallDependencies: false,
    extraCleanupNames: [],
    cleanReplaceConfirmed: true,
    confirmedFingerprint: undefined,
  });
});

test('resolvePublishGate: 覆盖全分支（一致/不一致/预览失败/额外清理/非共享根）', () => {
  // 分支 1：非共享根 + 无额外清理 → 直接放行
  const b1 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: false,
    hasSelectedExtra: false,
  });
  assert.deepEqual(b1, { canPublish: true, needConfirm: false });

  // 分支 2：非共享根 + 勾选额外清理 → 必须二次确认
  const b2 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: false,
    hasSelectedExtra: true,
    confirmed: false,
  });
  assert.deepEqual(b2, { canPublish: false, needConfirm: true });

  // 分支 3：共享根 + 预览一致（matchesConfirmed===true）+ 无额外清理 → 免确认直接放行
  const b3 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: false,
    matchesConfirmed: true,
  });
  assert.deepEqual(b3, { canPublish: true, needConfirm: false });

  // 分支 4：共享根 + 预览不一致（matchesConfirmed===false）→ 必须确认
  const b4 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: false,
    matchesConfirmed: false,
    confirmed: false,
  });
  assert.deepEqual(b4, { canPublish: false, needConfirm: true });

  // 分支 5：共享根 + 预览失败（matchesConfirmed 为 undefined）→ 必须确认
  const b5 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: false,
    matchesConfirmed: undefined,
    confirmed: false,
  });
  assert.deepEqual(b5, { canPublish: false, needConfirm: true });

  // 分支 6：共享根 + 预览一致（matchesConfirmed===true）但勾选额外清理 → 仍必须确认
  const b6 = resolvePublishGate({
    isCleanReplace: true,
    isSharedRoot: true,
    hasSelectedExtra: true,
    matchesConfirmed: true,
    confirmed: false,
  });
  assert.deepEqual(b6, { canPublish: false, needConfirm: true });

  // 分支 7：非清空后替换模式（isCleanReplace===false）→ 永远直接放行
  const b7 = resolvePublishGate({
    isCleanReplace: false,
    isSharedRoot: true,
    hasSelectedExtra: true,
  });
  assert.deepEqual(b7, { canPublish: true, needConfirm: false });
});


