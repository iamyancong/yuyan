import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSnapshotSourceLabel, resolveCentralRestoreState } from '../centralRestorePolicy.ts';

test('formatSnapshotSourceLabel: 映射中文来源标签', () => {
  assert.equal(formatSnapshotSourceLabel('save'), '在线保存');
  assert.equal(formatSnapshotSourceLabel('sync'), '站点同步');
  assert.equal(formatSnapshotSourceLabel('init'), '托管初始化');
  assert.equal(formatSnapshotSourceLabel('patrol'), '每日巡检');
  assert.equal(formatSnapshotSourceLabel(''), '未知来源');
});

test('resolveCentralRestoreState: 快照缺失禁用、sha 一致禁用、不一致或线上不存在可用', () => {
  assert.deepEqual(
    resolveCentralRestoreState({
      snapshot: null,
      remoteExists: true,
      remoteSha256: 'abc',
    }),
    { available: false, reason: '中央暂无备份' }
  );

  assert.deepEqual(
    resolveCentralRestoreState({
      snapshot: { exists: false, path: '/etc/nginx/a.conf' },
      remoteExists: true,
      remoteSha256: 'abc',
    }),
    { available: false, reason: '中央暂无备份' }
  );

  assert.deepEqual(
    resolveCentralRestoreState({
      snapshot: { exists: true, path: '/etc/nginx/a.conf', content: 'x', sha256: 'AbC123' },
      remoteExists: true,
      remoteSha256: 'abc123',
    }),
    { available: false, reason: '与线上一致' }
  );

  assert.deepEqual(
    resolveCentralRestoreState({
      snapshot: { exists: true, path: '/etc/nginx/a.conf', content: 'x', sha256: 'def456' },
      remoteExists: true,
      remoteSha256: 'abc123',
    }),
    { available: true, reason: '' }
  );

  // 线上文件已删除但中央有快照 -> 允许恢复
  assert.deepEqual(
    resolveCentralRestoreState({
      snapshot: { exists: true, path: '/etc/nginx/a.conf', content: 'x', sha256: 'abc123' },
      remoteExists: false,
      remoteSha256: '',
    }),
    { available: true, reason: '' }
  );
});
