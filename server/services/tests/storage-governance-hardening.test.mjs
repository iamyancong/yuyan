import test from 'node:test';
import assert from 'node:assert/strict';
import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireDeployRootLock,
  buildDeployRootLockKey,
} from '../deploy-root-lock.mjs';
import {
  buildCasBackupDeployRootCommand,
  buildCasObjectPoolGcCommand,
  buildCasRestoreDeployRootCommand,
  parseCasGcOutput,
} from '../deploy-cas-backup.mjs';
import {
  resolveCandidateDeployStateLocations,
  resolveDeployStateLocation,
  STATE_CAS_USERS_DIR_NAME,
} from '../deploy-state-layout.mjs';
import {
  acquireFrontendDeployLock,
  buildDetectDeployRootCommand,
  parseDetectDeployRootOutput,
  releaseFrontendDeployLock,
  resolveActiveDeployStateLayout,
} from '../deploy-service.mjs';
import {
  buildCleanOrphanAssetsCommand,
  buildPreviewOrphanAssetsCommand,
  collectInstanceStateRoots,
  parseInspectNginxStorageOutput,
  parsePreviewOrphanAssetsOutput,
  resolveGovernanceLockRoots,
} from '../storage-governance-service.mjs';
import {
  buildPhysicalPruneKey,
  resetStoragePruneJobsForTest,
  runNginxStoragePruneSynchronously,
  startNginxStoragePruneJob,
} from '../storage-prune-jobs.mjs';
import { getRequiredRoles } from '../central-deploy-guard.mjs';
import {
  buildArchiveExcludeTarScript,
  renderMainNginxConfigBody,
  renderRuntimeScript,
  renderSiteConfigBody,
} from '../nginx-runtime-service.mjs';

const execAsync = promisify(exec);

async function runShell(command) {
  return execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
}

test('P0-1 进程内目录锁：同物理机父子目录互斥，无嵌套兄弟目录可并发，释放父锁唤醒兄弟', async () => {
  const server = { host: '10.10.0.8', port: 22 };
  const parentKey = buildDeployRootLockKey(server, '/opt/yuyan/html');
  const childAKey = buildDeployRootLockKey(server, '/opt/yuyan/html/app-a');
  const childBKey = buildDeployRootLockKey(server, '/opt/yuyan/html/app-b');

  // 1. 兄弟目录 /html/app-a 与 /html/app-b 互不阻塞
  const relA = await acquireDeployRootLock(childAKey, { owner: { projectName: 'app-a' } });
  const relB = await acquireDeployRootLock(childBKey, { owner: { projectName: 'app-b' } });

  // 2. 此时申请父目录 /html 锁，必须等待两个子锁均释放
  let parentGranted = false;
  const parentPromise = acquireDeployRootLock(parentKey, { owner: { projectName: 'governance-parent' } }).then((rel) => {
    parentGranted = true;
    return rel;
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(parentGranted, false, '子目录持锁期间父目录锁不得并发进入');

  relA();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(parentGranted, false, '仍有兄弟子目录 app-b 持锁，父目录锁需继续等待');

  relB();
  const relParent = await parentPromise;
  assert.equal(parentGranted, true, '所有子目录锁释放后父目录锁立即获批');

  // 3. 父目录持锁期间，两个子目录均需排队，父锁释放后两个兄弟同时唤醒
  let a2Granted = false;
  let b2Granted = false;
  const pA2 = acquireDeployRootLock(childAKey, { owner: { projectName: 'app-a-2' } }).then((r) => { a2Granted = true; return r; });
  const pB2 = acquireDeployRootLock(childBKey, { owner: { projectName: 'app-b-2' } }).then((r) => { b2Granted = true; return r; });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(a2Granted, false);
  assert.equal(b2Granted, false);

  relParent();
  const [rA2, rB2] = await Promise.all([pA2, pB2]);
  assert.equal(a2Granted, true);
  assert.equal(b2Granted, true);
  rA2();
  rB2();
});

test('P0-2 真实 Shell：CAS 活跃读/写租约（.cas-users）存在时 GC 安全跳过，去重命中刷新对象 mtime', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-cas-lease-'));
  try {
    const appRoot = path.join(tmpDir, 'html', 'app-a');
    const stateRoot = path.join(tmpDir, '.yuyan-state');
    const objectsDir = path.join(stateRoot, 'objects');
    const backup1 = path.join(stateRoot, 'targets', 'app-a-1111', 'backups', '20261124000001');
    const backup2 = path.join(stateRoot, 'targets', 'app-a-1111', 'backups', '20261124000002');
    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(path.join(appRoot, 'index.html'), '<html>shared-v1</html>');

    // 1. 首次 CAS 备份写入对象池
    await runShell(
      buildCasBackupDeployRootCommand({
        rootPath: appRoot,
        backupPath: backup1,
        objectsDir,
        kind: 'cas-full',
        namesToBackup: ['index.html'],
      })
    );

    // 2. 找到对象并把 mtime 拨回 2 天前，然后模拟另一应用去重命中（应通过 touch -c 刷新 mtime）
    const shards = await fs.readdir(objectsDir);
    const shardDir = path.join(objectsDir, shards[0]);
    const files = await fs.readdir(shardDir);
    const objFile = path.join(shardDir, files[0]);
    const oldDate = new Date(Date.now() - 2 * 86400 * 1000);
    await fs.chmod(objFile, 0o644);
    await fs.utimes(objFile, oldDate, oldDate);
    await fs.chmod(objFile, 0o444);
    const beforeMtime = (await fs.stat(objFile)).mtimeMs;

    await runShell(
      buildCasBackupDeployRootCommand({
        rootPath: appRoot,
        backupPath: backup2,
        objectsDir,
        kind: 'cas-full',
        namesToBackup: ['index.html'],
      })
    );
    const afterMtime = (await fs.stat(objFile)).mtimeMs;
    assert.ok(afterMtime > beforeMtime + 1000, '去重命中对象时应刷新对象 mtime');

    // 3. 备份完成后 .cas-users 租约目录必须已清理干净
    const usersDir = path.join(stateRoot, STATE_CAS_USERS_DIR_NAME);
    const remainLeases = await fs.readdir(usersDir).catch(() => []);
    assert.equal(remainLeases.length, 0, '备份结束后应释放 .cas-users 租约');

    // 4. 模拟有正在写入/回滚的活跃租约（并移除所有备份使对象成为孤儿），此时 GC 必须安全跳过绝不删对象
    await fs.rm(path.join(stateRoot, 'targets'), { recursive: true, force: true });
    const fakeLease = path.join(usersDir, 'u-99999-active');
    await fs.mkdir(fakeLease, { recursive: true });
    const gcDuringActive = parseCasGcOutput(
      (await runShell(buildCasObjectPoolGcCommand(stateRoot, { graceMinutes: 0 }))).stdout
    );
    assert.equal(gcDuringActive.status, 'skipped_active_writer');
    assert.equal(gcDuringActive.deletedObjects, 0);
    assert.ok(await fs.stat(objFile).catch(() => null), '活跃读/写租约期间绝不可删除对象');

    // 5. 租约释放后，CAS GC 正常回收孤儿对象
    await fs.rmdir(fakeLease);
    const gcAfterRelease = parseCasGcOutput(
      (await runShell(buildCasObjectPoolGcCommand(stateRoot, { graceMinutes: 0 }))).stdout
    );
    assert.equal(gcAfterRelease.status, 'ok');
    assert.equal(gcAfterRelease.deletedObjects, 1);

    // 6. 验证 buildCasRestoreDeployRootCommand 同样包含租约注册逻辑
    const restoreCmd = buildCasRestoreDeployRootCommand({
      rootPath: appRoot,
      backupPath: backup1,
      objectsDir,
      restoreNames: ['index.html'],
      removeNames: ['index.html'],
    });
    assert.match(restoreCmd, /yuyan_acquire_cas_lease/);
    assert.match(restoreCmd, /yuyan_release_cas_lease/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('P1-1 多团队隔离：parseInspectNginxStorageOutput 识别他团队目录脱敏且不计入本团队孤儿统计', () => {
  const stdout = [
    'HTML_ROOT\t/opt/yuyan/html\t1\t5000',
    'STATE_ROOT\t/opt/yuyan/.yuyan-state\t1\t1000\t500\t1',
    'APP\t/opt/yuyan/html/team-a-app\t1\t2000\t400\t1\t0\t0\t1\t100',
    'APP\t/opt/yuyan/html/team-b-app\t1\t2000\t600\t1\t0\t0\t1\t100',
    'APP\t/opt/yuyan/html/unmanaged-dir\t1\t1000\t300\t1\t0\t0\t0\t0',
    'BACKUP\tinline\t\t/opt/yuyan/html/team-a-app\t/opt/yuyan/html/team-a-app/.yuyan-backups/20261120000001\tfull\t1763596800\t400\t400',
    'BACKUP\tinline\t\t/opt/yuyan/html/team-b-app\t/opt/yuyan/html/team-b-app/.yuyan-backups/20261120000002\tfull\t1763596801\t600\t600',
    'BACKUP\tinline\t\t/opt/yuyan/html/unmanaged-dir\t/opt/yuyan/html/unmanaged-dir/.yuyan-backups/20261120000003\tfull\t1763596802\t300\t300',
  ].join('\n');

  const parsed = parseInspectNginxStorageOutput(stdout, {
    targets: [{ id: 1, projectName: 'TeamAApp', deployRoot: '/opt/yuyan/html/team-a-app' }],
    otherTeamTargets: [{ id: 2, projectName: 'SecretTeamB', deployRoot: '/opt/yuyan/html/team-b-app', teamId: 'team-b' }],
    backupReferences: [{ id: 10, targetId: 1, backupPath: '/opt/yuyan/html/team-a-app/.yuyan-backups/20261120000001' }],
  });

  const appA = parsed.apps.find((a) => a.deployRoot === '/opt/yuyan/html/team-a-app');
  const appB = parsed.apps.find((a) => a.deployRoot === '/opt/yuyan/html/team-b-app');
  const appU = parsed.apps.find((a) => a.deployRoot === '/opt/yuyan/html/unmanaged-dir');

  assert.equal(appA?.ownership, 'managed_self');
  assert.equal(appA?.referencedInlineBackupCount, 1);
  assert.equal(appB?.ownership, 'managed_other_team');
  assert.equal(appB?.otherTeamManaged, true);
  assert.ok(!appB?.displayName.includes('SecretTeamB'), '其他团队项目名应脱敏');
  assert.equal(appB?.unreferencedBackupCount, 0);
  assert.equal(appU?.ownership, 'unmanaged');
  // 孤儿统计仅计入 unmanaged-dir 的 1 份（300B），绝不把 team-b-app 的 600B 算进本团队孤儿
  assert.equal(parsed.summary.unreferencedBackupCount, 1);
  assert.equal(parsed.summary.unreferencedBackupBytes, 300);

  // 跨团队祖先锁根：team-b 持有父目录时，team-a 子目录治理也能正确对齐到父目录锁根
  const lockPlan = resolveGovernanceLockRoots({
    inspection: {
      htmlRoot: { path: '/data/portal', exists: true },
      apps: [
        { key: '/data/portal', deployRoot: '/data/portal', exists: true, managed: false, otherTeamManaged: true },
        { key: '/data/portal/sub-a', deployRoot: '/data/portal/sub-a', exists: true, managed: true },
      ],
    },
    selectedApps: [{ key: '/data/portal/sub-a', deployRoot: '/data/portal/sub-a', exists: true, managed: true }],
  });
  assert.deepEqual(lockPlan.lockRoots, ['/data/portal']);
});

test('P1-2 真实 Shell：无主静态资源清理在锁内删除前复核清单与 mtime，命中新发布 chunk 自动跳过', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-orphan-reverify-'));
  try {
    const appRoot = path.join(tmpDir, 'app');
    const assetsDir = path.join(appRoot, 'assets');
    const manifestDir = path.join(tmpDir, 'manifests');
    const backupRoot = path.join(tmpDir, 'backups');
    const bak1Dir = path.join(backupRoot, '20261120000001');

    await fs.mkdir(assetsDir, { recursive: true });
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.mkdir(bak1Dir, { recursive: true });

    const revivedChunk = path.join(assetsDir, 'index-a1b2c3d4.js');
    const backupChunk = path.join(assetsDir, 'vendor-11223344.js');
    const freshChunk = path.join(assetsDir, 'fresh-55667788.js');
    const trueOrphan = path.join(assetsDir, 'stale-99aabbcc.js');

    await fs.writeFile(revivedChunk, 'revived');
    await fs.writeFile(backupChunk, 'backup-ref');
    await fs.writeFile(freshChunk, 'just-uploaded');
    await fs.writeFile(trueOrphan, 'true-orphan');

    const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
    await fs.utimes(revivedChunk, tenDaysAgo, tenDaysAgo);
    await fs.utimes(backupChunk, tenDaysAgo, tenDaysAgo);
    await fs.utimes(trueOrphan, tenDaysAgo, tenDaysAgo);
    // freshChunk 保持刚刚修改的 mtime（< 1 天）

    // 模拟预览后 15 分钟内新发布将 revivedChunk 写回 current.txt，且 backupChunk 被存活备份引用
    await fs.writeFile(path.join(manifestDir, 'current.txt'), 'index.html\nassets/index-a1b2c3d4.js\n');
    await fs.writeFile(path.join(bak1Dir, '.manifest.txt'), 'assets/vendor-11223344.js\n');

    const cmd = buildCleanOrphanAssetsCommand(
      appRoot,
      [
        'assets/index-a1b2c3d4.js',
        'assets/vendor-11223344.js',
        'assets/fresh-55667788.js',
        'assets/stale-99aabbcc.js',
      ],
      false,
      {
        manifestDir,
        backupRoot,
        minAgeDays: 1,
      }
    );
    const { stdout } = await runShell(cmd);
    assert.match(stdout, /\bdeleted_count=1\b/);
    assert.match(stdout, /\bskipped_count=3\b/);

    assert.ok(await fs.stat(revivedChunk).catch(() => null), '预览后被新发布带回 current.txt 的 chunk 必须跳过');
    assert.ok(await fs.stat(backupChunk).catch(() => null), '存活备份 .manifest.txt 引用的 chunk 必须跳过');
    assert.ok(await fs.stat(freshChunk).catch(() => null), '刚刚更新未满 minAgeDays 的文件必须跳过');
    assert.equal(await fs.stat(trueOrphan).catch(() => null), null, '真正超期无主文件应被安全删除');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('P1-3 真实 Shell：定时 gc-backups 识别嵌套祖先目录锁并避让活跃 .cas-users 租约', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-gc-ancestor-'));
  try {
    const baseRoot = path.join(tmpDir, 'frontend');
    const nginxDir = path.join(baseRoot, 'nginx');
    const htmlDir = path.join(baseRoot, 'html');
    const stateDir = path.join(baseRoot, '.yuyan-state');
    const scriptPath = path.join(nginxDir, 'yuyan-nginx.sh');
    await fs.mkdir(nginxDir, { recursive: true });
    await fs.writeFile(scriptPath, renderRuntimeScript(), { mode: 0o755 });

    const nowSec = Math.floor(Date.now() / 1000);
    const oldTime = new Date((nowSec - 20 * 86400) * 1000);

    // 嵌套子目录 /html/portal/sub 已退役超期，但父目录 /html/portal 正持有发布锁 → 必须跳过
    const portalDir = path.join(htmlDir, 'portal');
    const subDir = path.join(portalDir, 'sub');
    await fs.mkdir(subDir, { recursive: true });
    await fs.mkdir(path.join(portalDir, '.yuyan-deploy.lock'), { recursive: true });

    const subTargetState = path.join(stateDir, 'targets', 'sub-1234567890ab');
    await fs.mkdir(path.join(subTargetState, 'backups', '20261101000001'), { recursive: true });
    await fs.writeFile(path.join(subTargetState, 'target.json'), JSON.stringify({ realRoot: subDir }));
    await fs.writeFile(path.join(subTargetState, '.retired'), `retired_at=${nowSec - 20 * 86400}\n`);

    // 对象池有一孤儿对象，但 .cas-users 存在活跃租约 → 对象池 GC 必须跳过
    const orphanHash = 'd'.repeat(64);
    const orphanObj = path.join(stateDir, 'objects', 'dd', orphanHash);
    await fs.mkdir(path.dirname(orphanObj), { recursive: true });
    await fs.writeFile(orphanObj, 'in-flight-object');
    await fs.utimes(orphanObj, oldTime, oldTime);
    await fs.mkdir(path.join(stateDir, STATE_CAS_USERS_DIR_NAME, 'u-12345-active'), { recursive: true });

    const out = execFileSync('bash', [scriptPath, 'gc-backups', '14', '200', '6', '10'], { encoding: 'utf8' });
    assert.match(out, /gc_backups_ok=1/);
    assert.match(out, /reclaimed_targets=0/);
    assert.match(out, /deleted_objects=0/);
    assert.ok(await fs.stat(subTargetState).catch(() => null), '祖先目录持有发布锁时绝不可回收子目录退役状态');
    assert.ok(await fs.stat(orphanObj).catch(() => null), '活跃 CAS 租约期间定时 GC 绝不可删除对象');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('P2 嵌套外置仓防暴露、Nginx 模板拦截隐藏目录、同步接口去重互斥与 viewer 预览权限', async () => {
  // 1. 嵌套项目启发式布局：下级 /data/apps/portal/sub 避开上级 web 根 /data/apps/portal
  const layout = resolveDeployStateLocation({
    realRoot: '/data/apps/portal/sub',
    otherTargetRoots: ['/data/apps/portal'],
  });
  assert.equal(layout.mode, 'external');
  assert.equal(layout.stateRoot, '/data/apps/.yuyan-state', '状态仓应跳出上级站点 web 根，落在 /data/apps/.yuyan-state');

  // 2. 托管 Nginx 主配置与站点配置均在静态资源正则前拦截隐藏目录（放行 .well-known）
  const mainConf = renderMainNginxConfigBody({ portStart: 8080, webRoot: '/opt/yuyan/html' });
  const siteConf = renderSiteConfigBody({ listenPort: 8081, deployRoot: '/opt/yuyan/html/app-a' });
  assert.match(mainConf, /location ~ \/\\\.\(\?!well-known\) \{[\s\S]*deny all;/);
  assert.match(siteConf, /location ~ \/\\\.\(\?!well-known\) \{[\s\S]*deny all;/);
  assert.ok(
    mainConf.indexOf('location ~ /\\.(?!well-known)') < mainConf.indexOf('location ~* \\.html$'),
    '隐藏目录拦截规则必须位于 .html / .json 正则规则之前'
  );

  // 3. 权限：viewer 允许调用只读 POST 孤儿预览接口，但仍禁止清理
  assert.ok(getRequiredRoles('POST', '/targets/12/storage/orphan-assets/preview').includes('viewer'));
  assert.ok(!getRequiredRoles('POST', '/targets/12/storage/orphan-assets/clean').includes('viewer'));

  // 4. 异步与同步清理互斥 + 物理机跨团队互斥
  resetStoragePruneJobsForTest();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const physicalKey = buildPhysicalPruneKey({ host: '10.0.0.9', port: 22 }, { baseRoot: '/opt/yuyan' });
    startNginxStoragePruneJob(
      101,
      { inlineAction: 'keep_latest_1' },
      {
        physicalKey,
        pruneRunner: async () => {
          await gate;
          return { deletedBackups: 0, freedBytes: 0, clearedDbRecords: 0, deletedPaths: [], casGc: null };
        },
      }
    );

    // 同步接口 prune-backups 不能绕过单实例去重
    await assert.rejects(
      () => runNginxStoragePruneSynchronously(101, { inlineAction: 'keep_latest_1' }, { physicalKey }),
      (err) => err?.statusCode === 409 && err?.code === 'PRUNE_JOB_CONFLICT'
    );

    // 同物理机另一实例（如其他团队建的实例 202）命中同一 physicalKey 也必须互斥拒绝
    assert.throws(
      () => startNginxStoragePruneJob(202, { inlineAction: 'keep_latest_1' }, { physicalKey }),
      (err) => err?.statusCode === 409 && err?.code === 'PRUNE_JOB_CONFLICT'
    );

    // 同实例同 scope=all 但 inlineAction 不同，绝不静默复用（P3-2）
    assert.throws(
      () => startNginxStoragePruneJob(101, { inlineAction: 'purge_all' }, { physicalKey }),
      (err) => err?.statusCode === 409 && err?.code === 'PRUNE_JOB_CONFLICT'
    );

    release();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    resetStoragePruneJobsForTest();
  }
});

test('Review 回归：远端目录锁父子双向互斥、进程内锁路径归一、状态仓粘性布局与恢复不被 .gc.lock 卡死', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-review-reg-'));
  const fakeConn = {
    exec(cmd, cb) {
      const child = exec(cmd, { maxBuffer: 10 * 1024 * 1024 });
      const stream = {
        stderr: child.stderr,
        on(ev, fn) {
          if (ev === 'data') child.stdout.on('data', fn);
          else if (ev === 'close') child.on('close', (code) => fn(code));
          else if (ev === 'error') child.on('error', fn);
          return this;
        },
        close() { child.kill(); },
        destroy() { child.kill(); },
      };
      cb(null, stream);
    },
  };

  try {
    // 1. 进程内锁路径归一：含 ./ 与 // 的路径映射到同一锁键（P3-1）
    assert.equal(
      buildDeployRootLockKey({ host: '10.0.0.1', port: 22 }, '/srv/nginx/./html//a/'),
      buildDeployRootLockKey({ host: '10.0.0.1', port: 22 }, '/srv/nginx/html/a')
    );

    // 2. 远端目录锁父子双向互斥（P0-A）
    const htmlRoot = path.join(tmpDir, 'html');
    const appA = path.join(htmlRoot, 'a');
    await fs.mkdir(appA, { recursive: true });

    // 2a. 父目录持锁 → 子目录拿锁必须失败（并清掉自己的锁）
    const parentToken = await acquireFrontendDeployLock(fakeConn, htmlRoot, false, { waitTimeoutMs: 0 });
    await assert.rejects(
      () => acquireFrontendDeployLock(fakeConn, appA, false, { waitTimeoutMs: 0 }),
      /无法获取远程部署目录锁/
    );
    assert.equal(await fs.stat(path.join(appA, '.yuyan-deploy.lock')).catch(() => null), null, '冲突退让后子锁目录必须已清理');
    await releaseFrontendDeployLock(fakeConn, htmlRoot, parentToken, false);

    // 2b. 子目录持锁 → 父目录拿锁必须被子孙锁挡住（并清掉自己的锁）
    const childToken = await acquireFrontendDeployLock(fakeConn, appA, false, { waitTimeoutMs: 0 });
    await assert.rejects(
      () => acquireFrontendDeployLock(fakeConn, htmlRoot, false, { waitTimeoutMs: 0 }),
      /无法获取远程部署目录锁/
    );
    assert.equal(await fs.stat(path.join(htmlRoot, '.yuyan-deploy.lock')).catch(() => null), null, '冲突退让后父锁目录必须已清理');
    await releaseFrontendDeployLock(fakeConn, appA, childToken, false);

    // 3. 状态仓粘性布局（P0-B）：旧位置已有 targets/<slug> 时，即使新增父目标也不漂移；扫描汇总同时囊括新旧仓
    const portalDir = path.join(tmpDir, 'apps', 'portal');
    const subDir = path.join(portalDir, 'sub');
    await fs.mkdir(subDir, { recursive: true });
    const cand = resolveCandidateDeployStateLocations({
      realRoot: subDir,
      otherTargetRoots: [portalDir],
    });
    assert.equal(cand.primary.stateRoot, path.join(tmpDir, 'apps', '.yuyan-state'));
    assert.ok(cand.legacyCandidates.length >= 1, '应包含历史粘性候选仓');
    assert.equal(cand.legacyCandidates[0].stateRoot, path.join(portalDir, '.yuyan-state'));

    // 在旧位置预建 targets/<slug>，验证 resolveActiveDeployStateLayout 粘性沿用旧位置
    await fs.mkdir(cand.legacyCandidates[0].targetStateDir, { recursive: true });
    const stickyState = await resolveActiveDeployStateLayout(fakeConn, {
      realRoot: subDir,
      otherTargetRoots: [portalDir],
    });
    assert.equal(stickyState.layout.stateRoot, cand.legacyCandidates[0].stateRoot, '已有旧仓目标应粘性沿用旧位置防止读写分叉');

    // 额外仓候选携带目标 slug，旧仓只有存在该目标目录时才会进入扫描
    const collected = collectInstanceStateRoots(
      { instanceType: 'external', baseRoot: '', htmlRoot: '' },
      [{ deployRoot: subDir }],
      [portalDir]
    );
    assert.ok(collected.candidateTargetStateDirs.includes(cand.primary.targetStateDir));
    assert.ok(collected.candidateTargetStateDirs.includes(cand.legacyCandidates[0].targetStateDir));

    const movedRoot = path.join(tmpDir, 'new-home', 'app');
    await fs.mkdir(movedRoot, { recursive: true });
    const stalePin = stickyState.layout.stateRoot;
    const movedState = await resolveActiveDeployStateLayout(fakeConn, { realRoot: movedRoot, pinnedStateRoot: stalePin });
    assert.equal(movedState.layout.stateRoot, path.join(tmpDir, 'new-home', '.yuyan-state'));
    const unchangedState = await resolveActiveDeployStateLayout(fakeConn, { realRoot: subDir, pinnedStateRoot: stalePin });
    assert.equal(unchangedState.layout.stateRoot, stalePin, '同一真实目录仍沿用已经固定的仓');

    // 4. CAS 回滚恢复在 .gc.lock 存在时绝不阻塞卡死，秒级完成恢复（P1-1）
    const casState = path.join(tmpDir, 'cas-state');
    const casObjects = path.join(casState, 'objects');
    const casTargetRoot = path.join(tmpDir, 'cas-app');
    const casBackup = path.join(casState, 'targets', 'cas-app-1111', 'backups', '20261124000001');
    await fs.mkdir(casTargetRoot, { recursive: true });
    await fs.writeFile(path.join(casTargetRoot, 'index.html'), '<html>v1</html>');
    await runShell(
      buildCasBackupDeployRootCommand({
        rootPath: casTargetRoot,
        backupPath: casBackup,
        objectsDir: casObjects,
        kind: 'cas-full',
        namesToBackup: ['index.html'],
      })
    );
    // 模拟 GC 正在持锁，此时失败恢复/回滚仍应立刻完成
    await fs.mkdir(path.join(casState, '.gc.lock'), { recursive: true });
    await fs.writeFile(path.join(casTargetRoot, 'index.html'), '<html>broken</html>');
    const t0 = Date.now();
    await runShell(
      buildCasRestoreDeployRootCommand({
        rootPath: casTargetRoot,
        backupPath: casBackup,
        objectsDir: casObjects,
        restoreNames: ['index.html'],
        removeNames: ['index.html'],
      })
    );
    const restoreMs = Date.now() - t0;
    assert.ok(restoreMs < 5000, `恢复不应被 .gc.lock 阻塞，实际耗时 ${restoreMs}ms`);
    assert.equal(await fs.readFile(path.join(casTargetRoot, 'index.html'), 'utf8'), '<html>v1</html>');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Round3 新 P0 回归：粘性旧仓 + 过期内嵌清单场景，孤儿预览/锁内复核绝不误删线上 chunk，归档干净导出完整保留', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-r3-orphan-'));
  try {
    const portalDir = path.join(tmpDir, 'apps', 'portal');
    const subDir = path.join(portalDir, 'sub');
    const assetsDir = path.join(subDir, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });

    // 线上正在使用的 chunk（10 天前发布，满足 minAgeDays=1）+ 真正的无主旧 chunk
    const liveChunk = path.join(assetsDir, 'index-3f9a2c1b.js');
    const trueOrphan = path.join(assetsDir, 'legacy-deadbeef.js');
    await fs.writeFile(liveChunk, 'console.log("live");');
    await fs.writeFile(trueOrphan, 'console.log("orphan");');
    const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
    await fs.utimes(liveChunk, tenDaysAgo, tenDaysAgo);
    await fs.utimes(trueOrphan, tenDaysAgo, tenDaysAgo);

    // 过期内嵌清单（外置化前的旧清单，不含 index-3f9a2c1b.js）
    const inlineManifestDir = path.join(subDir, '.yuyan-manifests');
    await fs.mkdir(inlineManifestDir, { recursive: true });
    await fs.writeFile(path.join(inlineManifestDir, 'current.txt'), 'index.html\nassets/stale-00001111.js\n');

    // 新增父目标 portalDir 后，primary 指向 apps/.yuyan-state（尚不存在），而老粘性仓 A 在 portal/.yuyan-state
    const cand = resolveCandidateDeployStateLocations({
      realRoot: subDir,
      otherTargetRoots: [portalDir],
    });
    const stickyLayoutA = cand.legacyCandidates[0];
    assert.equal(stickyLayoutA.stateRoot, path.join(portalDir, '.yuyan-state'));
    await fs.mkdir(stickyLayoutA.manifestDir, { recursive: true });
    await fs.writeFile(path.join(stickyLayoutA.manifestDir, 'current.txt'), 'index.html\nassets/index-3f9a2c1b.js\n');

    const extraManifestDirs = cand.allExternal.map((l) => l.manifestDir);
    const extraBackupRoots = cand.allExternal.map((l) => l.backupRoot);

    // 1. 孤儿预览：即使传入不存在的新 primary，依靠 extraManifestDirs 必须保护粘性仓 A 的线上 chunk
    const previewCmd = buildPreviewOrphanAssetsCommand({
      rootPath: subDir,
      manifestDir: cand.primary.manifestDir,
      legacyManifestDir: inlineManifestDir,
      extraManifestDirs,
      backupRoot: cand.primary.backupRoot,
      legacyBackupRoot: path.join(subDir, '.yuyan-backups'),
      extraBackupRoots,
      hashedDirs: ['assets'],
      minAgeDays: 1,
    });
    const { stdout: previewOut } = await runShell(previewCmd);
    const parsed = parsePreviewOrphanAssetsOutput(previewOut);
    assert.equal(parsed.status, 'ok');
    const allRel = [...parsed.hashedCandidates, ...parsed.otherCandidates].map((i) => i.relativePath);
    assert.ok(!allRel.includes('assets/index-3f9a2c1b.js'), '粘性旧仓 current.txt 引用的线上 chunk 绝不可进入孤儿列表');
    assert.ok(allRel.includes('assets/legacy-deadbeef.js'), '真正的无主历史 chunk 应被正确检出');

    // 2. 锁内复核删除：即便强行传入线上 chunk，也必须被白名单拦截跳过
    const cleanCmd = buildCleanOrphanAssetsCommand(
      subDir,
      ['assets/index-3f9a2c1b.js', 'assets/legacy-deadbeef.js'],
      false,
      {
        manifestDir: cand.primary.manifestDir,
        legacyManifestDir: inlineManifestDir,
        extraManifestDirs,
        backupRoot: cand.primary.backupRoot,
        legacyBackupRoot: path.join(subDir, '.yuyan-backups'),
        extraBackupRoots,
        minAgeDays: 1,
      }
    );
    const { stdout: cleanOut } = await runShell(cleanCmd);
    assert.match(cleanOut, /deleted_count=1\b/);
    assert.match(cleanOut, /skipped_count=1\b/);
    assert.equal(await fs.readFile(liveChunk, 'utf8'), 'console.log("live");', '线上 chunk 必须安然无恙');
    assert.equal(await fs.stat(trueOrphan).catch(() => null), null, '真正孤儿 chunk 已被删除');

    // 3. 归档干净导出：重建真孤儿并执行 exclude 清单生成段，校验线上 chunk 不在排除列表、孤儿 chunk 在排除列表（跨 macOS/Linux 兼容）
    await fs.writeFile(trueOrphan, 'console.log("orphan-again");');
    const archiveRel = subDir.replace(/^\/+/, '');
    const tarCmd = buildArchiveExcludeTarScript({
      config: { useSudo: false },
      roots: [subDir],
      archivePaths: [archiveRel],
      excludePatterns: [],
      whitelist: [],
      includeHidden: true,
      cleanManifestScopes: [
        {
          rootPath: subDir,
          manifestDir: cand.primary.manifestDir,
          manifestDirs: extraManifestDirs,
          legacyManifestDir: inlineManifestDir,
          hashedDirs: ['assets'],
        },
      ],
    });
    const excludeInspectCmd = tarCmd.replace(/tar -czf -[\s\S]*$/, 'cat "$YUYAN_EXCLUDE"');
    const { stdout: excludeList } = await runShell(excludeInspectCmd);
    assert.ok(!excludeList.includes(`${archiveRel}/assets/index-3f9a2c1b.js`), '归档干净导出绝不可排除粘性旧仓引用的线上 chunk');
    assert.ok(excludeList.includes(`${archiveRel}/assets/legacy-deadbeef.js`), '归档干净导出应将非活跃旧 chunk 写入排除列表');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Round3 P0-2 回归：pinnedStateRoot 防父目标增删漂移、三层嵌套祖先枚举、detectDeployRoot 优先外置清单、readOnly 零写入', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-r3-state-'));
  try {
    // 1. pinnedStateRoot 在新增/删除父目标后保持绝对稳定不漂移
    const pinnedRoot = '/data/x/a/.yuyan-state';
    const withParent = resolveDeployStateLocation({
      realRoot: '/data/x/a/b/c',
      otherTargetRoots: ['/data/x/a', '/data/x/a/b'],
      pinnedStateRoot: pinnedRoot,
    });
    const withoutParent = resolveDeployStateLocation({
      realRoot: '/data/x/a/b/c',
      otherTargetRoots: [],
      pinnedStateRoot: pinnedRoot,
    });
    assert.equal(withParent.stateRoot, pinnedRoot);
    assert.equal(withParent.source, 'pinned-target-state');
    assert.equal(withoutParent.stateRoot, pinnedRoot);
    assert.equal(withoutParent.source, 'pinned-target-state');

    // 2. 三层嵌套场景（先有 /data/x/a/b，后新增 /data/x/a）：未固化时仍能枚举出中间老仓 /data/x/a/.yuyan-state
    const nested3 = resolveCandidateDeployStateLocations({
      realRoot: '/data/x/a/b/c',
      otherTargetRoots: ['/data/x/a', '/data/x/a/b'],
    });
    assert.equal(nested3.primary.stateRoot, '/data/x/.yuyan-state');
    const allRoots = nested3.allExternal.map((l) => l.stateRoot);
    assert.ok(allRoots.includes('/data/x/a/.yuyan-state'), '三层嵌套必须包含中间层旧仓 /data/x/a/.yuyan-state');
    assert.ok(allRoots.includes('/data/x/a/b/.yuyan-state'), '三层嵌套必须包含直接父级旧仓 /data/x/a/b/.yuyan-state');

    // 3. detectDeployRoot：主仓 B 不存在、粘性仓 A 有新清单、内嵌目录有过期清单时，必须读到粘性仓 A 而非过期内嵌清单
    const portalDir = path.join(tmpDir, 'apps', 'portal');
    const subDir = path.join(portalDir, 'sub');
    await fs.mkdir(path.join(subDir, '.yuyan-manifests'), { recursive: true });
    await fs.writeFile(path.join(subDir, '.yuyan-manifests', 'current.txt'), 'assets/stale-inline.js\n');
    const cand = resolveCandidateDeployStateLocations({
      realRoot: subDir,
      otherTargetRoots: [portalDir],
    });
    const stickyA = cand.legacyCandidates[0];
    await fs.mkdir(stickyA.manifestDir, { recursive: true });
    await fs.writeFile(path.join(stickyA.manifestDir, 'current.txt'), 'assets/fresh-external.js\n');

    const detectCmd = buildDetectDeployRootCommand(subDir, false, false, {
      externalManifestDirs: cand.allExternal.map((l) => l.manifestDir),
    });
    const { stdout: detectOut } = await runShell(detectCmd);
    const parsedDetect = parseDetectDeployRootOutput(detectOut, subDir);
    assert.equal(parsedDetect.manifestText, 'assets/fresh-external.js', '必须优先读取粘性外置仓清单，不得被过期内嵌清单覆盖');

    // 4. resolveActiveDeployStateLayout(readOnly: true) 不得在远端 mkdir 建目录
    const freshSub = path.join(tmpDir, 'readonly-case', 'sub');
    await fs.mkdir(freshSub, { recursive: true });
    const fakeConn = {
      exec(cmd, cb) {
        const child = exec(cmd, { maxBuffer: 4 * 1024 * 1024 });
        const stream = {
          stderr: child.stderr,
          on(ev, fn) {
            if (ev === 'data') child.stdout.on('data', fn);
            else if (ev === 'close') child.on('close', (code) => fn(code));
            else if (ev === 'error') child.on('error', fn);
            return this;
          },
          close() { child.kill(); },
          destroy() { child.kill(); },
        };
        cb(null, stream);
      },
    };
    const roState = await resolveActiveDeployStateLayout(fakeConn, {
      realRoot: freshSub,
      readOnly: true,
      persistStateRoot: false,
    });
    assert.equal(await fs.stat(roState.layout.stateRoot).catch(() => null), null, 'readOnly 模式绝不可创建远端状态仓目录');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Round3 P2/P3 回归：定时 gc-backups 目标等于 HTML_DIR 时不自锁且正常回收；远端锁强化校验', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-r3-gc-'));
  try {
    const baseRoot = path.join(tmpDir, 'nginx-base');
    const nginxDir = path.join(baseRoot, 'nginx');
    const htmlDir = path.join(baseRoot, 'html');
    const stateRoot = path.join(baseRoot, '.yuyan-state');
    const targetDir = path.join(stateRoot, 'targets', 'html-self-1234');
    const backupDir = path.join(targetDir, 'backups', '20261001000001');
    const scriptPath = path.join(nginxDir, 'yuyan-nginx.sh');

    await fs.mkdir(nginxDir, { recursive: true });
    await fs.mkdir(htmlDir, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'objects'), { recursive: true });

    const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 86400;
    await fs.writeFile(
      path.join(targetDir, 'target.json'),
      JSON.stringify({ realRoot: htmlDir, retentionTtlDays: 30 })
    );
    await fs.writeFile(
      path.join(targetDir, '.retired'),
      `retired_at=${sixtyDaysAgo}\nreal_root=${htmlDir}\nreason=target-deleted\n`
    );

    const scriptBody = renderRuntimeScript({
      baseRoot,
      installRoot: path.join(baseRoot, 'nginx'),
      webRoot: htmlDir,
      mainConfPath: path.join(baseRoot, 'nginx/conf/nginx.conf'),
      pidPath: path.join(baseRoot, 'nginx/logs/nginx.pid'),
      sitesDir: path.join(baseRoot, 'nginx/conf/conf.d'),
      scriptPath,
    });
    await fs.writeFile(scriptPath, scriptBody, { mode: 0o755 });

    const { stdout } = await runShell(`${JSON.stringify(scriptPath)} gc-backups`);
    assert.match(stdout, /reclaimed_targets=1\b/, '当退役目标 realRoot 恰好等于 HTML_DIR 时，不得自锁跳过而应正常回收');
    assert.equal(await fs.stat(targetDir).catch(() => null), null, '已到期退役目标目录应被彻底移除');
    assert.equal(await fs.stat(path.join(htmlDir, '.yuyan-deploy.lock')).catch(() => null), null, '回收完成后锁目录必须已清理');

    // 校验远端锁脚本已放宽深度上限、mktemp 失败安全退让且嵌套冲突带独立前缀
    const deployServiceSrc = await fs.readFile(new URL('../deploy-service.mjs', import.meta.url), 'utf8');
    assert.match(deployServiceSrc, /LOCK_CONFLICT_NESTED:/, '嵌套锁冲突应与同目录锁失败区分输出');
    assert.match(deployServiceSrc, /LOCK_UNAVAILABLE:.*临时文件/, 'mktemp 失败必须按锁不可用安全退让');
    assert.match(deployServiceSrc, /YUYAN_REMOTE_LOCK_MAX_DEPTH[\s\S]{0,80}12/, '远端锁子孙扫描默认深度应放宽至 12');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
