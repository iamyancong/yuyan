import assert from 'node:assert/strict';
import test from 'node:test';
import { getRequiredRoles, isDestructiveNameConfirmed } from '../central-deploy-guard.mjs';

test('viewer、operator、admin 权限矩阵覆盖查询、普通写入和管理/删除操作', () => {
  assert.deepEqual(getRequiredRoles('GET', '/targets'), ['viewer', 'operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/targets/1/deploy'), ['operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/records/1/rollback'), ['operator', 'admin']);
  assert.deepEqual(getRequiredRoles('POST', '/servers'), ['admin']);
  assert.deepEqual(getRequiredRoles('PUT', '/environments/1'), ['admin']);
  assert.deepEqual(getRequiredRoles('DELETE', '/targets/1'), ['admin']);
  assert.equal(isDestructiveNameConfirmed('DELETE', 'target', '', 'demo'), false);
  assert.equal(isDestructiveNameConfirmed('DELETE', 'target', 'other', 'demo'), false);
  assert.equal(isDestructiveNameConfirmed('DELETE', 'target', 'demo', 'demo'), true);
});
