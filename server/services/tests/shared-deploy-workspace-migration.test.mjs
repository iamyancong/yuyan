import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * 在隔离 Node 进程中执行中央部署迁移脚本。
 * @param {string} root 临时数据目录
 * @param {string} source ESM 测试脚本
 * @returns {unknown} 脚本最后一行 JSON
 */
function runMigrationScript(root, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEPLOY_DATA_DIR: root,
      DEPLOY_DB_PATH: path.join(root, 'deploy.sqlite'),
      DEPLOY_SECRET_KEY: 'shared-workspace-migration-secret',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return line ? JSON.parse(line) : null;
}

test('v6 无损合并多账号部署数据、换绑 SSH/Nacos 密文并保持设备资源隔离', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-shared-deploy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = runMigrationScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const { runRequestContext, SHARED_DEPLOY_WORKSPACE_ID, useSharedDeployWorkspace } = await import('./server/services/request-context.mjs');
    const createScope = (teamId, suffix) => runRequestContext({
      accountId: 'account-' + suffix,
      userId: 'user-' + suffix,
      deviceId: 'device-' + suffix,
      teamId,
      role: 'admin',
      client: 'desktop',
      requestId: 'request-' + suffix,
    }, async () => {
      const ordinal = suffix === 'a' ? 1 : suffix === 'b' ? 2 : 3;
      const server = await store.createServer({
        name: '服务器-' + suffix,
        host: '10.0.0.' + ordinal,
        port: 22,
        username: 'ops-' + suffix,
        authType: 'password',
        password: 'ssh-secret-' + suffix,
        defaultBackendRoot: '/opt/apps',
      });
      const environment = await store.createDeployEnvironment({
        name: '环境-' + suffix,
        nacosServerAddr: '127.0.0.1:8848',
        username: 'nacos-' + suffix,
        password: 'nacos-secret-' + suffix,
      });
      const nginxInstance = await store.createNginxInstance(server.id, {
        name: '系统 Nginx-' + suffix,
        instanceType: 'external',
        defaultDeployRoot: '/opt/html',
        defaultNginxConfPath: '/etc/nginx/conf.d/project-' + suffix + '.conf',
      });
      const target = await store.createTarget({
        projectId: ordinal * 101,
        projectSource: 'gitlab',
        projectName: '项目-' + suffix,
        projectPath: 'group/project-' + suffix,
        repositoryUrl: 'https://gitlab.example/group/project-' + suffix + '.git',
        defaultBranch: 'dev',
        envName: '测试',
        serverId: server.id,
        deployRoot: '/opt/apps/project-' + suffix,
        projectType: 'backend',
        serviceName: 'project-' + suffix,
        serviceRole: 'application',
        serverPort: 18080 + ordinal,
        artifactPattern: 'target/*.jar',
        processMode: 'pid',
        healthCheckPath: '/actuator/health',
        environmentId: environment.id,
      });
      const timestamp = new Date().toISOString();
      const record = await store.createRecord({
        targetId: target.id,
        projectId: target.projectId,
        projectName: target.projectName,
        envName: target.envName,
        branch: target.defaultBranch,
        status: 'success',
        operator: 'operator-' + suffix,
        startedAt: timestamp,
        finishedAt: timestamp,
      });
      return { serverId: server.id, environmentId: environment.id, nginxInstanceId: nginxInstance.id, targetId: target.id, recordId: record.id };
    });
    const first = await createScope('account-space-a', 'a');
    const second = await createScope('account-space-b', 'b');
    const legacy = await createScope(SHARED_DEPLOY_WORKSPACE_ID, 'legacy');
    const db = await store.getDeployDb();
    const timestamp = new Date().toISOString();
    db.prepare(\`INSERT INTO build_jdks
      (team_id,name,home_path,java_version,major_version,vendor,arch,status,status_output,last_checked_at,remark,created_at,updated_at)
      VALUES ('account-space-a','设备 JDK','/device/jdk','17',17,'test','arm64','available','',?,'',?,?)\`)
      .run(timestamp, timestamp, timestamp);
    const deviceJdkId = db.prepare("SELECT id FROM build_jdks WHERE name = '设备 JDK'").get().id;
    db.prepare('UPDATE backend_target_configs SET build_jdk_id = ?, required_jdk_alias = ? WHERE target_id = ?')
      .run(deviceJdkId, '设备 JDK', first.targetId);
    db.prepare('UPDATE deploy_targets SET jdk_id = ? WHERE id = ?').run(deviceJdkId, first.targetId);
    const migration = await store.migrateCentralDeployWorkspace();
    const repeated = await store.migrateCentralDeployWorkspace();
    const shared = await runRequestContext({
      accountId: 'account-reader', userId: 'user-reader', deviceId: 'device-reader',
      teamId: SHARED_DEPLOY_WORKSPACE_ID, role: 'admin', client: 'desktop', requestId: 'verify-shared',
    }, async () => ({
      servers: await Promise.all([first.serverId, second.serverId, legacy.serverId].map((id) => store.getServerWithCredential(id))),
      environments: await Promise.all([first.environmentId, second.environmentId, legacy.environmentId].map((id) => store.getDeployEnvironmentWithCredential(id))),
      targets: await store.listTargets({}),
      records: await store.listRecords({ pageSize: 20 }),
    }));
    const listTargetsAsAuthenticatedUser = (accountId, teamId) => runRequestContext({
      accountId, userId: accountId, deviceId: 'device-' + accountId, teamId,
      role: 'viewer', client: 'desktop', requestId: 'v2-' + accountId,
    }, () => new Promise((resolve, reject) => {
      useSharedDeployWorkspace({}, {}, () => store.listTargets({}).then(resolve, reject));
    }));
    const crossUserTargets = await Promise.all([
      listTargetsAsAuthenticatedUser('gitlab-user-a', 'account-space-a'),
      listTargetsAsAuthenticatedUser('gitlab-user-b', 'account-space-b'),
    ]);
    const teamCounts = Object.fromEntries([
      'deploy_servers','nginx_instances','deploy_targets','deploy_records','backend_target_configs','deploy_environments'
    ].map((table) => [table, db.prepare(\`SELECT COUNT(DISTINCT team_id) AS count FROM \${table}\`).get().count]));
    const relations = db.prepare(\`SELECT t.server_id, b.environment_id
      FROM deploy_targets t INNER JOIN backend_target_configs b ON b.target_id = t.id ORDER BY t.id\`).all();
    const deviceJdkTeam = db.prepare("SELECT team_id FROM build_jdks WHERE name = '设备 JDK'").get().team_id;
    const logicalJdk = db.prepare('SELECT b.build_jdk_id, b.required_jdk_alias, t.jdk_id FROM backend_target_configs b INNER JOIN deploy_targets t ON t.id = b.target_id WHERE b.target_id = ?')
      .get(first.targetId);
    console.log(JSON.stringify({ migration, repeated, shared, crossUserTargets, teamCounts, relations, deviceJdkTeam, logicalJdk }));
  `);

  assert.equal(result.migration.migrated, true);
  assert.equal(result.migration.reencryptedCredentials, 4);
  assert.equal(result.repeated.migrated, false);
  assert.match(result.migration.backupPath, /\.pre-shared-workspace-v6-\d+\.bak$/);
  assert.deepEqual(result.shared.servers.map((item) => item.credential.password), ['ssh-secret-a', 'ssh-secret-b', 'ssh-secret-legacy']);
  assert.deepEqual(result.shared.environments.map((item) => item.credential.password), ['nacos-secret-a', 'nacos-secret-b', 'nacos-secret-legacy']);
  assert.deepEqual(result.shared.targets.map((item) => item.projectName).sort(), ['项目-a', '项目-b', '项目-legacy']);
  assert.equal(result.shared.records.total, 3);
  assert.deepEqual(
    result.crossUserTargets.map((items) => items.map((item) => item.projectName).sort()),
    [['项目-a', '项目-b', '项目-legacy'], ['项目-a', '项目-b', '项目-legacy']],
  );
  assert.deepEqual(result.teamCounts, {
    deploy_servers: 1,
    nginx_instances: 1,
    deploy_targets: 1,
    deploy_records: 1,
    backend_target_configs: 1,
    deploy_environments: 1,
  });
  assert.deepEqual(result.relations, [
    { server_id: result.shared.targets.find((item) => item.projectName === '项目-a').serverId, environment_id: result.shared.environments[0].id },
    { server_id: result.shared.targets.find((item) => item.projectName === '项目-b').serverId, environment_id: result.shared.environments[1].id },
    { server_id: result.shared.targets.find((item) => item.projectName === '项目-legacy').serverId, environment_id: result.shared.environments[2].id },
  ]);
  assert.equal(result.deviceJdkTeam, 'account-space-a');
  assert.deepEqual(result.logicalJdk, { build_jdk_id: null, required_jdk_alias: '设备 JDK', jdk_id: null });
  const backups = (await fs.readdir(root)).filter((name) => name.includes('.pre-shared-workspace-v6-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
});

test('v6 凭据转换失败时整体回滚、拒绝写入迁移版本且不重复备份', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-shared-deploy-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = runMigrationScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const { runRequestContext } = await import('./server/services/request-context.mjs');
    const server = await runRequestContext({
      accountId: 'account-a', userId: 'user-a', deviceId: 'device-a', teamId: 'account-space-a',
      role: 'admin', client: 'desktop', requestId: 'create-corrupt',
    }, () => store.createServer({
      name: '损坏凭据服务器', host: '127.0.0.1', port: 22, username: 'ops', authType: 'password',
      password: 'will-be-corrupted', defaultBackendRoot: '/opt/apps',
    }));
    const db = await store.getDeployDb();
    db.prepare("UPDATE deploy_servers SET encrypted_secret = '{malformed' WHERE id = ?").run(server.id);
    let firstError = '';
    let secondError = '';
    try { await store.migrateCentralDeployWorkspace(); } catch (error) { firstError = error.message; }
    const afterFirst = {
      version: db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6').get().count,
      teamId: db.prepare('SELECT team_id FROM deploy_servers WHERE id = ?').get(server.id).team_id,
    };
    try { await store.migrateCentralDeployWorkspace(); } catch (error) { secondError = error.message; }
    console.log(JSON.stringify({ firstError, secondError, afterFirst }));
  `);

  assert.match(result.firstError, /已回滚且禁止启动/);
  assert.match(result.secondError, /已回滚且禁止启动/);
  assert.deepEqual(result.afterFirst, { version: 0, teamId: 'account-space-a' });
  const backups = (await fs.readdir(root)).filter((name) => name.includes('.pre-shared-workspace-v6-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
});
