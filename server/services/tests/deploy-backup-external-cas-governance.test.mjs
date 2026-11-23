import test from 'node:test';
import assert from 'node:assert/strict';
import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildTargetStateSlug,
  normalizeHashedAssetDirsInput,
  parseExternalBackupPath,
  parseHashedAssetDirs,
  resolveDeployRetentionPolicy,
  resolveDeployStateLocation,
  toInlineStateLayout,
} from '../deploy-state-layout.mjs';
import {
  buildCasBackupDeployRootCommand,
  buildCasObjectPoolGcCommand,
  buildCasPreflightCheckRollbackCommand,
  buildCasRestoreDeployRootCommand,
  buildProbeStateRootCommand,
  buildPruneBackupsCommand,
  CAS_BACKUP_KINDS,
  CAS_INDEX_FILE_NAME,
  parseCasBackupOutput,
  parseCasGcOutput,
  parseProbeStateRootOutput,
  parsePruneBackupsOutput,
} from '../deploy-cas-backup.mjs';
import {
  assertSafeBackupEntryPath,
  buildCleanOrphanAssetsCommand,
  buildDeleteBackupEntriesCommand,
  buildInspectNginxStorageCommand,
  buildPreviewOrphanAssetsCommand,
  isLikelyHashedBuildAsset,
  parseDeleteBackupEntriesOutput,
  parseInspectNginxStorageOutput,
  parsePreviewOrphanAssetsOutput,
} from '../storage-governance-service.mjs';
import {
  buildArchiveTarCommand,
  buildBackupGcCronInstallCommand,
  renderRuntimeScript,
} from '../nginx-runtime-service.mjs';
import { planRestore } from '../deploy-cleanup-policy.mjs';
import {
  buildDetectBackupRestorePlanCommand,
  buildPruneRemoteArtifactManifestsCommand,
  parseDetectBackupRestorePlanOutput,
} from '../deploy-service.mjs';

const execAsync = promisify(exec);

/**
 * 在真实本地 Shell 中执行生成的命令，返回标准输出。
 * @param {string} command - 待执行的 Shell 命令
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function runShell(command) {
  return execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
}

test('deploy-state-layout: 托管 Nginx 平级外置推导、危险系统父目录降级与 slug 稳定性', () => {
  const managedInstance = {
    instanceType: 'managed',
    baseRoot: '/home/app/frontend',
    htmlRoot: '/home/app/frontend/html',
  };

  // 1. 微应用自动落到托管 Nginx 平级 .yuyan-state
  const microLayout = resolveDeployStateLocation({
    realRoot: '/home/app/frontend/html/entrusted-management/',
    nginxInstance: managedInstance,
  });
  assert.equal(microLayout.mode, 'external');
  assert.equal(microLayout.source, 'managed-nginx-sibling');
  assert.equal(microLayout.stateRoot, '/home/app/frontend/.yuyan-state');
  assert.equal(microLayout.objectsDir, '/home/app/frontend/.yuyan-state/objects');
  assert.match(microLayout.slug, /^entrusted-management-[a-f0-9]{12}$/);
  assert.equal(microLayout.backupRoot, `/home/app/frontend/.yuyan-state/targets/${microLayout.slug}/backups`);
  assert.equal(microLayout.manifestDir, `/home/app/frontend/.yuyan-state/targets/${microLayout.slug}/manifests`);

  // 2. 主应用在共享根 html/ 与子应用互不碰撞，但共享同一 objectsDir
  const mainLayout = resolveDeployStateLocation({
    realRoot: '/home/app/frontend/html',
    nginxInstance: managedInstance,
  });
  assert.equal(mainLayout.mode, 'external');
  assert.equal(mainLayout.objectsDir, microLayout.objectsDir);
  assert.notEqual(mainLayout.slug, microLayout.slug);

  // 3. 反推外置备份绝对路径
  const parsedExt = parseExternalBackupPath(`${microLayout.backupRoot}/20261123160000`);
  assert.equal(parsedExt.isExternal, true);
  assert.equal(parsedExt.stateRoot, '/home/app/frontend/.yuyan-state');
  assert.equal(parsedExt.objectsDir, '/home/app/frontend/.yuyan-state/objects');
  assert.equal(parseExternalBackupPath('/home/app/frontend/html/app/.yuyan-backups/2026').isExternal, false);

  // 4. 非托管常见 html 目录启发式外置到 html 平级（不在 html 内部）
  const heuristic = resolveDeployStateLocation({
    realRoot: '/data/portal/html/sub-app',
  });
  assert.equal(heuristic.mode, 'external');
  assert.equal(heuristic.stateRoot, '/data/portal/.yuyan-state');

  // 5. 危险一级系统父目录（/opt/my-app 的父目录是 /opt）必须安全降级为 inline，不污染 /opt
  const unsafeParent = resolveDeployStateLocation({
    realRoot: '/opt/my-app',
  });
  assert.equal(unsafeParent.mode, 'inline');
  assert.equal(unsafeParent.backupRoot, '/opt/my-app/.yuyan-backups');

  // 6. 特殊字符目录名生成安全 slug
  const weirdSlug = buildTargetStateSlug('/data/apps/html/..微应用 App#1/');
  assert.match(weirdSlug, /^[a-zA-Z0-9][a-zA-Z0-9._-]*-[a-f0-9]{12}$/);

  // 7. 显式降级保留 legacy 路径
  const downgraded = toInlineStateLayout(microLayout, 'write_denied');
  assert.equal(downgraded.mode, 'inline');
  assert.equal(downgraded.backupRoot, '/home/app/frontend/html/entrusted-management/.yuyan-backups');
});

test('deploy-state-layout: 三维保留策略与带哈希目录边界校验', () => {
  const defaultOverlay = resolveDeployRetentionPolicy({ uploadStrategy: 'overlayKeepAssets' });
  assert.equal(defaultOverlay.backupKeepCount, 6);
  assert.equal(defaultOverlay.manifestKeepCount, 6);
  assert.equal(defaultOverlay.backupMaxSizeMb, 200);
  assert.equal(defaultOverlay.backupTtlDays, 14);
  assert.deepEqual(defaultOverlay.hashedAssetDirs, ['assets']);

  const defaultClean = resolveDeployRetentionPolicy({ uploadStrategy: 'cleanReplace' });
  assert.equal(defaultClean.backupKeepCount, 3);
  assert.equal(defaultClean.manifestKeepCount, 3);
  assert.equal(defaultClean.backupMaxSizeMb, 200);
  assert.equal(defaultClean.backupTtlDays, 14);

  // 0 必须被保留为“不限”，不能当 falsy 回退默认值
  const unlimited = resolveDeployRetentionPolicy({
    uploadStrategy: 'cleanReplace',
    backupKeepCount: 4,
    backupMaxSizeMb: 0,
    backupTtlDays: 0,
    hashedAssetDirs: 'static, chunks, assets',
  });
  assert.equal(unlimited.backupKeepCount, 4);
  assert.equal(unlimited.backupMaxSizeMb, 0);
  assert.equal(unlimited.backupTtlDays, 0);
  assert.deepEqual(unlimited.hashedAssetDirs, ['assets', 'static', 'chunks']);

  // 非法目录名拦截
  assert.throws(() => normalizeHashedAssetDirsInput('assets,../etc'), /不合法/);
  assert.throws(() => normalizeHashedAssetDirsInput('.yuyan-backups'), /不合法/);
  assert.equal(normalizeHashedAssetDirsInput('static， chunks, static'), 'static,chunks');
  assert.deepEqual(parseHashedAssetDirs('["assets","static","../bad"]'), ['assets', 'static']);
});

test('真实 Shell 集成：外置 CAS 跨版本与跨应用去重、免疫原地覆写污染、含空格/空目录/软链完整回滚', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-cas-e2e-'));
  try {
    const baseRoot = path.join(tmpDir, 'frontend');
    const htmlRoot = path.join(baseRoot, 'html');
    const appA = path.join(htmlRoot, 'app-a');
    const appB = path.join(htmlRoot, 'app-b');
    await fs.mkdir(path.join(appA, 'assets'), { recursive: true });
    await fs.mkdir(path.join(appA, 'iconfont'), { recursive: true });
    await fs.mkdir(path.join(appA, 'empty-folder'), { recursive: true });
    await fs.mkdir(path.join(appA, 'protected-child'), { recursive: true });
    await fs.mkdir(path.join(appB, 'iconfont'), { recursive: true });

    const sharedBigFont = Buffer.alloc(64 * 1024, 0x41);
    await fs.writeFile(path.join(appA, 'index.html'), '<html>v1</html>', 'utf8');
    await fs.writeFile(path.join(appA, 'my notes.txt'), 'space filename v1', 'utf8');
    await fs.writeFile(path.join(appA, 'iconfont', 'font.woff2'), sharedBigFont);
    await fs.writeFile(path.join(appA, 'assets', 'chunk-v1.js'), 'console.log("v1")', 'utf8');
    await fs.writeFile(path.join(appA, 'protected-child', 'keep.txt'), 'untouched', 'utf8');
    await fs.symlink('my notes.txt', path.join(appA, 'notes-link.txt'));

    // 微应用 B 放一份一模一样的 64KB 字体文件验证跨微应用全局去重
    await fs.writeFile(path.join(appB, 'index.html'), '<html>appB v1</html>', 'utf8');
    await fs.writeFile(path.join(appB, 'iconfont', 'font.woff2'), sharedBigFont);

    const managedInst = { instanceType: 'managed', baseRoot, htmlRoot };
    const layoutA = resolveDeployStateLocation({ realRoot: appA, nginxInstance: managedInst });
    const layoutB = resolveDeployStateLocation({ realRoot: appB, nginxInstance: managedInst });

    // 1. 探测外置仓可写性
    const probeRes = await runShell(buildProbeStateRootCommand(layoutA, false));
    const probe = parseProbeStateRootOutput(probeRes.stdout);
    assert.equal(probe.writable, true);
    assert.equal(probe.casSupported, true);
    assert.equal(probe.sameFs, true);

    await fs.mkdir(layoutA.manifestDir, { recursive: true });
    await fs.writeFile(path.join(layoutA.manifestDir, 'current.txt'), 'index.html\nmy notes.txt\niconfont/font.woff2\nassets/chunk-v1.js\n', 'utf8');

    // 2. 应用 A 第 1 次全量 CAS 备份
    const backupA1 = path.join(layoutA.backupRoot, '20261123100001');
    const b1Res = await runShell(
      buildCasBackupDeployRootCommand({
        rootPath: appA,
        backupPath: backupA1,
        objectsDir: layoutA.objectsDir,
        manifestDir: layoutA.manifestDir,
        legacyManifestDir: layoutA.legacyManifestDir,
        kind: CAS_BACKUP_KINDS.casFull,
        protectedSubDirs: ['protected-child'],
        namesToBackup: ['index.html', 'my notes.txt', 'iconfont', 'empty-folder', 'notes-link.txt', 'assets', 'protected-child'],
        meta: { releaseName: '20261123100001', branch: 'main', commitSha: 'aaa111' },
      })
    );
    const stat1 = parseCasBackupOutput(b1Res.stdout);
    assert.equal(stat1.ok, true);
    assert.equal(stat1.fileCount, 4);
    assert.ok(stat1.newObjectBytes >= 64 * 1024);
    // 验证 html/app-a 内没有生成 .yuyan-backups
    assert.equal(await fs.stat(path.join(appA, '.yuyan-backups')).catch(() => null), null);

    // 3. 模拟 sftp.fastPut 原地覆写 index.html 与 font.woff2，随后做第 2 次备份（只改 index.html）
    await fs.writeFile(path.join(appA, 'index.html'), '<html>v2-overwritten-in-place</html>', 'utf8');
    const backupA2 = path.join(layoutA.backupRoot, '20261123100002');
    const b2Res = await runShell(
      buildCasBackupDeployRootCommand({
        rootPath: appA,
        backupPath: backupA2,
        objectsDir: layoutA.objectsDir,
        manifestDir: layoutA.manifestDir,
        kind: CAS_BACKUP_KINDS.casFull,
        protectedSubDirs: ['protected-child'],
        namesToBackup: ['index.html', 'my notes.txt', 'iconfont', 'empty-folder', 'notes-link.txt', 'assets'],
        meta: { releaseName: '20261123100002', branch: 'main', commitSha: 'bbb222' },
      })
    );
    const stat2 = parseCasBackupOutput(b2Res.stdout);
    assert.equal(stat2.ok, true);
    assert.equal(stat2.dedupHits, 3, '除 index.html 外其余 3 个文件（含 64KB 字体）全部命中去重');
    assert.ok(stat2.newObjectBytes < 100, '新增对象仅几十字节');

    // 4. 应用 B 备份共享同一 objectsDir：64KB 字体 0 字节新增！
    const backupB1 = path.join(layoutB.backupRoot, '20261123100003');
    const bBRes = await runShell(
      buildCasBackupDeployRootCommand({
        rootPath: appB,
        backupPath: backupB1,
        objectsDir: layoutB.objectsDir,
        manifestDir: layoutB.manifestDir,
        kind: CAS_BACKUP_KINDS.casFull,
        namesToBackup: ['index.html', 'iconfont'],
      })
    );
    const statB = parseCasBackupOutput(bBRes.stdout);
    assert.equal(statB.dedupHits, 1, '应用 B 与应用 A 共享的 64KB 字体在对象池跨应用去重命中');
    assert.ok(statB.newObjectBytes < 100);

    // 5. 破坏运行态内容后执行预检 + 恢复 planning + CAS 恢复至 backupA1
    await fs.writeFile(path.join(appA, 'iconfont', 'font.woff2'), 'CORRUPTED-IN-PLACE', 'utf8');
    await fs.rm(path.join(appA, 'empty-folder'), { recursive: true });
    await fs.rm(path.join(appA, 'notes-link.txt'));

    const preflightRes = await runShell(
      buildCasPreflightCheckRollbackCommand({
        rootPath: appA,
        backupPath: backupA1,
        objectsDir: layoutA.objectsDir,
      })
    );
    assert.match(preflightRes.stdout, /kind=cas-full missing_count=0 missing_objects=0/);

    const detectRes = await runShell(
      buildDetectBackupRestorePlanCommand(appA, backupA1, false, { manifestDir: layoutA.manifestDir })
    );
    const restorePlan = parseDetectBackupRestorePlanOutput(detectRes.stdout, {
      rootPath: appA,
      backupPath: backupA1,
      protectedSubDirs: ['protected-child'],
    });
    assert.equal(restorePlan.kind, CAS_BACKUP_KINDS.casFull);
    assert.ok(!restorePlan.restoreNames.includes('protected-child'));

    await runShell(
      buildCasRestoreDeployRootCommand({
        rootPath: appA,
        backupPath: backupA1,
        objectsDir: layoutA.objectsDir,
        manifestDir: layoutA.manifestDir,
        protectedSubDirs: ['protected-child'],
        restoreNames: restorePlan.restoreNames,
        removeNames: restorePlan.removeNames,
      })
    );

    // 校验所有内容、空格文件名、空目录、符号链接、受保护目录及恢复后文件可写性
    assert.equal(await fs.readFile(path.join(appA, 'index.html'), 'utf8'), '<html>v1</html>');
    assert.equal(await fs.readFile(path.join(appA, 'my notes.txt'), 'utf8'), 'space filename v1');
    assert.deepEqual(await fs.readFile(path.join(appA, 'iconfont', 'font.woff2')), sharedBigFont);
    assert.equal((await fs.stat(path.join(appA, 'empty-folder'))).isDirectory(), true);
    assert.equal(await fs.readlink(path.join(appA, 'notes-link.txt')), 'my notes.txt');
    assert.equal(await fs.readFile(path.join(appA, 'protected-child', 'keep.txt'), 'utf8'), 'untouched');
    // 确认恢复后的文件可继续覆写（未继承对象池 0444 只读权限）
    await fs.writeFile(path.join(appA, 'index.html'), '<html>writable-after-restore</html>', 'utf8');

    // 6. 验证 cas-entry-only 的 planRestore 绝不把 assets 放进 removeNames
    const entryPlan = planRestore({
      backupKind: CAS_BACKUP_KINDS.casEntryOnly,
      backupNames: ['index.html', 'iconfont'],
      currentManifestTopNames: ['index.html', 'iconfont', 'assets'],
      existingNames: ['index.html', 'iconfont', 'assets'],
      hashedDirs: ['assets'],
    });
    assert.equal(entryPlan.kind, CAS_BACKUP_KINDS.casEntryOnly);
    assert.deepEqual(entryPlan.removeNames, ['iconfont', 'index.html']);
    assert.ok(!entryPlan.removeNames.includes('assets'), 'cas-entry-only 绝不能删除 assets');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('真实 Shell 集成：三维裁剪（Count + 去重物理容量 + TTL + 硬保底留 1 份）与 CAS 对象池 GC（含宽限期与写入中保护）', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-prune-gc-'));
  try {
    const stateRoot = path.join(tmpDir, '.yuyan-state');
    const objectsDir = path.join(stateRoot, 'objects');
    const targetBackups = path.join(stateRoot, 'targets', 'app-123456789012', 'backups');
    const legacyBackups = path.join(tmpDir, 'html', 'app', '.yuyan-backups');
    await fs.mkdir(targetBackups, { recursive: true });
    await fs.mkdir(legacyBackups, { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const makeObj = async (hexChar, sizeBytes, ageSeconds = 3600) => {
      const hash = hexChar.repeat(64);
      const shard = path.join(objectsDir, hash.slice(0, 2));
      await fs.mkdir(shard, { recursive: true });
      const objPath = path.join(shard, hash);
      await fs.writeFile(objPath, Buffer.alloc(sizeBytes, 0x61));
      const mtime = new Date((nowSec - ageSeconds) * 1000);
      await fs.utimes(objPath, mtime, mtime);
      return hash;
    };

    const hShared = await makeObj('a', 600 * 1024, 7200);
    const hV3 = await makeObj('b', 100 * 1024, 7200);
    const hV2 = await makeObj('c', 100 * 1024, 7200);
    const hOld = await makeObj('d', 100 * 1024, 7200);
    const hOrphanOld = await makeObj('e', 50 * 1024, 7200); // 超过 10 分钟宽限期，应被 GC 删
    const hOrphanFresh = await makeObj('f', 50 * 1024, 60); // 仅 1 分钟，应在宽限期内被跳过
    const hInflight = await makeObj('1', 50 * 1024, 7200); // 仅被 .cas-index.tsv.tmp 引用，应被保护

    const makeCasSnap = async (name, epoch, entries) => {
      const dir = path.join(targetBackups, name);
      await fs.mkdir(dir, { recursive: true });
      const lines = entries.map(([hash, size, rel]) => `f\t644\t${size}\t${hash}\t${rel}`).join('\n') + '\n';
      await fs.writeFile(path.join(dir, CAS_INDEX_FILE_NAME), lines, 'utf8');
      await fs.writeFile(path.join(dir, '.backup-meta.json'), JSON.stringify({ createdAtEpoch: epoch }), 'utf8');
      return dir;
    };

    // v3（最新）、v2（1 天前，与 v3 共用 600KB 对象）、v1（20 天前，超 14 天 TTL）
    const snapV3 = await makeCasSnap('20261123120000', nowSec - 100, [[hShared, 600 * 1024, 'font.woff2'], [hV3, 100 * 1024, 'v3.js']]);
    const snapV2 = await makeCasSnap('20261122120000', nowSec - 86400, [[hShared, 600 * 1024, 'font.woff2'], [hV2, 100 * 1024, 'v2.js']]);
    const snapV1Expired = await makeCasSnap('20261101120000', nowSec - 20 * 86400, [[hShared, 600 * 1024, 'font.woff2'], [hOld, 100 * 1024, 'old.js']]);

    // 旧内嵌大备份（25 天前）
    const legacyDir = path.join(legacyBackups, '20261025120000');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'big.bin'), Buffer.alloc(200 * 1024, 0x62));
    const oldTime = new Date((nowSec - 25 * 86400) * 1000);
    await fs.utimes(legacyDir, oldTime, oldTime);

    // 写入中快照（含 .cas-index.tsv.tmp.9999）
    const inflightDir = path.join(stateRoot, 'targets', 'other-app-abcdef123456', 'backups', '20261123120500');
    await fs.mkdir(inflightDir, { recursive: true });
    await fs.writeFile(path.join(inflightDir, `${CAS_INDEX_FILE_NAME}.tmp.9999`), `f\t644\t51200\t${hInflight}\tinflight.js\n`, 'utf8');

    // 执行三维裁剪：keep=6, maxSizeMb=1 (1MB，若按逻辑体积 v3+v2=1.4MB 会误删 v2；按去重物理体积仅 800KB <= 1MB，v2 应保留！), ttlDays=14
    const pruneRes = await runShell(
      buildPruneBackupsCommand({
        primaryBackupRoot: targetBackups,
        legacyBackupRoot: legacyBackups,
        keepCount: 6,
        maxSizeMb: 1,
        ttlDays: 14,
        minKeepCount: 1,
      })
    );
    const pruned = parsePruneBackupsOutput(pruneRes.stdout);
    assert.equal(pruned.deletedCount, 2, '超 14 天 TTL 的 v1 与旧内嵌备份应被淘汰');
    assert.equal(pruned.survivingCount, 2, 'v3 与去重后未超 1MB 的 v2 应被保留');
    assert.ok(pruned.deletedPaths.includes(snapV1Expired));
    assert.ok(pruned.deletedPaths.includes(legacyDir));
    assert.ok(pruned.survivingPaths.includes(snapV3));
    assert.ok(pruned.survivingPaths.includes(snapV2));
    // 内嵌 .yuyan-backups 空壳目录应被自动清理
    assert.equal(await fs.stat(legacyBackups).catch(() => null), null);

    // 执行对象池 GC（10 分钟宽限期）
    const gcRes = await runShell(buildCasObjectPoolGcCommand(stateRoot, { graceMinutes: 10 }));
    const gc = parseCasGcOutput(gcRes.stdout);
    assert.equal(gc.status, 'ok');
    assert.equal(gc.deletedObjects, 2, '被淘汰快照独有的 hOld 与老孤儿对象 hOrphanOld 应被删除');
    assert.equal(gc.skippedGrace, 1, '未满 10 分钟的 hOrphanFresh 应受宽限期保护');
    assert.ok(await fs.stat(path.join(objectsDir, hShared.slice(0, 2), hShared)).catch(() => null));
    assert.ok(await fs.stat(path.join(objectsDir, hInflight.slice(0, 2), hInflight)).catch(() => null), '写入中索引引用的对象绝不能误删');
    assert.ok(await fs.stat(path.join(objectsDir, hOrphanFresh.slice(0, 2), hOrphanFresh)).catch(() => null));
    assert.equal(await fs.stat(path.join(objectsDir, hOrphanOld.slice(0, 2), hOrphanOld)).catch(() => null), null);
    assert.equal(await fs.stat(path.join(objectsDir, hOld.slice(0, 2), hOld)).catch(() => null), null);

    // 验证极端情况下硬保底留 1 份：即使 ttlDays=1 且全部快照都很老，仍保留最新 1 份
    const oldOnlyDir = path.join(tmpDir, 'hard-floor-backups');
    await fs.mkdir(path.join(oldOnlyDir, '20260101000001'), { recursive: true });
    await fs.mkdir(path.join(oldOnlyDir, '20260101000002'), { recursive: true });
    await fs.writeFile(path.join(oldOnlyDir, '20260101000001', '.backup-meta.json'), JSON.stringify({ createdAtEpoch: nowSec - 100 * 86400 }));
    await fs.writeFile(path.join(oldOnlyDir, '20260101000002', '.backup-meta.json'), JSON.stringify({ createdAtEpoch: nowSec - 90 * 86400 }));
    const floorRes = await runShell(
      buildPruneBackupsCommand({
        primaryBackupRoot: oldOnlyDir,
        keepCount: 3,
        maxSizeMb: 1,
        ttlDays: 1,
        minKeepCount: 1,
      })
    );
    const floorParsed = parsePruneBackupsOutput(floorRes.stdout);
    assert.equal(floorParsed.survivingCount, 1, '所有备份超 TTL 时仍必须硬保底保留最新 1 份');
    assert.equal(floorParsed.deletedCount, 1);
    assert.ok(floorParsed.survivingPaths[0].endsWith('20260101000002'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('存储治理：安全路径校验、构建哈希识别、扫描统计、无主历史静态资源两段清理与纯净迁移包导出', async () => {
  // 1. 路径越界拦截
  assert.throws(() => assertSafeBackupEntryPath('/home/app/html/app'), /非雨燕备份目录/);
  assert.throws(() => assertSafeBackupEntryPath('/home/app/html/app/.yuyan-backups/../assets'), /路径穿越/);
  assert.throws(() => assertSafeBackupEntryPath('/home/app/html/app/.yuyan-backups/.hidden'), /非法备份条目名/);
  assert.equal(
    assertSafeBackupEntryPath('/home/app/frontend/.yuyan-state/targets/app-123456789012/backups/20261123'),
    '/home/app/frontend/.yuyan-state/targets/app-123456789012/backups/20261123'
  );

  // 2. 构建哈希文件名置信度判断
  assert.equal(isLikelyHashedBuildAsset('assets/index-B3kL9x2A.js'), true);
  assert.equal(isLikelyHashedBuildAsset('assets/vendor-a1b2c3d4.css.br'), true);
  assert.equal(isLikelyHashedBuildAsset('assets/chunk.8f3a1c2d.js.gz'), true);
  assert.equal(isLikelyHashedBuildAsset('assets/logo-homepage.png'), false, '普通英文语义文件名不得误标为高置信度哈希垃圾');
  assert.equal(isLikelyHashedBuildAsset('assets/favicon.ico'), false);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-gov-e2e-'));
  try {
    const baseRoot = path.join(tmpDir, 'frontend');
    const htmlRoot = path.join(baseRoot, 'html');
    const appDir = path.join(htmlRoot, 'entrusted-management');
    const stateRoot = path.join(baseRoot, '.yuyan-state');
    const slug = buildTargetStateSlug(appDir);
    const extManifestDir = path.join(stateRoot, 'targets', slug, 'manifests');
    const extBackupDir = path.join(stateRoot, 'targets', slug, 'backups', '20261123150000');
    const legacyBackupDir = path.join(appDir, '.yuyan-backups', '20261001120000');
    const legacyStagingDir = path.join(appDir, '.yuyan-retiring-20261001');

    await fs.mkdir(path.join(appDir, 'assets'), { recursive: true });
    await fs.mkdir(extManifestDir, { recursive: true });
    await fs.mkdir(extBackupDir, { recursive: true });
    await fs.mkdir(legacyBackupDir, { recursive: true });
    await fs.mkdir(legacyStagingDir, { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const oldTime = new Date((nowSec - 10 * 86400) * 1000);

    await fs.writeFile(path.join(appDir, 'index.html'), '<html>current</html>');
    await fs.writeFile(path.join(appDir, 'assets', 'app-11223344.js'), 'current-chunk');
    await fs.writeFile(path.join(appDir, 'assets', 'prev-55667788.js'), 'prev-backup-chunk');
    await fs.writeFile(path.join(appDir, 'assets', 'orphan-99aabbcc.js'), 'stale-orphan-chunk');
    await fs.writeFile(path.join(appDir, 'assets', 'orphan-99aabbcc.js.br'), 'stale-orphan-br');
    await fs.writeFile(path.join(appDir, 'assets', 'manual-banner.png'), 'manual-image');
    await fs.writeFile(path.join(appDir, 'assets', 'recent-aabb1122.js'), 'fresh-orphan-under-grace');
    await fs.utimes(path.join(appDir, 'assets', 'orphan-99aabbcc.js'), oldTime, oldTime);
    await fs.utimes(path.join(appDir, 'assets', 'orphan-99aabbcc.js.br'), oldTime, oldTime);
    await fs.utimes(path.join(appDir, 'assets', 'manual-banner.png'), oldTime, oldTime);
    await fs.writeFile(path.join(legacyBackupDir, 'old.bin'), Buffer.alloc(128 * 1024, 0x78));
    await fs.writeFile(path.join(legacyStagingDir, 'temp.bin'), Buffer.alloc(16 * 1024, 0x79));

    await fs.writeFile(path.join(extManifestDir, 'current.txt'), 'index.html\nassets/app-11223344.js\n');
    await fs.writeFile(path.join(extBackupDir, '.manifest.txt'), 'index.html\nassets/prev-55667788.js\n');
    await fs.writeFile(path.join(extBackupDir, '.backup-kind'), 'cas-entry-only\n');
    await fs.writeFile(path.join(extBackupDir, '.backup-meta.json'), JSON.stringify({ createdAtEpoch: nowSec - 60, logicalBytes: 500000 }));
    await fs.writeFile(path.join(stateRoot, 'targets', slug, 'target.json'), JSON.stringify({ realRoot: appDir }));

    // 3. 存储诊断扫描
    const inspectRes = await runShell(buildInspectNginxStorageCommand({ htmlRoot, stateRoot, targetRoots: [appDir] }));
    const report = parseInspectNginxStorageOutput(inspectRes.stdout, {
      targets: [{ id: 10, projectName: '委外管理', deployRoot: appDir, uploadStrategy: 'overlayKeepAssets' }],
      backupReferences: [{ id: 99, targetId: 10, backupPath: extBackupDir, branch: 'main', commitSha: 'abc' }],
    });
    assert.ok(report.summary.inlineBackupTotalBytes >= 128 * 1024);
    assert.equal(report.summary.inlineBackupTotalCount, 1);
    assert.equal(report.summary.externalBackupTotalCount, 1);
    assert.equal(report.summary.unreferencedBackupCount, 1, '旧内嵌备份不在 DB 回滚引用中应识别为孤儿备份');
    const appRow = report.apps.find((a) => a.deployRoot === appDir);
    assert.ok(appRow);
    assert.equal(appRow.managed, true);
    assert.equal(appRow.hasExternalManifest, true);

    // 4. 预览无主历史静态资源（保护 current.txt、存活备份 prev-55667788.js 以及未满 7 天的 recent-aabb1122.js）
    const previewRes = await runShell(
      buildPreviewOrphanAssetsCommand({
        rootPath: appDir,
        manifestDir: extManifestDir,
        legacyManifestDir: path.join(appDir, '.yuyan-manifests'),
        backupRoot: path.join(stateRoot, 'targets', slug, 'backups'),
        legacyBackupRoot: path.join(appDir, '.yuyan-backups'),
        hashedDirs: ['assets'],
        minAgeDays: 7,
      })
    );
    const preview = parsePreviewOrphanAssetsOutput(previewRes.stdout);
    assert.equal(preview.status, 'ok');
    assert.deepEqual(
      preview.hashedCandidates.map((i) => i.relativePath).sort(),
      ['assets/orphan-99aabbcc.js', 'assets/orphan-99aabbcc.js.br']
    );
    assert.deepEqual(
      preview.otherCandidates.map((i) => i.relativePath),
      ['assets/manual-banner.png']
    );

    // 5. 仅删除高置信度无主资源，验证 manual-banner.png / app-11223344.js / prev-55667788.js 完好
    const cleanRes = await runShell(buildCleanOrphanAssetsCommand(appDir, ['assets/orphan-99aabbcc.js', 'assets/orphan-99aabbcc.js.br']));
    assert.match(cleanRes.stdout, /deleted_count=2/);
    assert.equal(await fs.stat(path.join(appDir, 'assets', 'orphan-99aabbcc.js')).catch(() => null), null);
    assert.ok(await fs.stat(path.join(appDir, 'assets', 'manual-banner.png')).catch(() => null));
    assert.ok(await fs.stat(path.join(appDir, 'assets', 'prev-55667788.js')).catch(() => null));

    // 6. 批量删除旧内嵌备份并清理空壳目录
    const delRes = await runShell(
      buildDeleteBackupEntriesCommand({
        backupPaths: [legacyBackupDir],
        cleanupEmptyInlineRoots: [appDir],
      })
    );
    const delParsed = parseDeleteBackupEntriesOutput(delRes.stdout);
    assert.equal(delParsed.deletedCount, 1);
    assert.equal(await fs.stat(path.join(appDir, '.yuyan-backups')).catch(() => null), null);

    // 7. 纯净迁移导出命令包含对历史 chunk 与瞬态目录的排除
    const archiveCmd = buildArchiveTarCommand({ useSudo: false, webRoot: htmlRoot, baseRoot }, htmlRoot.replace(/^\//, ''), 'html', {
      cleanManifestScopes: [
        {
          rootPath: appDir,
          manifestDir: extManifestDir,
          legacyManifestDir: path.join(appDir, '.yuyan-manifests'),
          hashedDirs: ['assets'],
        },
      ],
    });
    assert.ok(archiveCmd.includes(".yuyan-state"));
    assert.ok(archiveCmd.includes(".yuyan-deploy.lock"));
    assert.ok(archiveCmd.includes(".yuyan-retiring-*"));
    assert.ok(archiveCmd.includes('current.txt'));

    // 8. 双目录静态资源保护：即使清单超过 keepCount，外置仓存活备份的 .manifest.txt 仍保护 prev-55667788.js
    await fs.writeFile(path.join(extManifestDir, '20261120000000.txt'), 'assets/prev-55667788.js\n');
    await fs.writeFile(path.join(extManifestDir, '20261123000000.txt'), 'assets/app-11223344.js\n');
    const pruneManifestRes = await runShell(
      buildPruneRemoteArtifactManifestsCommand(appDir, 1, false, {
        manifestDir: extManifestDir,
        backupRoot: path.join(stateRoot, 'targets', slug, 'backups'),
        legacyManifestDir: path.join(appDir, '.yuyan-manifests'),
        legacyBackupRoot: path.join(appDir, '.yuyan-backups'),
      })
    );
    assert.match(pruneManifestRes.stdout, /deleted_files=0 deleted_manifests=1/);
    assert.ok(await fs.stat(path.join(appDir, 'assets', 'prev-55667788.js')).catch(() => null));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('yuyan-nginx.sh gc-backups 定时巡检命令与 crontab 安装：跳过发布锁目录、清理超期备份/暂存垃圾与孤儿对象', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-ngx-gc-'));
  try {
    const baseRoot = path.join(tmpDir, 'frontend');
    const nginxDir = path.join(baseRoot, 'nginx');
    const htmlDir = path.join(baseRoot, 'html');
    const stateDir = path.join(baseRoot, '.yuyan-state');
    const scriptPath = path.join(nginxDir, 'yuyan-nginx.sh');
    await fs.mkdir(nginxDir, { recursive: true });
    await fs.writeFile(scriptPath, renderRuntimeScript(), { mode: 0o755 });

    // 验证 crontab 安装命令（每日 04 点执行，带独立 marker）
    const cron = buildBackupGcCronInstallCommand({ scriptPath, useSudo: false });
    assert.match(cron.cronLine, /^\d+ 4 \* \* \* '.*yuyan-nginx\.sh' gc-backups 14 200 6 >\/dev\/null 2>&1 # yuyan-nginx-gc-backups:[a-f0-9]{12}$/);

    const nowSec = Math.floor(Date.now() / 1000);
    const oldTime = new Date((nowSec - 20 * 86400) * 1000);
    const oldStagingTime = new Date((nowSec - 7200) * 1000);

    // 1. 构造未加锁微应用（含 2 份内嵌备份，旧的 20 天前，以及超过 60 分钟的暂存垃圾）
    const freeApp = path.join(htmlDir, 'free-app');
    const freeNewBk = path.join(freeApp, '.yuyan-backups', '20261123100000');
    const freeOldBk = path.join(freeApp, '.yuyan-backups', '20261101100000');
    const freeStaging = path.join(freeApp, '.yuyan-retiring-old');
    await fs.mkdir(freeNewBk, { recursive: true });
    await fs.mkdir(freeOldBk, { recursive: true });
    await fs.mkdir(freeStaging, { recursive: true });
    await fs.utimes(freeOldBk, oldTime, oldTime);
    await fs.utimes(freeStaging, oldStagingTime, oldStagingTime);

    // 2. 构造正在发布（持有未过期 .yuyan-deploy.lock）的微应用，其旧备份必须被完全跳过
    const lockedApp = path.join(htmlDir, 'locked-app');
    const lockedOldBk = path.join(lockedApp, '.yuyan-backups', '20261101100000');
    const lockedNewBk = path.join(lockedApp, '.yuyan-backups', '20261123100000');
    await fs.mkdir(lockedOldBk, { recursive: true });
    await fs.mkdir(lockedNewBk, { recursive: true });
    await fs.mkdir(path.join(lockedApp, '.yuyan-deploy.lock'), { recursive: true });
    await fs.utimes(lockedOldBk, oldTime, oldTime);

    // 3. 构造外置仓孤儿 CAS 对象（超过宽限期）
    const orphanHash = 'c'.repeat(64);
    const orphanObjPath = path.join(stateDir, 'objects', 'cc', orphanHash);
    await fs.mkdir(path.dirname(orphanObjPath), { recursive: true });
    await fs.writeFile(orphanObjPath, 'orphan-object-data');
    await fs.utimes(orphanObjPath, oldTime, oldTime);

    const out = execFileSync('bash', [scriptPath, 'gc-backups', '14', '200', '6', '10'], { encoding: 'utf8' });
    assert.match(out, /gc_backups_ok=1/);
    assert.match(out, /deleted_backups=1/);
    assert.match(out, /deleted_objects=1/);
    assert.match(out, /cleaned_staging=1/);

    assert.equal(await fs.stat(freeOldBk).catch(() => null), null, '超期旧备份应被清理');
    assert.ok(await fs.stat(freeNewBk).catch(() => null), '最新备份应硬保底保留');
    assert.equal(await fs.stat(freeStaging).catch(() => null), null, '超过 60 分钟的暂存垃圾应被清理');
    assert.ok(await fs.stat(lockedOldBk).catch(() => null), '持有发布锁的目录绝不能被巡检脚本干扰');
    assert.equal(await fs.stat(orphanObjPath).catch(() => null), null, '外置仓孤儿对象应被回收');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('deploy-store: 4 个备份策略列读写（含 0 与 null 区分）以及精确同步/清理 DB 回滚引用', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-store-ret-'));
  const prevDb = process.env.DEPLOY_DB_PATH;
  const prevData = process.env.DEPLOY_DATA_DIR;
  process.env.DEPLOY_DATA_DIR = tmpDir;
  process.env.DEPLOY_DB_PATH = path.join(tmpDir, 'deploy.sqlite');

  // 使用独立子进程测试新数据库路径，确保不污染其他测试的全局 SQLite 单例
  const verifyScript = `
    import assert from 'node:assert/strict';
    import {
      createServer,
      createNginxInstance,
      createTarget,
      updateTarget,
      getTarget,
      createRecord,
      getRecord,
      syncTargetBackupReferences,
      clearTargetBackupReferencesByPaths,
      listBackupReferencesByTargetIds,
      closeDeployDb,
    } from './server/services/deploy-store.mjs';

    const server = await createServer({
      name: 'store-ret-srv',
      host: '10.0.0.10',
      port: 22,
      username: 'app',
      authType: 'password',
      password: 'secret',
    });
    const inst = await createNginxInstance(server.id, {
      name: 'managed-main',
      instanceType: 'managed',
      baseRoot: '/home/app/frontend',
      htmlRoot: '/home/app/frontend/html',
      nginxRoot: '/home/app/frontend/nginx',
      sitesDir: '/home/app/frontend/nginx/conf/conf.d',
      defaultNginxConfPath: '/home/app/frontend/nginx/conf/nginx.conf',
    });

    // 1. 创建目标：0（不限）与正整数精确保存
    const created = await createTarget({
      projectId: 1001,
      projectName: 'demo-micro',
      projectPath: 'group/demo-micro',
      repositoryUrl: 'http://git.local/group/demo-micro.git',
      defaultBranch: 'main',
      envName: '测试',
      serverId: server.id,
      nginxInstanceId: inst.id,
      deployRoot: '/home/app/frontend/html/demo-micro',
      nginxConfPath: '/home/app/frontend/nginx/conf/nginx.conf',
      enableNginxTest: false,
      enableNginxReload: false,
      installCommand: 'pnpm i',
      buildCommand: 'pnpm build',
      artifactDir: 'dist',
      uploadStrategy: 'cleanReplace',
      backupKeepCount: 4,
      backupMaxSizeMb: 0,
      backupTtlDays: 0,
      hashedAssetDirs: 'static, chunks',
    });
    assert.equal(created.backupKeepCount, 4);
    assert.equal(created.backupMaxSizeMb, 0);
    assert.equal(created.backupTtlDays, 0);
    assert.equal(created.hashedAssetDirs, 'static,chunks');

    // 2. 更新为 null 重置跟随系统默认
    const updated = await updateTarget(created.id, {
      ...created,
      backupKeepCount: null,
      backupMaxSizeMb: 150,
      backupTtlDays: null,
      hashedAssetDirs: '',
    });
    assert.equal(updated.backupKeepCount, null);
    assert.equal(updated.backupMaxSizeMb, 150);
    assert.equal(updated.backupTtlDays, null);
    assert.equal(updated.hashedAssetDirs, '');

    // 3. 精确同步 DB 回滚引用：按 survivingPaths 与 deletedPaths 精准清理
    const r1 = await createRecord({
      targetId: created.id, projectId: 1001, projectName: 'demo-micro', envName: '测试', branch: 'main',
      status: 'success', releasePath: created.deployRoot, backupPath: '/home/app/frontend/.yuyan-state/targets/demo/backups/b1',
    });
    const r2 = await createRecord({
      targetId: created.id, projectId: 1001, projectName: 'demo-micro', envName: '测试', branch: 'main',
      status: 'success', releasePath: created.deployRoot, backupPath: '/home/app/frontend/.yuyan-state/targets/demo/backups/b2',
    });
    const r3 = await createRecord({
      targetId: created.id, projectId: 1001, projectName: 'demo-micro', envName: '测试', branch: 'main',
      status: 'success', releasePath: created.deployRoot, backupPath: '/home/app/frontend/html/demo-micro/.yuyan-backups/legacy1',
    });

    const refsBefore = await listBackupReferencesByTargetIds([created.id]);
    assert.equal(refsBefore.length, 3);

    // 远程淘汰 b1，保留 b2 和 legacy1
    const syncRes = await syncTargetBackupReferences(created.id, {
      deletedPaths: ['/home/app/frontend/.yuyan-state/targets/demo/backups/b1'],
      survivingPaths: ['/home/app/frontend/.yuyan-state/targets/demo/backups/b2', '/home/app/frontend/html/demo-micro/.yuyan-backups/legacy1'],
    });
    assert.equal(syncRes.clearedRecords, 1);
    assert.equal((await getRecord(r1.id)).backupPath, '');
    assert.equal((await getRecord(r2.id)).backupPath, '/home/app/frontend/.yuyan-state/targets/demo/backups/b2');

    // 存储治理手动清除 legacy1
    const clearRes = await clearTargetBackupReferencesByPaths(0, ['/home/app/frontend/html/demo-micro/.yuyan-backups/legacy1']);
    assert.equal(clearRes.clearedRecords, 1);
    assert.equal((await getRecord(r3.id)).backupPath, '');
    assert.equal((await getRecord(r2.id)).backupPath, '/home/app/frontend/.yuyan-state/targets/demo/backups/b2');

    await closeDeployDb();
    console.log('SQLITE_RETENTION_OK');
  `;

  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', verifyScript], {
      cwd: process.cwd(),
      env: { ...process.env, DEPLOY_DATA_DIR: tmpDir, DEPLOY_DB_PATH: path.join(tmpDir, 'deploy.sqlite') },
      encoding: 'utf8',
    });
    assert.match(out, /SQLITE_RETENTION_OK/);
  } finally {
    if (prevDb === undefined) delete process.env.DEPLOY_DB_PATH;
    else process.env.DEPLOY_DB_PATH = prevDb;
    if (prevData === undefined) delete process.env.DEPLOY_DATA_DIR;
    else process.env.DEPLOY_DATA_DIR = prevData;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
