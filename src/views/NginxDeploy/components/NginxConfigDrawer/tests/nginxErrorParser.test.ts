import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseNginxError,
  formatShortNginxErrorMessage,
} from '../utils/nginxErrorParser.ts';

test('正确解析用户实际遇到的 duplicate location 重复配置错误', () => {
  const raw =
    '/home/nginx/sbin/nginx -t 执行失败，退出码 1 nginx: [emerg] duplicate location "/external/api/v1/entrust/" in /home/nginx//conf/nginx.conf:111 nginx: configuration file /home/nginx//conf/nginx.conf test failed';

  const result = parseNginxError(raw);
  assert.equal(result.isNginxError, true);
  assert.equal(result.line, 111);
  assert.equal(result.configFile, '/home/nginx/conf/nginx.conf');
  assert.equal(result.title, '第 111 行：路由规则重复声明');
  assert.ok(result.reason.includes('"/external/api/v1/entrust/"'));
  assert.ok(result.suggestion.includes('已存在同名的 location'));

  const shortMsg = formatShortNginxErrorMessage(result);
  assert.equal(
    shortMsg,
    'Nginx 校验未通过（第 111 行）：路由路径 "/external/api/v1/entrust/" 被多次重复定义'
  );
});

test('正确解析缺少分号错误', () => {
  const raw =
    'nginx: [emerg] directive "proxy_pass" is not terminated by ";" in /etc/nginx/nginx.conf:25';

  const result = parseNginxError(raw);
  assert.equal(result.line, 25);
  assert.equal(result.configFile, '/etc/nginx/nginx.conf');
  assert.equal(result.title, '第 25 行：指令缺少分号');
  assert.ok(result.reason.includes('"proxy_pass"'));
  assert.ok(result.suggestion.includes('补齐英文半角分号 ";"'));
});

test('正确解析未知指令错误', () => {
  const raw =
    'nginx: [emerg] unknown directive "proxy_pas" in /etc/nginx/nginx.conf:30';

  const result = parseNginxError(raw);
  assert.equal(result.line, 30);
  assert.equal(result.title, '第 30 行：无法识别的指令');
  assert.ok(result.reason.includes('"proxy_pas"'));
  assert.ok(result.suggestion.includes('拼写是否正确'));
});

test('正确解析多余或不匹配的花括号错误', () => {
  const raw =
    'nginx: [emerg] unexpected "}" in /etc/nginx/nginx.conf:88';

  const result = parseNginxError(raw);
  assert.equal(result.line, 88);
  assert.equal(result.title, '第 88 行：括号不匹配（多余的 "}"）');
  assert.ok(result.suggestion.includes('成对闭合'));
});

test('正确解析指令放置层级错误', () => {
  const raw =
    'nginx: [emerg] "proxy_pass" directive is not allowed here in /etc/nginx/nginx.conf:15';

  const result = parseNginxError(raw);
  assert.equal(result.line, 15);
  assert.equal(result.title, '第 15 行：指令上下文层级错误');
  assert.ok(result.suggestion.includes('location 块内部'));
});

test('正确解析端口占用错误', () => {
  const raw =
    'nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)';

  const result = parseNginxError(raw);
  assert.equal(result.line, null);
  assert.equal(result.title, '监听端口已被占用');
  assert.ok(result.reason.includes('0.0.0.0:80'));
  assert.ok(result.suggestion.includes('修改 listen 监听端口'));
});

test('正确解析证书不存在错误', () => {
  const raw =
    'nginx: [emerg] cannot load certificate "/etc/ssl/cert.pem": BIO_new_file() failed (SSL: error:02001002:system library:fopen:No such file or directory)';

  const result = parseNginxError(raw);
  assert.equal(result.title, '引用的文件或证书不存在');
  assert.ok(result.suggestion.includes('是否存在'));
});

test('兜底非结构化未知错误', () => {
  const raw = '网络连接异常超时 (ETIMEDOUT)';
  const result = parseNginxError(raw);
  assert.equal(result.line, null);
  assert.equal(result.reason, '网络连接异常超时 (ETIMEDOUT)');
});
