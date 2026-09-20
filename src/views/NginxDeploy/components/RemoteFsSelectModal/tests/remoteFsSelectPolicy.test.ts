import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPathWithinAnyRoot,
  isSubPathOrEqual,
  normalizePosix,
} from '../constant.ts';

test('isSubPathOrEqual: 正确识别受限根与子路径边界', () => {
  const root = '/opt/yuyan/html';

  // 精准命中允许根自身
  assert.equal(isSubPathOrEqual('/opt/yuyan/html', root), true);
  assert.equal(isSubPathOrEqual('/opt/yuyan/html/', root), true);

  // 命中合法深层子目录
  assert.equal(isSubPathOrEqual('/opt/yuyan/html/outsourced', root), true);
  assert.equal(isSubPathOrEqual('/opt/yuyan/html/system/dist', root), true);

  // 阻断受限根之上的祖先路径（面包屑上级段），防止 403
  assert.equal(isSubPathOrEqual('/opt/yuyan', root), false);
  assert.equal(isSubPathOrEqual('/opt', root), false);
  assert.equal(isSubPathOrEqual('/', root), false);

  // 阻断非法平级同前缀逃逸路径
  assert.equal(isSubPathOrEqual('/opt/yuyan/html-escape', root), false);
  assert.equal(isSubPathOrEqual('/etc/nginx', root), false);
});

test('isPathWithinAnyRoot: 支持多受限作用域根联合判定', () => {
  const roots = [
    { path: '/opt/yuyan/html' },
    { path: '/etc/nginx/conf.d' },
  ];

  assert.equal(isPathWithinAnyRoot('/opt/yuyan/html/taskFlow', roots), true);
  assert.equal(isPathWithinAnyRoot('/etc/nginx/conf.d/vhost.conf', roots), true);

  // 任何在所有根之外的路径一律判定不可访问
  assert.equal(isPathWithinAnyRoot('/opt/yuyan', roots), false);
  assert.equal(isPathWithinAnyRoot('/etc/nginx', roots), false);
  assert.equal(isPathWithinAnyRoot('/var/log', roots), false);
});

test('normalizePosix: 规范化各种反斜杠与冗余斜杠路径', () => {
  assert.equal(normalizePosix('//opt//yuyan///html/'), '/opt/yuyan/html');
  assert.equal(normalizePosix('\\opt\\yuyan\\html'), '/opt/yuyan/html');
  assert.equal(normalizePosix(''), '/');
});

test('隐藏条目过滤规则: 仅保留业务目录和虚拟上一级，默认隐藏点开头项', () => {
  const mockEntries = [
    { name: '..', type: 'parent_dir' },
    { name: '.vite', type: 'directory' },
    { name: '.yuyan-backups', type: 'directory' },
    { name: '.yuyan-manifests', type: 'directory' },
    { name: 'outsourced', type: 'directory' },
    { name: 'system', type: 'directory' },
    { name: 'taskFlow', type: 'directory' },
  ];

  // 默认过滤 (showHidden = false)
  const filtered = mockEntries.filter((item) => {
    if (item.type === 'parent_dir') return true;
    if (item.type !== 'directory') return false;
    return !item.name.startsWith('.');
  });

  assert.deepEqual(
    filtered.map((e) => e.name),
    ['..', 'outsourced', 'system', 'taskFlow']
  );

  // 开启显示隐藏项 (showHidden = true)
  const allDirs = mockEntries.filter((item) => item.type === 'parent_dir' || item.type === 'directory');
  assert.equal(allDirs.length, 7);
});
