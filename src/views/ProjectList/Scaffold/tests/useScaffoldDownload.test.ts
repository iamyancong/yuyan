import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDownloadSize, getErrorMessage } from '../constant.ts';

test('formatDownloadSize: 格式化各种字节大小', () => {
  assert.equal(formatDownloadSize(0), '0 B');
  assert.equal(formatDownloadSize(-10), '0 B');
  assert.equal(formatDownloadSize(512), '512 B');
  assert.equal(formatDownloadSize(1024), '1.0 KB');
  assert.equal(formatDownloadSize(1024 * 1024), '1.0 MB');
  assert.equal(formatDownloadSize(2.5 * 1024 * 1024), '2.5 MB');
  assert.equal(formatDownloadSize(1024 * 1024 * 1024), '1.0 GB');
});

test('getErrorMessage: 正确提取各种异常信息', () => {
  assert.equal(getErrorMessage(new Error('网络连接超时')), '网络连接超时');
  assert.equal(getErrorMessage('自定义错误字符串'), '自定义错误字符串');
  assert.equal(getErrorMessage({ message: '对象包含 message' }), '对象包含 message');
  assert.equal(getErrorMessage(null), '未知异常，请重试');
  assert.equal(getErrorMessage(undefined), '未知异常，请重试');
});

