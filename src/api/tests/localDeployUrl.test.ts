import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalDeployApiUrl } from '../localDeployUrl.ts';

test('本地部署接口自动补充 deploy-api 路由前缀', () => {
  assert.equal(
    buildLocalDeployApiUrl('http://127.0.0.1:3100', '/jdks/scan'),
    'http://127.0.0.1:3100/deploy-api/jdks/scan',
  );
});

test('已包含 deploy-api 前缀时不会重复拼接', () => {
  assert.equal(
    buildLocalDeployApiUrl('http://127.0.0.1:3100/', '/deploy-api/nginx-instances/8/archive-save'),
    'http://127.0.0.1:3100/deploy-api/nginx-instances/8/archive-save',
  );
});
