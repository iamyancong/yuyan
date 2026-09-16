import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRecordCommitSummary,
  ROLLBACK_EXECUTION_NOTICES,
  UNDO_ROLLBACK_EXECUTION_NOTICES,
  type DeployRecord,
} from '../constant.ts';



test('getRecordCommitSummary 能正确提取与回退空值', () => {
  const emptySummary = getRecordCommitSummary(null);
  assert.deepEqual(emptySummary, {
    sha: '-',
    message: '-',
    author: '-',
    time: '-',
  });

  const record: Partial<DeployRecord> = {
    commitSha: 'abcdef1234567890',
    commitMessage: 'feat: new feature release',
    commitAuthor: 'developer-a',
    finishedAt: '2026-03-30T10:00:00.000Z',
  };

  const summary = getRecordCommitSummary(record as DeployRecord);
  assert.equal(summary.sha, 'abcdef12');
  assert.equal(summary.message, 'feat: new feature release');
  assert.equal(summary.author, 'developer-a');
  assert.notEqual(summary.time, '-');
});

test('回滚与撤销回滚执行提示清单保持完整且具备安全性保证', () => {
  assert.equal(ROLLBACK_EXECUTION_NOTICES.length, 4);
  assert.ok(ROLLBACK_EXECUTION_NOTICES.some((n) => n.title.includes('秒级恢复')));
  assert.ok(ROLLBACK_EXECUTION_NOTICES.some((n) => n.title.includes('安全可逆')));

  assert.equal(UNDO_ROLLBACK_EXECUTION_NOTICES.length, 3);
  assert.ok(UNDO_ROLLBACK_EXECUTION_NOTICES.some((n) => n.title.includes('秒级复原')));
  assert.ok(UNDO_ROLLBACK_EXECUTION_NOTICES.some((n) => n.title.includes('恢复状态')));
});
