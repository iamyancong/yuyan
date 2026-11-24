import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-deploy-root-lock-'));
process.env.DEPLOY_DATA_DIR = dataRoot;
process.env.DEPLOY_DB_PATH = path.join(dataRoot, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'deploy-root-lock-test-key';

const {
  acquireDeployRootLock,
  buildDeployRootLockKey,
  formatDeployRootLockWait,
  getDeployRootLockHolder,
  getDeployRootLockWaitingCount,
  withDeployRootLock,
} = await import('../deploy-root-lock.mjs');
const { acquireDeployRootLocks, acquireFrontendDeployLock, releaseFrontendDeployLock, isStaleLocalDeployLockOwner } = await import('../deploy-service.mjs');

after(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
});

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用本机 /bin/sh 模拟 SSH 连接，真实执行远程锁脚本 */
const fakeConn = {
  exec(cmd, callback) {
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    callback(null, stream);
    exec(cmd, { shell: '/bin/sh' }, (err, stdout, stderr) => {
      if (stdout) stream.write(stdout);
      if (stderr) stream.stderr.write(stderr);
      stream.end();
      stream.stderr.end();
      stream.emit('close', err ? (err.code || 1) : 0);
    });
  },
};

test('锁键按物理服务器 host:port + 最外层目录区分，路径尾斜杠归一', () => {
  assert.equal(buildDeployRootLockKey({ host: '192.168.165.13', port: 22 }, '/home/app/frontend/html/'), '192.168.165.13:22|/home/app/frontend/html');
  assert.notEqual(
    buildDeployRootLockKey({ host: '10.0.0.1' }, '/a'),
    buildDeployRootLockKey({ host: '10.0.0.2' }, '/a')
  );
  assert.equal(buildDeployRootLockKey({ id: 7 }, '/a'), 'server#7|/a');
});

test('同一锁键 FIFO 等待：前一个释放后下一个获得，等待者能看到占用项目与名次', async () => {
  const key = buildDeployRootLockKey({ host: 'h1' }, '/x/html');
  const order = [];
  const waits = [];
  const releaseA = await acquireDeployRootLock(key, { owner: { projectName: '主应用' } });
  assert.equal(getDeployRootLockHolder(key).projectName, '主应用');

  const pB = acquireDeployRootLock(key, { owner: { projectName: '子应用B' }, onWait: (info) => waits.push(['B', info.holder?.projectName, info.position]) })
    .then((release) => { order.push('B'); return release; });
  const pC = acquireDeployRootLock(key, { owner: { projectName: '子应用C' }, onWait: (info) => waits.push(['C', info.holder?.projectName, info.position]) })
    .then((release) => { order.push('C'); return release; });
  await tick();
  assert.equal(getDeployRootLockWaitingCount(key), 2);
  assert.deepEqual(waits, [['B', '主应用', 1], ['C', '主应用', 2]]);

  releaseA();
  releaseA(); // 幂等
  const releaseB = await pB;
  assert.deepEqual(order, ['B']);
  assert.deepEqual(waits.at(-1), ['C', '子应用B', 1], 'C 收到新的持有者与名次');
  releaseB();
  const releaseC = await pC;
  assert.deepEqual(order, ['B', 'C']);
  releaseC();
  assert.equal(getDeployRootLockHolder(key), null);
});

test('不同锁键互不影响；等待中被停止立即退出队列且不影响后续等待者', async () => {
  const key = buildDeployRootLockKey({ host: 'h2' }, '/x/html');
  const otherKey = buildDeployRootLockKey({ host: 'h2' }, '/y/html');
  const releaseA = await acquireDeployRootLock(key, { owner: { projectName: 'A' } });
  const releaseOther = await acquireDeployRootLock(otherKey, { owner: { projectName: 'Other' } });
  releaseOther();

  const controller = new AbortController();
  const stopped = acquireDeployRootLock(key, { owner: { projectName: 'B' }, signal: controller.signal });
  const pC = acquireDeployRootLock(key, { owner: { projectName: 'C' } });
  await tick();
  controller.abort(Object.assign(new Error('用户已停止发布任务'), { name: 'DeployStoppedError' }));
  await assert.rejects(stopped, /用户已停止发布任务/);
  assert.equal(getDeployRootLockWaitingCount(key), 1);
  releaseA();
  const releaseC = await pC;
  assert.equal(getDeployRootLockHolder(key).projectName, 'C');
  releaseC();
});

test('withDeployRootLock 在执行出错时也会释放', async () => {
  const key = buildDeployRootLockKey({ host: 'h3' }, '/x');
  await assert.rejects(withDeployRootLock(key, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(getDeployRootLockHolder(key), null);
  const release = await acquireDeployRootLock(key);
  release();
});

test('等待文案包含占用项目、操作人、目录与名次', () => {
  const text = formatDeployRootLockWait({
    holder: { projectName: '国寿海外星河主应用', operator: '程述强', actionLabel: '发布' },
    position: 2,
    lockRoot: '/home/app/frontend/html',
    hint: '构建已完成，轮到后自动上传',
  });
  assert.equal(text.message, '等待同服务器目录锁…（被「国寿海外星河主应用」占用）');
  assert.match(text.detail, /程述强 发布/);
  assert.match(text.detail, /目录 \/home\/app\/frontend\/html/);
  assert.match(text.detail, /前面还有 1 个任务/);
});

test('远程锁：被其他实例占用时按退避等待，释放后获得；超时才报错；等待中可停止', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-remote-lock-'));
  try {
    const root = path.join(tmp, 'html');
    await fs.mkdir(root, { recursive: true });
    const lockDir = path.join(root, '.yuyan-deploy.lock');
    const otherOwner = 'host=other-instance pid=4321 record=1245 at=2026-11-16T02:29:27.000Z';
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, 'owner'), `${otherOwner}\n`);

    // 1. 等待其他实例释放
    const waits = [];
    setTimeout(() => {
      void releaseFrontendDeployLock(fakeConn, root, otherOwner, false);
    }, 120);
    const token = await acquireFrontendDeployLock(fakeConn, root, false, {
      recordId: 1,
      waitTimeoutMs: 5000,
      retryBaseMs: 30,
      retryMaxMs: 60,
      onWait: (owner) => waits.push(owner),
    });
    assert.match(token, /record=1/);
    assert.deepEqual(waits, [otherOwner]);

    // 2. 被自己当前持有：另一个调用（模拟其他实例视角）在超时后报 LOCK_FAILED
    await assert.rejects(
      acquireFrontendDeployLock(fakeConn, root, false, { recordId: 2, waitTimeoutMs: 80, retryBaseMs: 20, retryMaxMs: 20 }),
      /无法获取远程部署目录锁/
    );

    // 3. 等待中停止
    const controller = new AbortController();
    const pending = acquireFrontendDeployLock(fakeConn, root, false, { recordId: 3, waitTimeoutMs: 5000, retryBaseMs: 30, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('用户已停止发布任务')), 50);
    await assert.rejects(pending, /用户已停止发布任务/);

    await releaseFrontendDeployLock(fakeConn, root, token, false);
    assert.equal(await fs.stat(lockDir).catch(() => null), null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('远程锁：本机旧进程遗留的锁（同主机名、同 pid 但本进程未持有）直接清理后获得', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-remote-lock-stale-'));
  try {
    const root = path.join(tmp, 'html');
    const lockDir = path.join(root, '.yuyan-deploy.lock');
    await fs.mkdir(lockDir, { recursive: true });
    const staleOwner = `host=${os.hostname()} pid=${process.pid} record=1245 at=2026-11-16T02:29:27.000Z`;
    await fs.writeFile(path.join(lockDir, 'owner'), `${staleOwner}\n`);
    assert.equal(isStaleLocalDeployLockOwner(staleOwner), true);
    assert.equal(isStaleLocalDeployLockOwner('host=another-host pid=1 record=1 at=x'), false);

    const logs = [];
    const token = await acquireFrontendDeployLock(fakeConn, root, false, {
      recordId: 9,
      waitTimeoutMs: 0,
      log: (level, message) => logs.push([level, message]),
    });
    assert.match(token, /record=9/);
    assert.ok(logs.some(([, message]) => message.includes('旧任务遗留')));
    assert.equal(isStaleLocalDeployLockOwner(token), false, '本进程正在持有的锁不能被当成遗留锁');
    await releaseFrontendDeployLock(fakeConn, root, token, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('acquireDeployRootLocks：两个嵌套目标同时上传依次进行，不出现 LOCK_FAILED；停止等待与出错都会释放', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-root-locks-'));
  try {
    const lockRoot = path.join(tmp, 'frontend', 'html');
    await fs.mkdir(lockRoot, { recursive: true });
    const server = { host: '192.168.165.13', port: 22 };
    const timeline = [];
    const waitsB = [];

    const lockA = await acquireDeployRootLocks(fakeConn, {
      server,
      lockRoot,
      useSudo: false,
      recordId: 1245,
      owner: { projectName: '星河主应用', operator: '程述强', actionLabel: '发布' },
    });
    timeline.push('A:acquired');

    const pB = acquireDeployRootLocks(fakeConn, {
      server,
      lockRoot,
      useSudo: false,
      recordId: 1246,
      owner: { projectName: '星河子应用', operator: '王五', actionLabel: '发布' },
      waitHint: '构建已完成，轮到后自动上传',
      onWait: (wait) => waitsB.push(wait),
    }).then((lock) => {
      timeline.push('B:acquired');
      return lock;
    });

    await tick(30);
    assert.equal(waitsB.length, 1);
    assert.equal(waitsB[0].message, '等待同服务器目录锁…（被「星河主应用」占用）');
    assert.deepEqual(timeline, ['A:acquired']);

    // 第三个任务等待中被停止：抛出停止错误，不占位
    const controller = new AbortController();
    const pC = acquireDeployRootLocks(fakeConn, {
      server,
      lockRoot,
      useSudo: false,
      recordId: 1247,
      owner: { projectName: '子应用C' },
      signal: controller.signal,
    });
    await tick(10);
    controller.abort(Object.assign(new Error('用户已停止发布任务'), { name: 'DeployStoppedError', code: 'DEPLOY_STOPPED' }));
    await assert.rejects(pC, (error) => error.name === 'DeployStoppedError');

    timeline.push('A:release');
    await lockA.release();
    const lockB = await pB;
    assert.deepEqual(timeline, ['A:acquired', 'A:release', 'B:acquired']);
    assert.equal(lockB.waited, true);
    const owner = await fs.readFile(path.join(lockRoot, '.yuyan-deploy.lock', 'owner'), 'utf8');
    assert.match(owner, /record=1246/);

    // 模拟发布出错：finally 中 release 后锁完全释放，下一个任务立即可得
    try {
      throw new Error('上传失败');
    } catch {
      await lockB.release();
    }
    assert.equal(await fs.stat(path.join(lockRoot, '.yuyan-deploy.lock')).catch(() => null), null);
    const lockD = await acquireDeployRootLocks(fakeConn, { server, lockRoot, useSudo: false, recordId: 1248, owner: { projectName: 'D' } });
    assert.equal(lockD.waited, false);
    await lockD.release();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('远程锁：父目录不存在时立即快速失败，绝不进入长时间重试循环', async () => {
  const missingRoot = path.join(os.tmpdir(), `yuyan-nonexistent-lock-parent-${Date.now()}`);
  const startedAt = Date.now();
  await assert.rejects(
    acquireFrontendDeployLock(fakeConn, missingRoot, false, {
      recordId: 77,
      waitTimeoutMs: 30_000,
      retryBaseMs: 50,
    }),
    /目录不存在/
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 3000, `父目录不存在应立即失败，实际耗时 ${elapsedMs}ms`);
});

test('acquireDeployRootLocks：严格透传并遵守 waitTimeoutMs（含进程内排队与远程锁等待）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-root-lock-timeout-'));
  try {
    const lockRoot = path.join(tmp, 'html');
    await fs.mkdir(lockRoot, { recursive: true });
    const server = { host: '10.0.0.99', port: 22 };

    // 1. 进程内锁占用时，第二个调用按 waitTimeoutMs 快速超时
    const lockA = await acquireDeployRootLocks(fakeConn, {
      server,
      lockRoot,
      useSudo: false,
      recordId: 2001,
      owner: { projectName: '长任务A' },
    });
    const t1 = Date.now();
    await assert.rejects(
      acquireDeployRootLocks(fakeConn, {
        server,
        lockRoot,
        useSudo: false,
        recordId: 2002,
        owner: { projectName: '清理任务B' },
        waitTimeoutMs: 80,
      }),
      /等待同服务器目录锁超时/
    );
    assert.ok(Date.now() - t1 < 2000, '进程内排队应按 waitTimeoutMs 及时超时');
    await lockA.release();

    // 2. 远程锁被其他实例占用时，waitTimeoutMs 准确透传到 acquireFrontendDeployLock
    const lockDir = path.join(lockRoot, '.yuyan-deploy.lock');
    await fs.mkdir(lockDir);
    await fs.writeFile(path.join(lockDir, 'owner'), 'host=remote-other pid=999 record=88 at=2026-11-23T00:00:00.000Z\n');
    const t2 = Date.now();
    await assert.rejects(
      acquireDeployRootLocks(fakeConn, {
        server,
        lockRoot,
        useSudo: false,
        recordId: 2003,
        owner: { projectName: '清理任务C' },
        waitTimeoutMs: 90,
        retryBaseMs: 25,
        retryMaxMs: 30,
      }),
      /无法获取远程部署目录锁/
    );
    assert.ok(Date.now() - t2 < 2000, '远程锁等待应按透传的 waitTimeoutMs 及时超时');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
