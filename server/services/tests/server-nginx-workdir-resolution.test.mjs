import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('updateServer 允许将 nginxWorkDir 与默认路径显式清空为字符串', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-server-workdir-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'server-workdir-test-secret';

  const store = await import('../deploy-store.mjs');
  const server = await store.createServer({
    name: '星河测试机',
    host: '192.168.165.13',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
    defaultDeployRoot: '/home/app/frontend/html',
    defaultBackendRoot: '/home/yuyan/backend',
    defaultNginxConfPath: '/home/app/frontend/nginx/conf/nginx.conf',
    nginxWorkDir: '/home/app/frontend/nginx',
    remark: '测试备注',
  });

  assert.equal(server.nginxWorkDir, '/home/app/frontend/nginx');
  assert.equal(server.defaultNginxConfPath, '/home/app/frontend/nginx/conf/nginx.conf');

  // 用户在表单中将 nginxWorkDir 等字段清空保存
  const updated = await store.updateServer(server.id, {
    name: '星河测试机',
    host: '192.168.165.13',
    port: 22,
    username: 'root',
    authType: 'password',
    defaultDeployRoot: '/home/app/frontend/html',
    defaultBackendRoot: '',
    defaultNginxConfPath: '/home/nginx/conf/nginx.conf',
    nginxWorkDir: '',
    remark: '',
  });

  assert.equal(updated.nginxWorkDir, '', 'nginxWorkDir 必须成功置空，不得回退为旧值');
  assert.equal(updated.defaultBackendRoot, '', 'defaultBackendRoot 必须成功置空');
  assert.equal(updated.defaultNginxConfPath, '/home/nginx/conf/nginx.conf');
  assert.equal(updated.remark, '', 'remark 必须成功置空');

  // 再次从数据库单独读取验证持久化
  const reloaded = await store.getServerWithCredential(server.id);
  assert.equal(reloaded.nginxWorkDir, '', '重新从数据库读取时 nginxWorkDir 依然必须为空');
  assert.equal(reloaded.defaultBackendRoot, '');
  assert.equal(reloaded.remark, '');
});

test('buildNginxCommand 与 getNginxCommandLabel 严格以绑定的 Nginx 实例为准，防止被 server.nginxWorkDir 污染', async () => {
  const { buildNginxCommand, getNginxCommandLabel } = await import('../deploy-service.mjs');

  const serverWithLegacyDirtyWorkDir = {
    id: 5,
    name: '国寿海外星河系统',
    useSudo: true,
    nginxWorkDir: '/home/app/frontend/nginx',
    nginxTestCommand: 'nginx -t',
    nginxReloadCommand: 'nginx -s reload',
  };

  const externalInstanceWithEmptyWorkDir = {
    id: 12,
    name: '已有 Nginx',
    instanceType: 'external',
    useSudo: false,
    nginxWorkDir: '',
    nginxTestCommand: '/home/nginx/sbin/nginx -t',
    nginxReloadCommand: '/home/nginx/sbin/nginx -s reload',
  };

  // 1. 实例明确留空工作目录时，绝不能穿透继承 server 的 /home/app/frontend/nginx
  const testCmd = buildNginxCommand(serverWithLegacyDirtyWorkDir, externalInstanceWithEmptyWorkDir, 'test');
  assert.equal(testCmd, '/home/nginx/sbin/nginx -t', '不得拼接 cd /home/app/frontend/nginx 前缀');

  const reloadCmd = buildNginxCommand(serverWithLegacyDirtyWorkDir, externalInstanceWithEmptyWorkDir, 'reload');
  assert.equal(reloadCmd, '/home/nginx/sbin/nginx -s reload');

  const testLabel = getNginxCommandLabel(serverWithLegacyDirtyWorkDir, externalInstanceWithEmptyWorkDir, 'test');
  assert.equal(testLabel, '/home/nginx/sbin/nginx -t');

  // 2. 实例如果自身配置了合法的工作目录，则正常使用自身工作目录
  const externalInstanceWithSpecificWorkDir = {
    ...externalInstanceWithEmptyWorkDir,
    nginxWorkDir: '/home/nginx',
  };
  const testCmdWithWorkDir = buildNginxCommand(serverWithLegacyDirtyWorkDir, externalInstanceWithSpecificWorkDir, 'test');
  assert.equal(testCmdWithWorkDir, "cd '/home/nginx' && /home/nginx/sbin/nginx -t");

  // 3. 兼容未绑定实例的历史目标（此时回退到 server 配置）
  const fallbackCmd = buildNginxCommand(serverWithLegacyDirtyWorkDir, null, 'test');
  assert.equal(fallbackCmd, "cd '/home/app/frontend/nginx' && sudo -n nginx -t");
});
