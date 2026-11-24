import test from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildCasObjectPoolGcCommand,
  parseCasGcOutput,
} from '../deploy-cas-backup.mjs';
import { buildTargetStateSlug } from '../deploy-state-layout.mjs';
import {
  buildDeleteBackupEntriesCommand,
  buildInspectNginxStorageCommand,
  collectInstanceStateRoots,
  parseDeleteBackupEntriesOutput,
  parseInspectNginxStorageOutput,
  resolveGovernanceLockRoots,
} from '../storage-governance-service.mjs';
import {
  cancelNginxStoragePruneJob,
  getLatestNginxStoragePruneJob,
  getNginxStoragePruneJob,
  resetStoragePruneJobsForTest,
  startNginxStoragePruneJob,
} from '../storage-prune-jobs.mjs';

const execAsync = promisify(exec);

/**
 * 在本地真实 Shell 执行生成命令。
 * @param {string} command - Shell 命令
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function runShell(command) {
  return execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
}

test('resolveGovernanceLockRoots：与发布/回滚保持同一锁根规则（非目标 htmlRoot 不强锁，主应用与嵌套目录精确收敛）', () => {
  // 1. 托管 Nginx 下 htmlRoot 不是部署目标，仅有两个独立兄弟微应用 → 锁各自目录，与发布锁根 100% 一致（P0-1）
  const managedSiblings = resolveGovernanceLockRoots({
    inspection: {
      htmlRoot: { path: '/opt/yuyan/html', exists: true },
      apps: [
        { key: '/opt/yuyan/html/app-a', deployRoot: '/opt/yuyan/html/app-a', exists: true, managed: true },
        { key: '/opt/yuyan/html/app-b', deployRoot: '/opt/yuyan/html/app-b', exists: true, managed: true },
      ],
    },
    selectedApps: [
      { key: '/opt/yuyan/html/app-a', deployRoot: '/opt/yuyan/html/app-a', exists: true, managed: true },
      { key: '/opt/yuyan/html/app-b', deployRoot: '/opt/yuyan/html/app-b', exists: true, managed: true },
    ],
  });
  assert.deepEqual(managedSiblings.lockRoots, ['/opt/yuyan/html/app-a', '/opt/yuyan/html/app-b']);
  assert.equal(managedSiblings.groups.length, 2);
  assert.equal(managedSiblings.locklessApps.length, 0);

  // 1b. 当 /opt/yuyan/html 本身是已纳管主应用目标时 → 所有子目录与发布一致收敛到 /opt/yuyan/html
  const managedWithMain = resolveGovernanceLockRoots({
    inspection: {
      htmlRoot: { path: '/opt/yuyan/html', exists: true },
      apps: [
        { key: '/opt/yuyan/html', deployRoot: '/opt/yuyan/html', exists: true, managed: true },
        { key: '/opt/yuyan/html/app-a', deployRoot: '/opt/yuyan/html/app-a', exists: true, managed: true },
        { key: '/opt/yuyan/html/app-b', deployRoot: '/opt/yuyan/html/app-b', exists: true, managed: true },
      ],
    },
    selectedApps: [
      { key: '/opt/yuyan/html/app-a', deployRoot: '/opt/yuyan/html/app-a', exists: true, managed: true },
      { key: '/opt/yuyan/html/app-b', deployRoot: '/opt/yuyan/html/app-b', exists: true, managed: true },
    ],
  });
  assert.deepEqual(managedWithMain.lockRoots, ['/opt/yuyan/html']);
  assert.equal(managedWithMain.groups.length, 1);
  assert.equal(managedWithMain.groups[0].apps.length, 2);

  // 2. 原有 Nginx 接入：默认 /opt/yuyan/html 不存在，真实目录在 /home/app/frontend/html 及其子目录
  const externalShared = resolveGovernanceLockRoots({
    inspection: {
      htmlRoot: { path: '/opt/yuyan/html', exists: false },
      apps: [
        { key: '/home/app/frontend/html', deployRoot: '/home/app/frontend/html', exists: true },
        { key: '/home/app/frontend/html/dm-source', deployRoot: '/home/app/frontend/html/dm-source', exists: true },
      ],
    },
    selectedApps: [
      { key: '/home/app/frontend/html/dm-source', deployRoot: '/home/app/frontend/html/dm-source', exists: true },
    ],
  });
  assert.deepEqual(externalShared.lockRoots, ['/home/app/frontend/html']);
  assert.ok(!externalShared.lockRoots.includes('/opt/yuyan/html'), '绝不可对不存在的 htmlRoot 加锁');

  // 3. 原有 Nginx 多分散独立站点目录 + 已删目录的纯孤儿快照 → 按字典序分组加锁 + 孤儿无锁
  const externalScattered = resolveGovernanceLockRoots({
    inspection: {
      htmlRoot: { path: '/opt/yuyan/html', exists: false },
      apps: [
        { key: '/var/www/site-b', deployRoot: '/var/www/site-b', exists: true },
        { key: '/data/web/site-a', deployRoot: '/data/web/site-a', exists: true },
        { key: 'external:deleted-app', deployRoot: '', exists: false },
      ],
    },
    selectedApps: [
      { key: '/var/www/site-b', deployRoot: '/var/www/site-b', exists: true },
      { key: '/data/web/site-a', deployRoot: '/data/web/site-a', exists: true },
      { key: 'external:deleted-app', deployRoot: '', exists: false },
    ],
  });
  assert.deepEqual(externalScattered.lockRoots, ['/data/web/site-a', '/var/www/site-b']);
  assert.equal(externalScattered.locklessApps.length, 1);
});

test('原有 Nginx 接入：collectInstanceStateRoots 补齐启发式外置仓，htmlRoot 不存在时按顶层不重叠目录汇总体积', () => {
  const externalInstance = {
    id: 10,
    instanceType: 'external',
    baseRoot: '/opt/yuyan',
    htmlRoot: '/opt/yuyan/html',
  };
  const targets = [
    { id: 1, deployRoot: '/home/app/frontend/html' },
    { id: 2, deployRoot: '/home/app/frontend/html/dm-data-source' },
  ];

  const stateRoots = collectInstanceStateRoots(externalInstance, targets);
  assert.equal(stateRoots.primaryStateRoot, '/opt/yuyan/.yuyan-state');
  assert.equal(stateRoots.candidateTargetStateDirs[0], `/home/app/frontend/.yuyan-state/targets/${buildTargetStateSlug(targets[0].deployRoot)}`);
  assert.ok(stateRoots.candidateTargetStateDirs.includes(`/home/app/frontend/html/.yuyan-state/targets/${buildTargetStateSlug(targets[1].deployRoot)}`));

  const fakeStdout = [
    'HTML_ROOT\t/opt/yuyan/html\t0\t0',
    'EXTRA_STATE_ROOT\t/home/app/frontend/.yuyan-state\t1\t4096\t2048\t2',
    'STATE_ROOT\t/home/app/frontend/.yuyan-state\t1\t4096\t2048\t2',
    'APP\t/home/app/frontend/html\t1\t3000000\t100000\t1\t0\t0\t0\t500000',
    'APP\t/home/app/frontend/html/dm-data-source\t1\t500000\t200000\t2\t0\t0\t0\t0',
    'BACKUP\tinline\t\t/home/app/frontend/html\t/home/app/frontend/html/.yuyan-backups/20261120000001\tfull\t1763596800\t100000\t100000',
    'BACKUP\tinline\t\t/home/app/frontend/html/dm-data-source\t/home/app/frontend/html/dm-data-source/.yuyan-backups/20261120000002\tfull\t1763596801\t200000\t200000',
  ].join('\n');

  const parsed = parseInspectNginxStorageOutput(fakeStdout, {
    targets,
    backupReferences: [],
    nginxInstance: externalInstance,
  });
  assert.equal(parsed.htmlRoot.exists, false);
  assert.equal(parsed.stateRoot.path, '/home/app/frontend/.yuyan-state');
  assert.equal(parsed.existingStateRoots.length, 1);
  // 子目录 /home/app/frontend/html/dm-data-source 嵌套在 /home/app/frontend/html 下，不能重复累加
  assert.equal(parsed.summary.htmlTotalBytes, 3000000);
  assert.equal(parsed.summary.htmlRuntimeBytes, 2700000);
});

test('真实 Shell 集成：scopedOnly 定向扫描、skipMeasure 秒删备份、空 live 集下的线性 CAS GC', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-prune-p1-'));
  try {
    const htmlRoot = path.join(tmpDir, 'html');
    const stateRoot = path.join(tmpDir, '.yuyan-state');
    const appTarget = path.join(htmlRoot, 'app-target');
    const appHuge = path.join(htmlRoot, 'app-other');
    const bak1 = path.join(appTarget, '.yuyan-backups', '20261120010001');
    const bak2 = path.join(appTarget, '.yuyan-backups', '20261120010002');
    const otherBak = path.join(appHuge, '.yuyan-backups', '20261120010003');

    await fs.mkdir(bak1, { recursive: true });
    await fs.mkdir(bak2, { recursive: true });
    await fs.mkdir(otherBak, { recursive: true });
    await fs.writeFile(path.join(bak1, 'index.html'), 'v1'.repeat(1024));
    await fs.writeFile(path.join(bak2, 'index.html'), 'v2'.repeat(1024));
    await fs.writeFile(path.join(otherBak, 'index.html'), 'other'.repeat(1024));

    // 1. scopedOnly 定向扫描只输出 appTarget，完全跳过 appHuge
    const inspectRes = await runShell(
      buildInspectNginxStorageCommand({
        htmlRoot,
        stateRoot,
        targetRoots: [appTarget],
        scopedOnly: true,
      })
    );
    const parsedInspect = parseInspectNginxStorageOutput(inspectRes.stdout, {
      targets: [{ id: 1, projectName: 'TargetApp', deployRoot: appTarget }],
    });
    assert.equal(parsedInspect.apps.length, 1);
    assert.equal(parsedInspect.apps[0].deployRoot, appTarget);
    assert.equal(parsedInspect.apps[0].inlineBackupCount, 2);

    // 2. skipMeasure: true 删除备份不报错且正确输出已删路径
    const delRes = await runShell(
      buildDeleteBackupEntriesCommand({
        backupPaths: [bak1],
        skipMeasure: true,
      })
    );
    const parsedDel = parseDeleteBackupEntriesOutput(delRes.stdout);
    assert.equal(parsedDel.deletedCount, 1);
    assert.deepEqual(parsedDel.deletedPaths, [bak1]);
    assert.equal(await fs.stat(bak1).catch(() => null), null);
    assert.ok(await fs.stat(bak2));

    // 3. 线性 awk CAS GC 在活跃集为空时也能准确回收全部孤儿对象（防 NR==FNR 空文件陷阱）
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    await fs.mkdir(path.join(stateRoot, 'objects', 'aa'), { recursive: true });
    await fs.mkdir(path.join(stateRoot, 'objects', 'bb'), { recursive: true });
    const objA = path.join(stateRoot, 'objects', 'aa', hashA);
    const objB = path.join(stateRoot, 'objects', 'bb', hashB);
    await fs.writeFile(objA, 'orphan-a');
    await fs.writeFile(objB, 'orphan-b');

    const gcRes = await runShell(buildCasObjectPoolGcCommand(stateRoot, { graceMinutes: 0 }));
    const parsedGc = parseCasGcOutput(gcRes.stdout);
    assert.equal(parsedGc.status, 'ok');
    assert.equal(parsedGc.scannedObjects, 2);
    assert.equal(parsedGc.liveObjects, 0);
    assert.equal(parsedGc.deletedObjects, 2);
    assert.equal(await fs.stat(objA).catch(() => null), null);
    assert.equal(await fs.stat(objB).catch(() => null), null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('storage-prune-jobs：异步启动、实时进度更新、单实例并发复用与取消中止', async () => {
  resetStoragePruneJobsForTest();
  try {
    let releaseRunner;
    const events = [];
    const runnerPromise = new Promise((resolve) => {
      releaseRunner = resolve;
    });

    const job1 = startNginxStoragePruneJob(
      42,
      { inlineAction: 'keep_latest_1', targetRoots: ['/home/app/frontend/html/dm-source'] },
      {
        publishEvent: (evt) => events.push(evt),
        pruneRunner: async (_id, opts) => {
          opts.onProgress?.({
            phase: 'deleting_inline',
            phaseLabel: '正在清理内嵌备份 (1/1)：dm-source',
            percent: 55,
            totalApps: 1,
            completedApps: 0,
            deletedBackups: 4,
            freedBytes: 67_900_000,
          });
          await runnerPromise;
          return {
            deletedBackups: 4,
            freedBytes: 67_900_000,
            clearedDbRecords: 4,
            deletedPaths: ['/home/app/frontend/html/dm-source/.yuyan-backups/1'],
            casGc: null,
          };
        },
      }
    );

    assert.equal(job1.status, 'running');
    assert.equal(job1.scope, 'single');

    // 等待微任务推进进度
    await new Promise((r) => setTimeout(r, 20));
    const mid = getNginxStoragePruneJob(42, job1.jobId);
    assert.equal(mid.percent, 55);
    assert.equal(mid.deletedBackups, 4);

    // 同实例同范围并发触发应复用正在运行中的任务
    const reused = startNginxStoragePruneJob(42, {
      inlineAction: 'keep_latest_1',
      targetRoots: ['/home/app/frontend/html/dm-source'],
    });
    assert.equal(reused.jobId, job1.jobId);
    assert.equal(reused.reused, true);

    // 同实例不同范围（single 运行中被全量 all 请求）应拒绝静默误复用并抛出 409 冲突（#63）
    assert.throws(
      () => startNginxStoragePruneJob(42, { inlineAction: 'purge_all' }),
      (err) => err?.statusCode === 409 && err?.code === 'PRUNE_JOB_CONFLICT'
    );

    const latestRunning = getLatestNginxStoragePruneJob(42);
    assert.equal(latestRunning?.jobId, job1.jobId);

    // 放行完成
    releaseRunner();
    await new Promise((r) => setTimeout(r, 20));
    const done = getNginxStoragePruneJob(42, job1.jobId);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.percent, 100);
    assert.equal(done.freedBytes, 67_900_000);
    assert.equal(events.length, 1);

    // 测试取消流程
    const job2 = startNginxStoragePruneJob(
      43,
      { inlineAction: 'keep_latest_1' },
      {
        pruneRunner: async (_id, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
          }),
      }
    );
    await new Promise((r) => setTimeout(r, 15));
    const cancelling = cancelNginxStoragePruneJob(43, job2.jobId);
    assert.equal(cancelling.cancelling, true);
    await new Promise((r) => setTimeout(r, 20));
    const cancelled = getNginxStoragePruneJob(43, job2.jobId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error, '');
  } finally {
    resetStoragePruneJobsForTest();
  }
});

test('端到端 HTTP 路由集成：原有 Nginx 无 htmlRoot 时扫出真实体积并通过 prune-jobs 秒级清理', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-e2e-prune-'));
  const prevDataDir = process.env.DEPLOY_DATA_DIR;
  process.env.DEPLOY_DATA_DIR = path.join(tmpRoot, 'data');

  const { default: express } = await import('express');
  const { default: deployRouter } = await import('../../routes/deploy.mjs');
  const { __setTestHooks, __resetTestHooks } = await import('../../controllers/deploy-controller.mjs');
  const store = await import('../deploy-store.mjs');

  const missingHtmlRoot = path.join(tmpRoot, 'opt-yuyan-missing', 'html');
  const realAppRoot = path.join(tmpRoot, 'home-app', 'frontend', 'html', 'dm-data-source');

  for (let i = 1; i <= 5; i += 1) {
    const bdir = path.join(realAppRoot, '.yuyan-backups', `2026112001000${i}`);
    await fs.mkdir(bdir, { recursive: true });
    await fs.writeFile(path.join(bdir, 'index.html'), `backup-${i}`.repeat(256));
  }

  const physicalRoot = await fs.realpath(realAppRoot);
  const webParent = path.dirname(path.dirname(physicalRoot));
  const ownedStateRoot = path.join(webParent, '.yuyan-state');
  const unrelatedStateRoot = path.join(path.dirname(webParent), '.yuyan-state');
  await fs.mkdir(path.join(ownedStateRoot, 'targets', buildTargetStateSlug(physicalRoot)), { recursive: true });
  await fs.mkdir(path.join(unrelatedStateRoot, 'targets', 'other-team-app'), { recursive: true });
  const writeOldObject = async (root, char) => {
    const hash = char.repeat(64);
    const objectPath = path.join(root, 'objects', hash.slice(0, 2), hash);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, '未被快照引用的测试对象');
    const old = new Date(Date.now() - 86400_000);
    await fs.utimes(objectPath, old, old);
    return objectPath;
  };
  const ownedObject = await writeOldObject(ownedStateRoot, 'a');
  const unrelatedObject = await writeOldObject(unrelatedStateRoot, 'b');

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
        close() {
          child.kill();
        },
        destroy() {
          child.kill();
        },
      };
      cb(null, stream);
    },
  };

  __setTestHooks({
    withSsh: async (_server, fn) => fn(fakeConn),
  });

  const serverRec = await store.createServer({
    name: 'e2e-srv',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'x',
  });
  const inst = await store.createNginxInstance(serverRec.id, {
    name: '原有Nginx',
    instanceType: 'external',
    baseRoot: path.dirname(missingHtmlRoot),
    htmlRoot: missingHtmlRoot,
    nginxRoot: path.join(tmpRoot, 'opt-yuyan-missing', 'nginx'),
    sitesDir: path.join(tmpRoot, 'opt-yuyan-missing', 'nginx', 'conf', 'conf.d'),
    defaultNginxConfPath: path.join(tmpRoot, 'opt-yuyan-missing', 'nginx', 'conf', 'nginx.conf'),
  });
  await store.createTarget({
    projectId: 2001,
    projectName: 'dm-data-source',
    projectPath: 'group/dm-data-source',
    repositoryUrl: 'http://git.local/group/dm-data-source.git',
    defaultBranch: 'main',
    envName: '测试',
    serverId: serverRec.id,
    nginxInstanceId: inst.id,
    deployRoot: realAppRoot,
    projectType: 'frontend',
    uploadStrategy: 'overlayKeepAssets',
    enableNginxTest: false,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/deploy', deployRouter);
  const httpSrv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${httpSrv.address().port}/api/deploy`;

  try {
    const t0 = Date.now();
    const insResp = await fetch(`${base}/nginx-instances/${inst.id}/storage/inspect`).then((r) => r.json());
    assert.equal(insResp.success, true);
    assert.equal(insResp.data.htmlRoot.exists, false);
    assert.equal(insResp.data.apps.length, 1);
    assert.equal(insResp.data.apps[0].inlineBackupCount, 5);
    assert.ok(insResp.data.summary.htmlTotalBytes > 0, '无 htmlRoot 时应汇总真实应用占用');
    assert.deepEqual(insResp.data.existingStateRoots.map(({ path: root }) => root), [ownedStateRoot]);

    const startResp = await fetch(`${base}/nginx-instances/${inst.id}/storage/prune-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inlineAction: 'keep_latest_1',
        applyRetentionPolicy: true,
        runCasGc: true,
        targetRoots: [realAppRoot],
      }),
    }).then((r) => r.json());
    assert.equal(startResp.success, true);
    const jobId = startResp.data.jobId;
    assert.ok(jobId);

    let snap = null;
    for (let i = 0; i < 60; i += 1) {
      const pollResp = await fetch(`${base}/nginx-instances/${inst.id}/storage/prune-jobs/${jobId}`).then((r) => r.json());
      assert.equal(pollResp.success, true);
      snap = pollResp.data;
      if (snap.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const elapsedMs = Date.now() - t0;
    assert.equal(snap.status, 'succeeded', `期望 succeeded，实际: ${JSON.stringify(snap)}`);
    assert.equal(snap.deletedBackups, 4);
    assert.ok(snap.freedBytes > 0);
    assert.ok(elapsedMs < 5000, `清理应秒级完成，实际耗时 ${elapsedMs}ms`);

    const remaining = await fs.readdir(path.join(realAppRoot, '.yuyan-backups'));
    assert.equal(remaining.length, 1, '保底留最新 1 份内嵌备份');
    await assert.rejects(fs.access(ownedObject), { code: 'ENOENT' });
    await fs.access(unrelatedObject);

    const latestResp = await fetch(`${base}/nginx-instances/${inst.id}/storage/prune-jobs/latest`).then((r) => r.json());
    assert.equal(latestResp.success, true);
    assert.equal(latestResp.data.jobId, jobId);
  } finally {
    httpSrv.close();
    __resetTestHooks();
    resetStoragePruneJobsForTest();
    await store.closeDeployDb?.();
    if (prevDataDir === undefined) delete process.env.DEPLOY_DATA_DIR;
    else process.env.DEPLOY_DATA_DIR = prevDataDir;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
