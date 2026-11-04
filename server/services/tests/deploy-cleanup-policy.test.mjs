import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifactManifestFile, buildLocalTarExcludeArgs } from '../deploy-service.mjs';
import {
  normalizeDeployRootPath,
  classifyDeployRootRisk,
  manifestTopNames,
  computeCleanupPlan,
  isSharedDeployRoot,
  planRestore,
  filterManifestRelativeFiles,
  RESERVED_DEPLOY_ENTRIES,
} from '../deploy-cleanup-policy.mjs';

test('normalizeDeployRootPath: 路径规范化与合法性校验', () => {
  // 正常路径去重斜杠和去尾斜杠
  assert.equal(normalizeDeployRootPath('/'), '/');
  assert.equal(normalizeDeployRootPath('/opt'), '/opt');
  assert.equal(normalizeDeployRootPath('/opt/'), '/opt');
  assert.equal(normalizeDeployRootPath('//opt//yuyan/html/'), '/opt/yuyan/html');
  assert.equal(normalizeDeployRootPath('/opt/my app/site/'), '/opt/my app/site');
  assert.equal(normalizeDeployRootPath('  /opt/yuyan\\html/  '), '/opt/yuyan/html');

  // 非法路径直接抛错（拒绝自动解析 ..）
  assert.throws(() => normalizeDeployRootPath('/opt/yuyan/html/..'), /相对路径段/);
  assert.throws(() => normalizeDeployRootPath('/opt/./x'), /相对路径段/);
  assert.throws(() => normalizeDeployRootPath('../opt/yuyan'), /以 \/ 开头/);
  assert.throws(() => normalizeDeployRootPath('opt/yuyan'), /以 \/ 开头/);
  assert.throws(() => normalizeDeployRootPath(''), /不能为空/);
  assert.throws(() => normalizeDeployRootPath('/opt/yuyan\n/test'), /换行符或特殊控制字符/);
  assert.throws(() => normalizeDeployRootPath('/opt/yuyan\r/test'), /换行符或特殊控制字符/);
  assert.throws(() => normalizeDeployRootPath('/opt/yuyan\0/test'), /换行符或特殊控制字符/);
});

test('classifyDeployRootRisk: 严格的硬黑名单与软风险分级', () => {
  const nginxPaths = ['/opt/yuyan/nginx', '/opt/yuyan/nginx/conf', '/opt/yuyan/nginx/sites'];

  // 1. 系统核心硬黑名单 (block)
  assert.equal(classifyDeployRootRisk('/').level, 'block');
  assert.equal(classifyDeployRootRisk('/root').level, 'block');
  assert.equal(classifyDeployRootRisk('/root/sub').level, 'block');
  assert.equal(classifyDeployRootRisk('/home').level, 'block');
  assert.equal(classifyDeployRootRisk('/home/ubuntu').level, 'block');
  assert.equal(classifyDeployRootRisk('/home/a').level, 'block');
  assert.equal(classifyDeployRootRisk('/opt').level, 'block');
  assert.equal(classifyDeployRootRisk('/etc').level, 'block');
  assert.equal(classifyDeployRootRisk('/etc/nginx').level, 'block');
  assert.equal(classifyDeployRootRisk('/var').level, 'block');
  assert.equal(classifyDeployRootRisk('/var/lib').level, 'block');
  assert.equal(classifyDeployRootRisk('/var/lib/mysql').level, 'block');
  assert.equal(classifyDeployRootRisk('/var/www').level, 'block');
  assert.equal(classifyDeployRootRisk('/bin').level, 'block');
  assert.equal(classifyDeployRootRisk('/bin/test').level, 'block');
  assert.equal(classifyDeployRootRisk('/boot').level, 'block');
  assert.equal(classifyDeployRootRisk('/data').level, 'block');
  assert.equal(classifyDeployRootRisk('/srv').level, 'block');
  assert.equal(classifyDeployRootRisk('/mnt').level, 'block');

  // /usr 体系放宽与精细化
  assert.equal(classifyDeployRootRisk('/usr').level, 'block');
  assert.equal(classifyDeployRootRisk('/usr/local').level, 'block');
  assert.equal(classifyDeployRootRisk('/usr/local/bin').level, 'block');
  assert.equal(classifyDeployRootRisk('/usr/local/bin/my-app').level, 'block');
  assert.equal(classifyDeployRootRisk('/usr/local/nginx').level, 'warn');
  assert.equal(classifyDeployRootRisk('/usr/local/nginx/html').level, 'ok');
  assert.equal(classifyDeployRootRisk('/usr/local/nginx/html/sub').level, 'ok');
  assert.equal(classifyDeployRootRisk('/usr/share').level, 'block');
  assert.equal(classifyDeployRootRisk('/usr/share/nginx').level, 'block');
  assert.equal(classifyDeployRootRisk('/usr/share/nginx/html').level, 'ok');
  assert.equal(classifyDeployRootRisk('/usr/share/nginx/html/my-app').level, 'ok');
  assert.equal(classifyDeployRootRisk('/usr/share/doc').level, 'block');

  // 保留目录名阻断
  assert.equal(classifyDeployRootRisk('/opt/yuyan/html/.yuyan-backups').level, 'block');
  assert.equal(classifyDeployRootRisk('/opt/yuyan/html/.yuyan-manifests/sub').level, 'block');

  // Nginx 关键目录精细化拦截
  const nginxDetails = {
    nginxRoot: '/opt/yuyan/nginx',
    criticalDirs: ['/opt/yuyan/nginx/conf', '/opt/yuyan/nginx/sites'],
  };
  assert.equal(classifyDeployRootRisk('/opt/yuyan/nginx', { nginxPaths: nginxDetails }).level, 'block');
  assert.equal(classifyDeployRootRisk('/opt/yuyan/nginx/conf', { nginxPaths: nginxDetails }).level, 'block');
  assert.equal(classifyDeployRootRisk('/opt/yuyan/nginx/conf/vhost', { nginxPaths: nginxDetails }).level, 'block');
  assert.equal(classifyDeployRootRisk('/opt/yuyan/nginx/sbin', { nginxPaths: nginxDetails }).level, 'block');
  assert.equal(classifyDeployRootRisk('/opt/yuyan/nginx/logs', { nginxPaths: nginxDetails }).level, 'block');
  assert.equal(classifyDeployRootRisk('/opt/yuyan', { nginxPaths: nginxDetails }).level, 'block', 'Nginx 祖先目录必须 block');
  // nginxRoot 下的其他业务目录（如 html）允许
  assert.equal(classifyDeployRootRisk('/opt/yuyan/nginx/html', { nginxPaths: nginxDetails }).level, 'ok');
  assert.equal(classifyDeployRootRisk('/opt/yuyan/nginx/html/app1', { nginxPaths: nginxDetails }).level, 'ok');

  // 2. 软名单提示 (warn)
  assert.equal(classifyDeployRootRisk('/opt/yuyan').level, 'warn');
  assert.equal(classifyDeployRootRisk('/data/app').level, 'warn');
  assert.equal(classifyDeployRootRisk('/srv/web').level, 'warn');
  assert.equal(classifyDeployRootRisk('/mnt/disk').level, 'warn');
  assert.equal(classifyDeployRootRisk('/var/web').level, 'warn');
  assert.equal(classifyDeployRootRisk('/home/ubuntu/app').level, 'warn');
  assert.equal(classifyDeployRootRisk('/home/a/b').level, 'warn');

  // 3. 安全业务路径 (ok)
  assert.equal(classifyDeployRootRisk('/opt/yuyan/html').level, 'ok');
  assert.equal(classifyDeployRootRisk('/opt/yuyan/html/app1').level, 'ok');
  assert.equal(classifyDeployRootRisk('/data/apps/web/dist').level, 'ok');
});

test('manifestTopNames: 准确提取清单中的顶层文件或目录名', () => {
  const manifest = `
index.html
assets/main.123.js
assets/chunk.456.css
static/images/logo.png
config.json
/absolute/bad.txt
../hack.js
nested/../hack2.js
.
..
`;
  const tops = manifestTopNames(manifest);
  assert.deepEqual(tops, ['assets', 'config.json', 'index.html', 'static']);
});

test('computeCleanupPlan: 只清理雨燕证明发布过的项，未识别项默认保留', () => {
  // 场景 1：正常清空后替换，存在未登记子应用与手放压缩包
  const plan1 = computeCleanupPlan({
    existingNames: ['index.html', 'assets', 'sub-app1', 'unregistered-app', 'backup.tar.gz', '.yuyan-backups'],
    artifactTopNames: ['index.html', 'assets', 'favicon.ico'],
    manifestTopNames: ['index.html', 'assets', 'old-chunk.js'],
    protectedNames: ['sub-app1'],
    extraCleanupNames: [],
    mode: 'cleanReplace',
  });

  // deleteNames 只能是 (artifact ∪ manifest) ∩ existing - protected - reserved
  assert.deepEqual(plan1.deleteNames, ['assets', 'index.html']);
  assert.deepEqual(plan1.keptProtected, ['sub-app1']);
  assert.deepEqual(plan1.keptReserved, ['.yuyan-backups']);
  assert.deepEqual(plan1.keptUnknown, ['backup.tar.gz', 'unregistered-app']);
  assert.deepEqual(plan1.rejectedExtra, []);

  // 场景 2：用户在未识别项中主动勾选 extraCleanupNames
  const plan2 = computeCleanupPlan({
    existingNames: ['index.html', 'assets', 'unregistered-app', 'temp-file.log'],
    artifactTopNames: ['index.html', 'assets'],
    manifestTopNames: ['index.html', 'assets'],
    protectedNames: [],
    extraCleanupNames: ['temp-file.log', 'index.html', 'hacker/path', '../etc', 'not-exist'],
    mode: 'cleanReplace',
  });

  // temp-file.log 是未识别项，允许被加入清理
  // index.html 已经在产物中，不算未识别项 -> rejected
  // hacker/path 非法单段 -> rejected
  // not-exist 不在 existing 中 -> rejected
  assert.deepEqual(plan2.deleteNames, ['assets', 'index.html', 'temp-file.log']);
  assert.deepEqual(plan2.keptUnknown, ['unregistered-app']);
  assert.deepEqual(plan2.rejectedExtra, ['../etc', 'hacker/path', 'index.html', 'not-exist']);

  // 场景 3：无上次清单兜底（首次发布），只清理产物顶层 ∩ 已存在
  const plan3 = computeCleanupPlan({
    existingNames: ['index.html', 'assets', 'legacy-app', 'old.html'],
    artifactTopNames: ['index.html', 'assets'],
    manifestTopNames: [],
    protectedNames: [],
    extraCleanupNames: [],
    mode: 'cleanReplace',
  });
  assert.deepEqual(plan3.deleteNames, ['assets', 'index.html']);
  assert.deepEqual(plan3.keptUnknown, ['legacy-app', 'old.html']);
});

test('isSharedDeployRoot: 准确识别共享根目录场景', () => {
  // 1. 项目名称或描述包含“主应用”
  assert.equal(
    isSharedDeployRoot({
      target: { id: 1, projectName: '综合门户主应用', deployRoot: '/opt/yuyan/html' },
    }),
    true
  );
  assert.equal(
    isSharedDeployRoot({
      target: { id: 1, projectName: 'portal', projectDescription: '核心主应用', deployRoot: '/opt/yuyan/html' },
    }),
    true
  );

  // 2. deployRoot 等于所选托管 Nginx 实例的 htmlRoot
  assert.equal(
    isSharedDeployRoot({
      target: { id: 2, projectName: 'portal', deployRoot: '/opt/yuyan/html/' },
      nginxInstance: { instanceType: 'managed', htmlRoot: '/opt/yuyan/html' },
    }),
    true
  );

  // 3. 同服务器下有嵌套在当前部署目录内的其他部署目标
  assert.equal(
    isSharedDeployRoot({
      target: { id: 3, projectName: 'web-root', deployRoot: '/opt/yuyan/html' },
      allServerTargets: [
        { id: 3, deployRoot: '/opt/yuyan/html' },
        { id: 4, deployRoot: '/opt/yuyan/html/sub-app' },
      ],
    }),
    true
  );

  // 4. 普通独立目录非共享根
  assert.equal(
    isSharedDeployRoot({
      target: { id: 5, projectName: 'independent-app', deployRoot: '/opt/yuyan/html/independent-app' },
      allServerTargets: [
        { id: 5, deployRoot: '/opt/yuyan/html/independent-app' },
        { id: 6, deployRoot: '/opt/yuyan/html/other-app' },
      ],
      nginxInstance: { instanceType: 'managed', htmlRoot: '/opt/yuyan/html' },
    }),
    false
  );
});

test('planRestore: 新旧格式备份的恢复集合计算与受保护目录防御', () => {
  // 场景 1：新格式备份（有 .backup-names），严格按记录恢复，排除当前受保护项
  const plan1 = planRestore({
    backupKind: 'full',
    backupNames: ['index.html', 'assets', 'sub-registered-after'],
    existingNames: ['index.html', 'assets', 'sub-registered-after', 'unregistered'],
    protectedNames: ['sub-registered-after'], // 备份后才登记的子应用
    currentManifestTopNames: ['index.html', 'assets'],
    extraRemoveNames: [],
  });
  // sub-registered-after 被保护，绝不能被备份里的旧文件覆盖
  assert.deepEqual(plan1.restoreNames, ['assets', 'index.html']);
  // unregistered 未被纳入 remove，未登记目录完好
  assert.deepEqual(plan1.removeNames, ['assets', 'index.html']);
  assert.deepEqual(plan1.skippedOldBackupNames, []);

  // 场景 2：旧格式备份（无 .backup-names），有清单，未识别项跳过自动恢复
  const plan2 = planRestore({
    backupKind: 'full',
    backupNames: null,
    backupTopEntries: ['index.html', 'assets', 'old-unknown-file.txt', 'sub-app'],
    backupManifestTopNames: ['index.html', 'assets'],
    currentManifestTopNames: ['index.html'],
    existingNames: ['index.html', 'assets'],
    protectedNames: ['sub-app'],
  });
  assert.deepEqual(plan2.restoreNames, ['assets', 'index.html']);
  assert.deepEqual(plan2.skippedOldBackupNames, ['old-unknown-file.txt']);

  // 场景 3：旧格式备份无清单兜底（已有子目录保留进 skippedOldBackupNames，只恢复普通文件、hashedDirs 和当前不存在项）
  const plan3 = planRestore({
    backupKind: 'full',
    backupNames: null,
    backupTopEntries: ['index.html', 'assets', 'legacy.txt', 'unregistered-subapp'],
    backupDirs: ['assets', 'unregistered-subapp'],
    backupManifestTopNames: [],
    currentManifestTopNames: [],
    existingNames: ['index.html', 'assets', 'unregistered-subapp'],
    existingDirs: ['assets', 'unregistered-subapp'],
    protectedNames: [],
    hashedDirs: ['assets'],
  });
  // unregistered-subapp 作为已有目录必须保留，绝不覆盖回退，放进 skippedOldBackupNames
  assert.deepEqual(plan3.restoreNames, ['assets', 'index.html', 'legacy.txt']);
  assert.deepEqual(plan3.skippedOldBackupNames, ['unregistered-subapp']);
  assert.deepEqual(plan3.removeNames, ['assets', 'index.html']);
  assert.ok(plan3.warningMessage.includes('未找到清单文件'));

  // 场景 4：发布失败自动恢复（传入本次产物顶层名 extraRemoveNames）
  const plan4 = planRestore({
    backupKind: 'full',
    backupNames: ['index.html', 'assets'],
    existingNames: ['index.html', 'assets', 'new-failed-file.txt', 'other-kept'],
    protectedNames: [],
    currentManifestTopNames: [],
    extraRemoveNames: ['new-failed-file.txt'],
  });
  // new-failed-file.txt 必须被移除
  assert.deepEqual(plan4.removeNames, ['assets', 'index.html', 'new-failed-file.txt']);
  assert.deepEqual(plan4.restoreNames, ['assets', 'index.html']);

  // 场景 5：entry-only 恢复排除 hashedDirs（如 assets）不删除
  const plan5 = planRestore({
    backupKind: 'entry-only',
    backupNames: ['index.html'],
    existingNames: ['index.html', 'assets', 'other'],
    currentManifestTopNames: ['index.html', 'assets'],
    hashedDirs: ['assets'],
  });
  assert.deepEqual(plan5.removeNames, ['index.html']);
  assert.deepEqual(plan5.restoreNames, ['index.html']);

  // 场景 6：旧格式备份如果 restoreNames 为空且 removeNames 非空，必须抛错防御只删不恢复
  assert.throws(
    () => {
      planRestore({
        backupKind: 'full',
        backupNames: null,
        backupTopEntries: [],
        currentManifestTopNames: ['index.html'],
        existingNames: ['index.html'],
      });
    },
    { message: /旧格式备份未解析到待恢复条目，但计算出待清理条目/ }
  );

  // 场景 7：新格式备份（.backup-names 合法为空，如首次发布空目录），允许正常返回不抛错
  const plan7 = planRestore({
    backupKind: 'full',
    backupNames: [],
    currentManifestTopNames: [],
    existingNames: [],
  });
  assert.deepEqual(plan7.restoreNames, []);
  assert.deepEqual(plan7.removeNames, []);
});

test('filterManifestRelativeFiles: 严格排除受保护子目录与系统保留目录', () => {
  const files = [
    'index.html',
    'favicon.ico',
    'assets/app.12345678.js',
    'assets/chunk.abc.css',
    'subapp/index.html',
    'subapp/static/logo.png',
    '.yuyan-backups/release-1/index.html',
    '.yuyan-manifests/current.txt',
    'normal-dir/file.txt',
  ];
  const protectedSubDirs = ['subapp'];

  const filtered = filterManifestRelativeFiles(files, protectedSubDirs);
  assert.deepEqual(filtered, [
    'index.html',
    'favicon.ico',
    'assets/app.12345678.js',
    'assets/chunk.abc.css',
    'normal-dir/file.txt',
  ]);

  // 空值与边界校验
  assert.deepEqual(filterManifestRelativeFiles(null, []), []);
  assert.deepEqual(filterManifestRelativeFiles(['', '   ', '/abs/path.js'], []), []);
});

test('createArtifactManifestFile: 构建期间动态追加受保护子目录时，能够重写清单并自动排除新增保护项', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-manifest-test-'));
  try {
    const files = [
      'index.html',
      'assets/index.1234.js',
      'subapp-a/index.html',
      'subapp-b/index.html',
    ];
    const protectedDirs = ['subapp-a'];

    // 初始生成清单
    const manifestPath1 = await createArtifactManifestFile(tmpDir, 'rel-1', files, protectedDirs);
    const content1 = await fs.readFile(manifestPath1, 'utf8');
    assert.match(content1, /index\.html/);
    assert.match(content1, /assets\/index\.1234\.js/);
    assert.doesNotMatch(content1, /subapp-a/);
    assert.match(content1, /subapp-b/);

    // 构建期间新增保护目录 subapp-b，重新生成清单
    protectedDirs.push('subapp-b');
    const manifestPath2 = await createArtifactManifestFile(tmpDir, 'rel-1', files, protectedDirs);
    const content2 = await fs.readFile(manifestPath2, 'utf8');
    assert.match(content2, /index\.html/);
    assert.match(content2, /assets\/index\.1234\.js/);
    assert.doesNotMatch(content2, /subapp-a/);
    assert.doesNotMatch(content2, /subapp-b/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('buildLocalTarExcludeArgs: 原地追加受保护目录后，能够生成包含新增项的 tar --exclude 参数', () => {
  const protectedDirs = ['sub-existing'];
  const args1 = buildLocalTarExcludeArgs(protectedDirs, ['index.html']);
  assert.ok(args1.includes('--exclude=\'./sub-existing\''));
  assert.ok(args1.includes('--exclude=\'./sub-existing/*\''));
  assert.ok(args1.includes('--exclude=\'./index.html\''));
  assert.ok(!args1.includes('sub-dynamic'));

  // 模拟构建期间动态并入新增保护项
  protectedDirs.push('sub-dynamic');
  const args2 = buildLocalTarExcludeArgs(protectedDirs, ['index.html']);
  assert.ok(args2.includes('--exclude=\'./sub-existing\''));
  assert.ok(args2.includes('--exclude=\'./sub-dynamic\''));
  assert.ok(args2.includes('--exclude=\'./sub-dynamic/*\''));
  assert.ok(args2.includes('--exclude=\'./index.html\''));
});
