import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEditingFileName,
  describeHistoryItem,
  describeSaveFailure,
  formatBeijingShort,
  formatBeijingTime,
  formatFileSize,
  formatRelativeTime,
  isReadonlyNginxRole,
  resolveConfigFileName,
  resolveHistoryItemTime,
  resolveRestoreHint,
  sanitizeDownloadName,
} from '../historyPolicy.ts';

test('formatBeijingTime: UTC 时间换算为北京时间（含跨日）', () => {
  assert.equal(formatBeijingTime('2026-11-12T08:30:05.000Z'), '2026-11-12 16:30:05');
  assert.equal(formatBeijingTime('2026-12-31T16:00:00.000Z'), '2027-01-01 00:00:00');
  assert.equal(formatBeijingTime('not a date'), '');
  assert.equal(formatBeijingShort('2026-11-12T08:30:05.000Z'), '11-12 16:30');
});

test('formatRelativeTime: 相对时间分档', () => {
  const now = Date.parse('2026-11-12T08:30:00.000Z');
  assert.equal(formatRelativeTime('2026-11-12T08:29:30.000Z', now), '刚刚');
  assert.equal(formatRelativeTime('2026-11-12T08:25:00.000Z', now), '5 分钟前');
  assert.equal(formatRelativeTime('2026-11-12T05:30:00.000Z', now), '3 小时前');
  assert.equal(formatRelativeTime('2026-11-10T08:30:00.000Z', now), '2 天前');
  assert.equal(formatRelativeTime('2026-08-01T08:30:00.000Z', now), '3 个月前');
  assert.equal(formatRelativeTime('2024-01-01T00:00:00.000Z', now), '2 年前');
  // 服务器时钟比本机快时不显示负数
  assert.equal(formatRelativeTime('2026-11-12T09:30:00.000Z', now), '刚刚');
  assert.equal(formatRelativeTime('', now), '');
});

test('formatFileSize', () => {
  assert.equal(formatFileSize(812), '812 B');
  assert.equal(formatFileSize(12_698), '12.4 KB');
  assert.equal(formatFileSize(3 * 1024 * 1024), '3.00 MB');
  assert.equal(formatFileSize(Number.NaN), '0 B');
});

test('历史条目时间与描述：平台备份用文件名时间，外部备份用 mtime', () => {
  const yuyan = { name: 'nginx.conf.bak.20261112083005', source: 'yuyan' as const, createdAt: '2026-11-12T08:30:05.000Z', mtime: '2026-11-12T08:30:06.000Z' };
  const external = { name: 'nginx.conf.bak.old', source: 'external' as const, createdAt: '', mtime: '2026-10-01T02:00:00.000Z' };
  assert.equal(resolveHistoryItemTime(yuyan), yuyan.createdAt);
  assert.equal(resolveHistoryItemTime(external), external.mtime);
  assert.equal(describeHistoryItem(yuyan), '11-12 16:30 的版本');
  assert.equal(describeHistoryItem(external), '外部备份 nginx.conf.bak.old（修改于 10-01 10:00）');
  assert.equal(describeHistoryItem({ ...external, mtime: '' }), '外部备份 nginx.conf.bak.old');
});

test('下载文件名：取真实文件名、编辑中插入 .editing、清理非法字符', () => {
  assert.equal(resolveConfigFileName('/home/nginx/conf/nginx.conf'), 'nginx.conf');
  assert.equal(resolveConfigFileName('C:\\nginx\\conf\\site.conf'), 'site.conf');
  assert.equal(resolveConfigFileName(''), 'nginx.conf');
  assert.equal(resolveConfigFileName('/etc/nginx/'), 'nginx');
  assert.equal(buildEditingFileName('nginx.conf'), 'nginx.editing.conf');
  assert.equal(buildEditingFileName('default'), 'default.editing');
  assert.equal(buildEditingFileName('.htaccess'), '.htaccess.editing');
  assert.equal(sanitizeDownloadName('a:b*c?.conf'), 'a_b_c_.conf');
  assert.equal(sanitizeDownloadName('..'), '');
});

test('describeSaveFailure: 区分校验失败已还原 / 重载失败已回滚 / 回滚失败 / 冲突', () => {
  const testFail = describeSaveFailure({ response: { status: 400, data: { code: 'NGINX_TEST_FAILED', details: { stage: 'test', rolledBack: true, backupPath: '/a.bak.1' } } } });
  assert.equal(testFail.kind, 'test');
  assert.equal(testFail.headline, '语法校验未通过，已还原，线上未变更');
  assert.equal(testFail.severe, false);

  const reloadFail = describeSaveFailure({ response: { status: 400, data: { code: 'NGINX_RELOAD_FAILED', details: { stage: 'reload', rolledBack: true, restoreTestOk: true } } } });
  assert.equal(reloadFail.kind, 'reload');
  assert.match(reloadFail.headline, /重载失败，已自动回滚/);
  assert.equal(reloadFail.severe, false);

  const reloadRetestFail = describeSaveFailure({ response: { data: { details: { stage: 'reload', rolledBack: true, restoreTestOk: false } } } });
  assert.equal(reloadRetestFail.severe, true);

  const rollbackFail = describeSaveFailure({ response: { data: { details: { stage: 'reload', rolledBack: false, backupPath: '/home/nginx/conf/nginx.conf.bak.20261112083005' } } } });
  assert.equal(rollbackFail.kind, 'rollback-failed');
  assert.equal(rollbackFail.severe, true);
  assert.equal(rollbackFail.backupPath, '/home/nginx/conf/nginx.conf.bak.20261112083005');
  assert.match(rollbackFail.detail, /手动恢复/);

  const noBackup = describeSaveFailure({ response: { data: { details: { stage: 'test', rolledBack: false, backupPath: '', rollbackError: '写入前备份失败' } } } });
  assert.equal(noBackup.kind, 'rollback-failed');
  assert.match(noBackup.detail, /写入前备份失败/);

  assert.equal(describeSaveFailure({ response: { status: 409, data: { code: 'NGINX_CONF_CHANGED' } } }).kind, 'conflict');
  assert.equal(describeSaveFailure({ response: { data: { details: { stage: 'test', rolledBack: true, unchanged: true } } } }).headline, '语法校验未通过，线上配置未变更');
  // 老后端（没有 details）
  assert.equal(describeSaveFailure(new Error('nginx: [emerg] x')).kind, 'other');
  assert.equal(describeSaveFailure(null).kind, 'other');
});

test('isReadonlyNginxRole / resolveRestoreHint', () => {
  assert.equal(isReadonlyNginxRole('viewer'), true);
  assert.equal(isReadonlyNginxRole('operator'), false);
  assert.equal(isReadonlyNginxRole(''), false);
  assert.equal(isReadonlyNginxRole(undefined), false);
  assert.match(resolveRestoreHint('11-12 16:30 的版本', true), /^已载入 11-12 16:30 的版本，点击「保存并重载」后生效/);
  assert.equal(resolveRestoreHint('11-12 16:30 的版本', false), '');
  assert.equal(resolveRestoreHint('', true), '');
});
