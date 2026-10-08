import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachManagedHeader,
  buildArchiveTarCommand,
  buildExternalArchivePrecheckCommand,
  buildExternalArchiveTarCommand,
  buildSelectedArchiveTarCommand,
  checkNginxOverwriteSafety,
  computeConfigBodySha256,
  inspectNginxConfigManagedState,
  parseManagedHeader,
  renderSiteConfig,
  resolveArchiveRuntimeConfig,
} from '../nginx-runtime-service.mjs';
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

test('解析无 http 包裹的顶层 server 块（兼容 conf.d/*.conf 分离配置）', () => {
  const confSnippet = `
  # 独立分发文件 conf.d/my-app.conf
  server {
    listen 80;
    server_name my-app.example.com;
    root /var/www/my-app/dist;
    location / {
      try_files $uri $uri/ /index.html;
    }
  }
  `;
  const parsed = parseNginxArchiveSites(confSnippet);
  assert.equal(parsed.sites.length, 1);
  assert.deepEqual(parsed.sites[0].listenPorts, [80]);
  assert.deepEqual(parsed.sites[0].serverNames, ['my-app.example.com']);
  assert.deepEqual(parsed.sites[0].roots, ['/var/www/my-app/dist']);
});

test('已有实例预检命令不检查管理脚本与托管安装根目录', () => {
  const precheck = buildExternalArchivePrecheckCommand(
    {
      useSudo: true,
      mainConfPath: '/etc/nginx/nginx.conf',
    },
    'all',
    ['/var/www/site1']
  );

  assert.equal(precheck.includes('yuyan-nginx.sh'), false);
  assert.equal(precheck.includes('installRoot'), false);
  assert.equal(precheck.includes('command -v tar'), true);
  assert.equal(precheck.includes('sudo -n true'), true);
  assert.equal(precheck.includes("test -f '/etc/nginx/nginx.conf'"), true);
  assert.equal(precheck.includes("test -d '/var/www/site1'"), true);
});

test('已有实例 tar 命令打包配置与站点 root 且不包含托管二进制', () => {
  const tarCmd = buildExternalArchiveTarCommand(
    {
      useSudo: true,
      mainConfPath: '/etc/nginx/conf.d/app.conf',
    },
    ['/var/www/site1'],
    'all',
    'server { listen 80; root /var/www/site1; }'
  );

  assert.equal(tarCmd.includes('opt/yuyan'), false);
  assert.equal(tarCmd.includes("'var/www/site1'"), true);
  assert.match(tarCmd, /--transform=/);
  assert.equal(tarCmd.includes('etc/nginx/conf.d/app.conf'), true);
});

test('resolveArchiveRuntimeConfig 正确分流托管与已有实例', () => {
  const managed = resolveArchiveRuntimeConfig({
    instanceType: 'managed',
    baseRoot: '/opt/yuyan',
    useSudo: true,
  });
  assert.equal(managed.mainConfPath, '/opt/yuyan/nginx/conf/nginx.conf');
  assert.equal(managed.scriptPath, '/opt/yuyan/nginx/yuyan-nginx.sh');

  const external = resolveArchiveRuntimeConfig({
    instanceType: 'external',
    defaultNginxConfPath: '/etc/nginx/nginx.conf',
    htmlRoot: '/var/www/html',
    useSudo: false,
  });
  assert.equal(external.mainConfPath, '/etc/nginx/nginx.conf');
  assert.equal(external.scriptPath, '');
  assert.equal(external.webRoot, '/var/www/html');
});

test('Nginx 站点配置按文件归属防线（首行 managed-by 标记与哈希防篡改）', () => {
  const target = {
    id: 101,
    listenPort: 7777,
    nginxServerName: '192.168.164.11',
    deployRoot: '/var/www/site7777',
  };
  const generated = renderSiteConfig(target);

  // 1. 生成的配置第一行必须包含 managed-by 标记、target ID 和正确的 SHA-256
  const parsed = parseManagedHeader(generated);
  assert.equal(parsed.isManaged, true);
  assert.equal(parsed.targetId, 101);
  assert.equal(typeof parsed.expectedSha256, 'string');
  assert.equal(parsed.expectedSha256.length, 64);
  assert.equal(computeConfigBodySha256(parsed.body), parsed.expectedSha256);

  // 2. 空配置允许生成写入
  const notFoundCheck = inspectNginxConfigManagedState('', target, parsed.body);
  assert.equal(notFoundCheck.canAutoOverwrite, true);
  assert.equal(notFoundCheck.status, 'not_found');

  // 3. 干净的托管配置允许更新
  const cleanCheck = inspectNginxConfigManagedState(generated, target, parsed.body);
  assert.equal(cleanCheck.canAutoOverwrite, true);
  assert.equal(cleanCheck.status, 'clean_managed');

  // 4. 配置被手工篡改（例如手工加了一行 proxy_pass 或自定义注释）拦截拒绝
  const tamperedContent = generated + '\n# 手工加了一行业务代理\n';
  const tamperedCheck = inspectNginxConfigManagedState(tamperedContent, target, parsed.body);
  assert.equal(tamperedCheck.canAutoOverwrite, false);
  assert.equal(tamperedCheck.status, 'drifted_managed');
  assert.match(tamperedCheck.reason, /已被手工修改过/);

  // 5. 属于其他部署目标（例如 target 202）的配置文件拦截拒绝
  const otherTargetConf = attachManagedHeader(parsed.body, 202);
  const otherCheck = inspectNginxConfigManagedState(otherTargetConf, target, parsed.body);
  assert.equal(otherCheck.canAutoOverwrite, false);
  assert.equal(otherCheck.status, 'drifted_managed');
  assert.match(otherCheck.reason, /属于其他部署目标/);

  // 6. 外部/手工维护的无标记配置文件拦截拒绝
  const manualConf = `
server {
  listen 7777;
  server_name 192.168.164.11;
  location / {
    proxy_pass http://127.0.0.1:8080;
  }
}
  `;
  const manualCheck = inspectNginxConfigManagedState(manualConf, target, parsed.body);
  assert.equal(manualCheck.canAutoOverwrite, false);
  assert.equal(manualCheck.status, 'unmanaged_external');
  assert.match(manualCheck.reason, /手工维护或已有实例文件/);

  // 7. 托管实例老文件平滑迁移：无标记但正文与平台模板完全一致，允许接管
  const legacyMatchCheck = inspectNginxConfigManagedState(parsed.body, target, parsed.body);
  assert.equal(legacyMatchCheck.canAutoOverwrite, true);
  assert.equal(legacyMatchCheck.status, 'legacy_clean_match');
});


