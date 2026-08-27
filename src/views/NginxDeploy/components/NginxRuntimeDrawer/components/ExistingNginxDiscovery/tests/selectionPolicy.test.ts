import assert from 'node:assert/strict';
import test from 'node:test';
import type { NginxDiscoveryRuntime, NginxDiscoverySite } from '@/api/deploy';
import {
  createDiscoveredInstanceName,
  createExistingNginxSelection,
  getPreferredDiscoveryRoot,
} from '../selectionPolicy.ts';

/** 创建站点测试数据。 */
const createSite = (): NginxDiscoverySite => ({
  id: 'site-1',
  order: 0,
  listenPorts: [32088],
  listenValues: ['32088'],
  serverNames: ['_'],
  configPath: '/opt/nginx/conf/nginx.conf',
  roots: [
    { path: '/opt/site-empty', exists: true, hasIndexHtml: false },
    { path: '/opt/yuyan/html', exists: true, hasIndexHtml: true },
  ],
  dynamicRoots: [],
  aliases: [],
  dynamicAliases: [],
  hasProxyPass: false,
  type: 'static',
});

/** 创建物理 Nginx 测试数据。 */
const createRuntime = (site: NginxDiscoverySite): NginxDiscoveryRuntime => ({
  id: 'runtime-1',
  binaryPath: '/opt/nginx/sbin/nginx',
  masterPids: [101],
  running: true,
  version: 'nginx/1.26.3',
  prefix: '/opt/nginx',
  mainConfigPath: '/opt/nginx/conf/nginx.conf',
  nginxWorkDir: '/opt/nginx',
  nginxTestCommand: '/opt/nginx/sbin/nginx -p /opt/nginx -c conf/nginx.conf -t',
  nginxReloadCommand: '/opt/nginx/sbin/nginx -p /opt/nginx -c conf/nginx.conf -s reload',
  useSudo: true,
  connectedInstanceId: null,
  sites: [site],
  warnings: [],
});

test('优先选择包含 index.html 的静态根目录', () => {
  const site = createSite();
  assert.equal(getPreferredDiscoveryRoot(site)?.path, '/opt/yuyan/html');
});

test('server_name 不可用时使用监听端口生成实例名', () => {
  assert.equal(createDiscoveredInstanceName(createSite()), 'Nginx 32088');
});

test('选择站点后映射现有接入表单字段并保留 sudo 设置', () => {
  const site = { ...createSite(), serverNames: ['app.example.com'] };
  const runtime = createRuntime(site);
  const root = site.roots[1];
  assert.ok(root);

  const selection = createExistingNginxSelection(runtime, site, root);
  assert.deepEqual(selection.formPatch, {
    name: 'app.example.com Nginx',
    instanceType: 'external',
    defaultDeployRoot: '/opt/yuyan/html',
    defaultNginxConfPath: '/opt/nginx/conf/nginx.conf',
    nginxWorkDir: '/opt/nginx',
    nginxTestCommand: '/opt/nginx/sbin/nginx -p /opt/nginx -c conf/nginx.conf -t',
    nginxReloadCommand: '/opt/nginx/sbin/nginx -p /opt/nginx -c conf/nginx.conf -s reload',
    baseRoot: '',
    portStart: 32088,
    useSudo: true,
  });
});
