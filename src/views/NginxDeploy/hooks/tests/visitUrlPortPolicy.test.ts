import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatListenPortSyncHint,
  formatSummaryPortMismatchHint,
  getVisitUrlPortMismatch,
  normalizeListenPort,
  parseVisitUrlPort,
  resolveListenPortSyncValue,
  syncVisitUrlWithListenPort,
} from '../visitUrlPortPolicy.ts';

test('parseVisitUrlPort：http/https 无显式端口取 80/443', () => {
  assert.equal(parseVisitUrlPort('http://192.168.165.60'), 80);
  assert.equal(parseVisitUrlPort('https://yuyan.example.com'), 443);
  assert.equal(parseVisitUrlPort('HTTPS://yuyan.example.com/'), 443);
});

test('parseVisitUrlPort：显式端口、带 path/query/hash、前后空格', () => {
  assert.equal(parseVisitUrlPort('http://192.168.165.60:8050'), 8050);
  assert.equal(parseVisitUrlPort('https://example.com:8443/portal/#/home'), 8443);
  assert.equal(parseVisitUrlPort('  http://host:9999/app/?a=1  '), 9999);
  // 显式写默认端口时 URL 会归一化为空，仍应得到 80/443
  assert.equal(parseVisitUrlPort('http://host:80/app'), 80);
  assert.equal(parseVisitUrlPort('https://host:443'), 443);
  assert.equal(parseVisitUrlPort('http://user:pwd@host:8050/a'), 8050);
});

test('parseVisitUrlPort：IPv6', () => {
  assert.equal(parseVisitUrlPort('http://[::1]:8050/app'), 8050);
  assert.equal(parseVisitUrlPort('https://[2001:db8::1]/'), 443);
});

test('parseVisitUrlPort：空、非法或非 http(s) 无法比较', () => {
  for (const value of ['', '   ', '-', '未配置', 'host:8050', '192.168.1.1:8050', 'ftp://host:21', 'http://', 'http://host:99999', 'http://host:abc', 'javascript:alert(1)', null, undefined, 8050]) {
    assert.equal(parseVisitUrlPort(value), null, String(value));
  }
});

test('normalizeListenPort：只接受 1-65535 整数', () => {
  assert.equal(normalizeListenPort(8050), 8050);
  assert.equal(normalizeListenPort('9999'), 9999);
  for (const value of [0, -1, 65536, 80.5, '', ' ', null, undefined, NaN, 'abc']) {
    assert.equal(normalizeListenPort(value), null, String(value));
  }
});

test('getVisitUrlPortMismatch：一致时不提示', () => {
  assert.equal(getVisitUrlPortMismatch('http://host:8050', 8050), null);
  assert.equal(getVisitUrlPortMismatch('http://host', 80), null);
  assert.equal(getVisitUrlPortMismatch('https://host/app', '443'), null);
});

test('getVisitUrlPortMismatch：不一致返回双方端口', () => {
  assert.deepEqual(getVisitUrlPortMismatch('http://192.168.165.60:8050', 9999), { visitPort: 8050, listenPort: 9999 });
  assert.deepEqual(getVisitUrlPortMismatch('https://example.com', 8050), { visitPort: 443, listenPort: 8050 });
});

test('getVisitUrlPortMismatch：监听端口为 0/空也算不一致，可同步', () => {
  assert.deepEqual(getVisitUrlPortMismatch('http://host:8050', 0), { visitPort: 8050, listenPort: null });
  assert.deepEqual(getVisitUrlPortMismatch('http://host:8050', null), { visitPort: 8050, listenPort: null });
  assert.deepEqual(getVisitUrlPortMismatch('http://host:8050', undefined), { visitPort: 8050, listenPort: null });
});

test('getVisitUrlPortMismatch：访问地址无法解析时不提示', () => {
  assert.equal(getVisitUrlPortMismatch('', 9999), null);
  assert.equal(getVisitUrlPortMismatch('not a url', 9999), null);
  assert.equal(getVisitUrlPortMismatch('', 0), null);
});

test('提示文案', () => {
  assert.equal(formatListenPortSyncHint({ visitPort: 8050, listenPort: 9999 }), '访问地址是 8050，当前监听端口仍是 9999');
  assert.equal(formatListenPortSyncHint({ visitPort: 8050, listenPort: null }), '访问地址是 8050，当前监听端口未填写');
  assert.ok(formatSummaryPortMismatchHint({ visitPort: 8050, listenPort: 9999 }).startsWith('访问地址端口为 8050，监听端口为 9999'));
});

test('resolveListenPortSyncValue：只给出新监听端口，一致或无法解析时为 null', () => {
  assert.equal(resolveListenPortSyncValue('http://host:8050/app', 9999), 8050);
  assert.equal(resolveListenPortSyncValue('http://host:8050/app', 0), 8050);
  assert.equal(resolveListenPortSyncValue('http://host:8050/app', 8050), null);
  assert.equal(resolveListenPortSyncValue('bad', 9999), null);
});

test('syncVisitUrlWithListenPort：访问地址原本与旧监听端口一致时只替换端口', () => {
  assert.equal(syncVisitUrlWithListenPort('http://192.168.165.60:9999', 9999, 8050), 'http://192.168.165.60:8050');
  assert.equal(syncVisitUrlWithListenPort('http://host:9999/app/?a=1#x', 9999, 8050), 'http://host:8050/app/?a=1#x');
  assert.equal(syncVisitUrlWithListenPort('http://[::1]:9999/app', 9999, 8050), 'http://[::1]:8050/app');
  assert.equal(syncVisitUrlWithListenPort('http://u:p@host:9999', '9999', '8050'), 'http://u:p@host:8050');
  assert.equal(syncVisitUrlWithListenPort('http://host/app', 80, 8050), 'http://host:8050/app');
});

test('syncVisitUrlWithListenPort：访问地址与旧端口不一致（如反代地址）或端口非法时原样返回', () => {
  assert.equal(syncVisitUrlWithListenPort('https://example.com', 9999, 8050), 'https://example.com');
  assert.equal(syncVisitUrlWithListenPort('http://host:8050', 9999, 8050), 'http://host:8050');
  assert.equal(syncVisitUrlWithListenPort('http://host:9999', null, 8050), 'http://host:9999');
  assert.equal(syncVisitUrlWithListenPort('http://host:9999', 9999, 0), 'http://host:9999');
  assert.equal(syncVisitUrlWithListenPort('http://host:9999', 9999, 9999), 'http://host:9999');
  assert.equal(syncVisitUrlWithListenPort('', 9999, 8050), '');
});
