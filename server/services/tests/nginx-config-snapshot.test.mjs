import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runIsolated(dataDir, scriptBody) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', scriptBody], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEPLOY_DATA_DIR: dataDir,
      DEPLOY_DB_PATH: path.join(dataDir, 'deploy.sqlite'),
      DEPLOY_SECRET_KEY: 'snapshot-test-secret',
    },
    encoding: 'utf8',
  });
}

test('extractSslCertificatePaths & parseOpenSslEndDate: 只匹配 ssl_certificate，忽略 key 与注释', async () => {
  const { extractSslCertificatePaths, parseOpenSslEndDate } = await import('../nginx-config-snapshot-service.mjs');
  const conf = `
    server {
      listen 443 ssl;
      # ssl_certificate /etc/nginx/certs/commented.pem;
      ssl_certificate /etc/nginx/certs/site.pem;
      ssl_certificate_key /etc/nginx/certs/site.key;
      ssl_certificate '/etc/nginx/certs/site.pem';
      ssl_certificate "/etc/nginx/certs/extra.crt";
      ssl_certificate /etc/nginx/certs/$ssl_server_name.crt;
    }
  `;
  assert.deepEqual(extractSslCertificatePaths(conf), [
    '/etc/nginx/certs/site.pem',
    '/etc/nginx/certs/extra.crt',
  ]);
  assert.equal(parseOpenSslEndDate('notAfter=Nov 25 12:00:00 2027 GMT\n'), '2027-11-25T12:00:00.000Z');
  assert.equal(parseOpenSslEndDate('invalid'), null);
});

test('upsertNginxConfigSnapshot: 覆盖写入、sha 不变不重写、超 1MB 跳过、非法路径拒绝', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-snap-upsert-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const res = runIsolated(dataDir, `
    const store = await import('./server/services/deploy-store.mjs');
    const snap = await import('./server/services/nginx-config-snapshot-service.mjs');
    const db = await store.getDeployDb();

    // 1. 非法路径拒绝
    let badPathErr = '';
    try {
      await snap.upsertNginxConfigSnapshot({ serverId: 1, filePath: 'relative/nginx.conf', content: 'x', source: 'save' });
    } catch (e) {
      badPathErr = e.code;
    }

    // 2. 超过 1MB 跳过
    const tooBig = await snap.upsertNginxConfigSnapshot({
      serverId: 1,
      filePath: '/etc/nginx/big.conf',
      content: 'a'.repeat(1024 * 1024 + 1),
      source: 'save',
    });

    // 3. 首次写入
    const r1 = await snap.upsertNginxConfigSnapshot({
      serverId: 1,
      targetId: 10,
      filePath: '/etc/nginx/conf.d/app.conf',
      content: 'server { listen 80; }',
      source: 'save',
      operator: 'alice',
    });
    const row1 = db.prepare('SELECT updated_at, content, source FROM nginx_config_snapshots WHERE server_id = 1 AND file_path = ?').get('/etc/nginx/conf.d/app.conf');

    await new Promise((r) => setTimeout(r, 20));

    // 4. sha 未变不重写 updated_at
    const r2 = await snap.upsertNginxConfigSnapshot({
      serverId: 1,
      targetId: 10,
      filePath: '/etc/nginx/conf.d/app.conf',
      content: 'server { listen 80; }',
      source: 'patrol',
    });
    const row2 = db.prepare('SELECT updated_at, source FROM nginx_config_snapshots WHERE server_id = 1 AND file_path = ?').get('/etc/nginx/conf.d/app.conf');

    // 5. 内容变化覆盖更新
    const r3 = await snap.upsertNginxConfigSnapshot({
      serverId: 1,
      targetId: 10,
      filePath: '/etc/nginx/conf.d/app.conf',
      content: 'server { listen 8080; }',
      source: 'sync',
    });
    const row3 = db.prepare('SELECT content, source FROM nginx_config_snapshots WHERE server_id = 1 AND file_path = ?').get('/etc/nginx/conf.d/app.conf');

    await store.closeDeployDb();
    console.log(JSON.stringify({ badPathErr, tooBig, r1, r2, r3, sameUpdatedAt: row1.updated_at === row2.updated_at, sourceAfterNoChange: row2.source, row3 }));
  `);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout.trim().split('\n').at(-1));
  assert.equal(parsed.badPathErr, 'NGINX_CONF_PATH_INVALID');
  assert.equal(parsed.tooBig.skipped, 'too_large');
  assert.equal(parsed.r1.changed, true);
  assert.equal(parsed.r2.changed, false);
  assert.equal(parsed.sameUpdatedAt, true);
  assert.equal(parsed.sourceAfterNoChange, 'save');
  assert.equal(parsed.r3.changed, true);
  assert.equal(parsed.row3.content, 'server { listen 8080; }');
  assert.equal(parsed.row3.source, 'sync');
});

test('patrolNginxConfigSnapshots: 单台失败不影响其他台、只在 sha 变化时更新、解析证书到期时间、只读查询快照', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-snap-patrol-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const res = runIsolated(dataDir, `
    import { EventEmitter } from 'node:events';
    const store = await import('./server/services/deploy-store.mjs');
    const snap = await import('./server/services/nginx-config-snapshot-service.mjs');
    const deployService = await import('./server/services/deploy-service.mjs');
    const cb = await import('./server/services/central-backup-service.mjs');
    const db = await store.getDeployDb();

    const s1 = await store.createServer({ name: 'bad-srv', host: '10.0.0.1', port: 22, username: 'root', authType: 'password', password: 'p1' });
    const s2 = await store.createServer({ name: 'good-srv', host: '10.0.0.2', port: 22, username: 'root', authType: 'password', password: 'p2' });
    const inst1 = await store.createNginxInstance(s1.id, {
      name: 'ext-1',
      instanceType: 'external',
      defaultNginxConfPath: '/etc/nginx/conf.d/p1.conf',
    });
    const inst2 = await store.createNginxInstance(s2.id, {
      name: 'managed-2',
      instanceType: 'managed',
      baseRoot: '/opt/yuyan',
    });
    const t1 = await store.createTarget({
      projectId: 1, projectName: 'p1', projectPath: 'g/p1', repositoryUrl: 'http://git/p1.git', defaultBranch: 'main',
      envName: 'prod', serverId: s1.id, nginxInstanceId: inst1.id, deployRoot: '/opt/html/p1', nginxConfPath: '/etc/nginx/conf.d/p1.conf',
      enableNginxTest: false, enableNginxReload: false, installCommand: '', buildCommand: '', artifactDir: 'dist',
    });
    const t2 = await store.createTarget({
      projectId: 2, projectName: 'p2', projectPath: 'g/p2', repositoryUrl: 'http://git/p2.git', defaultBranch: 'main',
      envName: 'prod', serverId: s2.id, nginxInstanceId: inst2.id, deployRoot: '/opt/html/p2', nginxConfPath: '/opt/yuyan/nginx/conf/conf.d/p2.conf',
      enableNginxTest: false, enableNginxReload: false, installCommand: '', buildCommand: '', artifactDir: 'dist',
    });

    const files = {
      '/opt/yuyan/nginx/conf/nginx.conf': 'worker_processes 1;',
      '/opt/yuyan/nginx/conf/conf.d/p2.conf': 'server {\\n  listen 443 ssl;\\n  ssl_certificate /etc/ssl/p2.pem;\\n  ssl_certificate_key /etc/ssl/p2.key;\\n}',
    };
    let keyReadAttempted = false;

    const mockWithSsh = async (server, task) => {
      if (server.id === s1.id) {
        throw new Error('connect ECONNREFUSED 10.0.0.1:22');
      }
      const conn = {
        exec(cmd, cb) {
          const stream = new EventEmitter();
          stream.stderr = new EventEmitter();
          process.nextTick(() => {
            cb(null, stream);
            let stdout = '';
            let code = 0;
            if (cmd.includes('openssl x509')) {
              if (cmd.includes('p2.key')) keyReadAttempted = true;
              stdout = 'notAfter=Dec 31 23:59:59 2027 GMT\\n';
            } else if (cmd.includes('base64 < "$f"')) {
              const matched = cmd.match(/'([^']+)'\\s+'\\d+'\\s+'\\d+'$/);
              const fileArg = matched ? matched[1] : '';
              // 简单提取倒数第 3 个单引号参数
              const args = [...cmd.matchAll(/'((?:[^']|'\\\\'')*)'/g)].map((m) => m[1]);
              const targetFile = args.at(-3);
              if (files[targetFile] !== undefined) {
                stdout = 'B64\\n' + Buffer.from(files[targetFile], 'utf8').toString('base64') + '\\n';
              } else {
                code = 44;
              }
            }
            if (stdout) stream.emit('data', Buffer.from(stdout));
            stream.emit('close', code);
          });
        },
        sftp(cb) {
          process.nextTick(() => cb(null, {
            readdir(_dir, rcb) {
              rcb(null, [
                { filename: 'p2.conf', attrs: { isDirectory: () => false, isSymbolicLink: () => false } },
                { filename: 'ignore.txt', attrs: { isDirectory: () => false, isSymbolicLink: () => false } },
              ]);
            },
          }));
        },
      };
      return task(conn);
    };

    // 并发巡检互斥检查：第一轮仍在执行时第二次直接抛 409 nginx_patrol_running
    let releaseSlowPatrol;
    const slowGate = new Promise((resolve) => { releaseSlowPatrol = resolve; });
    let schedulerRanBackupWhilePatrolRunning = false;
    const slowWithSsh = async (server, task) => {
      await slowGate;
      return mockWithSsh(server, task);
    };
    const pSlow = snap.patrolNginxConfigSnapshots({ withSsh: slowWithSsh });
    const runningInside = snap.isNginxConfigPatrolRunning();
    let concurrentErrCode = '';
    let concurrentErrStatus = 0;
    try {
      await snap.patrolNginxConfigSnapshots({ withSsh: mockWithSsh });
    } catch (err) {
      concurrentErrCode = err.code;
      concurrentErrStatus = err.statusCode;
    }

    // 调度周期在巡检运行中跳过巡检并继续检查备份
    await cb.updateCentralBackupSettings({ serverId: s2.id, remoteDir: '/bak/sched-skip', enabled: true }, 'admin');
    let schedulerTriedPatrol = false;
    await new Promise((resolve) => {
      const stop = cb.startCentralBackupScheduler({
        computeDelayMs: () => 10,
        onPatrol: async () => { schedulerTriedPatrol = true; },
        onBackup: async () => {
          schedulerRanBackupWhilePatrolRunning = true;
          stop();
          resolve();
        },
      });
    });

    releaseSlowPatrol();
    const patrol1 = await pSlow;
    const runningAfter = snap.isNginxConfigPatrolRunning();
    const patrol2 = await snap.patrolNginxConfigSnapshots({ withSsh: mockWithSsh });
    const snapshotT2 = await deployService.getTargetNginxCentralSnapshot(t2.id);
    const snapshotT1Missing = await deployService.getTargetNginxCentralSnapshot(t1.id);
    const rawRead = await snap.readNginxConfigSnapshot({ serverId: s2.id, filePath: '/opt/yuyan/nginx/conf/nginx.conf' });

    await store.closeDeployDb();
    console.log(JSON.stringify({
      patrol1,
      patrol2,
      keyReadAttempted,
      snapshotT2,
      snapshotT1Missing,
      rawRead,
      runningInside,
      runningAfter,
      concurrentErrCode,
      concurrentErrStatus,
      schedulerTriedPatrol,
      schedulerRanBackupWhilePatrolRunning,
    }));
  `);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout.trim().split('\n').at(-1));
  assert.equal(parsed.runningInside, true);
  assert.equal(parsed.runningAfter, false);
  assert.equal(parsed.concurrentErrCode, 'nginx_patrol_running');
  assert.equal(parsed.concurrentErrStatus, 409);
  assert.equal(parsed.schedulerTriedPatrol, false);
  assert.equal(parsed.schedulerRanBackupWhilePatrolRunning, true);
  assert.equal(parsed.keyReadAttempted, false);
  assert.equal(parsed.patrol1.failures.length, 1);
  assert.equal(parsed.patrol1.failures[0].serverName, 'bad-srv');
  assert.equal(parsed.patrol1.filesChecked, 2);
  assert.equal(parsed.patrol1.filesUpdated, 2);
  assert.equal(parsed.patrol1.certs.length, 1);
  assert.equal(parsed.patrol1.certs[0].path, '/etc/ssl/p2.pem');
  assert.equal(parsed.patrol1.certs[0].notAfter, '2027-12-31T23:59:59.000Z');
  // 第二次内容无变化，filesUpdated 为 0
  assert.equal(parsed.patrol2.filesChecked, 2);
  assert.equal(parsed.patrol2.filesUpdated, 0);
  // deploy-service 与只读接口返回快照
  assert.equal(parsed.snapshotT2.exists, true);
  assert.equal(parsed.snapshotT2.certInfo[0].notAfter, '2027-12-31T23:59:59.000Z');
  assert.equal(parsed.snapshotT1Missing.exists, false);
  assert.equal(parsed.rawRead.exists, true);
});
