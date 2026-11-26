import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCertExpiry,
  formatBackupRunContext,
  formatBackupSize,
  formatDuration,
  resolveBackupStatusTag,
  resolveCentralBackupPermissions,
  readSystemAdminFlag,
  shouldShowCentralBackupEntry,
  truncateSha256,
  validateBackupRemoteDirClient,
} from '../centralBackupPolicy.ts';

test('resolveBackupStatusTag: 状态与运行态映射', () => {
  assert.deepEqual(resolveBackupStatusTag('success', false), { color: 'success', text: '成功' });
  assert.deepEqual(resolveBackupStatusTag('failed', false), { color: 'error', text: '失败' });
  assert.deepEqual(resolveBackupStatusTag('running', false), { color: 'processing', text: '执行中' });
  assert.deepEqual(resolveBackupStatusTag('success', true), { color: 'processing', text: '执行中' });
  assert.deepEqual(resolveBackupStatusTag('', false), { color: 'default', text: '尚未执行' });
});

test('formatBackupSize & truncateSha256', () => {
  assert.equal(formatBackupSize(0), '0 B');
  assert.equal(formatBackupSize(512), '512 B');
  assert.equal(formatBackupSize(1536), '1.5 KB');
  assert.equal(formatBackupSize(2 * 1024 * 1024), '2.00 MB');
  assert.equal(truncateSha256('', 12), '-');
  assert.equal(truncateSha256('abcdef1234567890', 8), 'abcdef12…');
});

test('classifyCertExpiry: 证书到期分级（已过期红、30天内橙、30天以上绿、未知灰）', () => {
  const now = Date.parse('2026-11-25T00:00:00.000Z');
  assert.equal(classifyCertExpiry(null, now).color, 'default');
  assert.equal(classifyCertExpiry('not-a-date', now).status, 'unknown');
  assert.equal(classifyCertExpiry('2026-11-24T00:00:00.000Z', now).status, 'expired');
  assert.equal(classifyCertExpiry('2026-11-24T00:00:00.000Z', now).color, 'error');
  assert.equal(classifyCertExpiry('2026-12-10T00:00:00.000Z', now).status, 'expiring');
  assert.equal(classifyCertExpiry('2026-12-10T00:00:00.000Z', now).color, 'warning');
  assert.equal(classifyCertExpiry('2027-06-01T00:00:00.000Z', now).status, 'valid');
  assert.equal(classifyCertExpiry('2027-06-01T00:00:00.000Z', now).color, 'success');
});

test('resolveCentralBackupPermissions: 角色权限矩阵', () => {
  assert.deepEqual(resolveCentralBackupPermissions('admin'), {
    canEditSettings: true,
    canTriggerBackup: true,
    canTriggerPatrol: true,
    readonlyReason: '',
  });
  assert.deepEqual(resolveCentralBackupPermissions('operator'), {
    canEditSettings: false,
    canTriggerBackup: true,
    canTriggerPatrol: true,
    readonlyReason: '',
  });
  assert.deepEqual(resolveCentralBackupPermissions('viewer'), {
    canEditSettings: false,
    canTriggerBackup: false,
    canTriggerPatrol: false,
    readonlyReason: '只读账号不能触发备份',
  });
});

test('validateBackupRemoteDirClient: 与后端一致的目录校验正反例', () => {
  assert.equal(validateBackupRemoteDirClient('/bak/wangyancong-yuyan/').valid, true);
  assert.equal(validateBackupRemoteDirClient('/bak/wangyancong-yuyan/').normalized, '/bak/wangyancong-yuyan');
  assert.equal(validateBackupRemoteDirClient('/root/yuyan-bak').valid, true);

  for (const bad of ['', 'bak/a', '/', '/bak', '/root', '/etc/yuyan', '/var/run/x', '/bak/../etc', '/bak/a b', '/bak/"x"']) {
    assert.equal(validateBackupRemoteDirClient(bad).valid, false, `应拒绝 ${bad}`);
  }
});

test('formatDuration & formatBackupRunContext', () => {
  assert.equal(formatDuration(null), '-');
  assert.equal(formatDuration(undefined), '-');
  assert.equal(formatDuration(-10), '-');
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(456), '456 ms');
  assert.equal(formatDuration(999), '999 ms');
  assert.equal(formatDuration(1000), '1.0 秒');
  assert.equal(formatDuration(2340), '2.3 秒');

  assert.equal(formatBackupRunContext('manual', 'alice'), '手动 · alice');
  assert.equal(formatBackupRunContext('schedule', 'system'), '定时 · system');
  assert.equal(formatBackupRunContext('manual', ''), '手动');
  assert.equal(formatBackupRunContext('', ''), '');
});

test('shouldShowCentralBackupEntry: 仅系统管理员展示入口，未配置或非白名单均隐藏', () => {
  assert.equal(shouldShowCentralBackupEntry(true), true);
  assert.equal(shouldShowCentralBackupEntry(false), false);
  assert.equal(shouldShowCentralBackupEntry(undefined), false);
  assert.equal(shouldShowCentralBackupEntry(null), false);
});

test('readSystemAdminFlag: 缺失或空的 authState 不得抛错，并视为非管理员', () => {
  assert.equal(readSystemAdminFlag(undefined), false);
  assert.equal(readSystemAdminFlag(null), false);
  assert.equal(readSystemAdminFlag({}), false);
  assert.equal(readSystemAdminFlag({ value: undefined }), false);
  assert.equal(readSystemAdminFlag({ value: null }), false);
  assert.equal(readSystemAdminFlag({ value: {} }), false);
  assert.equal(readSystemAdminFlag({ value: { isSystemAdmin: false } }), false);
});

test('readSystemAdminFlag: 仅在 authState.value.isSystemAdmin 为 true 时返回 true', () => {
  assert.equal(readSystemAdminFlag({ value: { isSystemAdmin: true } }), true);
  assert.equal(shouldShowCentralBackupEntry(readSystemAdminFlag(undefined)), false);
  assert.equal(shouldShowCentralBackupEntry(readSystemAdminFlag({ value: { isSystemAdmin: true } })), true);
});
