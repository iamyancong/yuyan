import assert from 'node:assert/strict';
import test from 'node:test';
import type { NginxDiscoveryRuntime, NginxDiscoverySite } from '@/api/deploy';
import {
  createDiscoveredInstanceName,
  createExistingNginxSelection,
  getPreferredDiscoveryRoot,
} from '../selectionPolicy.ts';
import {
  formatDiscoveryServerNames,
  groupNginxDiscoveryRuntimes,
  hasDiscoveryCandidateKey,
} from '../presentationPolicy.ts';

/** 创建站点测试数据。 */
const createSite = (): NginxDiscoverySite => ({
  id: 'site-1',
  order: 0,
  listens: [{ raw: '32088', address: '*', port: 32088, transport: 'tcp', ssl: false, defaultServer: false, wildcard: true, loopback: false }],
  accessEndpoints: [{ url: 'http://192.168.165.13:32088', host: '192.168.165.13', port: 32088, protocol: 'http', source: 'serverHost', scope: 'remote' }],
  listenPorts: [32088],
  listenValues: ['32088'],
  serverNames: ['_'],
  configPath: '/opt/nginx/conf/nginx.conf',
  roots: [
    { path: '/opt/site-empty', exists: true, readable: true, hasIndexHtml: false },
    { path: '/opt/yuyan/html', exists: true, readable: true, hasIndexHtml: true },
  ],
  dynamicRoots: [],
  aliases: [],
  dynamicAliases: [],
  hasProxyPass: false,
  type: 'static',
  warnings: [],
});

/** 创建物理 Nginx 测试数据。 */
const createRuntime = (site: NginxDiscoverySite): NginxDiscoveryRuntime => ({
  id: 'runtime-1',
  binaryPath: '/opt/nginx/sbin/nginx',
  binaryResolution: 'resolved',
  inspectionState: 'ready',
  runtimeFingerprint: 'a'.repeat(64),
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
  connectedInstance: null,
  diagnostics: [],
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
    runtimeFingerprint: 'a'.repeat(64),
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

test('仅一个满足全部强条件的候选会被标记为推荐', () => {
  const site = createSite();
  const runtime = createRuntime(site);
  const groups = groupNginxDiscoveryRuntimes([runtime]);
  assert.equal(groups.candidates.length, 2);
  assert.equal(groups.recommendedKey, `${runtime.id}:${site.id}:/opt/yuyan/html`);
});

test('目录存在但当前扫描账号不可读时不会推荐接入', () => {
  const site = createSite();
  const runtime = createRuntime({
    ...site,
    roots: [{ path: '/opt/private/html', exists: true, readable: false, hasIndexHtml: true }],
  });
  assert.equal(groupNginxDiscoveryRuntimes([runtime]).recommendedKey, '');
});

test('多个高置信度候选时不做唯一推荐，已接入项进入独立分组', () => {
  const site = {
    ...createSite(),
    roots: [
      { path: '/opt/site-a', exists: true, readable: true, hasIndexHtml: true },
      { path: '/opt/site-b', exists: true, readable: true, hasIndexHtml: true },
    ],
  };
  const runtime = createRuntime(site);
  assert.equal(groupNginxDiscoveryRuntimes([runtime]).recommendedKey, '');
  const connected = { ...runtime, connectedInstanceId: 9, connectedInstance: { id: 9, name: '生产 Nginx' } };
  const groups = groupNginxDiscoveryRuntimes([connected]);
  assert.equal(groups.connectedRuntimes.length, 1);
  assert.equal(groups.candidates.length, 0);
});

test('占位 server_name 只显示为默认站点，不冒充服务器 IP', () => {
  assert.equal(formatDiscoveryServerNames(createSite()), '未配置/默认站点');
});

test('同条件刷新仅在新快照仍含候选时保留用户选择', () => {
  const runtime = createRuntime(createSite());
  assert.equal(hasDiscoveryCandidateKey([runtime], 'runtime-1:site-1:/opt/yuyan/html'), true);
  assert.equal(hasDiscoveryCandidateKey([runtime], 'runtime-1:site-old:/opt/yuyan/html'), false);
});
