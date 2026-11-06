import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildListenPortSyncPlan,
  formatAmbiguousListenPortsHint,
  formatListenPortSyncConfirm,
  isNginxConfSyncResultActive,
  parseListenAddressPort,
  parseNginxListenPorts,
  resolveListenPortSuggestion,
} from '../nginxListenSyncPolicy.ts';

test('parseListenAddressPort：各种 listen 地址写法', () => {
  assert.equal(parseListenAddressPort('80'), 80);
  assert.equal(parseListenAddressPort('8050'), 8050);
  assert.equal(parseListenAddressPort('[::]:8050'), 8050);
  assert.equal(parseListenAddressPort('[::]'), 80);
  assert.equal(parseListenAddressPort('127.0.0.1:8050'), 8050);
  assert.equal(parseListenAddressPort('*:8443'), 8443);
  assert.equal(parseListenAddressPort('127.0.0.1'), 80);
  assert.equal(parseListenAddressPort('localhost'), 80);
  assert.equal(parseListenAddressPort('unix:/var/run/nginx.sock'), null);
  assert.equal(parseListenAddressPort('70000'), null);
  assert.equal(parseListenAddressPort(''), null);
});

test('parseNginxListenPorts：常见写法、ssl 去重、注释不算', () => {
  const conf = `
server {
    listen 80;
    listen 8050;
    listen 8050 ssl;
    listen [::]:8050 ssl http2;
    listen 127.0.0.1:9000 default_server;
    # listen 9999;
    #listen 7777 ssl;
    server_name example.com; # listen 6666;
    location / { root /data/www; }
}`;
  assert.deepEqual(parseNginxListenPorts(conf), [80, 8050, 9000]);
});

test('parseNginxListenPorts：同一行多条指令、缩进 tab、unix 套接字', () => {
  assert.deepEqual(parseNginxListenPorts('server{listen 81;listen 82 ssl;}'), [81, 82]);
  assert.deepEqual(parseNginxListenPorts('server {\n\tlisten\t8050;\n\tlisten unix:/tmp/a.sock;\n}'), [8050]);
  assert.deepEqual(parseNginxListenPorts('server { proxy_listen 1234; return 200 "listen 5555;"; }').includes(1234), false);
  assert.deepEqual(parseNginxListenPorts(''), []);
  assert.deepEqual(parseNginxListenPorts('# listen 80;\n'), []);
});

test('resolveListenPortSuggestion：唯一端口变了 → 建议', () => {
  assert.deepEqual(
    resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [8050], previousPorts: [9999] }),
    { kind: 'suggest', from: 9999, to: 8050, ports: [8050] }
  );
  // listen 8050 与 listen 8050 ssl 解析后只剩一个端口
  assert.deepEqual(
    resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: parseNginxListenPorts('listen 8050; listen 8050 ssl;') }),
    { kind: 'suggest', from: 9999, to: 8050, ports: [8050] }
  );
  // 未填写监听端口时也可建议
  assert.deepEqual(
    resolveListenPortSuggestion({ currentListenPort: 0, nextPorts: [8050] }),
    { kind: 'suggest', from: null, to: 8050, ports: [8050] }
  );
});

test('resolveListenPortSuggestion：保存前后端口集合没变 → 不打扰', () => {
  assert.equal(resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [80, 443], previousPorts: [443, 80] }).kind, 'config-unchanged');
});

test('resolveListenPortSuggestion：当前端口仍在配置里 → 一致', () => {
  assert.deepEqual(
    resolveListenPortSuggestion({ currentListenPort: 443, nextPorts: [80, 443] }),
    { kind: 'in-sync', ports: [80, 443], listenPort: 443 }
  );
  assert.equal(resolveListenPortSuggestion({ currentListenPort: 8050, nextPorts: [8050], previousPorts: [9999] }).kind, 'in-sync');
});

test('resolveListenPortSuggestion：没找到 listen', () => {
  assert.deepEqual(resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [] }), { kind: 'no-listen' });
});

test('resolveListenPortSuggestion：多端口时只提示、不擅自选', () => {
  // 旧 9999，新 80 + 443
  assert.deepEqual(resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [80, 443], previousPorts: [9999] }), { kind: 'ambiguous', ports: [80, 443] });
  // 旧 9999 → 新 8050 + 443（新增两个，看不出单端口替换）
  assert.equal(resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [443, 8050], previousPorts: [9999] }).kind, 'ambiguous');
  // 直接从服务器读取（无保存前基线）
  assert.equal(resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [443, 8050] }).kind, 'ambiguous');
  // 未填写监听端口 + 多端口
  assert.equal(resolveListenPortSuggestion({ currentListenPort: null, nextPorts: [443, 8050], previousPorts: [443, 9999] }).kind, 'ambiguous');
});

test('resolveListenPortSuggestion：能明确看出 9999→8050 单端口替换时建议', () => {
  assert.deepEqual(
    resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [443, 8050], previousPorts: [443, 9999] }),
    { kind: 'suggest', from: 9999, to: 8050, ports: [443, 8050] }
  );
  // 替换的不是当前监听端口（443→8443），当前 9999 也不在新配置里 → 只提示
  assert.equal(resolveListenPortSuggestion({ currentListenPort: 9999, nextPorts: [80, 8443], previousPorts: [80, 443] }).kind, 'ambiguous');
});

test('buildListenPortSyncPlan：访问地址端口等于旧端口才跟着改，反代地址不动', () => {
  const suggestion = { kind: 'suggest' as const, from: 9999, to: 8050, ports: [8050] };
  assert.deepEqual(buildListenPortSyncPlan(suggestion, 'http://192.168.165.60:9999/app'), {
    listenPort: 8050,
    visitUrl: 'http://192.168.165.60:8050/app',
    visitUrlChanged: true,
  });
  assert.deepEqual(buildListenPortSyncPlan(suggestion, 'https://example.com'), {
    listenPort: 8050,
    visitUrl: 'https://example.com',
    visitUrlChanged: false,
  });
  assert.deepEqual(buildListenPortSyncPlan({ ...suggestion, from: null }, 'http://host:9999'), {
    listenPort: 8050,
    visitUrl: 'http://host:9999',
    visitUrlChanged: false,
  });
});

test('询问与提示文案', () => {
  const suggestion = { kind: 'suggest' as const, from: 9999, to: 8050, ports: [8050] };
  assert.deepEqual(
    formatListenPortSyncConfirm(suggestion, buildListenPortSyncPlan(suggestion, 'http://host:9999')),
    ['该站点监听端口已从 9999 改为 8050，是否同步到部署目标？', '访问地址会同步改为 http://host:8050']
  );
  assert.deepEqual(
    formatListenPortSyncConfirm(suggestion, buildListenPortSyncPlan(suggestion, 'https://example.com')),
    ['该站点监听端口已从 9999 改为 8050，是否同步到部署目标？', '访问地址 https://example.com 保持不变']
  );
  assert.deepEqual(
    formatListenPortSyncConfirm({ ...suggestion, from: null }, buildListenPortSyncPlan({ ...suggestion, from: null }, '')),
    ['该站点配置里的监听端口是 8050，部署目标还没有填写监听端口，是否同步到部署目标？']
  );
  assert.equal(formatAmbiguousListenPortsHint([80, 443]), '配置里检测到多个监听端口：80、443，请在部署目标里手动确认');
});

test('isNginxConfSyncResultActive：生命周期与过期防护判断', () => {
  const baseState = {
    aborted: false,
    disposed: false,
    requestGeneration: 1,
    currentGeneration: 1,
    requestTargetId: 100,
    currentTargetId: 100,
  };

  // true 场景：正常匹配且未销毁未中止
  assert.equal(isNginxConfSyncResultActive(baseState), true);

  // false 场景 1：请求已被 abort
  assert.equal(isNginxConfSyncResultActive({ ...baseState, aborted: true }), false);

  // false 场景 2：表单组件已卸载（弹窗关闭）
  assert.equal(isNginxConfSyncResultActive({ ...baseState, disposed: true }), false);

  // false 场景 3：世代不匹配（有更新的同步请求发起）
  assert.equal(isNginxConfSyncResultActive({ ...baseState, requestGeneration: 1, currentGeneration: 2 }), false);

  // false 场景 4：部署目标 ID 已切换
  assert.equal(isNginxConfSyncResultActive({ ...baseState, requestTargetId: 100, currentTargetId: 101 }), false);
});
