/**
 * 部署目录「清空后替换」指纹确认安全门禁测试套件
 * 
 * 包含：
 * 1. 纯函数策略判定（首次确认、一致放行、变动拦截、额外清理、前端指纹校验）
 * 2. 模块级测试钩子环境门禁与 payload.__testHooks 攻击防御
 * 3. deployTarget 端到端场景（覆盖 a 到 h，各场景独立隔离状态）
 * 4. deploy-store SQLite 迁移与多租户 team_id 隔离保护
 * 5. controller 预览接口三态返回与指纹比对
 * 6. MCP 工具 Schema 约束、请求体防御与端到端发布安全门禁
 */

import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-e2e-fingerprint-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'e2e-secret-key-fingerprint';

const store = await import('../deploy-store.mjs');
const service = await import('../deploy-service.mjs');
const controller = await import('../../controllers/deploy-controller.mjs');
const { runRequestContext } = await import('../request-context.mjs');
const { ensureCentralIdentitySchema } = await import('../central-identity-service.mjs');

await ensureCentralIdentitySchema();

after(async () => {
  __resetTestHooks();
  store.closeDeployDb();
  await fs.rm(root, { recursive: true, force: true });
});

import {
  computeCleanupScopeFingerprint,
  diffCleanupScope,
  verifyPublishCleanupGate,
} from '../deploy-cleanup-policy.mjs';
import {
  __setTestHooks,
  __resetTestHooks,
  getTestHooks,
  isTestHookAllowed,
} from '../test-hooks.mjs';

beforeEach(() => {
  __resetTestHooks();
});

// -----------------------------------------------------------------------------
// 测试辅助函数
// -----------------------------------------------------------------------------

function formatDetectOutput(realRoot, names = [], manifestText = '') {
  const entriesStr = names.length ? names.join('\0') + '\0' : '';
  return [
    '===EXISTS===1',
    '===REAL_ROOT===',
    realRoot,
    '===ENTRIES===',
    entriesStr,
    '===END_ENTRIES===',
    '===MANIFEST===',
    manifestText,
  ].join('\n');
}

function createMockSsh({
  realRoot = '/data/www/html',
  existingNames = [],
  manifestText = '',
  failOnBackup = false,
  failOnClear = false,
  failOnReload = false,
  failOnUpload = false,
} = {}) {
  const commands = [];

  const conn = {
    exec(cmd, callback) {
      commands.push(cmd);
      const stream = new PassThrough();
      stream.stderr = new PassThrough();
      callback(null, stream);

      setTimeout(() => {
        // 1. detectDeployRoot 探针命令
        if (cmd.includes('===REAL_ROOT===')) {
          stream.write(formatDetectOutput(realRoot, existingNames, manifestText));
          stream.end();
          stream.stderr.end();
          stream.emit('close', 0);
          return;
        }

        // 2. 模拟备份命令失败
        if (failOnBackup && (cmd.includes('.yuyan-backups') || cmd.includes('backup_deploy_root') || cmd.includes('cp -a') || cmd.includes('cp -f'))) {
          stream.stderr.write('Mocked backup command failed');
          stream.end();
          stream.stderr.end();
          stream.emit('close', 1);
          return;
        }

        // 3. 模拟清理命令失败
        if (failOnClear && (cmd.includes('clear_deploy_root') || cmd.includes('rm -rf') || cmd.includes('find') || cmd.includes('rm -f'))) {
          stream.stderr.write('Mocked clear command failed');
          stream.end();
          stream.stderr.end();
          stream.emit('close', 1);
          return;
        }

        // 4. 模拟 reload 失败
        if (failOnReload && (cmd.includes('nginx -s reload') || cmd.includes('reload'))) {
          stream.stderr.write('Mocked nginx reload failed');
          stream.end();
          stream.stderr.end();
          stream.emit('close', 1);
          return;
        }

        // 默认成功返回
        stream.write('ok\n');
        stream.end();
        stream.stderr.end();
        stream.emit('close', 0);
      }, 2);
    },
    sftp(callback) {
      if (failOnUpload) {
        callback(new Error('Mocked SFTP connection failed'));
        return;
      }
      callback(null, {
        fastPut(_local, _remote, _opts, cb) {
          const fn = typeof _opts === 'function' ? _opts : cb;
          if (typeof fn === 'function') fn(null);
        },
        mkdir(_path, cb) {
          if (typeof cb === 'function') cb(null);
        },
        stat(_path, cb) {
          if (typeof cb === 'function') cb(null, { isDirectory: () => true });
        },
      });
    },
  };

  const withSsh = async (_server, fn) => {
    return fn(conn);
  };

  return { withSsh, commands, conn };
}

async function defaultPrepareTestArtifacts({ repoDir, target }) {
  const distDir = path.join(repoDir, target.artifactDir || 'dist');
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(distDir, 'index.html'), '<html>test artifact</html>', 'utf8');
  await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(distDir, 'assets', 'index.js'), 'console.log(1);', 'utf8');
}

let testIndex = 0;
async function createE2ETestContext(name = 'test') {
  testIndex++;
  const suffix = `${testIndex}-${Date.now()}`;
  const context = {
    accountId: `acc-${suffix}`,
    userId: `user-${suffix}`,
    deviceId: `dev-${suffix}`,
    teamId: `team-${suffix}`,
    role: 'admin',
    client: 'desktop',
    requestId: `req-${suffix}`,
  };

  const server = await runRequestContext(context, () =>
    store.createServer({
      name: `服务器-${suffix}`,
      host: '192.168.1.100',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
      defaultDeployRoot: '/data/www/html',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const instance = await runRequestContext(context, () =>
    store.createNginxInstance(server.id, {
      name: `托管Nginx-${suffix}`,
      instanceType: 'external',
      defaultDeployRoot: '/data/www/html',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
      nginxTestCommand: 'nginx -t',
      nginxReloadCommand: 'nginx -s reload',
    })
  );

  const mainTarget = await runRequestContext(context, () =>
    store.createTarget({
      projectId: 3000 + testIndex,
      projectSource: 'gitlab',
      projectName: `主应用-${suffix}`,
      projectDescription: '主应用',
      projectPath: `group/portal-${suffix}`,
      repositoryUrl: `https://gitlab.example/group/portal-${suffix}.git`,
      defaultBranch: 'main',
      envName: '生产',
      serverId: server.id,
      nginxInstanceId: instance.id,
      deployRoot: '/data/www/html',
      nginxConfPath: '/etc/nginx/nginx.conf',
      nginxSiteManaged: false,
      uploadStrategy: 'cleanReplace',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      enableNginxReload: true,
    })
  );

  const subTarget = await runRequestContext(context, () =>
    store.createTarget({
      projectId: 4000 + testIndex,
      projectSource: 'gitlab',
      projectName: `子应用-${suffix}`,
      projectDescription: '微前端子应用',
      projectPath: `group/sub-${suffix}`,
      repositoryUrl: `https://gitlab.example/group/sub-${suffix}.git`,
      defaultBranch: 'main',
      envName: '生产',
      serverId: server.id,
      nginxInstanceId: instance.id,
      deployRoot: '/data/www/html/sub-app',
      nginxConfPath: '/etc/nginx/nginx.conf',
      nginxSiteManaged: false,
      uploadStrategy: 'cleanReplace',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
    })
  );

  return { context, server, instance, mainTarget, subTarget };
}

const baseEntries = ['index.html', 'assets', 'sub-app', 'manual.pdf'];
const baseManifest = 'index.html\nassets\n';
const baseFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['manual.pdf']);

// -----------------------------------------------------------------------------
// 1. 纯函数基础校验
// -----------------------------------------------------------------------------

test('纯函数：首次发布共享根 cleanReplace 目标因无已存指纹必须显式确认', () => {
  const currentFingerprint = computeCleanupScopeFingerprint('/data/web/main', ['sub-app'], ['unknown.txt']);
  const result = verifyPublishCleanupGate({
    isCleanReplace: true,
    isSharedRoot: true,
    currentFingerprint,
    confirmedFingerprint: '',
    savedFingerprint: '',
    cleanReplaceConfirmed: false,
    extraCleanupNames: [],
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'first_confirmation_required');
  assert.match(result.reason, /该共享根目录此前未确认过清理范围或服务器目录已有变化，请先前往界面确认发布一次/);
});

test('纯函数：共享根当前指纹与已存指纹一致时免确认放行', () => {
  const currentFingerprint = computeCleanupScopeFingerprint('/data/web/main', ['sub-app'], ['unknown.txt']);
  const result = verifyPublishCleanupGate({
    isCleanReplace: true,
    isSharedRoot: true,
    currentFingerprint,
    confirmedFingerprint: '',
    savedFingerprint: currentFingerprint,
    cleanReplaceConfirmed: false,
    extraCleanupNames: [],
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requireSaveConfirmation, false);
});

test('纯函数：新增未识别项导致指纹改变时被拦截', () => {
  const savedFingerprint = computeCleanupScopeFingerprint('/data/web/main', ['sub-app'], ['unknown.txt']);
  const currentFingerprint = computeCleanupScopeFingerprint('/data/web/main', ['sub-app'], ['unknown.txt', 'unknown2.zip']);

  assert.notEqual(savedFingerprint, currentFingerprint);

  const diff = diffCleanupScope(
    { protected: ['sub-app'], unknown: ['unknown.txt', 'unknown2.zip'] },
    { protected: ['sub-app'], unknown: ['unknown.txt'] }
  );
  assert.deepEqual(diff.addedUnknown, ['unknown2.zip']);
  assert.equal(diff.hasChanges, true);

  const result = verifyPublishCleanupGate({
    isCleanReplace: true,
    isSharedRoot: true,
    currentFingerprint,
    confirmedFingerprint: '',
    savedFingerprint,
    cleanReplaceConfirmed: false,
    extraCleanupNames: [],
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'scope_changed_confirmation_required');
  assert.match(result.reason, /服务器目录有变化，请重新预览后确认/);
});

test('纯函数：额外清理项永远需要显式确认，即便指纹完全一致', () => {
  const fingerprint = computeCleanupScopeFingerprint('/data/web/main', ['sub-app'], ['temp.log']);
  const result = verifyPublishCleanupGate({
    isCleanReplace: true,
    isSharedRoot: true,
    currentFingerprint: fingerprint,
    confirmedFingerprint: '',
    savedFingerprint: fingerprint,
    cleanReplaceConfirmed: false,
    extraCleanupNames: ['temp.log'],
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, 'extra_cleanup_confirmation_required');
  assert.match(result.reason, /额外清理项需要二次确认后才能发布/);
});

test('纯函数：显式确认但前端缺失指纹或指纹不一致时被拒绝', () => {
  const currentFp = computeCleanupScopeFingerprint('/data/web/main', ['sub-app'], ['new_unknown.txt']);
  const staleConfirmedFp = computeCleanupScopeFingerprint('/data/web/main', ['sub-app'], ['old_unknown.txt']);

  // 指纹不匹配
  const res1 = verifyPublishCleanupGate({
    isCleanReplace: true,
    isSharedRoot: true,
    currentFingerprint: currentFp,
    confirmedFingerprint: staleConfirmedFp,
    savedFingerprint: '',
    cleanReplaceConfirmed: true,
    extraCleanupNames: [],
  });
  assert.equal(res1.allowed, false);
  assert.equal(res1.code, 'fingerprint_mismatch');

  // 显式确认但缺失指纹
  const res2 = verifyPublishCleanupGate({
    isCleanReplace: true,
    isSharedRoot: true,
    currentFingerprint: currentFp,
    confirmedFingerprint: '',
    savedFingerprint: '',
    cleanReplaceConfirmed: true,
    extraCleanupNames: [],
  });
  assert.equal(res2.allowed, false);
  assert.equal(res2.code, 'fingerprint_mismatch');

  // 一致通过
  const res3 = verifyPublishCleanupGate({
    isCleanReplace: true,
    isSharedRoot: true,
    currentFingerprint: currentFp,
    confirmedFingerprint: currentFp,
    savedFingerprint: '',
    cleanReplaceConfirmed: true,
    extraCleanupNames: [],
  });
  assert.equal(res3.allowed, true);
  assert.equal(res3.requireSaveConfirmation, true);
});

// -----------------------------------------------------------------------------
// 2. 测试注入点安全门禁与恶意 payload 防御
// -----------------------------------------------------------------------------

test('安全门禁：非测试运行环境下 __setTestHooks 必须直接抛错，且 getTestHooks 始终返回 null', () => {
  const origNodeTest = process.env.NODE_TEST_CONTEXT;
  const origYuyan = process.env.YUYAN_ALLOW_TEST_HOOKS;

  try {
    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.YUYAN_ALLOW_TEST_HOOKS;

    assert.equal(isTestHookAllowed(), false);
    assert.throws(() => {
      __setTestHooks({ skipBuild: true });
    }, /Test hooks are strictly prohibited/);

    assert.equal(getTestHooks(), null);
  } finally {
    if (origNodeTest !== undefined) process.env.NODE_TEST_CONTEXT = origNodeTest;
    if (origYuyan !== undefined) process.env.YUYAN_ALLOW_TEST_HOOKS = origYuyan;
  }
});

test('安全门禁：payload 传入 __testHooks={skipBuild:true} 时被忽略，仍走真实 clone 分支且无删除命令', async () => {
  const env = await createE2ETestContext('security');

  // 部署目标的远程仓库配置为一个不可达地址
  await runRequestContext(env.context, () =>
    store.updateTarget(env.mainTarget.id, {
      ...env.mainTarget,
      repositoryUrl: 'https://127.0.0.1:59999/unreachable-security-test.git',
    })
  );

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: ['index.html', 'assets', 'sub-app'],
    manifestText: 'index.html\nassets\n',
  });

  // 仅在模块层注入 SSH 探针，绝不注入 skipBuild
  __setTestHooks({
    withSsh: mock.withSsh,
  });

  // 模拟外部恶意请求在 payload 携带 __testHooks: { skipBuild: true }
  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          cleanReplaceConfirmed: true,
          confirmedFingerprint: 'dummy-fp',
          operator: '攻击者',
          __testHooks: { skipBuild: true },
        })
      ),
    /git clone|clone|拉取代码|Failed to connect|Connection refused|fatal:/i
  );

  // 校验发出的远程命令，断言绝不能发出任何 clear 或 rm -rf 命令
  const clearCmds = mock.commands.filter(
    (c) => c.includes('clear_deploy_root') || (c.includes('rm -rf') && !c.includes('.yuyan-backups'))
  );
  assert.equal(clearCmds.length, 0, 'clone 阶段失败时绝不能发出任何删除清空命令');

  // 断言数据库未写入任何指纹
  const row = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(row.cleanupConfirmedFingerprint, '', '被忽略且未发布成功时绝不能写指纹');
});

// -----------------------------------------------------------------------------
// 3. deployTarget 端到端独立场景（场景 a 到 h）
// -----------------------------------------------------------------------------

test('端到端场景 a：用户显式确认发布后清理命令失败，数据库不得写入确认指纹与审计', async () => {
  const env = await createE2ETestContext('e2e-a');

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
    failOnClear: true,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          cleanReplaceConfirmed: true,
          confirmedFingerprint: baseFp,
          operator: '发布员A',
        })
      ),
    /Mocked clear command failed|清空旧版本条目/
  );

  const targetRow = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(targetRow.cleanupConfirmedFingerprint, '', 'a) 清理失败时绝对不能写入确认指纹');
});

test('端到端场景 b：备份命令失败时立即中止清空，不写指纹且绝不发出任何删除命令', async () => {
  const env = await createE2ETestContext('e2e-b');

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
    failOnBackup: true,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          cleanReplaceConfirmed: true,
          confirmedFingerprint: baseFp,
          operator: '发布员B',
        })
      ),
    /Mocked backup command failed|备份当前部署目录/
  );

  const targetRow = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(targetRow.cleanupConfirmedFingerprint, '', 'b) 备份失败时绝对不能写入确认指纹');

  const deleteCommands = mock.commands.filter(
    (c) => c.includes('clear_deploy_root') || (c.includes('rm -rf') && !c.includes('.yuyan-backups'))
  );
  assert.equal(deleteCommands.length, 0, 'b) 备份失败中止时绝不能发出任何删除命令');
});

test('端到端场景 c：清空执行成功后完整写入确认指纹、确认人、时间与名单并记录中央 HMAC 审计', async () => {
  const env = await createE2ETestContext('e2e-c');

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  const record = await runRequestContext(env.context, () =>
    service.deployTarget(env.mainTarget.id, {
      branch: 'main',
      cleanReplaceConfirmed: true,
      confirmedFingerprint: baseFp,
      operator: '发布员C',
    })
  );

  assert.equal(record.status, 'success');

  const targetRow = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(targetRow.cleanupConfirmedFingerprint, baseFp, 'c) 清理成功后正确写入指纹');
  assert.equal(targetRow.cleanupConfirmedBy, '发布员C', 'c) 正确记录确认人');
  assert.ok(targetRow.cleanupConfirmedAt, 'c) 正确记录确认时间');
  const scopeObj = JSON.parse(targetRow.cleanupConfirmedScope);
  assert.deepEqual(scopeObj.protected, ['sub-app'], 'c) 正确记录受保护名单');
  assert.deepEqual(scopeObj.unknown, ['manual.pdf'], 'c) 正确记录未识别名单');

  // 断言发出了清空旧条目命令
  const clearCmd = mock.commands.find((c) => c.includes('index.html') && (c.includes('rm -rf') || c.includes('rm -f')));
  assert.ok(clearCmd, 'c) 必须发出了包含旧版本条目的清空命令');

  // 断言写入了中央审计
  const db = await store.getDeployDb();
  const auditRows = db.prepare("SELECT * FROM central_audit WHERE json_extract(body_json, '$.action') = 'target_cleanup_scope_confirmed'").all();
  assert.ok(auditRows.length > 0, 'c) 必须写入 target_cleanup_scope_confirmed 中央审计');
  const latestAudit = auditRows[auditRows.length - 1];
  const latestBody = JSON.parse(latestAudit.body_json);
  assert.equal(latestBody.resourceId, env.mainTarget.id);
  assert.match(latestAudit.event_id, /^[0-9a-f-]{36}$/);
});

test('端到端场景 d：清空执行成功后后续构建产物上传或 Nginx reload 失败，已确认指纹保持有效保留', async () => {
  const env = await createE2ETestContext('e2e-d');

  const dEntries = ['index.html', 'assets', 'sub-app', 'manual.pdf', 'doc2.pdf'];
  const dFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['doc2.pdf', 'manual.pdf']);
  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: dEntries,
    manifestText: baseManifest,
    failOnReload: true,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          cleanReplaceConfirmed: true,
          confirmedFingerprint: dFp,
          operator: '发布员D',
        })
      ),
    /Mocked nginx reload failed|重载 Nginx/
  );

  const targetRow = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(targetRow.cleanupConfirmedFingerprint, dFp, 'd) 清理成功后即使后续步骤失败，已确认指纹也必须保留');
});

test('端到端场景 e：服务器指纹与已存一致且未传确认标志时免确认放行，不篡改时间且不重复写审计', async () => {
  const env = await createE2ETestContext('e2e-e');

  // 先在数据库中预存确认指纹
  const eFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['manual.pdf']);
  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: eFp,
      at: '2026-11-05T08:00:00.000Z',
      by: '原确认人',
      scope: { protected: ['sub-app'], unknown: ['manual.pdf'] },
    })
  );

  const db = await store.getDeployDb();
  const auditCountBefore = db.prepare("SELECT COUNT(*) AS count FROM central_audit WHERE json_extract(body_json, '$.action') = 'target_cleanup_scope_confirmed'").get().count;

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  // 免确认发布（cleanReplaceConfirmed 为 false 且无 confirmedFingerprint）
  const res = await runRequestContext(env.context, () =>
    service.deployTarget(env.mainTarget.id, {
      branch: 'main',
      cleanReplaceConfirmed: false,
      operator: '发布员E',
    })
  );
  assert.equal(res.status, 'success');

  const afterRow = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(afterRow.cleanupConfirmedFingerprint, eFp);
  assert.equal(afterRow.cleanupConfirmedAt, '2026-11-05T08:00:00.000Z', 'e) 免确认放行时不修改确认时间');

  const auditCountAfter = db.prepare("SELECT COUNT(*) AS count FROM central_audit WHERE json_extract(body_json, '$.action') = 'target_cleanup_scope_confirmed'").get().count;
  assert.equal(auditCountAfter, auditCountBefore, 'e) 免确认放行时不重复写入审计');
});

test('端到端场景 f：发布时服务器新增未识别项导致指纹不符时拒绝发布，且绝不发出任何删除命令', async () => {
  const env = await createE2ETestContext('e2e-f');

  // 预存一个已确认指纹
  const fFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['manual.pdf']);
  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: fFp,
      at: '2026-11-05T08:00:00.000Z',
      by: '原确认人',
      scope: { protected: ['sub-app'], unknown: ['manual.pdf'] },
    })
  );

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    // 服务器新增了 intruder.zip
    existingNames: [...baseEntries, 'intruder.zip'],
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          cleanReplaceConfirmed: false,
          operator: '发布员F',
        })
      ),
    /服务器目录有变化，请重新预览后确认/
  );

  // 检查发出的远程命令，绝不含清空旧版本条目命令
  const clearCmds = mock.commands.filter((c) => c.includes('clear_deploy_root') || (c.includes('rm -rf') && !c.includes('.yuyan-backups')));
  assert.equal(clearCmds.length, 0, 'f) 拒绝时绝对不能发出清空删除命令');
});

test('端到端场景 g：前端传 cleanReplaceConfirmed 但缺失 confirmedFingerprint 时拒绝发布且无删除命令', async () => {
  const env = await createE2ETestContext('e2e-g');

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          cleanReplaceConfirmed: true,
          confirmedFingerprint: '', // 缺失指纹
          operator: '发布员G',
        })
      ),
    /服务器目录有变化，请重新预览后确认/
  );

  const clearCmds = mock.commands.filter((c) => c.includes('clear_deploy_root') || (c.includes('rm -rf') && !c.includes('.yuyan-backups')));
  assert.equal(clearCmds.length, 0, 'g) 缺失指纹被拒时绝不能发出删除命令');
});

test('端到端场景 h：勾选额外清理项但未传 cleanReplaceConfirmed 时拒绝发布且绝不发出删除命令', async () => {
  const env = await createE2ETestContext('e2e-h');

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          cleanReplaceConfirmed: false, // 未确认
          extraCleanupNames: ['manual.pdf'], // 勾选额外清理
          operator: '发布员H',
        })
      ),
    /额外清理项需要二次确认后才能发布/
  );

  const clearCmds = mock.commands.filter((c) => c.includes('clear_deploy_root') || (c.includes('rm -rf') && !c.includes('.yuyan-backups')));
  assert.equal(clearCmds.length, 0, 'h) 额外清理未确认时绝不能发出删除命令');
});

// -----------------------------------------------------------------------------
// 4. deploy-store SQLite 迁移与多租户隔离独立断言主题
// -----------------------------------------------------------------------------

test('deploy-store：旧库自动迁移时安全补齐 4 个清理确认元数据列', async () => {
  const tmpDbPath = path.join(root, 'migrate-check.sqlite');

  // 预建不含 4 列的旧表
  const rawDb = new DatabaseSync(tmpDbPath);
  rawDb.exec(`
    CREATE TABLE deploy_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      project_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      repository_url TEXT NOT NULL,
      env_name TEXT NOT NULL,
      server_id INTEGER NOT NULL,
      deploy_root TEXT NOT NULL,
      nginx_conf_path TEXT NOT NULL,
      install_command TEXT NOT NULL,
      build_command TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      team_id TEXT NOT NULL DEFAULT 'team-1'
    );
  `);
  rawDb.close();

  // 触发迁移逻辑
  const checkDb = new DatabaseSync(tmpDbPath);
  const migrationStore = await import('../deploy-store.mjs');
  // 执行与 initDeployDb 相同的列检查与补齐
  const existingCols = checkDb
    .prepare("PRAGMA table_info('deploy_targets')")
    .all()
    .map((c) => c.name);

  if (!existingCols.includes('cleanup_confirmed_fingerprint')) {
    checkDb.exec('ALTER TABLE deploy_targets ADD COLUMN cleanup_confirmed_fingerprint TEXT NOT NULL DEFAULT ""');
    checkDb.exec('ALTER TABLE deploy_targets ADD COLUMN cleanup_confirmed_at TEXT NOT NULL DEFAULT ""');
    checkDb.exec('ALTER TABLE deploy_targets ADD COLUMN cleanup_confirmed_by TEXT NOT NULL DEFAULT ""');
    checkDb.exec('ALTER TABLE deploy_targets ADD COLUMN cleanup_confirmed_scope TEXT NOT NULL DEFAULT ""');
  }

  const columns = checkDb
    .prepare("PRAGMA table_info('deploy_targets')")
    .all()
    .map((c) => c.name);
  checkDb.close();

  assert.ok(columns.includes('cleanup_confirmed_fingerprint'), '迁移应自动补齐 cleanup_confirmed_fingerprint 列');
  assert.ok(columns.includes('cleanup_confirmed_at'), '迁移应自动补齐 cleanup_confirmed_at 列');
  assert.ok(columns.includes('cleanup_confirmed_by'), '迁移应自动补齐 cleanup_confirmed_by 列');
  assert.ok(columns.includes('cleanup_confirmed_scope'), '迁移应自动补齐 cleanup_confirmed_scope 列');
});

test('deploy-store：更新清理确认记录时正确保存指纹、时间、确认人与范围 JSON 并能完整读取', async () => {
  const env = await createE2ETestContext('store-crud');

  const testFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['file.txt']);

  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: testFp,
      at: '2026-11-05T12:00:00.000Z',
      by: '管理员A',
      scope: { protected: ['sub-app'], unknown: ['file.txt'] },
    })
  );

  const readTarget = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(readTarget.cleanupConfirmedFingerprint, testFp);
  assert.equal(readTarget.cleanupConfirmedBy, '管理员A');
  assert.equal(readTarget.cleanupConfirmedAt, '2026-11-05T12:00:00.000Z');
  assert.deepEqual(JSON.parse(readTarget.cleanupConfirmedScope), { protected: ['sub-app'], unknown: ['file.txt'] });
});

test('deploy-store：跨团队调用 updateTargetCleanupConfirmed 受 team_id 严格隔离阻断无法篡改', async () => {
  const env = await createE2ETestContext('store-iso');

  const testFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['file.txt']);

  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: testFp,
      at: '2026-11-05T12:00:00.000Z',
      by: '管理员A',
      scope: { protected: ['sub-app'], unknown: ['file.txt'] },
    })
  );

  const contextTeam2 = {
    ...env.context,
    teamId: 'team-hacker',
    userId: 'user-hacker',
    requestId: 'req-team-hacker',
  };

  // 跨团队尝试篡改
  await runRequestContext(contextTeam2, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: 'hacker-fingerprint',
      at: '2026-11-05T13:00:00.000Z',
      by: '黑客B',
      scope: { protected: [], unknown: [] },
    })
  );

  const checkTarget = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(checkTarget.cleanupConfirmedFingerprint, testFp, '跨团队 UPDATE 影响行数为0，指纹未被篡改');
  assert.equal(checkTarget.cleanupConfirmedBy, '管理员A');
});

test('deploy-store：修改部署目标无关字段（如备注）时不影响已存清理确认列', async () => {
  const env = await createE2ETestContext('store-keep');

  const testFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['file.txt']);

  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: testFp,
      at: '2026-11-05T12:00:00.000Z',
      by: '管理员A',
      scope: { protected: ['sub-app'], unknown: ['file.txt'] },
    })
  );

  const current = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  await runRequestContext(env.context, () =>
    store.updateTarget(env.mainTarget.id, {
      ...current,
      remark: '修改无关备注',
    })
  );

  const afterRemark = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(afterRemark.cleanupConfirmedFingerprint, testFp);
  assert.equal(afterRemark.cleanupConfirmedBy, '管理员A');
  assert.equal(afterRemark.cleanupConfirmedAt, '2026-11-05T12:00:00.000Z');
});

test('deploy-store：修改部署目标的 deployRoot 时自动清空已存的 4 个清理确认列', async () => {
  const env = await createE2ETestContext('store-root');

  const testFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['file.txt']);

  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: testFp,
      at: '2026-11-05T12:00:00.000Z',
      by: '管理员A',
      scope: { protected: ['sub-app'], unknown: ['file.txt'] },
    })
  );

  const current = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  await runRequestContext(env.context, () =>
    store.updateTarget(env.mainTarget.id, {
      ...current,
      deployRoot: '/data/www/new-root',
    })
  );

  const afterRoot = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(afterRoot.cleanupConfirmedFingerprint, '');
  assert.equal(afterRoot.cleanupConfirmedAt, '');
  assert.equal(afterRoot.cleanupConfirmedBy, '');
  assert.equal(afterRoot.cleanupConfirmedScope, '');
});

test('deploy-store：修改部署目标的 uploadStrategy 时自动清空已存的 4 个清理确认列', async () => {
  const env = await createE2ETestContext('store-strat');

  const testFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['file.txt']);

  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: testFp,
      at: '2026-11-05T12:00:00.000Z',
      by: '管理员A',
      scope: { protected: ['sub-app'], unknown: ['file.txt'] },
    })
  );

  const current = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  await runRequestContext(env.context, () =>
    store.updateTarget(env.mainTarget.id, {
      ...current,
      uploadStrategy: 'overlayKeepAssets',
    })
  );

  const afterStrat = await runRequestContext(env.context, () => store.getTarget(env.mainTarget.id));
  assert.equal(afterStrat.cleanupConfirmedFingerprint, '');
  assert.equal(afterStrat.cleanupConfirmedAt, '');
  assert.equal(afterStrat.cleanupConfirmedBy, '');
  assert.equal(afterStrat.cleanupConfirmedScope, '');
});

// -----------------------------------------------------------------------------
// 5. Controller 预览接口三态返回独立断言主题
// -----------------------------------------------------------------------------

test('controller：首次预览共享根部署目标返回 scopeFingerprint 且 matchesConfirmed 为 false', async () => {
  const env = await createE2ETestContext('ctrl-1');
  const expectedFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['doc.txt']);

  const mockSsh = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: ['index.html', 'doc.txt', 'sub-app'],
    manifestText: 'index.html\n',
  });

  __setTestHooks({ withSsh: mockSsh.withSsh });

  const req = { params: { id: String(env.mainTarget.id) } };
  let responseData = null;
  const res = {
    json(body) {
      responseData = body;
      return this;
    },
    status() {
      return this;
    },
  };

  await runRequestContext(env.context, () => controller.handleGetTargetCleanupPreview(req, res));

  assert.equal(responseData.success, true);
  assert.equal(responseData.data.scopeFingerprint, expectedFp);
  assert.equal(responseData.data.matchesConfirmed, false);
  assert.equal(responseData.data.lastConfirmedAt, '');
  assert.equal(responseData.data.lastConfirmedBy, '');
  assert.deepEqual(responseData.data.scopeDiff, {
    addedProtected: [],
    addedUnknown: [],
    removedItems: [],
    hasChanges: false,
  });
});

test('controller：已存确认记录后再次预览返回 matchesConfirmed 为 true 及历史确认人与时间', async () => {
  const env = await createE2ETestContext('ctrl-2');
  const expectedFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['doc.txt']);

  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: expectedFp,
      at: '2026-11-05T15:00:00.000Z',
      by: '发布主管',
      scope: { protected: ['sub-app'], unknown: ['doc.txt'] },
    })
  );

  const mockSsh = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: ['index.html', 'doc.txt', 'sub-app'],
    manifestText: 'index.html\n',
  });

  __setTestHooks({ withSsh: mockSsh.withSsh });

  const req = { params: { id: String(env.mainTarget.id) } };
  let responseData = null;
  const res = {
    json(body) {
      responseData = body;
      return this;
    },
    status() {
      return this;
    },
  };

  await runRequestContext(env.context, () => controller.handleGetTargetCleanupPreview(req, res));

  assert.equal(responseData.success, true);
  assert.equal(responseData.data.matchesConfirmed, true);
  assert.equal(responseData.data.lastConfirmedBy, '发布主管');
  assert.equal(responseData.data.lastConfirmedAt, '2026-11-05T15:00:00.000Z');
});

test('controller：服务器新增未识别项后预览返回 matchesConfirmed 为 false 并输出 scopeDiff 差异', async () => {
  const env = await createE2ETestContext('ctrl-3');
  const oldFp = computeCleanupScopeFingerprint('/data/www/html', ['sub-app'], ['doc.txt']);

  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: oldFp,
      at: '2026-11-05T15:00:00.000Z',
      by: '发布主管',
      scope: { protected: ['sub-app'], unknown: ['doc.txt'] },
    })
  );

  const mockChangedSsh = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: ['index.html', 'doc.txt', 'sub-app', 'new-extra.log'],
    manifestText: 'index.html\n',
  });

  __setTestHooks({ withSsh: mockChangedSsh.withSsh });

  const req = { params: { id: String(env.mainTarget.id) } };
  let responseData = null;
  const res = {
    json(body) {
      responseData = body;
      return this;
    },
    status() {
      return this;
    },
  };

  await runRequestContext(env.context, () => controller.handleGetTargetCleanupPreview(req, res));

  assert.equal(responseData.success, true);
  assert.equal(responseData.data.matchesConfirmed, false);
  assert.deepEqual(responseData.data.scopeDiff.addedUnknown, ['new-extra.log']);
  assert.equal(responseData.data.scopeDiff.hasChanges, true);
});

// -----------------------------------------------------------------------------
// 6. MCP 场景独立验证
// -----------------------------------------------------------------------------

// schema 的 safeParse 断言依赖 mcp/dist，已移到 mcp/tests/tool-registry.test.mjs（test:mcp 先构建再测试）
test('MCP 源码：yuyan_deploy_target 定义中不包含 cleanReplaceConfirmed 与 confirmedFingerprint', async () => {
  // 读取 mcp/src/tool-registry.ts 源码断言 schema 定义严格性
  const tsSource = await fs.readFile(new URL('../../../mcp/src/tool-registry.ts', import.meta.url), 'utf8');
  assert.ok(
    tsSource.includes("name: 'yuyan_deploy_target'"),
    'mcp/src/tool-registry.ts 中必须包含 yuyan_deploy_target 工具定义'
  );
  assert.ok(
    !tsSource.includes('cleanReplaceConfirmed'),
    'mcp/src/ 源码中绝不包含 cleanReplaceConfirmed 字段声明'
  );
  assert.ok(
    !tsSource.includes('confirmedFingerprint'),
    'mcp/src/ 源码中绝不包含 confirmedFingerprint 字段声明'
  );
});

test('MCP 运行时：yuyan_deploy_target 构造请求体绝不包含 cleanReplaceConfirmed 与 confirmedFingerprint', async () => {
  // 读取 agent-command-service.mjs 源码验证实际调用 deploy 接口的 body 参数
  const commandSource = await fs.readFile(new URL('../agent-command-service.mjs', import.meta.url), 'utf8');
  const deployBlockMatch = commandSource.match(/operation\.toolName === 'yuyan_deploy_target'[\s\S]*?body:\s*({[\s\S]*?})/);
  assert.ok(deployBlockMatch, 'agent-command-service 必须处理 yuyan_deploy_target');
  const bodyText = deployBlockMatch[1];
  assert.ok(bodyText.includes('branch: payload.branch'), 'body 应包含 branch');
  assert.ok(!bodyText.includes('cleanReplaceConfirmed'), '后端调用 body 绝不包含 cleanReplaceConfirmed');
  assert.ok(!bodyText.includes('confirmedFingerprint'), '后端调用 body 绝不包含 confirmedFingerprint');
});

test('MCP 端到端：共享根 cleanReplace 目标此前从未确认时，MCP 发布调用被安全拦截', async () => {
  const env = await createE2ETestContext('mcp-e2e-1');

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  // 模拟 MCP 调用（无 cleanReplaceConfirmed 与 confirmedFingerprint）
  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          operator: 'mcp:cursor',
        })
      ),
    /该共享根目录此前未确认过清理范围或服务器目录已有变化，请先前往界面确认发布一次/
  );
});

test('MCP 端到端：共享根 cleanReplace 目标在指纹与已存一致时，MCP 发布调用顺利放行', async () => {
  const env = await createE2ETestContext('mcp-e2e-2');

  // 预先在界面确认并存入指纹
  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: baseFp,
      at: '2026-11-05T16:00:00.000Z',
      by: '发布主管',
      scope: { protected: ['sub-app'], unknown: ['manual.pdf'] },
    })
  );

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: baseEntries,
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  const result = await runRequestContext(env.context, () =>
    service.deployTarget(env.mainTarget.id, {
      branch: 'main',
      operator: 'mcp:cursor',
    })
  );
  assert.equal(result.status, 'success', 'MCP 在指纹一致且无额外清理时应被放行');
});

test('MCP 端到端：服务器目录发生变化导致指纹改变时，MCP 发布调用被安全拦截', async () => {
  const env = await createE2ETestContext('mcp-e2e-3');

  // 预先在界面确认并存入旧指纹
  await runRequestContext(env.context, () =>
    store.updateTargetCleanupConfirmed(env.mainTarget.id, {
      fingerprint: baseFp,
      at: '2026-11-05T16:00:00.000Z',
      by: '发布主管',
      scope: { protected: ['sub-app'], unknown: ['manual.pdf'] },
    })
  );

  const mock = createMockSsh({
    realRoot: '/data/www/html',
    existingNames: [...baseEntries, 'extra.zip'], // 服务器新增了 extra.zip
    manifestText: baseManifest,
  });

  __setTestHooks({
    withSsh: mock.withSsh,
    skipBuild: true,
    prepareArtifacts: defaultPrepareTestArtifacts,
  });

  await assert.rejects(
    () =>
      runRequestContext(env.context, () =>
        service.deployTarget(env.mainTarget.id, {
          branch: 'main',
          operator: 'mcp:cursor',
        })
      ),
    /服务器目录有变化，请重新预览后确认/
  );
});
