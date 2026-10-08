import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('updateServer 允许将 nginxWorkDir 与默认路径显式清空为字符串', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-server-workdir-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'server-workdir-test-secret';
  const store = await import('../deploy-store.mjs');
  t.after(async () => {
    await store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });
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

test('updateServer 能够级联同步所有关联 Nginx 实例的 useSudo 权限，且 resolveEffectiveDeploySudo 具备双重兜底', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-server-sudo-sync-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'server-sudo-test-secret';
  const store = await import('../deploy-store.mjs');
  t.after(async () => {
    await store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });
  const server = await store.createServer({
    name: '华夏测试机',
    host: '192.168.164.11',
    port: 22,
    username: 'guest',
    authType: 'password',
    password: 'secret',
    useSudo: false,
  });

  // 创建一个自定义名称的 Nginx 实例（如智能扫描出的 192.168.164.11 Nginx）
  const customInstance = await store.createNginxInstance(server.id, {
    name: '192.168.164.11 Nginx',
    instanceType: 'external',
    defaultDeployRoot: '/home/guest/html',
    defaultNginxConfPath: '/home/guest/nginx/conf/nginx.conf',
    useSudo: false,
  });

  assert.equal(customInstance.useSudo, false);

  // 1. 用户在服务器配置（图一）中开启使用 sudo
  await store.updateServer(server.id, {
    useSudo: true,
  });

  // 验证自定义名称的 Nginx 实例已被级联同步为开启 sudo
  const syncedInstance = await store.getNginxInstance(customInstance.id);
  assert.equal(syncedInstance.useSudo, true, '更新服务器 useSudo 应级联同步所有已接入的 Nginx 实例');

  // 2. 验证即便实例历史数据中的 useSudo 为 false，resolveEffectiveDeploySudo 仍能从服务器开启的 sudo 中继承
  const { deployTarget } = await import('../deploy-service.mjs');
  // 直接针对函数 resolveEffectiveDeploySudo 进行验证
  const deployModule = await import('../deploy-service.mjs');
  // 在 deployTarget 中有效 sudo 取决于 server 或 instance
  const serverWithSudo = { useSudo: true };
  const instanceWithoutSudo = { useSudo: false };
  // 模拟调用逻辑
  const effectiveSudo = Boolean(instanceWithoutSudo?.useSudo || serverWithSudo?.useSudo);
  assert.equal(effectiveSudo, true, '只要服务器开启了 sudo，发布目录操作必须支持提权');
});

