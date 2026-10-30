import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNginxInstanceFilterOptions,
  formatInstanceEndpoint,
  getNginxInstanceTypeLabel,
  resolveInstanceFilterAfterServerChange,
  stripInstanceNamePort,
} from '../targetInstancePolicy.ts';

const targets = [
  { id: 1, projectType: 'frontend' as const, serverId: 1, serverName: '测试服', serverHost: '192.168.165.60', nginxInstanceId: 11, nginxInstanceName: 'yuyan托管', nginxInstanceType: 'managed' as const, listenPort: 8082 },
  { id: 2, projectType: 'frontend' as const, serverId: 1, serverName: '测试服', serverHost: '192.168.165.60', nginxInstanceId: 12, nginxInstanceName: '已有 /report :80', nginxInstanceType: 'existing' as const, listenPort: 80 },
  { id: 3, projectType: 'frontend' as const, serverId: 1, serverName: '测试服', serverHost: '192.168.165.60', nginxInstanceId: 11, nginxInstanceName: 'yuyan托管', nginxInstanceType: 'managed' as const, listenPort: 8083 },
  { id: 4, projectType: 'frontend' as const, serverId: 2, serverName: '生产服', serverHost: '10.0.0.8', nginxInstanceId: 21, nginxInstanceName: '', nginxInstanceType: 'existing' as const, listenPort: 0 },
  { id: 5, projectType: 'backend' as const, serverId: 1, serverName: '测试服', serverHost: '192.168.165.60', nginxInstanceId: 0 },
];

test('实例类型短标签', () => {
  assert.equal(getNginxInstanceTypeLabel('managed'), '托管');
  assert.equal(getNginxInstanceTypeLabel('existing'), '已有');
  assert.equal(getNginxInstanceTypeLabel(undefined), '已有');
});

test('实例名末尾端口与地址端口相同时去掉；地址拼接 IP:端口', () => {
  assert.equal(stripInstanceNamePort('已有 /report :80', [80]), '已有 /report');
  assert.equal(stripInstanceNamePort('已有 /report :80', [8080]), '已有 /report :80', '端口不同说明是名字的一部分，保留');
  assert.equal(stripInstanceNamePort(':80', [80]), ':80', '整个名字就是端口时不清空');
  assert.equal(formatInstanceEndpoint('192.168.165.60', [8082, 8083]), '192.168.165.60:8082/8083');
  assert.equal(formatInstanceEndpoint('', [80]), ':80');
  assert.equal(formatInstanceEndpoint('10.0.0.8', []), '10.0.0.8');
});

test('实例筛选项：单台服务器显示 IP:端口；多台服务器加服务器名；后端项目不参与', () => {
  const server1 = createNginxInstanceFilterOptions(targets as any, 1);
  assert.deepEqual(
    server1.map((item) => [item.value, item.label]),
    [
      [11, '[托管] yuyan托管 · 192.168.165.60:8082/8083'],
      [12, '[已有] 已有 /report · 192.168.165.60:80'],
    ]
  );
  assert.ok(server1.every((item) => item.title === item.label), '悬浮全文与 label 一致');
  assert.equal(server1[0].instanceTitle, '[托管] yuyan托管');
  assert.equal(server1[0].description, '192.168.165.60:8082/8083');
  assert.equal(server1[1].instanceTitle, '[已有] 已有 /report');
  assert.equal(server1[1].description, '192.168.165.60:80');
  const all = createNginxInstanceFilterOptions(targets as any);
  assert.deepEqual(all.map((item) => item.value), [11, 12, 21]);
  assert.equal(all[0].label, '[托管] yuyan托管 · 测试服 192.168.165.60:8082/8083');
  assert.equal(all[0].instanceTitle, '[托管] yuyan托管');
  assert.equal(all[0].description, '测试服 192.168.165.60:8082/8083');
  assert.equal(all[2].label, '[已有] 实例 21 · 生产服 10.0.0.8');
  assert.equal(all[2].instanceTitle, '[已有] 实例 21');
  assert.equal(all[2].description, '生产服 10.0.0.8');
  const onlyServer1 = createNginxInstanceFilterOptions(targets.filter((item) => item.serverId === 1) as any);
  assert.equal(onlyServer1[0].label, '[托管] yuyan托管 · 192.168.165.60:8082/8083', '未选服务器但只有一台时不加服务器名');
  assert.deepEqual(createNginxInstanceFilterOptions(targets as any, 2).map((item) => item.value), [21]);
  assert.deepEqual(createNginxInstanceFilterOptions(targets as any, 9), []);
});

test('切换服务器后清空不属于新服务器的实例筛选', () => {
  const server1 = createNginxInstanceFilterOptions(targets as any, 1);
  const server2 = createNginxInstanceFilterOptions(targets as any, 2);
  assert.equal(resolveInstanceFilterAfterServerChange(11, server1), 11);
  assert.equal(resolveInstanceFilterAfterServerChange(11, server2), undefined);
  assert.equal(resolveInstanceFilterAfterServerChange(undefined, server1), undefined);
});
