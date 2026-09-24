import assert from 'node:assert/strict';
import test from 'node:test';
import { detectFileLanguage } from '../constant.ts';

test('detectFileLanguage: 常见前端与配置文件语言识别', () => {
  assert.equal(detectFileLanguage('main.js'), 'javascript');
  assert.equal(detectFileLanguage('chunk.mjs'), 'javascript');
  assert.equal(detectFileLanguage('app.ts'), 'typescript');
  assert.equal(detectFileLanguage('component.vue'), 'html');
  assert.equal(detectFileLanguage('index.html'), 'html');
  assert.equal(detectFileLanguage('style.css'), 'css');
  assert.equal(detectFileLanguage('global.less'), 'less');
  assert.equal(detectFileLanguage('package.json'), 'json');
});

test('detectFileLanguage: Nginx 与服务配置语言识别', () => {
  assert.equal(detectFileLanguage('nginx.conf'), 'nginx');
  assert.equal(detectFileLanguage('default.conf'), 'nginx');
  assert.equal(detectFileLanguage('/etc/nginx/conf.d/yuyan.conf'), 'nginx');
  assert.equal(detectFileLanguage('Dockerfile'), 'dockerfile');
  assert.equal(detectFileLanguage('.env.production'), 'ini');
  assert.equal(detectFileLanguage('application.yml'), 'yaml');
  assert.equal(detectFileLanguage('deploy.sh'), 'shell');
  assert.equal(detectFileLanguage('schema.sql'), 'sql');
});

test('detectFileLanguage: 未知类型与空值边界回退', () => {
  assert.equal(detectFileLanguage(''), 'plaintext');
  assert.equal(detectFileLanguage('LICENSE'), 'plaintext');
  assert.equal(detectFileLanguage('unknown.bin'), 'plaintext');
});
