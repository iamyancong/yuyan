import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConfigHeaderBarMeta, splitFilePath, type DeployTarget } from '../constant.ts';

test('splitFilePath 能正确解析正常绝对路径', () => {
  const result = splitFilePath('/home/nginx/conf/nginx.conf');
  assert.equal(result.dir, '/home/nginx/conf/');
  assert.equal(result.fileName, 'nginx.conf');
});

test('splitFilePath 能正确处理单级文件名或空值', () => {
  assert.equal(splitFilePath('nginx.conf').dir, '');
  assert.equal(splitFilePath('nginx.conf').fileName, 'nginx.conf');

  assert.equal(splitFilePath('').fileName, '未选择配置');
  assert.equal(splitFilePath(undefined).fileName, '未选择配置');
  assert.equal(splitFilePath('自动推导配置').fileName, '自动推导配置');
});

test('resolveConfigHeaderBarMeta 在空目标时返回优雅的安全回退值', () => {
  const meta = resolveConfigHeaderBarMeta(null);
  assert.equal(meta.serverName, '未知服务器');
  assert.equal(meta.instanceName, '未绑定实例');
  assert.equal(meta.statusLabel, '未就绪');
  assert.equal(meta.configFileName, '未选择配置');
});

test('resolveConfigHeaderBarMeta 能够完整解析部署目标及托管实例信息', () => {
  const mockTarget: Partial<DeployTarget> = {
    id: 1,
    serverName: '国寿海外星河系统',
    serverHost: '192.168.165.13',
    nginxInstanceName: '生产 Nginx',
    nginxInstanceType: 'managed',
    nginxServerName: '192.168.165.13',
    listenPort: 9999,
    deployRoot: '/home/app/frontend/html',
    nginxConfPath: '/home/nginx/conf/vhost.conf',
    visitUrl: 'http://192.168.165.13:9999',
  };

  const meta = resolveConfigHeaderBarMeta(mockTarget as DeployTarget);
  assert.equal(meta.serverName, '国寿海外星河系统');
  assert.equal(meta.serverHost, '192.168.165.13');
  assert.equal(meta.instanceName, '生产 Nginx');
  assert.equal(meta.instanceType, 'managed');
  assert.equal(meta.instanceTypeLabel, '托管');
  assert.equal(meta.domainText, '192.168.165.13');
  assert.equal(meta.listenPort, '9999');
  assert.equal(meta.routeMapping, '/home/app/frontend/html:9999');
  assert.equal(meta.configDir, '/home/nginx/conf/');
  assert.equal(meta.configFileName, 'vhost.conf');
  assert.equal(meta.statusLabel, '已启用');
  assert.equal(meta.visitUrl, 'http://192.168.165.13:9999');
});
