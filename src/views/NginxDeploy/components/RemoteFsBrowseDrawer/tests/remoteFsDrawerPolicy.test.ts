import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatFileSize,
  formatDateTime,
  getFileVisualBadge,
  normalizePosix,
  isSubPathOrEqual,
  isPathWithinAnyRoot,
} from '../constant.ts';

test('formatFileSize: 格式化各种字节大小', () => {
  assert.equal(formatFileSize(null), '-');
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(419), '419 B');
  assert.equal(formatFileSize(1024), '1.0 KB');
  assert.equal(formatFileSize(23552), '23 KB');
  assert.equal(formatFileSize(1048576), '1.0 MB');
});

test('formatDateTime: 正确格式化日期时间与处理空值', () => {
  assert.equal(formatDateTime(null), '-');
  assert.equal(formatDateTime(0), '-');
  const timestamp = new Date('2026-09-23T14:30:00+08:00').getTime();
  const formatted = formatDateTime(timestamp);
  assert.match(formatted, /^2026-09-23/);
});

test('getFileVisualBadge: 正确推断文件分类与徽章标签', () => {
  assert.deepEqual(getFileVisualBadge('..', 'parent_dir'), { category: 'parent_dir', tag: '..' });
  assert.deepEqual(getFileVisualBadge('assets', 'directory'), { category: 'directory', tag: 'DIR' });
  assert.deepEqual(getFileVisualBadge('main.ts', 'file'), { category: 'code', tag: 'JS' });
  assert.deepEqual(getFileVisualBadge('index.html', 'file'), { category: 'page', tag: '</>' });
  assert.deepEqual(getFileVisualBadge('nginx.conf', 'file'), { category: 'config', tag: 'CFG' });
  assert.deepEqual(getFileVisualBadge('package.json', 'file'), { category: 'config', tag: '{}' });
  assert.deepEqual(getFileVisualBadge('bundle.tar.gz', 'file'), { category: 'archive', tag: 'ZIP' });
  assert.deepEqual(getFileVisualBadge('logo.svg', 'file'), { category: 'image', tag: 'IMG' });
  assert.deepEqual(getFileVisualBadge('error.log', 'file'), { category: 'log', tag: 'LOG' });
  assert.deepEqual(getFileVisualBadge('binary.bin', 'file'), { category: 'default', tag: 'FILE' });
});

test('normalizePosix: 标准化 POSIX 路径', () => {
  assert.equal(normalizePosix('///opt///yuyan/html///'), '/opt/yuyan/html');
  assert.equal(normalizePosix('\\etc\\nginx'), '/etc/nginx');
  assert.equal(normalizePosix(''), '/');
});

test('isSubPathOrEqual & isPathWithinAnyRoot: 权限范围控制判定', () => {
  const roots = [
    { path: '/opt/yuyan/html' },
    { path: '/etc/nginx' },
  ];

  assert.equal(isSubPathOrEqual('/opt/yuyan/html/taskFlow', '/opt/yuyan/html'), true);
  assert.equal(isSubPathOrEqual('/opt/yuyan', '/opt/yuyan/html'), false);

  assert.equal(isPathWithinAnyRoot('/etc/nginx/conf.d/vhost.conf', roots), true);
  assert.equal(isPathWithinAnyRoot('/root', roots), false);
});
