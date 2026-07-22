import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchiveTarCommand, buildSelectedArchiveTarCommand } from '../nginx-runtime-service.mjs';
import {
  parseNginxArchiveSites,
  resolveNginxArchiveSelection,
} from '../nginx-archive-selection.mjs';

/** 创建运行包命令测试配置。 */
const createConfig = (patch = {}) => ({
  useSudo: false,
  ...patch,
});

test('完整运行包排除部署备份、发布清单和 Nginx 运行态目录', () => {
  const command = buildArchiveTarCommand(createConfig(), 'opt/yuyan', 'all');

  assert.match(command, /tar -czf - -C \//);
  assert.equal(command.includes("--exclude='*/.yuyan-backups'"), true);
  assert.equal(command.includes("--exclude='*/.yuyan-backups/*'"), true);
  assert.equal(command.includes("--exclude='*/.yuyan-manifests'"), true);
  assert.equal(command.includes("--exclude='opt/yuyan/nginx/logs'"), true);
  assert.equal(command.includes("--exclude='opt/yuyan/nginx/run'"), true);
  assert.equal(command.includes("--exclude='*/yuyan-nginx.sh.bak.*'"), true);
});

test('仅前端静态产物也排除部署备份和发布清单', () => {
  const command = buildArchiveTarCommand(createConfig({ useSudo: true }), 'opt/yuyan/html', 'html');

  assert.match(command, /^sudo -n tar -czf - -C \//);
  assert.equal(command.includes("--exclude='*/.yuyan-backups'"), true);
  assert.equal(command.includes("--exclude='*/.yuyan-manifests'"), true);
  assert.equal(command.includes('nginx/logs'), false);
});

/** 两个 server 的主配置测试样本。 */
const MULTI_SERVER_CONFIG = `
events { worker_connections 1024; }
http {
  # 注释中的 server { listen 9999; } 不应被解析
  map $uri $target { default "value-{safe}"; }
  server {
    listen 32088;
    server_name _;
    root /opt/yuyan/html;
    location / { try_files $uri $uri/ /index.html; }
  }
  server {
    listen 127.0.0.1:32089;
    server_name xinhua.local;
    location / {
      root /opt/yuyan/xinhua-html;
      try_files $uri $uri/ /index.html;
    }
  }
}
`;

test('解析主配置直接 server 并提取端口、root 与 server_name', () => {
  const parsed = parseNginxArchiveSites(MULTI_SERVER_CONFIG);

  assert.equal(parsed.sites.length, 2);
  assert.deepEqual(parsed.sites[0].listenPorts, [32088]);
  assert.deepEqual(parsed.sites[0].roots, ['/opt/yuyan/html']);
  assert.deepEqual(parsed.sites[1].listenPorts, [32089]);
  assert.deepEqual(parsed.sites[1].roots, ['/opt/yuyan/xinhua-html']);
  assert.deepEqual(parsed.sites[1].serverNames, ['xinhua.local']);
  assert.match(parsed.revision, /^[a-f0-9]{64}$/);
});

test('选择单个或多个 server 时只保留所选配置并去重 root', () => {
  const parsed = parseNginxArchiveSites(MULTI_SERVER_CONFIG);
  const single = resolveNginxArchiveSelection(MULTI_SERVER_CONFIG, {
    type: 'all',
    revision: parsed.revision,
    siteIds: [parsed.sites[1].id],
  });

  assert.deepEqual(single.roots, ['/opt/yuyan/xinhua-html']);
  assert.equal(single.filteredConfig.includes('listen 32088'), false);
  assert.equal(single.filteredConfig.includes('127.0.0.1:32089'), true);
  assert.equal(single.filteredConfig.includes('events {'), true);

  const multiple = resolveNginxArchiveSelection(MULTI_SERVER_CONFIG, {
    type: 'html',
    siteIds: [parsed.sites[0].id, parsed.sites[1].id, parsed.sites[1].id],
  });
  assert.deepEqual(multiple.roots, ['/opt/yuyan/html', '/opt/yuyan/xinhua-html']);
});

test('配置版本、非法 server 与无 root 下载会被拒绝', () => {
  const parsed = parseNginxArchiveSites(MULTI_SERVER_CONFIG);
  assert.throws(
    () => resolveNginxArchiveSelection(MULTI_SERVER_CONFIG, { type: 'conf', revision: 'old', siteIds: [parsed.sites[0].id] }),
    /配置已发生变化/
  );
  assert.throws(
    () => resolveNginxArchiveSelection(MULTI_SERVER_CONFIG, { type: 'conf', siteIds: ['missing'] }),
    /已失效/
  );

  const proxyOnlyConfig = 'events {} http { server { listen 9000; location /api { proxy_pass http://127.0.0.1:8080; } } }';
  const proxySite = parseNginxArchiveSites(proxyOnlyConfig).sites[0];
  assert.doesNotThrow(() => resolveNginxArchiveSelection(proxyOnlyConfig, { type: 'conf', siteIds: [proxySite.id] }));
  assert.throws(
    () => resolveNginxArchiveSelection(proxyOnlyConfig, { type: 'html', siteIds: [proxySite.id] }),
    /未配置 root/
  );

  const mixedConfig = `${MULTI_SERVER_CONFIG}\nhttp { server { listen 9000; proxy_pass http://127.0.0.1:8080; } }`;
  const mixedParsed = parseNginxArchiveSites(mixedConfig);
  assert.throws(
    () => resolveNginxArchiveSelection(mixedConfig, {
      type: 'all',
      siteIds: [mixedParsed.sites[0].id, mixedParsed.sites.at(-1).id],
    }),
    /未配置 root/
  );
});

test('所选完整运行包只包含 Nginx 目录、所选 root 与裁剪配置', () => {
  const command = buildSelectedArchiveTarCommand(
    createConfig({
      installRoot: '/opt/yuyan/nginx',
      mainConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    }),
    ['/opt/yuyan/xinhua-html'],
    'all',
    'events {} http { server { listen 32089; root /opt/yuyan/xinhua-html; } }'
  );

  assert.equal(command.includes("'opt/yuyan/nginx'"), true);
  assert.equal(command.includes("'opt/yuyan/xinhua-html'"), true);
  assert.equal(command.includes("'opt/yuyan/html'"), false);
  assert.equal(command.includes("--exclude='opt/yuyan/nginx/conf/nginx.conf'"), true);
  assert.match(command, /--transform=/);
});
