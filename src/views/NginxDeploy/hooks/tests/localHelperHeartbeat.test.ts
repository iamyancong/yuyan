import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('部署中心操作 Hook 不再轮询写死的本机 127.0.0.1:3100/health', () => {
  const source = readFileSync(new URL('../useNginxDeployActions.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('127.0.0.1:3100'), false);
  assert.equal(/setInterval\s*\(/.test(source), false);
  assert.equal(source.includes('isLocalHelperOnline'), false);
});
