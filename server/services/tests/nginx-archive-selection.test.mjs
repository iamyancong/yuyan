import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectDotPathWhitelists,
  resolveNginxArchiveWhitelist,
} from '../nginx-archive-selection.mjs';
import {
  buildArchiveExcludeTarScript,
  buildSelectedArchiveTarCommand,
  buildExternalArchiveTarCommand,
} from '../nginx-runtime-service.mjs';

test('collectDotPathWhitelists 正确展开多级点目录与子文件', () => {
  // 1. 多层级隐藏目录与点文件
  const multiLevel = collectDotPathWhitelists('/data/.certs/keys/.auth/pass');
  assert.deepEqual(multiLevel, [
    '/data/.certs',
    '/data/.certs/keys',
    '/data/.certs/keys/.auth',
    '/data/.certs/keys/.auth/pass',
  ]);

  // 2. 单层点文件
  const singleFile = collectDotPathWhitelists('/etc/nginx/.htpasswd');
  assert.deepEqual(singleFile, ['/etc/nginx/.htpasswd']);

  // 3. 普通非隐藏路径（无任何点目录）
  const normalPath = collectDotPathWhitelists('/var/www/my-site/dist/index.html');
  assert.deepEqual(normalPath, []);

  // 4. .well-known 目录应由 find 自动放行，无需额外收集
  const wellKnown = collectDotPathWhitelists('/var/www/.well-known/acme-challenge/token');
  assert.deepEqual(wellKnown, []);

  // 5. 空路径与非绝对路径边界
  assert.deepEqual(collectDotPathWhitelists(''), []);
  assert.deepEqual(collectDotPathWhitelists('relative/path'), []);
});

test('resolveNginxArchiveWhitelist 能够从各类 Nginx 指令中精准解析点文件白名单', () => {
  const nginxConf = `
    user nginx;
    worker_processes auto;

    events { worker_connections 1024; }

    http {
      include /etc/nginx/mime.types;
      include .conf.d/*.conf;

      ssl_certificate /etc/ssl/.certs/bundle.crt;
      ssl_certificate_key /etc/ssl/.certs/bundle.key;
      ssl_dhparam /etc/ssl/.params/dhparam.pem;
      ssl_password_file /etc/ssl/.keys/pass.txt;

      server {
        listen 443 ssl;
        server_name app.example.com;

        auth_basic "Restricted";
        auth_basic_user_file /home/nginx/conf/.htpasswd;

        root /var/www/.sites/app/dist;
        alias /var/data/.static/files;

        error_page 404 /.error_pages/404.html;
        error_page 500 502 /50x.html;

        location / {
          try_files $uri $uri/ /.fallback.html =404;
        }
      }
    }
  `;

  const whitelist = resolveNginxArchiveWhitelist(nginxConf, {
    confDir: '/etc/nginx',
    prefix: '/usr/local/nginx',
  });

  // 验证 auth_basic_user_file
  assert.equal(whitelist.includes('/home/nginx/conf/.htpasswd'), true);

  // 验证 ssl 相关文件与目录
  assert.equal(whitelist.includes('/etc/ssl/.certs'), true);
  assert.equal(whitelist.includes('/etc/ssl/.certs/bundle.crt'), true);
  assert.equal(whitelist.includes('/etc/ssl/.certs/bundle.key'), true);
  assert.equal(whitelist.includes('/etc/ssl/.params'), true);
  assert.equal(whitelist.includes('/etc/ssl/.params/dhparam.pem'), true);
  assert.equal(whitelist.includes('/etc/ssl/.keys'), true);
  assert.equal(whitelist.includes('/etc/ssl/.keys/pass.txt'), true);

  // 验证 include 相对路径自动按 confDir 补全
  assert.equal(whitelist.includes('/etc/nginx/.conf.d'), true);
  assert.equal(whitelist.includes('/etc/nginx/.conf.d/*.conf'), true);

  // 验证 root 与 alias 点目录
  assert.equal(whitelist.includes('/var/www/.sites'), true);
  assert.equal(whitelist.includes('/var/www/.sites/app'), true);
  assert.equal(whitelist.includes('/var/www/.sites/app/dist'), true);
  assert.equal(whitelist.includes('/var/data/.static'), true);
  assert.equal(whitelist.includes('/var/data/.static/files'), true);

  // 验证 error_page 与 try_files
  assert.equal(whitelist.includes('/.error_pages'), true);
  assert.equal(whitelist.includes('/.error_pages/404.html'), true);
  assert.equal(whitelist.includes('/.fallback.html'), true);

  // 验证普通路径不产生白名单条目
  assert.equal(whitelist.includes('/50x.html'), false);
  assert.equal(whitelist.includes('/etc/nginx/mime.types'), false);
});

test('resolveNginxArchiveWhitelist 正确处理相对路径与变量过滤', () => {
  const confSnippet = `
    server {
      listen 80;
      auth_basic_user_file .htpasswd;
      location /api {
        proxy_pass http://127.0.0.1:8080;
        try_files $uri $uri/ =404;
      }
    }
  `;

  const whitelist = resolveNginxArchiveWhitelist(confSnippet, {
    confDir: '/opt/nginx/conf',
  });

  assert.deepEqual(whitelist, ['/opt/nginx/conf/.htpasswd']);
});

test('buildArchiveExcludeTarScript 结构与顺序验证（--anchored 与 -X 紧随）', () => {
  const script = buildArchiveExcludeTarScript({
    config: { useSudo: false },
    roots: ['/var/www/site'],
    archivePaths: ['var/www/site'],
    excludePatterns: ['*/.yuyan-backups', '*/.yuyan-manifests'],
    whitelist: ['/var/www/site/.htpasswd'],
    includeHidden: false,
  });

  // 1. 验证清理机制
  assert.match(script, /YUYAN_KEEP=\$\(mktemp\)/);
  assert.match(script, /YUYAN_EXCLUDE=\$\(mktemp\)/);
  assert.match(script, /trap 'rm -f "\$YUYAN_KEEP" "\$YUYAN_EXCLUDE"' EXIT/);

  // 2. 验证白名单注入
  assert.match(script, /base64 -d > "\$YUYAN_KEEP"/);

  // 3. 验证 find 排除管道与保留 .well-known
  assert.match(script, /find '\/var\/www\/site' -mindepth 1 -name '\.\*' ! -name '\.well-known' -prune -print/);
  assert.match(script, /grep -Fvx -f "\$YUYAN_KEEP" \|\| true/);
  assert.match(script, /sed -e "s#\^\/##" -e "s#\[\\\*\?\\\(\]\|\[#\\\\&#g"|sed -e "s#\^\/##"/);

  // 4. 验证 tar 参数顺序：--anchored -X 位于 --no-anchored 之前
  const tarPart = script.slice(script.indexOf('tar -czf'));
  assert.match(tarPart, /tar -czf - -C \/ --anchored -X "\$YUYAN_EXCLUDE" --no-anchored/);
  assert.match(tarPart, /--exclude='\*\/_?\.?yuyan-backups'/);
});

test('buildArchiveExcludeTarScript 在 includeHidden=true 时平滑回滚', () => {
  const script = buildArchiveExcludeTarScript({
    config: { useSudo: true },
    roots: ['/var/www/site'],
    archivePaths: ['var/www/site'],
    excludePatterns: ['*/.yuyan-backups'],
    whitelist: ['/var/www/site/.htpasswd'],
    includeHidden: true,
  });

  // 不生成任何 mktemp、trap、find、grep 命令
  assert.equal(script.includes('mktemp'), false);
  assert.equal(script.includes('find'), false);
  assert.equal(script.includes('grep'), false);
  assert.equal(script.includes('--anchored -X'), false);

  // 直接使用 sudo -n tar
  assert.match(script, /^sudo -n tar -czf - -C \/ --exclude='\*\/_?\.?yuyan-backups' 'var\/www\/site'/);
});

test('根目录本身处于点目录时（如 /home/app/.local/www）不被自身排除', () => {
  const command = buildSelectedArchiveTarCommand(
    { useSudo: false, installRoot: '/opt/nginx', mainConfPath: '/opt/nginx/conf/nginx.conf' },
    ['/home/app/.local/www'],
    'html',
    '',
    { whitelist: [], includeHidden: false }
  );

  // 验证 find 命令带有 -mindepth 1，只匹配内部子条目，不匹配自身
  assert.match(command, /find '\/home\/app\/\.local\/www' -mindepth 1/);
  // 验证 tar 打包条目包含相对路径
  assert.match(command, /'home\/app\/\.local\/www'/);
});

test('特殊字符通配符转义验证（sed 自动转义 *?[）', () => {
  const command = buildExternalArchiveTarCommand(
    { useSudo: false, mainConfPath: '/etc/nginx/nginx.conf' },
    ['/var/www/site[1]*'],
    'html',
    '',
    { includeHidden: false }
  );

  // 验证包含对通配符的 sed 转义模式
  assert.match(command, /sed -e "s#\^\/##"/);
  assert.match(command, /'var\/www\/site\[1\]\*'/);
});

test('resolveNginxArchiveWhitelist: 主配置 include 子配置，子配置中包含 auth_basic_user_file .htpasswd 与证书', () => {
  const nginxDumpOutput = `
# configuration file /etc/nginx/nginx.conf:
user nginx;
worker_processes auto;
include /etc/nginx/conf.d/*.conf;

# configuration file /etc/nginx/conf.d/subsite.conf:
server {
    listen 8080;
    server_name subsite.local;
    root /var/www/subsite;

    auth_basic "Restricted Area";
    auth_basic_user_file /data/secrets/.htpasswd;

    ssl_certificate /etc/nginx/.certs/subsite.crt;
    ssl_certificate_key /etc/nginx/.certs/subsite.key;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;

  const whitelist = resolveNginxArchiveWhitelist(nginxDumpOutput, {
    confDir: '/etc/nginx',
    prefix: '/etc/nginx',
  });

  // 必须成功放行子配置中的 .htpasswd 以及 .certs 目录和证书文件
  assert.equal(whitelist.includes('/data/secrets/.htpasswd'), true);
  assert.equal(whitelist.includes('/etc/nginx/.certs'), true);
  assert.equal(whitelist.includes('/etc/nginx/.certs/subsite.crt'), true);
  assert.equal(whitelist.includes('/etc/nginx/.certs/subsite.key'), true);
});

test('resolveNginxArchiveWhitelist: 支持子配置中相对路径的点文件引用', () => {
  const nginxDumpOutput = `
# configuration file /etc/nginx/nginx.conf:
include /etc/nginx/conf.d/*.conf;

# configuration file /etc/nginx/conf.d/project.conf:
server {
    listen 80;
    auth_basic_user_file .project-auth;
}
`;

  const whitelist = resolveNginxArchiveWhitelist(nginxDumpOutput, {
    confDir: '/etc/nginx',
    prefix: '/etc/nginx',
  });

  // 相对路径应基于子配置所在目录解析并进入白名单
  assert.equal(whitelist.includes('/etc/nginx/conf.d/.project-auth'), true);
});

