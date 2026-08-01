import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAllowedCentralUrl, isAllowedCentralUrl, isPrivateCentralHostname } from '../centralUrlPolicy.ts';

test('允许 HTTPS、回环地址与 RFC1918 私网地址', () => {
  const allowedUrls = [
    'https://yuyan.example.com',
    'http://localhost:3100',
    'http://127.0.0.1:3100',
    'http://127.8.9.10:3100',
    'http://[::1]:3100',
    'http://10.20.30.40:3100',
    'http://172.16.0.1:3100',
    'http://172.31.255.254:3100',
    'http://192.168.164.27:3100',
  ];

  for (const url of allowedUrls) assert.equal(isAllowedCentralUrl(url), true, url);
});

test('拒绝公网 HTTP、伪私网域名、越界地址与非 HTTP 协议', () => {
  const rejectedUrls = [
    'http://example.com',
    'http://8.8.8.8:3100',
    'http://172.15.0.1:3100',
    'http://172.32.0.1:3100',
    'http://192.168.1.1.example.com:3100',
    'http://256.168.1.1:3100',
    'ftp://192.168.1.1',
    'http://user:password@192.168.1.1:3100',
    'not-a-url',
  ];

  for (const url of rejectedUrls) assert.equal(isAllowedCentralUrl(url), false, url);
});

test('私网主机判断严格限制在回环与 RFC1918 网段', () => {
  assert.equal(isPrivateCentralHostname('192.168.164.27'), true);
  assert.equal(isPrivateCentralHostname('[::1]'), true);
  assert.equal(isPrivateCentralHostname('192.168.164.27.example.com'), false);
  assert.equal(isPrivateCentralHostname('169.254.1.1'), false);
});

test('断言函数返回合法地址并为不安全地址提供明确错误', () => {
  assert.equal(assertAllowedCentralUrl('http://192.168.164.27:3100'), 'http://192.168.164.27:3100');
  assert.throws(
    () => assertAllowedCentralUrl('http://example.com'),
    /仅回环或 RFC1918 私网地址允许 HTTP/,
  );
});
