import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 在独立 Node 进程中运行数据库脚本，确保常量读取测试环境变量。 */
function runStoreScript(root, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEPLOY_DATA_DIR: root,
      DEPLOY_DB_PATH: path.join(root, 'deploy.sqlite'),
      DEPLOY_SECRET_KEY: 'test-secret-key-application-kind',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return line ? JSON.parse(line) : null;
}

test('deploy_targets.application_kind: 迁移、创建、更新保留及非法值归一化', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-app-kind-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // 1. 模拟旧库（无 application_kind 列）迁移
  const initRes = runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    await store.getDeployDb();
    await store.closeDeployDb();

    // 手动删除 application_kind 列（若存在）来模拟旧版数据库，或直接验证迁移脚本
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(process.env.DEPLOY_DB_PATH);
    const columns = db.prepare("PRAGMA table_info('deploy_targets')").all().map(c => c.name);
    db.close();

    console.log(JSON.stringify({ columns }));
  `);
  assert.ok(initRes.columns.includes('application_kind'), 'deploy_targets 表必须包含 application_kind 列');

  // 2. 测试 create 存 micro/main/非法值以及后端目标
  const testRes = runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const { runRequestContext } = await import('./server/services/request-context.mjs');
    const context = {
      accountId: 'test-account',
      userId: 'test-user',
      deviceId: 'test-device',
      teamId: 'test-team',
      role: 'admin',
      client: 'desktop',
      requestId: 'test-app-kind',
    };

    const server = await runRequestContext(context, () => store.createServer({
      name: '测试服务器',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      secret: 'pwd123',
      defaultBackendRoot: '/opt/backend',
    }));

    const instance = await runRequestContext(context, () => store.createNginxInstance(server.id, {
      name: '已有 Nginx',
      instanceType: 'external',
      defaultDeployRoot: '/data/www',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    }));

    // 前端微应用
    const microTarget = await runRequestContext(context, () => store.createTarget({
      projectId: 101,
      projectName: 'micro-app',
      projectPath: 'group/micro-app',
      repositoryUrl: 'http://git.example.com/group/micro-app.git',
      defaultBranch: 'main',
      envName: '测试',
      serverId: server.id,
      nginxInstanceId: instance.id,
      deployRoot: '/data/www/micro-app',
      nginxConfPath: '/etc/nginx/conf.d/micro.conf',
      applicationKind: 'micro',
      projectType: 'frontend',
    }));

    // 前端主应用
    const mainTarget = await runRequestContext(context, () => store.createTarget({
      projectId: 102,
      projectName: 'main-app',
      projectPath: 'group/main-app',
      repositoryUrl: 'http://git.example.com/group/main-app.git',
      defaultBranch: 'main',
      envName: '测试',
      serverId: server.id,
      nginxInstanceId: instance.id,
      deployRoot: '/data/www/main-app',
      nginxConfPath: '/etc/nginx/conf.d/main.conf',
      applicationKind: 'main',
      projectType: 'frontend',
    }));

    // 非法值存 ''
    const invalidTarget = await runRequestContext(context, () => store.createTarget({
      projectId: 103,
      projectName: 'invalid-kind-app',
      projectPath: 'group/invalid-app',
      repositoryUrl: 'http://git.example.com/group/invalid-app.git',
      defaultBranch: 'main',
      envName: '测试',
      serverId: server.id,
      nginxInstanceId: instance.id,
      deployRoot: '/data/www/invalid-app',
      nginxConfPath: '/etc/nginx/conf.d/invalid.conf',
      applicationKind: 'something_else',
      projectType: 'frontend',
    }));

    // 后端项目一律存 ''
    const backendTarget = await runRequestContext(context, () => store.createTarget({
      projectId: 104,
      projectName: 'backend-app',
      projectPath: 'group/backend-app',
      repositoryUrl: 'http://git.example.com/group/backend-app.git',
      defaultBranch: 'main',
      envName: '测试',
      serverId: server.id,
      deployRoot: '/opt/backend/app',
      serverPort: 8089,
      applicationKind: 'micro',
      projectType: 'backend',
      processMode: 'pid',
      requiredJdkAlias: '17',
      runtimeJavaHome: '/opt/jdk-17',
      artifactPattern: 'app.jar',
      stopCommand: '',
      startCommand: '',
      healthCheckPath: '/actuator/health',
    }));

    // 3. update 不传字段保留旧值
    const updatedMicro = await runRequestContext(context, () => store.updateTarget(microTarget.id, {
      ...microTarget,
      projectName: 'micro-app-renamed',
      applicationKind: undefined, // 不传，保留
    }));

    // 4. update 传新值则更新
    const changedToMain = await runRequestContext(context, () => store.updateTarget(microTarget.id, {
      ...updatedMicro,
      applicationKind: 'main',
    }));

    // 5. update 传非法值则变成 ''
    const changedToInvalid = await runRequestContext(context, () => store.updateTarget(microTarget.id, {
      ...changedToMain,
      applicationKind: 'invalid',
    }));

    await store.closeDeployDb();

    console.log(JSON.stringify({
      microKind: microTarget.applicationKind,
      mainKind: mainTarget.applicationKind,
      invalidKind: invalidTarget.applicationKind,
      backendKind: backendTarget.applicationKind,
      retainedMicroKind: updatedMicro.applicationKind,
      changedToMainKind: changedToMain.applicationKind,
      changedToInvalidKind: changedToInvalid.applicationKind,
    }));
  `);

  assert.equal(testRes.microKind, 'micro', 'createTarget 存 micro 能读回');
  assert.equal(testRes.mainKind, 'main', 'createTarget 存 main 能读回');
  assert.equal(testRes.invalidKind, '', 'createTarget 存非法值存为 空字符串');
  assert.equal(testRes.backendKind, '', '后端项目 applicationKind 一律为 空字符串');
  assert.equal(testRes.retainedMicroKind, 'micro', 'updateTarget 不传 applicationKind 保留旧值');
  assert.equal(testRes.changedToMainKind, 'main', 'updateTarget 显式更新为 main');
  assert.equal(testRes.changedToInvalidKind, '', 'updateTarget 传入非法值更新为 空字符串');
});

test('旧库无 application_kind 列时迁移后该列默认为空字符串', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-migration-app-kind-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // 手工建一个没有 application_kind 列的 deploy_targets 表
  runStoreScript(root, `
    const { DatabaseSync } = await import('node:sqlite');
    const path = await import('node:path');
    const db = new DatabaseSync(process.env.DEPLOY_DB_PATH);
    const ts = new Date().toISOString();
    db.exec(\`
      CREATE TABLE IF NOT EXISTS deploy_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'password',
        encrypted_secret TEXT NOT NULL,
        use_sudo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deploy_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        project_source TEXT NOT NULL DEFAULT 'ops',
        project_name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'dev',
        env_name TEXT NOT NULL,
        server_id INTEGER NOT NULL,
        deploy_root TEXT NOT NULL,
        nginx_conf_path TEXT NOT NULL,
        install_command TEXT NOT NULL,
        build_command TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO deploy_servers (id, name, host, port, username, auth_type, encrypted_secret, created_at, updated_at)
      VALUES (1, 's1', '127.0.0.1', 22, 'root', 'password', '', '\${ts}', '\${ts}');
      INSERT INTO deploy_targets (id, project_id, project_name, project_path, repository_url, env_name, server_id, deploy_root, nginx_conf_path, install_command, build_command, created_at, updated_at)
      VALUES (1, 1, 'legacy-target', 'group/legacy', 'http://git/legacy.git', '测试', 1, '/opt/html/legacy', '/etc/nginx/legacy.conf', 'npm i', 'npm build', '\${ts}', '\${ts}');
    \`);
    db.close();
    console.log(JSON.stringify({ legacyCreated: true }));
  `);

  // 运行 store 初始化，触发迁移
  const migrationRes = runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const target = await store.getTarget(1);
    await store.closeDeployDb();
    console.log(JSON.stringify({ applicationKind: target.applicationKind }));
  `);

  assert.equal(migrationRes.applicationKind, '', '旧库迁移后历史记录 applicationKind 默认为空字符串');
});
