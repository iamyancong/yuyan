import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFsDownloadTimestamp,
  sanitizeFsFileNamePart,
} from '../remote-fs-service.mjs';

test('formatFsDownloadTimestamp 能够生成固定长度的纯数字时间戳', () => {
  const fixedDate = new Date('2026-09-24T14:15:30Z');
  const timestamp = formatFsDownloadTimestamp(fixedDate);
  assert.equal(timestamp.length, 14);
  assert.match(timestamp, /^\d{14}$/);
});

test('sanitizeFsFileNamePart 过滤非法字符与特殊符号并保留有效字符', () => {
  assert.equal(sanitizeFsFileNamePart('my folder name', 'fallback'), 'my-folder-name');
  assert.equal(sanitizeFsFileNamePart('path/to/folder:special?*', 'fallback'), 'path-to-folder-special');
  assert.equal(sanitizeFsFileNamePart('', 'default-dir'), 'default-dir');
  assert.equal(sanitizeFsFileNamePart('   ', 'fallback'), 'fallback');
  assert.equal(sanitizeFsFileNamePart('华贵委外 192.168.1.1', 'fallback'), '华贵委外-192.168.1.1');
});
