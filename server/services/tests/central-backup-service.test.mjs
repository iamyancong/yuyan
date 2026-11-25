import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import zlib from 'node:zlib';
import ssh2 from 'ssh2';
import { generateHostKey } from './ssh-test-server.mjs';

const { Server } = ssh2;

/**
 * 启动支持 SFTP 子系统与 exec 的测试 SSH 服务器（映射到底层临时目录）。
 * @param {string} sftpRootDir - SFTP 根目录映射
 * @param {{ username?: string, password?: string, corruptSha?: boolean, mismatchSize?: boolean, noSha256Sum?: boolean, onStartExec?: () => void }} [options]
 */
async function startSftpTestServer(sftpRootDir, options = {}) {
  const username = options.username || 'backup';
  const password = options.password || 'secret-pass-123';
  const hostKey = generateHostKey();
  const openHandles = new Map();
  let nextHandleId = 1;

  const mapPath = (remotePath) => {
    const clean = path.posix.normalize(String(remotePath || '/'));
    const rel = clean.replace(/^\/+/, '');
    const resolved = path.resolve(sftpRootDir, rel);
    if (!resolved.startsWith(path.resolve(sftpRootDir))) {
      throw new Error('path escapes sandbox');
    }
    return resolved;
  };

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.username === username && ctx.method === 'password' && ctx.password === password) {
        return ctx.accept();
      }
      return ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', async (acceptExec, _reject, info) => {
          options.onStartExec?.(info.command);
          const stream = acceptExec();
          const cmd = String(info.command || '');
          try {
            if (cmd.startsWith('mkdir -p -- ')) {
              const rawTarget = cmd.slice('mkdir -p -- '.length).trim().replace(/^'|'$/g, '').replace(/'\\''/g, "'");
              await fs.mkdir(mapPath(rawTarget), { recursive: true });
              stream.exit(0);
            } else if (cmd.startsWith('sha256sum -- ')) {
              if (options.noSha256Sum) {
                stream.stderr.write('sh: sha256sum: not found\n');
                stream.exit(127);
              } else {
                const rawTarget = cmd.slice('sha256sum -- '.length).trim().replace(/^'|'$/g, '').replace(/'\\''/g, "'");
                const bytes = await fs.readFile(mapPath(rawTarget));
                const hex = options.corruptSha
                  ? 'f'.repeat(64)
                  : crypto.createHash('sha256').update(bytes).digest('hex');
                stream.write(`${hex}  ${rawTarget}\n`);
                stream.exit(0);
              }
            } else {
              stream.exit(0);
            }
          } catch (err) {
            stream.stderr.write(String(err?.message || err));
            stream.exit(1);
          }
          stream.end();
        });

        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const STATUS = ssh2.utils.sftp.STATUS_CODE;

          sftp.on('OPEN', async (reqid, filename, flags) => {
            try {
              const local = mapPath(filename);
              const writeFlag = (flags & ssh2.utils.sftp.OPEN_MODE.WRITE) !== 0;
              const truncFlag = (flags & ssh2.utils.sftp.OPEN_MODE.TRUNC) !== 0;
              const creatFlag = (flags & ssh2.utils.sftp.OPEN_MODE.CREAT) !== 0;
              let nodeFlags = 'r';
              if (writeFlag && creatFlag && truncFlag) nodeFlags = 'w';
              else if (writeFlag && creatFlag) nodeFlags = 'w';
              else if (writeFlag) nodeFlags = 'r+';
              const fh = await fs.open(local, nodeFlags, 0o600);
              const handle = Buffer.alloc(4);
              const id = nextHandleId++;
              handle.writeUInt32BE(id, 0);
              openHandles.set(id, { fh, local, filename });
              sftp.handle(reqid, handle);
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE);
            }
          });

          sftp.on('WRITE', async (reqid, handle, offset, data) => {
            const entry = openHandles.get(handle.readUInt32BE(0));
            if (!entry) return sftp.status(reqid, STATUS.FAILURE);
            if (options.failOnWrite) return sftp.status(reqid, STATUS.FAILURE);
            try {
              await entry.fh.write(data, 0, data.length, offset);
              sftp.status(reqid, STATUS.OK);
            } catch {
              sftp.status(reqid, STATUS.FAILURE);
            }
          });

          sftp.on('READ', async (reqid, handle, offset, length) => {
            const entry = openHandles.get(handle.readUInt32BE(0));
            if (!entry) return sftp.status(reqid, STATUS.FAILURE);
            try {
              const buf = Buffer.alloc(length);
              const { bytesRead } = await entry.fh.read(buf, 0, length, offset);
              if (bytesRead === 0) sftp.status(reqid, STATUS.EOF);
              else sftp.data(reqid, buf.subarray(0, bytesRead));
            } catch {
              sftp.status(reqid, STATUS.FAILURE);
            }
          });

          sftp.on('CLOSE', async (reqid, handle) => {
            const id = handle.readUInt32BE(0);
            const entry = openHandles.get(id);
            openHandles.delete(id);
            if (entry?.fh) await entry.fh.close().catch(() => {});
            sftp.status(reqid, STATUS.OK);
          });

          const doStat = async (reqid, filepath) => {
            try {
              const st = await fs.stat(mapPath(filepath));
              const size = options.mismatchSize && String(filepath).includes('.tmp-') ? Math.max(0, st.size - 1) : st.size;
              sftp.attrs(reqid, {
                mode: st.mode,
                uid: st.uid,
                gid: st.gid,
                size,
                atime: Math.floor(st.atimeMs / 1000),
                mtime: Math.floor(st.mtimeMs / 1000),
              });
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE);
            }
          };

          sftp.on('STAT', doStat);
          sftp.on('LSTAT', doStat);

          sftp.on('FSTAT', async (reqid, handle) => {
            const entry = openHandles.get(handle.readUInt32BE(0));
            if (!entry) return sftp.status(reqid, STATUS.FAILURE);
            const st = await entry.fh.stat();
            sftp.attrs(reqid, {
              mode: st.mode,
              uid: st.uid,
              gid: st.gid,
              size: st.size,
              atime: Math.floor(st.atimeMs / 1000),
              mtime: Math.floor(st.mtimeMs / 1000),
            });
          });

          sftp.on('REALPATH', (reqid, filepath) => {
            sftp.name(reqid, [{ filename: path.posix.normalize(filepath || '/'), longname: '', attrs: {} }]);
          });

          sftp.on('OPENDIR', async (reqid, dirpath) => {
            try {
              const localDir = mapPath(dirpath);
              const items = await fs.readdir(localDir, { withFileTypes: true });
              const list = [];
              for (const item of items) {
                const st = await fs.stat(path.join(localDir, item.name));
                list.push({
                  filename: item.name,
                  longname: item.name,
                  attrs: {
                    mode: st.mode,
                    uid: st.uid,
                    gid: st.gid,
                    size: st.size,
                    atime: Math.floor(st.atimeMs / 1000),
                    mtime: Math.floor(st.mtimeMs / 1000),
                  },
                });
              }
              const id = nextHandleId++;
              const handle = Buffer.alloc(4);
              handle.writeUInt32BE(id, 0);
              openHandles.set(id, { dirList: list, sent: false });
              sftp.handle(reqid, handle);
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE);
            }
          });

          sftp.on('READDIR', (reqid, handle) => {
            const entry = openHandles.get(handle.readUInt32BE(0));
            if (!entry || entry.sent) return sftp.status(reqid, STATUS.EOF);
            entry.sent = true;
            sftp.name(reqid, entry.dirList);
          });

          sftp.on('RENAME', async (reqid, oldPath, newPath) => {
            try {
              await fs.rename(mapPath(oldPath), mapPath(newPath));
              sftp.status(reqid, STATUS.OK);
            } catch {
              sftp.status(reqid, STATUS.FAILURE);
            }
          });

          sftp.on('REMOVE', async (reqid, filepath) => {
            try {
              await fs.unlink(mapPath(filepath));
              sftp.status(reqid, STATUS.OK);
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE);
            }
          });
        });
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    username,
    password,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 在独立子进程中异步运行后端模块测试，确保不阻塞父进程内 SFTP Server 事件循环。 */
function runIsolatedAsync(dataDir, scriptBody, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', scriptBody], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DEPLOY_DATA_DIR: dataDir,
        DEPLOY_DB_PATH: path.join(dataDir, 'deploy.sqlite'),
        DEPLOY_SECRET_KEY: 'super-secret-backup-key-do-not-leak',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test('normalizeBackupRemoteDir: 合法路径规范化并拦截危险路径与非法字符', async () => {
  const { normalizeBackupRemoteDir } = await import('../central-backup-service.mjs');
  assert.equal(normalizeBackupRemoteDir('/bak/wangyancong-yuyan/'), '/bak/wangyancong-yuyan');
  assert.equal(normalizeBackupRemoteDir('  /data/yuyan_bak-01/prod  '), '/data/yuyan_bak-01/prod');
  assert.equal(normalizeBackupRemoteDir('/root/yuyan-backup'), '/root/yuyan-backup');

  const invalidCases = [
    '',
    '   ',
    'bak/yuyan',
    '/',
    '/bak',
    '/root',
    '/etc',
    '/etc/yuyan',
    '/bin/yuyan',
    '/sbin/yuyan',
    '/usr/local/bak',
    '/lib/bak',
    '/lib64/bak',
    '/boot/bak',
    '/dev/shm',
    '/proc/1',
    '/sys/fs',
    '/run/yuyan',
    '/var/run/yuyan',
    '/bak/../etc',
    '/bak/./sub',
    '/bak//sub',
    '/bak/with space',
    "/bak/'quoted'",
    '/bak/"quoted"',
    '/bak/$HOME',
    '/bak/`id`',
    '/bak/a;rm',
    '/bak/a&b',
    '/bak/a|b',
    '/bak/a*b',
    '/bak/a?b',
    '/bak/a\\b',
  ];
  for (const input of invalidCases) {
    assert.throws(() => normalizeBackupRemoteDir(input), { code: 'INVALID_BACKUP_DIR' }, `应拒绝: ${input}`);
  }
});

test('planBackupRetention & planBackupDirectoryCleanup: 7份日备 + 跨年3个月1号月备 + 绝不删非规则文件', async () => {
  const { planBackupRetention, planBackupDirectoryCleanup } = await import('../central-backup-service.mjs');

  const now = new Date(2026, 0, 15, 3, 0, 0); // 2026-01-15（覆盖跨年：2026-01 / 2025-12 / 2025-11）
  const files = [
    // 最新 7 份日备（2026-01-15 .. 2026-01-09）
    'yuyan-deploy-20260115-023000.sqlite.gz',
    'yuyan-deploy-20260114-023000.sqlite.gz',
    'yuyan-deploy-20260113-023000.sqlite.gz',
    'yuyan-deploy-20260112-023000.sqlite.gz',
    'yuyan-deploy-20260111-023000.sqlite.gz',
    'yuyan-deploy-20260110-023000.sqlite.gz',
    'yuyan-deploy-20260109-023000.sqlite.gz',
    // 第 8 份（非 1 号）：应删除
    'yuyan-deploy-20260108-023000.sqlite.gz',
    // 2026-01-01 有两份：只留最新 1 份
    'yuyan-deploy-20260101-140000.sqlite.gz',
    'yuyan-deploy-20260101-023000.sqlite.gz',
    // 2025-12-01（跨年上月 1 号）：保留
    'yuyan-deploy-20251201-023000.sqlite.gz',
    // 2025-11-01（往前第 2 个月 1 号）多份：只留最新 1 份
    'yuyan-deploy-20251101-180000.sqlite.gz',
    'yuyan-deploy-20251101-023000.sqlite.gz',
    // 2025-10-01（超出 3 个自然月）：应删除
    'yuyan-deploy-20251001-023000.sqlite.gz',
    // 非本规则文件：绝不能出现在 keep 或 remove
    'yuyan-deploy-20251105.tar',
    'wangyancong-20251105',
    'yuyan-deploy-20260101-023000.sqlite.gz.bak',
    '../x',
    'yuyan-deploy-20260230-023000.sqlite.gz', // 非法日期
  ];

  const { keep, remove } = planBackupRetention(files, now, { keepDaily: 7, keepMonthlyMonths: 3 });

  assert.deepEqual(
    keep.sort(),
    [
      'yuyan-deploy-20251101-180000.sqlite.gz',
      'yuyan-deploy-20251201-023000.sqlite.gz',
      'yuyan-deploy-20260101-140000.sqlite.gz',
      'yuyan-deploy-20260109-023000.sqlite.gz',
      'yuyan-deploy-20260110-023000.sqlite.gz',
      'yuyan-deploy-20260111-023000.sqlite.gz',
      'yuyan-deploy-20260112-023000.sqlite.gz',
      'yuyan-deploy-20260113-023000.sqlite.gz',
      'yuyan-deploy-20260114-023000.sqlite.gz',
      'yuyan-deploy-20260115-023000.sqlite.gz',
    ].sort()
  );

  assert.deepEqual(
    remove.sort(),
    [
      'yuyan-deploy-20251001-023000.sqlite.gz',
      'yuyan-deploy-20251101-023000.sqlite.gz',
      'yuyan-deploy-20260101-023000.sqlite.gz',
      'yuyan-deploy-20260108-023000.sqlite.gz',
    ].sort()
  );

  // 验证目录清理：sha256 跟随删除、孤儿 sha256 删除、超过 24h 的 tmp 删除，非规则文件绝不删除
  const entries = [
    ...files.map((filename) => ({ filename, attrs: { isDirectory: () => false, mtime: now.getTime() / 1000 } })),
    { filename: 'yuyan-deploy-20260115-023000.sqlite.gz.sha256', attrs: { isDirectory: () => false } },
    { filename: 'yuyan-deploy-20260108-023000.sqlite.gz.sha256', attrs: { isDirectory: () => false } },
    { filename: 'yuyan-deploy-20250901-023000.sqlite.gz.sha256', attrs: { isDirectory: () => false } }, // 孤儿 sha256
    { filename: 'yuyan-deploy-20260113-023000.sqlite.gz.tmp-abcdef012345', attrs: { isDirectory: () => false, mtime: (now.getTime() - 48 * 3600_000) / 1000 } }, // > 24h tmp
    { filename: 'yuyan-deploy-20260115-020000.sqlite.gz.tmp-123456abcdef', attrs: { isDirectory: () => false, mtime: (now.getTime() - 1800_000) / 1000 } }, // < 24h tmp
    { filename: 'wangyancong-20251105', attrs: { isDirectory: () => true } },
  ];
  const dirPlan = planBackupDirectoryCleanup(entries, now);
  assert.ok(dirPlan.remove.includes('yuyan-deploy-20260108-023000.sqlite.gz.sha256'));
  assert.ok(dirPlan.remove.includes('yuyan-deploy-20250901-023000.sqlite.gz.sha256'));
  assert.ok(dirPlan.remove.includes('yuyan-deploy-20260113-023000.sqlite.gz.tmp-abcdef012345'));
  assert.ok(!dirPlan.remove.includes('yuyan-deploy-20260115-023000.sqlite.gz.sha256'));
  assert.ok(!dirPlan.remove.includes('yuyan-deploy-20260115-020000.sqlite.gz.tmp-123456abcdef'));
  assert.ok(!dirPlan.remove.includes('wangyancong-20251105'));
  assert.ok(!dirPlan.remove.includes('yuyan-deploy-20251105.tar'));
  assert.ok(!dirPlan.remove.includes('../x'));
});

test('数据库迁移幂等与重启残留 running 状态收口，以及删除服务器联动清理', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-cb-mig-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));

  const first = await runIsolatedAsync(dataDir, `
    const store = await import('./server/services/deploy-store.mjs');
    const db = await store.getDeployDb();
    await store.closeDeployDb();
    const db2 = await store.getDeployDb();
    const row = db2.prepare('SELECT * FROM central_backup_settings WHERE id = 1').get();
    db2.prepare("UPDATE central_backup_settings SET last_status = 'running', updated_by = 'cfg-admin', updated_at = '2026-01-01T00:00:00.000Z' WHERE id = 1").run();
    const srv = await store.createServer({
      name: 'bak-srv',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
    });
    db2.prepare("UPDATE central_backup_settings SET server_id = ?, enabled = 1 WHERE id = 1").run(srv.id);
    const snap = await import('./server/services/nginx-config-snapshot-service.mjs');
    await snap.upsertNginxConfigSnapshot({
      serverId: srv.id,
      filePath: '/etc/nginx/conf.d/a.conf',
      content: 'server { listen 80; }',
      source: 'save',
    });
    await store.closeDeployDb();
    console.log(JSON.stringify({ hasRow: Boolean(row), serverId: srv.id }));
  `);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const parsedFirst = JSON.parse(first.stdout.trim().split('\n').at(-1));
  assert.equal(parsedFirst.hasRow, true);

  const second = await runIsolatedAsync(dataDir, `
    const store = await import('./server/services/deploy-store.mjs');
    const db = await store.getDeployDb();
    const rowAfterRestart = db.prepare('SELECT last_status, last_error, server_id, updated_by, updated_at FROM central_backup_settings WHERE id = 1').get();
    await store.deleteServer(${parsedFirst.serverId});
    const rowAfterDelete = db.prepare('SELECT server_id, enabled FROM central_backup_settings WHERE id = 1').get();
    const snapCount = db.prepare('SELECT COUNT(*) AS c FROM nginx_config_snapshots').get().c;
    await store.closeDeployDb();
    console.log(JSON.stringify({ rowAfterRestart, rowAfterDelete, snapCount }));
  `);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const parsedSecond = JSON.parse(second.stdout.trim().split('\n').at(-1));
  assert.equal(parsedSecond.rowAfterRestart.last_status, 'failed');
  assert.equal(parsedSecond.rowAfterRestart.last_error, '服务重启中断');
  assert.equal(parsedSecond.rowAfterRestart.updated_by, 'cfg-admin');
  assert.equal(parsedSecond.rowAfterRestart.updated_at, '2026-01-01T00:00:00.000Z');
  assert.equal(parsedSecond.rowAfterDelete.server_id, null);
  assert.equal(parsedSecond.rowAfterDelete.enabled, 0);
  assert.equal(parsedSecond.snapCount, 0);
});

test('runCentralBackup 端到端（真实 ssh2 SFTP Server）：成功压缩上传校验、防并发 409、失败清理 tmp 与未配置报错', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-cb-e2e-'));
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-cb-remote-'));
  t.after(() => Promise.all([
    fs.rm(dataDir, { recursive: true, force: true }),
    fs.rm(remoteRoot, { recursive: true, force: true }),
  ]));

  const sftpSrv = await startSftpTestServer(remoteRoot);
  t.after(() => sftpSrv.close());

  // 1. 未配置服务器直接运行 -> 报错并记录 failed
  const unconfigured = await runIsolatedAsync(dataDir, `
    const cb = await import('./server/services/central-backup-service.mjs');
    const store = await import('./server/services/deploy-store.mjs');
    let errCode = '';
    try {
      await cb.runCentralBackup({ trigger: 'manual', operator: 'alice' });
    } catch (err) {
      errCode = err.code;
    }
    const status = await cb.getCentralBackupStatus();
    await store.closeDeployDb();
    console.log(JSON.stringify({ errCode, status }));
  `);
  assert.equal(unconfigured.status, 0, unconfigured.stderr || unconfigured.stdout);
  const unconfRes = JSON.parse(unconfigured.stdout.trim().split('\n').at(-1));
  assert.equal(unconfRes.errCode, 'central_backup_server_not_configured');
  assert.equal(unconfRes.status.last.status, 'failed');

  // 2. 正常备份 + 验证 gz 解压后 integrity_check=ok + sha256 匹配 + 并发 409 + 本地临时目录清理干净
  const okRun = await runIsolatedAsync(dataDir, `
    const store = await import('./server/services/deploy-store.mjs');
    const cb = await import('./server/services/central-backup-service.mjs');
    const srv = await store.createServer({
      name: 'sftp-bak',
      host: '127.0.0.1',
      port: ${sftpSrv.port},
      username: '${sftpSrv.username}',
      authType: 'password',
      password: '${sftpSrv.password}',
    });
    await cb.updateCentralBackupSettings({
      serverId: srv.id,
      remoteDir: '/bak/wangyancong-yuyan',
      enabled: true,
    }, 'admin');

    const p1 = cb.runCentralBackup({ trigger: 'manual', operator: 'alice' });
    let concurrentCode = '';
    try {
      await cb.runCentralBackup({ trigger: 'manual', operator: 'bob' });
    } catch (e) {
      concurrentCode = e.code;
    }
    const r1 = await p1;
    const status = await cb.getCentralBackupStatus();
    await store.closeDeployDb();
    console.log(JSON.stringify({ concurrentCode, r1, status }));
  `);
  assert.equal(okRun.status, 0, okRun.stderr || okRun.stdout);
  const okParsed = JSON.parse(okRun.stdout.trim().split('\n').at(-1));
  assert.equal(okParsed.concurrentCode, 'central_backup_running');
  assert.equal(okParsed.status.last.status, 'success');
  assert.equal(okParsed.status.last.operator, 'alice');
  assert.equal(okParsed.status.settings.updatedBy, 'admin');
  assert.ok(okParsed.status.settings.updatedAt);
  assert.equal(okParsed.status.patrolRunning, false);
  assert.ok(okParsed.status.lastSuccessAt);
  assert.match(okParsed.r1.fileName, /^yuyan-deploy-\d{8}-\d{6}\.sqlite\.gz$/);

  const remoteDirPath = path.join(remoteRoot, 'bak', 'wangyancong-yuyan');
  const remoteFiles = await fs.readdir(remoteDirPath);
  assert.ok(remoteFiles.includes(okParsed.r1.fileName));
  assert.ok(remoteFiles.includes(`${okParsed.r1.fileName}.sha256`));
  assert.ok(!remoteFiles.some((n) => n.includes('.tmp-')));

  const gzBytes = await fs.readFile(path.join(remoteDirPath, okParsed.r1.fileName));
  const actualSha = crypto.createHash('sha256').update(gzBytes).digest('hex');
  assert.equal(actualSha, okParsed.r1.sha256);
  const shaFileText = await fs.readFile(path.join(remoteDirPath, `${okParsed.r1.fileName}.sha256`), 'utf8');
  assert.equal(shaFileText, `${actualSha}  ${okParsed.r1.fileName}\n`);

  const unzippedPath = path.join(dataDir, 'verify-unzipped.sqlite');
  await fs.writeFile(unzippedPath, zlib.gunzipSync(gzBytes));
  const verifyDb = new DatabaseSync(unzippedPath, { readOnly: true });
  const check = verifyDb.prepare('PRAGMA integrity_check').all();
  verifyDb.close();
  assert.equal(check.length, 1);
  assert.equal(check[0].integrity_check, 'ok');

  // 检查本地临时目录已删除干净
  const localEntries = await fs.readdir(dataDir);
  assert.ok(!localEntries.some((n) => n.startsWith('.central-backup-tmp-')));

  // 3. 远端 sha256 校验失败 -> 远端无新正式文件、无 tmp 残留、本地无 tmp 残留
  const badSftpSrv = await startSftpTestServer(remoteRoot, { corruptSha: true });
  t.after(() => badSftpSrv.close());

  const failRun = await runIsolatedAsync(dataDir, `
    const store = await import('./server/services/deploy-store.mjs');
    const cb = await import('./server/services/central-backup-service.mjs');
    const srv = await store.createServer({
      name: 'sftp-bad',
      host: '127.0.0.1',
      port: ${badSftpSrv.port},
      username: '${badSftpSrv.username}',
      authType: 'password',
      password: '${badSftpSrv.password}',
    });
    await cb.updateCentralBackupSettings({
      serverId: srv.id,
      remoteDir: '/bak/fail-case',
      enabled: false,
    }, 'admin');
    let errMsg = '';
    try {
      await cb.runCentralBackup({ trigger: 'manual', operator: 'alice' });
    } catch (e) {
      errMsg = e.message;
    }
    const status = await cb.getCentralBackupStatus();
    await store.closeDeployDb();
    console.log(JSON.stringify({ errMsg, status }));
  `);
  assert.equal(failRun.status, 0, failRun.stderr || failRun.stdout);
  const failParsed = JSON.parse(failRun.stdout.trim().split('\n').at(-1));
  assert.match(failParsed.errMsg, /SHA-256/);
  assert.equal(failParsed.status.last.status, 'failed');
  assert.ok(!failParsed.errMsg.includes('super-secret-backup-key-do-not-leak'));
  assert.ok(!failParsed.errMsg.includes(badSftpSrv.password));

  const failRemoteFiles = await fs.readdir(path.join(remoteRoot, 'bak', 'fail-case'));
  assert.equal(failRemoteFiles.length, 0);
  const localEntriesAfterFail = await fs.readdir(dataDir);
  assert.ok(!localEntriesAfterFail.some((n) => n.startsWith('.central-backup-tmp-')));

  // 4. SFTP WRITE 中途返回 FAILURE -> 远端无任何 tmp 或正式文件残留，且 settings.updatedBy 仍保持 admin
  const writeFailSrv = await startSftpTestServer(remoteRoot, { failOnWrite: true });
  t.after(() => writeFailSrv.close());

  const writeFailRun = await runIsolatedAsync(dataDir, `
    const store = await import('./server/services/deploy-store.mjs');
    const cb = await import('./server/services/central-backup-service.mjs');
    const beforeStatus = await cb.getCentralBackupStatus();
    const srv = await store.createServer({
      name: 'sftp-write-fail',
      host: '127.0.0.1',
      port: ${writeFailSrv.port},
      username: '${writeFailSrv.username}',
      authType: 'password',
      password: '${writeFailSrv.password}',
    });
    await cb.updateCentralBackupSettings({
      serverId: srv.id,
      remoteDir: '/bak/write-fail',
      enabled: false,
    }, 'cfg-editor');
    const afterSaveStatus = await cb.getCentralBackupStatus();
    let errMsg = '';
    try {
      await cb.runCentralBackup({ trigger: 'manual', operator: 'operator-bob' });
    } catch (e) {
      errMsg = e.message;
    }
    const status = await cb.getCentralBackupStatus();
    await store.closeDeployDb();
    console.log(JSON.stringify({ beforeStatus, afterSaveStatus, errMsg, status }));
  `);
  assert.equal(writeFailRun.status, 0, writeFailRun.stderr || writeFailRun.stdout);
  const writeFailParsed = JSON.parse(writeFailRun.stdout.trim().split('\n').at(-1));
  assert.ok(writeFailParsed.errMsg);
  assert.equal(writeFailParsed.status.last.status, 'failed');
  assert.equal(writeFailParsed.status.last.operator, 'operator-bob');
  assert.equal(writeFailParsed.status.settings.updatedBy, 'cfg-editor');
  assert.equal(writeFailParsed.status.settings.updatedAt, writeFailParsed.afterSaveStatus.settings.updatedAt);

  const writeFailRemoteFiles = await fs.readdir(path.join(remoteRoot, 'bak', 'write-fail'));
  assert.equal(writeFailRemoteFiles.length, 0);
  const localEntriesAfterWriteFail = await fs.readdir(dataDir);
  assert.ok(!localEntriesAfterWriteFail.some((n) => n.startsWith('.central-backup-tmp-')));
});
