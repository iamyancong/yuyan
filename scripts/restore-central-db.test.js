import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import zlib from 'node:zlib';

const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts', 'restore-central-db.sh');

test('restore-central-db.sh --help 正常输出用法并退出 0', () => {
  const result = spawnSync('bash', [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--file/);
  assert.match(result.stdout, /--data-dir/);
  assert.match(result.stdout, /DEPLOY_SECRET_KEY/);
});

test('restore-central-db.sh 在 sha256 不匹配时拒绝恢复且不修改现有库', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-restore-bad-sha-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const existingDbPath = path.join(dataDir, 'deploy.sqlite');
  await fs.writeFile(existingDbPath, 'existing-content');

  const gzPath = path.join(tmpRoot, 'backup.sqlite.gz');
  await fs.writeFile(gzPath, zlib.gzipSync(Buffer.from('dummy')));
  await fs.writeFile(`${gzPath}.sha256`, `${'0'.repeat(64)}  backup.sqlite.gz\n`);

  const result = spawnSync('bash', [SCRIPT_PATH, '--file', gzPath, '--data-dir', dataDir, '--yes'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 校验失败/);
  assert.equal(await fs.readFile(existingDbPath, 'utf8'), 'existing-content');
});

test('restore-central-db.sh 正常校验、解压、备份旧库并恢复', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-restore-ok-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const dataDir = path.join(tmpRoot, 'data');
  await fs.mkdir(dataDir, { recursive: true });

  // 先在 dataDir 放一个旧库和 wal
  const oldDbPath = path.join(dataDir, 'deploy.sqlite');
  await fs.writeFile(oldDbPath, 'old-db-bytes');
  await fs.writeFile(`${oldDbPath}-wal`, 'old-wal-bytes');

  // 用 node:sqlite 生成一个合法小库并压缩
  const srcDbPath = path.join(tmpRoot, 'source.sqlite');
  const db = new DatabaseSync(srcDbPath);
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT);');
  db.prepare('INSERT INTO sample (name) VALUES (?)').run('restored-ok');
  db.close();

  const gzBytes = zlib.gzipSync(await fs.readFile(srcDbPath));
  const gzPath = path.join(tmpRoot, 'yuyan-deploy-20261125-023000.sqlite.gz');
  await fs.writeFile(gzPath, gzBytes);
  const sha = crypto.createHash('sha256').update(gzBytes).digest('hex');
  await fs.writeFile(`${gzPath}.sha256`, `${sha}  yuyan-deploy-20261125-023000.sqlite.gz\n`);

  const result = spawnSync('bash', [SCRIPT_PATH, '--file', gzPath, '--data-dir', dataDir, '--yes'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /DEPLOY_SECRET_KEY/);

  const files = await fs.readdir(dataDir);
  assert.ok(files.some((name) => name.startsWith('deploy.sqlite.before-restore-')));
  assert.ok(files.some((name) => name.startsWith('deploy.sqlite-wal.before-restore-')));

  const restoredDb = new DatabaseSync(oldDbPath, { readOnly: true });
  try {
    const row = restoredDb.prepare('SELECT name FROM sample LIMIT 1').get();
    assert.equal(row?.name, 'restored-ok');
  } finally {
    restoredDb.close();
  }
});
