import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// 与 deploy-store-wal.test.mjs 相同的环境隔离模式
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-current-ids-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'current-ids-test';

const { getCurrentRecordIdsByTarget, closeDeployDb } = await import('../deploy-store.mjs');

after(async () => {
  closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * 逐条查询 baseline 实现（原算法），用于对比大批量查询等价性。
 * @param {DatabaseSync} db
 * @param {number[]} targetIds
 * @returns {Map<number, number>}
 */
function baselineGetCurrentRecordIds(db, targetIds) {
  const result = new Map();
  const ids = Array.from(new Set((targetIds || []).map((id) => (Number(id) > 0 ? Number(id) : 0)).filter(Boolean)));
  if (!ids.length) return result;
  const stmt = db.prepare(
    `SELECT id
     FROM deploy_records
     WHERE target_id = ? AND status = 'success'
     ORDER BY started_at DESC, id DESC
     LIMIT 1`
  );
  ids.forEach((targetId) => {
    const row = stmt.get(targetId);
    if (row?.id) result.set(targetId, Number(row.id));
  });
  return result;
}

/** 建一张仅含本查询涉及列的最小表。 */
function createFixture() {
  const db = new DatabaseSync(path.join(root, `fixture-${crypto.randomUUID()}.sqlite`));
  db.exec(`
    CREATE TABLE deploy_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare('INSERT INTO deploy_records (target_id, status, started_at) VALUES (?, ?, ?)');
  return { db, insert };
}

test('getCurrentRecordIdsByTarget：每个 target 取最新 success', () => {
  const { db, insert } = createFixture();
  insert.run(1, 'success', '2026-01-01T00:00:00Z');
  insert.run(1, 'success', '2026-01-03T00:00:00Z'); // 最新
  insert.run(2, 'success', '2026-01-02T00:00:00Z');

  const result = getCurrentRecordIdsByTarget(db, [1, 2]);
  assert.equal(result.get(1), 2);
  assert.equal(result.get(2), 3);
  assert.equal(result.size, 2);
  db.close();
});

test('getCurrentRecordIdsByTarget：失败/running 记录不影响最新 success，无成功记录的不返回', () => {
  const { db, insert } = createFixture();
  insert.run(1, 'success', '2026-01-01T00:00:00Z');
  insert.run(1, 'failed', '2026-01-04T00:00:00Z'); // 更新的失败记录不影响之前的成功记录
  insert.run(2, 'failed', '2026-01-01T00:00:00Z');
  insert.run(2, 'running', '2026-01-02T00:00:00Z');

  const result = getCurrentRecordIdsByTarget(db, [1, 2]);
  assert.equal(result.get(1), 1);
  assert.equal(result.has(2), false);
  assert.equal(result.size, 1);
  db.close();
});

test('getCurrentRecordIdsByTarget：started_at 相同取大 id', () => {
  const { db, insert } = createFixture();
  insert.run(1, 'success', '2026-01-01T00:00:00Z');
  insert.run(1, 'success', '2026-01-01T00:00:00Z'); // 同一时间，id 较大为 2

  const result = getCurrentRecordIdsByTarget(db, [1]);
  assert.equal(result.get(1), 2);
  db.close();
});

test('getCurrentRecordIdsByTarget：空输入、非法 ID 与重复 ID 边界', () => {
  const { db, insert } = createFixture();
  insert.run(1, 'success', '2026-01-01T00:00:00Z');

  assert.deepEqual([...getCurrentRecordIdsByTarget(db, [])], []);
  assert.deepEqual([...getCurrentRecordIdsByTarget(db, null)], []);
  assert.deepEqual([...getCurrentRecordIdsByTarget(db, undefined)], []);
  assert.deepEqual([...getCurrentRecordIdsByTarget(db, [0, -1, 'abc', null, undefined])], []);

  // 重复 ID 去重后正常返回
  const result = getCurrentRecordIdsByTarget(db, [1, 1, '1']);
  assert.equal(result.get(1), 1);
  assert.equal(result.size, 1);
  db.close();
});

test('getCurrentRecordIdsByTarget：未请求的 target 不出现在结果里（只返回请求的 target）', () => {
  const { db, insert } = createFixture();
  insert.run(1, 'success', '2026-01-01T00:00:00Z');
  insert.run(2, 'success', '2026-01-02T00:00:00Z');
  insert.run(3, 'success', '2026-01-03T00:00:00Z'); // 未请求 target 3

  const result = getCurrentRecordIdsByTarget(db, [1, 2]);
  assert.equal(result.size, 2);
  assert.equal(result.get(1), 1);
  assert.equal(result.get(2), 2);
  assert.equal(result.has(3), false);
  db.close();
});

test('getCurrentRecordIdsByTarget：超过 500 个 target（如 1203 个）跨分块结果完整无遗漏且与逐条查询结果逐一相等，prepare 次数 ≤ 3', () => {
  const { db, insert } = createFixture();
  const targetCount = 1203;

  db.exec('BEGIN TRANSACTION');
  for (let t = 1; t <= targetCount; t += 1) {
    insert.run(t, 'success', '2026-01-01T00:00:00Z');
    insert.run(t, 'success', '2026-01-02T00:00:00Z'); // 较新的 success
    if (t % 2 === 0) {
      insert.run(t, 'failed', '2026-01-03T00:00:00Z'); // 部分 target 有更新的 failed
    }
  }
  // 插入一个未请求的 target
  insert.run(99999, 'success', '2026-01-05T00:00:00Z');
  db.exec('COMMIT');

  const targets = Array.from({ length: targetCount }, (_, i) => i + 1);

  // 观测 prepare 调用次数：
  // 1203 个 target 按 500 分块：500、500、203。
  // 前两次 chunk 长度均为 500，复用 cachedStmt；第三次长度 203，新 prepare 一次。总 prepare 调用次数应为 2。
  const originalPrepare = db.prepare.bind(db);
  let prepareCalls = 0;
  db.prepare = (...args) => {
    prepareCalls += 1;
    return originalPrepare(...args);
  };

  const result = getCurrentRecordIdsByTarget(db, targets);
  assert.ok(prepareCalls <= 3, `prepare 调用次数应 ≤ 3，实际为 ${prepareCalls}`);

  // 与逐条查询（原算法）结果逐一比对
  const baseline = baselineGetCurrentRecordIds(db, targets);
  assert.equal(result.size, targetCount);
  assert.equal(result.size, baseline.size);
  for (const [targetId, expectedRecordId] of baseline) {
    assert.equal(result.get(targetId), expectedRecordId, `targetId ${targetId} 结果应一致`);
  }

  // 确认未请求的 target 不在结果里
  assert.equal(result.has(99999), false);

  db.close();
});
