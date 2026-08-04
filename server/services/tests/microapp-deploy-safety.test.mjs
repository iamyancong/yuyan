import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalTarExcludeArgs, normalizeUploadStrategy } from '../deploy-service.mjs';
import { renderMainNginxConfig, renderSiteConfig } from '../nginx-runtime-service.mjs';
import { orderUploadEntries } from '../ssh-service.mjs';

/** 创建目录条目测试替身。 */
const createEntry = (name, file = true) => ({
  name,
  isFile: () => file,
});

test('前端上传策略默认保留旧资源，同时允许显式清空替换', () => {
  assert.equal(normalizeUploadStrategy(undefined), 'overlayKeepAssets');
  assert.equal(normalizeUploadStrategy('invalid'), 'overlayKeepAssets');
  assert.equal(normalizeUploadStrategy('overlayKeepAssets'), 'overlayKeepAssets');
  assert.equal(normalizeUploadStrategy('cleanReplace'), 'cleanReplace');
});

test('SFTP 上传顺序将根入口文件放在静态资源之后', () => {
  const ordered = orderUploadEntries(
    [createEntry('index.html'), createEntry('assets', false), createEntry('favicon.ico')],
    new Set(['index.html'])
  );

  assert.deepEqual(ordered.map((entry) => entry.name), ['assets', 'favicon.ico', 'index.html']);
});

test('sudo tar 首批产物排除入口文件和受保护目录', () => {
  const args = buildLocalTarExcludeArgs(['outsourced'], ['index.html']);

  assert.match(args, /--exclude='\.\/outsourced'/);
  assert.match(args, /--exclude='\.\/outsourced\/\*'/);
  assert.match(args, /--exclude='\.\/index\.html'/);
});

test('托管主配置对缺失静态资源返回 404，仅普通页面路由回退入口', () => {
  const content = renderMainNginxConfig({ portStart: 32088, webRoot: '/opt/yuyan/html' });

  assert.match(content, /location ~\* \\\.html\$/);
  assert.match(content, /location ~\* \\\.\(js\|mjs\|css\|map\|wasm/);
  assert.match(content, /try_files \$uri =404;/);
  assert.match(content, /try_files \$uri \$uri\/ \/index\.html;/);
  assert.ok(content.indexOf('try_files $uri =404;') < content.indexOf('try_files $uri $uri/ /index.html;'));
});

test('独立站点配置与托管主配置使用相同静态资源策略', () => {
  const content = renderSiteConfig({
    listenPort: 32089,
    nginxServerName: '_',
    deployRoot: '/opt/yuyan/html/outsourced',
  });

  assert.match(content, /js\|mjs\|css\|map\|wasm/);
  assert.match(content, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(content, /try_files \$uri =404;/);
  assert.match(content, /try_files \$uri \$uri\/ \/index\.html;/);
});
