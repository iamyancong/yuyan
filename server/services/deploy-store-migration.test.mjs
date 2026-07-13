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
      DEPLOY_SECRET_KEY: 'migration-test-secret',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return line ? JSON.parse(line) : null;
}

test('v1/v2/v3 迁移保留前端目标，将历史后端命令标记为 legacy 且可重复执行', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    await store.getDeployDb();
    await store.closeDeployDb();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(process.env.DEPLOY_DB_PATH);
    const ts = new Date().toISOString();
    db.prepare(\`INSERT INTO deploy_servers
      (name,host,port,username,auth_type,encrypted_secret,use_sudo,default_deploy_root,default_backend_root,created_at,updated_at)
      VALUES ('server','127.0.0.1',22,'guest','password','',0,'/opt/html','/opt/backend',?,?)\`).run(ts,ts);
    const insert = db.prepare(\`INSERT INTO deploy_targets
      (project_id,project_source,project_name,project_description,project_path,repository_url,default_branch,env_name,server_id,
       deploy_root,nginx_conf_path,nginx_site_managed,enable_nginx_test,enable_nginx_reload,install_command,build_command,
       artifact_dir,preserve_sub_dirs,upload_strategy,created_at,updated_at,project_type,jdk_id,stop_command,start_command,health_check_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\`);
    insert.run(1,'gitlab','frontend-app','front','group/front','http://git/front.git','dev','测试',1,'/opt/html/front','/opt/nginx.conf',0,0,0,'pnpm install','pnpm build','dist','','cleanReplace',ts,ts,'frontend',null,'','','');
    insert.run(2,'gitlab','backend-app','back','group/back','http://git/back.git','dev','测试',1,'/opt/backend/back','',0,0,0,'','./mvnw package','starter/target/app.jar','','cleanReplace',ts,ts,'backend',null,'kill old','nohup java','http://127.0.0.1:9999/monitor/health');
    for (const table of ['backend_target_configs','server_java_runtimes','backend_releases','openapi_artifacts','deploy_tasks','deploy_environments','schema_migrations']) db.exec('DROP TABLE IF EXISTS ' + table);
    db.close();
    console.log(JSON.stringify({ prepared: true }));
  `);

  const migrated = runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const db = await store.getDeployDb();
    const targets = await store.listTargets({});
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x => x.version);
    const config = db.prepare('SELECT process_mode, needs_review, legacy_start_command, legacy_stop_command FROM backend_target_configs').get();
    const ts = new Date().toISOString();
    await store.createRecord({ targetId: 1, projectId: 1, projectName: 'frontend-app', envName: '测试', branch: 'dev', status: 'success', startedAt: ts, finishedAt: ts });
    await store.createRecord({ targetId: 2, projectId: 2, projectName: 'backend-app', envName: '测试', branch: 'dev', status: 'success', startedAt: ts, finishedAt: ts });
    const allRecords = await store.listRecords({ pageSize: 20 });
    const frontendRecords = await store.listRecords({ projectType: 'frontend', pageSize: 20 });
    const backendRecords = await store.listRecords({ projectType: 'backend', pageSize: 20 });
    const missingServerRecords = await store.listRecords({ serverId: 999, pageSize: 20 });
    db.prepare(\`INSERT INTO deploy_tasks (target_id,action,status,stage,percent,operator,started_at,heartbeat_at) VALUES (2,'deploy','running','build',30,'tester',?,?)\`).run(ts,ts);
    await store.closeDeployDb();
    console.log(JSON.stringify({
      targets: targets.map(x => ({name:x.projectName,type:x.projectType})),
      versions,
      config,
      recordCounts: {
        all: allRecords.total,
        frontend: frontendRecords.total,
        backend: backendRecords.total,
        missingServer: missingServerRecords.total,
      },
      recordTypes: allRecords.items.map(x => x.projectType).sort(),
    }));
  `);
  assert.deepEqual(migrated.versions, [1, 2, 3]);
  assert.deepEqual(migrated.targets, [
    { name: 'backend-app', type: 'backend' },
    { name: 'frontend-app', type: 'frontend' },
  ]);
  assert.equal(migrated.config.process_mode, 'legacy');
  assert.equal(migrated.config.needs_review, 1);
  assert.equal(migrated.config.legacy_start_command, 'nohup java');
  assert.deepEqual(migrated.recordCounts, { all: 2, frontend: 1, backend: 1, missingServer: 0 });
  assert.deepEqual(migrated.recordTypes, ['backend', 'frontend']);

  const repeated = runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const db = await store.getDeployDb();
    const result = { versions: db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, configs: db.prepare('SELECT COUNT(*) AS count FROM backend_target_configs').get().count, taskStatus: db.prepare('SELECT status FROM deploy_tasks LIMIT 1').get().status };
    await store.closeDeployDb();
    console.log(JSON.stringify(result));
  `);
  assert.deepEqual(repeated, { versions: 3, configs: 1, taskStatus: 'interrupted' });
  const backups = (await fs.readdir(root)).filter((name) => name.includes('.pre-backend-v3-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
});
