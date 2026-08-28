import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('托管实例可安全纠正为已有 Nginx，并允许直接绑定现有部署目录', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-nginx-transition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'nginx-instance-transition-test-secret';

  const store = await import('../deploy-store.mjs');
  const server = await store.createServer({
    name: '已有服务测试机',
    host: '127.0.0.1',
    port: 22,
    username: 'ops',
    authType: 'password',
    password: 'secret',
    defaultDeployRoot: '/home/app/frontend/html',
    defaultNginxConfPath: '/home/nginx/conf/nginx.conf',
  });
  const managed = await store.createNginxInstance(server.id, {
    name: '误建托管实例',
    instanceType: 'managed',
    baseRoot: '/opt/yuyan',
    defaultDeployRoot: '/opt/yuyan/html',
    defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    runtimeVersion: '1.0.0',
    packageVariant: 'linux-x64',
    initializedAt: new Date().toISOString(),
    status: 'running',
  });

  const external = await store.updateNginxInstance(managed.id, {
    name: '生产已有 Nginx',
    instanceType: 'external',
    defaultDeployRoot: '/home/app/frontend/html',
    defaultNginxConfPath: '/home/nginx/conf/nginx.conf',
    nginxWorkDir: '/home/nginx',
    nginxTestCommand: '/home/nginx/sbin/nginx -t',
    nginxReloadCommand: '/home/nginx/sbin/nginx -s reload',
    useSudo: false,
  });

  assert.equal(external.instanceType, 'external');
  assert.equal(external.defaultDeployRoot, '/home/app/frontend/html');
  assert.equal(external.defaultNginxConfPath, '/home/nginx/conf/nginx.conf');
  assert.equal(external.baseRoot, '');
  assert.equal(external.nginxRoot, '');
  assert.equal(external.htmlRoot, '');
  assert.equal(external.scriptPath, '');
  assert.equal(external.runtimeVersion, '');
  assert.equal(external.packageVariant, '');
  assert.equal(external.status, 'unknown');
  assert.equal(external.initializedAt, '');

  const target = await store.createTarget({
    projectId: 1001,
    projectSource: 'gitlab',
    projectName: '现有前端项目',
    projectPath: 'group/frontend',
    repositoryUrl: 'https://gitlab.example/group/frontend.git',
    defaultBranch: 'main',
    envName: '生产',
    serverId: server.id,
    nginxInstanceId: external.id,
    deployRoot: '/home/app/frontend/html',
    nginxConfPath: '/home/nginx/conf/nginx.conf',
    nginxSiteManaged: false,
    projectType: 'frontend',
  });
  assert.equal(target.deployRoot, '/home/app/frontend/html');
  assert.equal(target.nginxInstanceId, external.id);

  await assert.rejects(
    () => store.updateNginxInstance(external.id, { ...external, instanceType: 'managed' }),
    /已绑定部署目标/
  );

  const managedAgain = await store.createNginxInstance(server.id, {
    name: '平台托管',
    instanceType: 'managed',
    baseRoot: '/srv/yuyan',
  });
  const anotherExternal = await store.createNginxInstance(server.id, {
    name: '另一套已有 Nginx',
    instanceType: 'external',
    defaultDeployRoot: '/srv/webapps',
    defaultNginxConfPath: '/etc/nginx/nginx.conf',
  });
  await assert.rejects(
    () => store.updateNginxInstance(anotherExternal.id, { ...anotherExternal, instanceType: 'managed', baseRoot: '/srv/other' }),
    /只能配置一个平台托管 Nginx/
  );
  assert.equal(managedAgain.instanceType, 'managed');

  const fingerprint = 'a'.repeat(64);
  const fingerprintInstance = await store.createNginxInstance(server.id, {
    name: '指纹实例',
    instanceType: 'external',
    runtimeFingerprint: fingerprint,
    defaultNginxConfPath: '/srv/nginx/conf/nginx.conf',
  });
  assert.equal(fingerprintInstance.runtimeFingerprint, fingerprint);
  await assert.rejects(
    () => store.createNginxInstance(server.id, {
      name: '并发重复实例',
      instanceType: 'external',
      runtimeFingerprint: fingerprint,
      defaultNginxConfPath: '/srv/nginx/conf/other.conf',
    }),
    (error) => error?.status === 409
      && error?.code === 'nginx_runtime_already_connected'
      && error?.details?.existingInstance?.id === fingerprintInstance.id,
  );
  await assert.rejects(
    () => store.createNginxInstance(server.id, {
      name: '手动路径重复实例',
      instanceType: 'external',
      defaultNginxConfPath: '/etc/nginx/./nginx.conf',
    }),
    (error) => error?.status === 409 && error?.code === 'nginx_runtime_already_connected',
  );

  const secondServer = await store.createServer({
    name: '指纹清理测试机',
    host: '127.0.0.2',
    port: 22,
    username: 'ops',
    authType: 'password',
    password: 'secret',
  });
  const externalWithFingerprint = await store.createNginxInstance(secondServer.id, {
    name: '待切换实例',
    instanceType: 'external',
    runtimeFingerprint: 'b'.repeat(64),
    defaultNginxConfPath: '/opt/nginx/conf/nginx.conf',
  });
  const convertedManaged = await store.updateNginxInstance(externalWithFingerprint.id, {
    ...externalWithFingerprint,
    instanceType: 'managed',
    baseRoot: '/opt/yuyan-managed',
  });
  assert.equal(convertedManaged.runtimeFingerprint, '');
});
