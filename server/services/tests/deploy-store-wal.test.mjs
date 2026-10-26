import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-wal-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'wal-test';
delete process.env.YUYAN_SQLITE_JOURNAL_MODE;

const store = await import('../deploy-store.mjs');
const { runRequestContext } = await import('../request-context.mjs');
const inTeam = (callback) => runRequestContext({ accountId: 'a', userId: 'a', teamId: 'team-a', role: 'operator' }, callback);

after(async () => {
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

test('中央库默认启用 WAL、busy_timeout 与 synchronous=NORMAL', async () => {
  const db = await store.getDeployDb();
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
});

test('VACUUM INTO 快照包含尚未检查点的 WAL 数据，直接复制主库文件会丢失', async () => {
  await inTeam(() =>
    store.createServer({ name: 'wal-server', host: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'p', defaultBackendRoot: '/tmp' })
  );
  const snapshotPath = path.join(root, 'snapshot.sqlite');
  await store.createDeployDbSnapshot(snapshotPath);
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS count FROM deploy_servers WHERE name = 'wal-server'").get().count, 1);
  } finally {
    snapshot.close();
  }

  const rawCopyPath = path.join(root, 'raw-copy.sqlite');
  await fs.copyFile(process.env.DEPLOY_DB_PATH, rawCopyPath);
  const rawCopy = new DatabaseSync(rawCopyPath, { readOnly: true });
  try {
    const hasTable = rawCopy.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'deploy_servers'").get().count;
    const rows = hasTable ? rawCopy.prepare("SELECT COUNT(*) AS count FROM deploy_servers WHERE name = 'wal-server'").get().count : 0;
    assert.equal(rows, 0, '旧的 copyFile 备份方式在 WAL 下无法拿到最新数据');
  } finally {
    rawCopy.close();
  }
});

test('读事务进行中写入不被阻塞（WAL 读写并发）', async () => {
  const reader = new DatabaseSync(process.env.DEPLOY_DB_PATH, { readOnly: true });
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM deploy_servers').get();
    await inTeam(() =>
      store.createServer({ name: 'concurrent-write', host: '127.0.0.2', port: 22, username: 'u', authType: 'password', password: 'p', defaultBackendRoot: '/tmp' })
    );
    reader.exec('COMMIT');
  } finally {
    reader.close();
  }
  const servers = await inTeam(() => store.listServers());
  assert.ok(servers.some((server) => server.name === 'concurrent-write'));
});
