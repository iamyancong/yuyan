import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  cleanupExpiredDbRows,
  parseDbLogRetentionDays,
  parseDbRetentionIntervalHours,
} from '../db-retention-service.mjs';

const NOW = Date.parse('2026-11-16T03:00:00.000Z');
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

/** 内存库：只建清理涉及的表（列与生产表一致的子集）+ 发布记录 */
function createDb({ withCentral = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE deploy_records (id INTEGER PRIMARY KEY, status TEXT, started_at TEXT);
    CREATE TABLE deploy_tasks (id INTEGER PRIMARY KEY, target_id INTEGER, status TEXT, started_at TEXT, heartbeat_at TEXT, finished_at TEXT);
    CREATE TABLE backend_releases (id INTEGER PRIMARY KEY, target_id INTEGER, status TEXT, is_current INTEGER, created_at TEXT, activated_at TEXT);
    CREATE TABLE artifact_jobs (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT);
  `);
  if (withCentral) {
    db.exec(`
      CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, status TEXT, refresh_expires_at TEXT, revoked_at TEXT, updated_at TEXT);
      CREATE TABLE auth_refresh_nonces (session_id TEXT, nonce TEXT, created_at TEXT, PRIMARY KEY(session_id, nonce));
    `);
  }
  return db;
}

const ids = (db, table) => db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((row) => row.id);

test('环境变量解析：默认 90 天、0 关闭、非法值回退；间隔默认 24 小时最低 1 小时', () => {
  assert.equal(parseDbLogRetentionDays(undefined), 90);
  assert.equal(parseDbLogRetentionDays('30'), 30);
  assert.equal(parseDbLogRetentionDays('0'), 0);
  assert.equal(parseDbLogRetentionDays('-3'), 90);
  assert.equal(parseDbLogRetentionDays('abc'), 90);
  assert.equal(parseDbRetentionIntervalHours(undefined), 24);
  assert.equal(parseDbRetentionIntervalHours('0.2'), 1);
  assert.equal(parseDbRetentionIntervalHours('12'), 12);
});

test('只清理超过保留期、已结束且没有功能依赖的行；发布记录、运行中任务、当前版本不动', () => {
  const db = createDb();
  const insertRecord = db.prepare('INSERT INTO deploy_records VALUES (?, ?, ?)');
  insertRecord.run(1, 'success', daysAgo(400));
  insertRecord.run(2, 'failed', daysAgo(200));

  const task = db.prepare('INSERT INTO deploy_tasks VALUES (?, ?, ?, ?, ?, ?)');
  task.run(1, 1, 'succeeded', daysAgo(120), daysAgo(120), daysAgo(120)); // 删
  task.run(2, 1, 'failed', daysAgo(100), daysAgo(100), ''); // finished_at 为空，按 heartbeat 判断：删
  task.run(3, 1, 'running', daysAgo(200), daysAgo(200), ''); // 运行中：留
  task.run(4, 1, 'queued', daysAgo(200), daysAgo(200), ''); // 排队中：留
  task.run(5, 1, 'succeeded', daysAgo(10), daysAgo(10), daysAgo(10)); // 未过期：留

  const release = db.prepare('INSERT INTO backend_releases VALUES (?, ?, ?, ?, ?, ?)');
  release.run(1, 1, 'pruned', 0, daysAgo(150), daysAgo(140)); // 删
  release.run(2, 1, 'active', 1, daysAgo(300), daysAgo(300)); // 当前版本：留
  release.run(3, 1, 'uploaded', 0, daysAgo(300), ''); // 未清理的历史版本（可回滚）：留
  release.run(4, 1, 'pruned', 0, daysAgo(30), ''); // 未过期：留

  const job = db.prepare('INSERT INTO artifact_jobs VALUES (?, ?, ?)');
  job.run('a', 'expired', daysAgo(95)); // 删
  job.run('b', 'expired', daysAgo(5)); // 留
  job.run('c', 'succeeded', daysAgo(300)); // 非 expired：留

  const session = db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?)');
  session.run('s-revoked-old', 'revoked', daysAgo(10), daysAgo(120), daysAgo(120)); // 删
  session.run('s-expired-old', 'active', daysAgo(100), null, daysAgo(130)); // 刷新令牌早已过期：删
  session.run('s-active', 'active', new Date(NOW + 86400000).toISOString(), null, daysAgo(200)); // 留
  session.run('s-revoked-recent', 'revoked', daysAgo(1), daysAgo(1), daysAgo(1)); // 留
  const nonce = db.prepare('INSERT INTO auth_refresh_nonces VALUES (?, ?, ?)');
  for (const id of ['s-revoked-old', 's-expired-old', 's-active', 's-revoked-recent']) nonce.run(id, 'n1', daysAgo(150));

  const messages = [];
  const result = cleanupExpiredDbRows(db, { retentionDays: 90, now: NOW, log: (m) => messages.push(m) });

  assert.deepEqual(ids(db, 'deploy_records'), [1, 2], '发布记录一行都不删');
  assert.deepEqual(ids(db, 'deploy_tasks'), [3, 4, 5]);
  assert.deepEqual(ids(db, 'backend_releases'), [2, 3, 4]);
  assert.deepEqual(ids(db, 'artifact_jobs'), ['b', 'c']);
  assert.deepEqual(ids(db, 'auth_sessions'), ['s-active', 's-revoked-recent']);
  assert.deepEqual(
    db.prepare('SELECT session_id FROM auth_refresh_nonces ORDER BY session_id').all().map((row) => row.session_id),
    ['s-active', 's-revoked-recent'],
    'nonce 跟随失效会话一起删'
  );
  assert.deepEqual(result.deleted, { deploy_tasks: 2, backend_releases: 1, artifact_jobs: 1, auth_refresh_nonces: 2, auth_sessions: 2 });
  assert.equal(result.total, 8);
  assert.ok(messages.some((m) => m.includes('已结束的部署任务过程记录 2 行')));
  assert.ok(messages.at(-1).includes('本轮共清理 8 行'));

  // 再跑一次是幂等的
  assert.equal(cleanupExpiredDbRows(db, { retentionDays: 90, now: NOW, log: () => {} }).total, 0);
});

test('保留天数为 0 时不清理；没有中央表（本机模式）也能运行', () => {
  const db = createDb({ withCentral: false });
  db.prepare('INSERT INTO deploy_tasks VALUES (1, 1, ?, ?, ?, ?)').run('succeeded', daysAgo(500), daysAgo(500), daysAgo(500));
  assert.equal(cleanupExpiredDbRows(db, { retentionDays: 0, now: NOW }).total, 0);
  assert.deepEqual(ids(db, 'deploy_tasks'), [1]);
  const result = cleanupExpiredDbRows(db, { retentionDays: 90, now: NOW, log: () => {} });
  assert.deepEqual(result.deleted, { deploy_tasks: 1, backend_releases: 0, artifact_jobs: 0 });
});

test('清理出错时整体回滚', () => {
  const db = createDb();
  db.prepare('INSERT INTO deploy_tasks VALUES (1, 1, ?, ?, ?, ?)').run('succeeded', daysAgo(500), daysAgo(500), daysAgo(500));
  // 把 artifact_jobs 换成缺列的表，让第三条规则报错
  db.exec('DROP TABLE artifact_jobs; CREATE TABLE artifact_jobs (id TEXT PRIMARY KEY)');
  assert.throws(() => cleanupExpiredDbRows(db, { retentionDays: 90, now: NOW, log: () => {} }));
  assert.deepEqual(ids(db, 'deploy_tasks'), [1], '前面删掉的行应随事务回滚');
});
