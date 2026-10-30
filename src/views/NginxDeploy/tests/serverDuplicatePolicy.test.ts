import assert from 'node:assert/strict';
import test from 'node:test';
import { extractServerDuplicate, findServerDuplicate, formatServerDuplicateMessage, normalizeServerHostKey } from '../serverDuplicatePolicy.ts';

const servers = [
  { id: 1, name: '华贵委外-测试', host: '192.168.165.60', port: 22, username: 'root' },
  { id: 2, name: '估值-生产', host: 'Web-01.Example.com', port: 22, username: 'deploy' },
];

test('host 去首尾空格、不区分大小写；端口或账号不同允许', () => {
  assert.equal(normalizeServerHostKey('  Web-01.EXAMPLE.com '), 'web-01.example.com');
  const dup = findServerDuplicate(servers, { name: '新机器', host: ' web-01.example.COM ', port: '22', username: 'deploy' });
  assert.deepEqual(dup, {
    code: 'server_duplicate', field: 'host', message: '该服务器已存在：估值-生产（Web-01.Example.com:22 / deploy）', existingServerId: 2, existingServerName: '估值-生产',
  });
  assert.equal(findServerDuplicate(servers, { name: '新机器', host: '192.168.165.60', port: 2222, username: 'root' }), null);
  assert.equal(findServerDuplicate(servers, { name: '新机器', host: '192.168.165.60', port: 22, username: 'app' }), null);
});

test('名称 trim 后查重；编辑排除自己；旧重复记录不改地址和名称不拦', () => {
  assert.equal(findServerDuplicate(servers, { name: ' 估值-生产 ', host: '10.0.0.1', username: 'root' })?.code, 'server_name_duplicate');
  assert.equal(findServerDuplicate(servers, { ...servers[0] }, servers[0]), null);
  assert.equal(findServerDuplicate(servers, { ...servers[0], name: '估值-生产' }, servers[0])?.field, 'name', '只改名称也查重');
  const legacy = [...servers, { id: 3, name: '华贵委外-测试', host: '192.168.165.60', port: 22, username: 'root' }];
  assert.equal(findServerDuplicate(legacy, { ...legacy[2] }, legacy[2]), null);
  assert.equal(findServerDuplicate(legacy, { ...legacy[2], port: 22 }, { ...legacy[2], port: 2222 })?.code, 'server_duplicate');
});

test('从 axios / 中央错误里提取后端查重结果', () => {
  const axiosError = { response: { status: 409, data: { success: false, error: '该服务器已存在：A（1.1.1.1:22 / root）', code: 'server_duplicate', details: { code: 'server_duplicate', existingServerId: 7, existingServerName: 'A' } } } };
  assert.deepEqual(extractServerDuplicate(axiosError), { code: 'server_duplicate', field: 'host', message: '该服务器已存在：A（1.1.1.1:22 / root）', existingServerId: 7, existingServerName: 'A' });
  const agentError = Object.assign(new Error('服务器名称已存在：B（2.2.2.2:22 / root）'), { code: 'server_name_duplicate', details: { existingServerId: 8, existingServerName: 'B' } });
  assert.equal(extractServerDuplicate(agentError)?.field, 'name');
  assert.equal(extractServerDuplicate({ response: { data: { code: 'auth_failed' } } }), null);
  assert.equal(formatServerDuplicateMessage('server_name_duplicate', servers[0]), '服务器名称已存在：华贵委外-测试（192.168.165.60:22 / root）');
});
