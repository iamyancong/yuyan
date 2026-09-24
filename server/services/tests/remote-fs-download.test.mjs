import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  formatFsDownloadTimestamp,
  sanitizeFsFileNamePart,
} from '../remote-fs-service.mjs';
import { buildSafeContentDisposition } from '../../utils/http-header-utils.mjs';

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

test('buildSafeContentDisposition 能防止非 ASCII 字符导致 Node.js ERR_INVALID_CHAR 崩溃', () => {
  const chineseFileName = '国寿海外星河系统-192.168.165.13-dmDataService-20260924151700.tar.gz';
  const headerValue = buildSafeContentDisposition(chineseFileName);

  // 1. 验证在 Node.js 原生 http.OutgoingMessage 中 setHeader 不报错
  const msg = new http.OutgoingMessage();
  assert.doesNotThrow(() => {
    msg.setHeader('Content-Disposition', headerValue);
  });

  // 2. 验证 filename="..." 部分绝不含码点 > 127 的字符
  const plainMatch = headerValue.match(/filename="([^"]+)"/);
  assert.ok(plainMatch, '应当包含 filename="..."');
  for (let i = 0; i < plainMatch[1].length; i++) {
    assert.ok(plainMatch[1].charCodeAt(i) <= 127, `字符 ${plainMatch[1][i]} 不属于 ASCII 范围`);
  }

  // 3. 验证 filename* 包含标准 UTF-8 编码且可完美还原中文原名
  const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/);
  assert.ok(utf8Match, '应当包含 filename*=UTF-8\'\'...');
  assert.equal(decodeURIComponent(utf8Match[1]), chineseFileName);
});

test('buildSafeContentDisposition 处理纯 ASCII 文件名保持优雅与干净', () => {
  const asciiFileName = 'nginx-12-config.tar.gz';
  const headerValue = buildSafeContentDisposition(asciiFileName);
  const msg = new http.OutgoingMessage();
  assert.doesNotThrow(() => {
    msg.setHeader('Content-Disposition', headerValue);
  });
  assert.ok(headerValue.includes('filename="nginx-12-config.tar.gz"'));
  assert.ok(headerValue.includes("filename*=UTF-8''nginx-12-config.tar.gz"));
});

