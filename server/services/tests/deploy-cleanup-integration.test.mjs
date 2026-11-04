import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import util from 'node:util';

import {
  BACKUP_KINDS,
  buildBackupDeployRootCommand,
  buildClearDeployRootCommand,
  buildRestoreDeployRootCommand,
  buildDetectDeployRootCommand,
  parseDetectDeployRootOutput,
  buildDetectBackupRestorePlanCommand,
  parseDetectBackupRestorePlanOutput,
  detectBackupRestorePlan,
} from '../deploy-service.mjs';
import { shellQuote } from '../ssh-service.mjs';
import {
  computeCleanupPlan,
  manifestTopNames,
  normalizeDeployRootPath,
  classifyDeployRootRisk,
  planRestore,
} from '../deploy-cleanup-policy.mjs';

const execAsync = util.promisify(exec);

test('真实 Shell 集成：共享根场景下只清空雨燕已知项，未登记目录/手放文件毫发无损', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-shared-root-'));
  try {
    const deployRoot = path.join(tmpDir, 'shared-html');
    const backupRoot = path.join(deployRoot, '.yuyan-backups');
    const manifestDir = path.join(deployRoot, '.yuyan-manifests');

    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(path.join(deployRoot, 'assets'), { recursive: true });
    await fs.mkdir(path.join(deployRoot, 'sub1'), { recursive: true });
    await fs.mkdir(path.join(deployRoot, 'other-sub'), { recursive: true });
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.mkdir(backupRoot, { recursive: true });

    // 1. 共享根下混合已有文件
    // 主应用旧文件（在上次清单中）
    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>old v1</html>', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-old.js'), 'console.log("old")', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'old.txt'), 'old file', 'utf8');

    // 已在雨燕登记的子应用
    await fs.writeFile(path.join(deployRoot, 'sub1', 'app.js'), 'sub1 app', 'utf8');

    // 未在雨燕登记的子应用和手放文件
    await fs.writeFile(path.join(deployRoot, 'other-sub', 'index.html'), 'other sub', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'data.csv'), 'a,b,c', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'backup.tar.gz'), 'dummy gz', 'utf8');

    // 写入上次清单
    const lastManifestContent = 'index.html\nassets/chunk-old.js\nold.txt\n';
    await fs.writeFile(path.join(manifestDir, 'current.txt'), lastManifestContent, 'utf8');
    await fs.writeFile(path.join(manifestDir, '20261009100000.txt'), lastManifestContent, 'utf8');

    // 2. 模拟远程探测：列举顶层项
    const entries = await fs.readdir(deployRoot);
    const existingNames = entries.filter((name) => name !== '.' && name !== '..');

    // 本次产物顶层项
    const artifactTopNames = ['index.html', 'assets'];
    const lastManifestTops = manifestTopNames(lastManifestContent);
    const protectedNames = ['sub1']; // 嵌套子应用保护

    // 3. 计算清理计划（清空后替换模式）
    const plan = computeCleanupPlan({
      existingNames,
      artifactTopNames,
      manifestTopNames: lastManifestTops,
      protectedNames,
      extraCleanupNames: [],
      mode: 'cleanReplace',
    });

    // 待删除项 = (artifact ∪ manifest) ∩ existing - protected - reserved
    // 应该只删除: assets, index.html, old.txt
    assert.deepEqual(plan.deleteNames.sort(), ['assets', 'index.html', 'old.txt']);
    // 未登记目录和手放文件必须全部进入 keptUnknown！
    assert.ok(plan.keptUnknown.includes('other-sub'));
    assert.ok(plan.keptUnknown.includes('data.csv'));
    assert.ok(plan.keptUnknown.includes('backup.tar.gz'));
    // 系统保留目录
    assert.ok(plan.keptReserved.includes('.yuyan-backups'));
    assert.ok(plan.keptReserved.includes('.yuyan-manifests'));
    // 子应用保护
    assert.ok(plan.keptProtected.includes('sub1'));

    // 4. 执行备份命令（针对 deleteNames）
    const backupTargetDir = path.join(backupRoot, 'release-20261009120000');
    await fs.mkdir(backupTargetDir, { recursive: true });
    const backupCmd = buildBackupDeployRootCommand(
      { deployRoot },
      backupTargetDir,
      protectedNames,
      false,
      {
        isOverlayUpload: false,
        namesToBackup: plan.deleteNames,
      }
    );
    await execAsync(backupCmd);

    // 验证备份内容：必须记录 .backup-names
    const backupNamesContent = await fs.readFile(path.join(backupTargetDir, '.backup-names'), 'utf8');
    const recordedBackupNames = backupNamesContent.split('\n').filter(Boolean);
    assert.deepEqual(recordedBackupNames.sort(), ['assets', 'index.html', 'old.txt']);
    assert.equal(await fs.readFile(path.join(backupTargetDir, 'index.html'), 'utf8'), '<html>old v1</html>');
    assert.equal(await fs.readFile(path.join(backupTargetDir, 'old.txt'), 'utf8'), 'old file');

    // 5. 执行清空命令（只删 deleteNames）
    const clearCmd = buildClearDeployRootCommand(deployRoot, plan.deleteNames, false);
    await execAsync(clearCmd);

    // 6. 验证部署根目录：
    // 未登记项、手放文件、子应用、系统目录完好无损！
    assert.equal(await fs.readFile(path.join(deployRoot, 'sub1', 'app.js'), 'utf8'), 'sub1 app');
    assert.equal(await fs.readFile(path.join(deployRoot, 'other-sub', 'index.html'), 'utf8'), 'other sub');
    assert.equal(await fs.readFile(path.join(deployRoot, 'data.csv'), 'utf8'), 'a,b,c');
    assert.equal(await fs.readFile(path.join(deployRoot, 'backup.tar.gz'), 'utf8'), 'dummy gz');
    assert.ok(await fs.stat(backupRoot).catch(() => null));
    assert.ok(await fs.stat(manifestDir).catch(() => null));

    // old.txt 被成功清理，index.html 和 assets 暂时不存在（等待产物写入）
    assert.equal(await fs.stat(path.join(deployRoot, 'old.txt')).catch(() => null), null);
    assert.equal(await fs.stat(path.join(deployRoot, 'index.html')).catch(() => null), null);
    assert.equal(await fs.stat(path.join(deployRoot, 'assets')).catch(() => null), null);

    // 7. 写入新产物
    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>new v2</html>', 'utf8');
    await fs.mkdir(path.join(deployRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-v2.js'), 'console.log("v2")', 'utf8');
    assert.equal(await fs.readFile(path.join(deployRoot, 'index.html'), 'utf8'), '<html>new v2</html>');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('真实 Shell 集成：备份失败必须中止清空，部署根毫发无损', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-backup-fail-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'precious.txt'), 'do not lose me', 'utf8');

    // 构造一个不可写入的备份目录路径（例如将父目录指向普通文件）
    const fakeDir = path.join(tmpDir, 'file-not-dir');
    await fs.writeFile(fakeDir, 'block', 'utf8');
    const invalidBackupPath = path.join(fakeDir, 'backup');

    const backupCmd = buildBackupDeployRootCommand(
      { deployRoot },
      invalidBackupPath,
      [],
      false,
      {
        isOverlayUpload: false,
        namesToBackup: ['precious.txt'],
      }
    );

    // 备份命令必须以非 0 状态退出！
    let failed = false;
    try {
      await execAsync(backupCmd);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, '备份失败时命令必须返回非零退出码！');

    // 验证部署根目录下的文件毫发无损
    const fileContent = await fs.readFile(path.join(deployRoot, 'precious.txt'), 'utf8');
    assert.equal(fileContent, 'do not lose me');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('真实 Shell 集成：回滚/恢复测试（新旧格式备份恢复，保护后登记子应用）', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-restore-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    const manifestDir = path.join(deployRoot, '.yuyan-manifests');
    const backupDir = path.join(tmpDir, 'backups', 'v1');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });

    // 1. 准备新格式备份（含 .backup-names 和 .backup-kind）
    await fs.writeFile(path.join(backupDir, '.backup-kind'), 'full\n', 'utf8');
    await fs.writeFile(path.join(backupDir, '.backup-names'), 'index.html\n', 'utf8');
    await fs.writeFile(path.join(backupDir, 'index.html'), '<html>v1 original</html>', 'utf8');

    // 2. 部署根当前状态：当前有 v2 版本的 index.html，以及后来新登记的子应用 sub-late/
    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>v2 modified</html>', 'utf8');
    await fs.mkdir(path.join(deployRoot, 'sub-late'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'sub-late', 'sub.js'), 'late registered sub-app', 'utf8');

    // 3. 规划恢复集合
    const plan = planRestore({
      backupKind: 'full',
      backupNames: ['index.html'],
      backupTopEntries: ['index.html'],
      backupManifestTopNames: ['index.html'],
      currentManifestTopNames: ['index.html'],
      existingNames: ['index.html', 'sub-late'],
      protectedNames: ['sub-late'],
    });

    assert.deepEqual(plan.restoreNames, ['index.html']);
    assert.deepEqual(plan.removeNames, ['index.html']);

    // 4. 执行真实恢复命令
    const restoreCmd = buildRestoreDeployRootCommand(
      { deployRoot },
      backupDir,
      ['sub-late'],
      false,
      {
        plan,
      }
    );
    await execAsync(restoreCmd);

    // 5. 验证：index.html 成功还原为 v1，后登记的 sub-late 目录未被改动
    assert.equal(await fs.readFile(path.join(deployRoot, 'index.html'), 'utf8'), '<html>v1 original</html>');
    assert.equal(await fs.readFile(path.join(deployRoot, 'sub-late', 'sub.js'), 'utf8'), 'late registered sub-app');

    // 6. 测试旧格式备份恢复（无 .backup-names，依靠备份清单 + 当前清单提取）
    const oldBackupDir = path.join(tmpDir, 'backups', 'old-v0');
    await fs.mkdir(oldBackupDir, { recursive: true });
    await fs.writeFile(path.join(oldBackupDir, '.manifest.txt'), 'index.html\n', 'utf8');
    await fs.writeFile(path.join(oldBackupDir, 'index.html'), '<html>v0 old</html>', 'utf8');
    await fs.writeFile(path.join(oldBackupDir, 'stray-unknown.log'), 'unrecognized', 'utf8');

    const oldPlan = planRestore({
      backupKind: 'full',
      backupNames: null, // 旧格式无 .backup-names
      backupTopEntries: ['index.html', 'stray-unknown.log'],
      backupManifestTopNames: ['index.html'],
      currentManifestTopNames: ['index.html'],
      existingNames: ['index.html', 'sub-late'],
      protectedNames: ['sub-late'],
    });

    // 验证 stray-unknown.log 进入跳过名单，不被恢复进部署根
    assert.deepEqual(oldPlan.restoreNames, ['index.html']);
    assert.deepEqual(oldPlan.skippedOldBackupNames, ['stray-unknown.log']);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('真实 Shell 集成：软链接根目录能够正确穿透并对真实路径执行操作', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-symlink-'));
  try {
    const realRoot = path.join(tmpDir, 'real-target');
    const linkRoot = path.join(tmpDir, 'link-target');
    await fs.mkdir(realRoot, { recursive: true });
    await fs.symlink(realRoot, linkRoot);

    await fs.writeFile(path.join(realRoot, 'app.html'), 'content in real root', 'utf8');

    // 模拟远程探测命令：cd -P "$root" && pwd -P
    const probeCmd = `cd -P ${shellQuote(linkRoot)} && pwd -P`;
    const { stdout } = await execAsync(probeCmd);
    const resolvedReal = stdout.trim();
    const expectedRealRoot = await fs.realpath(realRoot);
    assert.equal(resolvedReal, expectedRealRoot);

    // 对真实路径进行清空操作
    const clearCmd = buildClearDeployRootCommand(resolvedReal, ['app.html'], false);
    await execAsync(clearCmd);

    // 验证真实路径下的文件被清空
    assert.equal(await fs.stat(path.join(expectedRealRoot, 'app.html')).catch(() => null), null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('特殊字符安全性：包含空格、- 开头、引号与变量语法的文件名安全处理', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-special-names-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    const backupDir = path.join(tmpDir, 'backup');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });

    // 构造具有潜在 Shell 注入风险的条目名称
    const specialNames = [
      'name with spaces.txt',
      '-rf',
      '-flag.txt',
      "single'quote.txt",
      'var$HOME.txt',
      'cmd$(id).txt',
    ];

    for (const name of specialNames) {
      await fs.writeFile(path.join(deployRoot, name), `content of ${name}`, 'utf8');
    }

    // 执行备份
    const backupCmd = buildBackupDeployRootCommand(
      { deployRoot },
      backupDir,
      [],
      false,
      {
        isOverlayUpload: false,
        namesToBackup: specialNames,
      }
    );
    await execAsync(backupCmd);

    // 验证备份目录全部正确拷入
    for (const name of specialNames) {
      const content = await fs.readFile(path.join(backupDir, name), 'utf8');
      assert.equal(content, `content of ${name}`);
    }

    // 执行清空
    const clearCmd = buildClearDeployRootCommand(deployRoot, specialNames, false);
    await execAsync(clearCmd);

    // 验证部署根全部安全删除，未引发 rm -rf 参数误判或变量求值
    for (const name of specialNames) {
      assert.equal(await fs.stat(path.join(deployRoot, name)).catch(() => null), null);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('数据存储查重：同一 server_id 下两个不同项目相同 deployRoot 严禁保存，不同服务器允许', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-store-dup-root-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'test-secret-key-12345';

  const store = await import('../deploy-store.mjs');
  const { runRequestContext } = await import('../request-context.mjs');

  t.after(async () => {
    store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = {
    accountId: 'acc-1',
    userId: 'user-1',
    deviceId: 'dev-1',
    teamId: 'team-1',
    role: 'admin',
    client: 'desktop',
    requestId: 'req-dup-root',
  };

  const server1 = await runRequestContext(context, () =>
    store.createServer({
      name: '服务器1',
      host: '192.168.1.10',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
      defaultDeployRoot: '/opt/yuyan/html',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const instance1 = await runRequestContext(context, () =>
    store.createNginxInstance(server1.id, {
      name: 'Nginx 1',
      instanceType: 'external',
      defaultDeployRoot: '/opt/yuyan/html',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const server2 = await runRequestContext(context, () =>
    store.createServer({
      name: '服务器2',
      host: '192.168.1.20',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
      defaultDeployRoot: '/opt/yuyan/html',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const instance2 = await runRequestContext(context, () =>
    store.createNginxInstance(server2.id, {
      name: 'Nginx 2',
      instanceType: 'external',
      defaultDeployRoot: '/opt/yuyan/html',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const baseTarget = {
    projectId: 101,
    projectSource: 'gitlab',
    projectName: '项目A',
    projectPath: 'group/proj-a',
    repositoryUrl: 'https://gitlab.example/group/proj-a.git',
    defaultBranch: 'main',
    envName: '生产',
    serverId: server1.id,
    nginxInstanceId: instance1.id,
    deployRoot: '/data/web/shared-root',
    nginxConfPath: '/etc/nginx/conf.d/a.conf',
    projectType: 'frontend',
  };

  // 1. 保存项目A成功
  await runRequestContext(context, () => store.createTarget(baseTarget));

  // 2. 在同一 server1 下为项目B配置相同的 deployRoot（带尾斜杠）-> 必须拒绝
  const targetB = {
    ...baseTarget,
    projectId: 102,
    projectName: '项目B',
    projectPath: 'group/proj-b',
    repositoryUrl: 'https://gitlab.example/group/proj-b.git',
    deployRoot: '/data/web/shared-root/',
  };

  await assert.rejects(
    () => runRequestContext(context, () => store.createTarget(targetB)),
    (err) => {
      assert.match(err.message, /已被项目「项目A」占用/);
      return true;
    }
  );

  // 3. 在不同 server2 下配置相同 deployRoot -> 允许保存
  const targetC = {
    ...baseTarget,
    projectId: 103,
    projectName: '项目C',
    projectPath: 'group/proj-c',
    repositoryUrl: 'https://gitlab.example/group/proj-c.git',
    serverId: server2.id,
    nginxInstanceId: instance2.id,
    deployRoot: '/data/web/shared-root',
  };

  const createdC = await runRequestContext(context, () => store.createTarget(targetC));
  assert.ok(createdC.id);
});

test('控制器参数校验：validateTargetPayload 拦截 block 风险并对 warn 要求显式确认', async () => {
  const { validateTargetPayload } = await import('../../controllers/deploy-controller.mjs');

  const validBase = {
    projectId: 1,
    projectName: '测试项目',
    repositoryUrl: 'https://git.example/a.git',
    defaultBranch: 'main',
    serverId: 1,
    nginxInstanceId: 1,
    nginxConfPath: '/etc/nginx/conf.d/a.conf',
    projectType: 'frontend',
  };

  // 1. block 风险硬拦截：如直接部署在 /opt
  await assert.rejects(
    () =>
      validateTargetPayload(
        {
          ...validBase,
          deployRoot: '/opt',
        },
        {}
      ),
    (err) => {
      assert.match(err.message, /不能直接使用/);
      return true;
    }
  );

  // 2. warn 软风险拦截（两级浅层目录 /opt/web）：未确认时抛出带 code 的错误
  await assert.rejects(
    () =>
      validateTargetPayload(
        {
          ...validBase,
          deployRoot: '/opt/web',
        },
        {}
      ),
    (err) => {
      assert.equal(err.code, 'DEPLOY_ROOT_RISK_CONFIRM_REQUIRED');
      assert.match(err.message, /层级较浅/);
      return true;
    }
  );

  // 3. warn 软风险带 deployRootRiskConfirmed: true 放行
  const validBody = {
    ...validBase,
    deployRoot: '/opt/web',
    deployRootRiskConfirmed: true,
  };
  await validateTargetPayload(validBody, {});
  assert.equal(validBody.deployRoot, '/opt/web');
});

test('cleanup-preview 接口处理：后端目标直接返回空 preview 不报错', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-preview-test-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'test-secret-key-preview';

  const store = await import('../deploy-store.mjs');
  const { runRequestContext } = await import('../request-context.mjs');
  const { handleGetTargetCleanupPreview } = await import('../../controllers/deploy-controller.mjs');

  t.after(async () => {
    store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = {
    accountId: 'acc-prev',
    userId: 'user-prev',
    deviceId: 'dev-prev',
    teamId: 'team-prev',
    role: 'admin',
    client: 'desktop',
    requestId: 'req-prev',
  };

  const server = await runRequestContext(context, () =>
    store.createServer({
      name: '测试服务器',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
      defaultDeployRoot: '/opt/app',
      defaultBackendRoot: '/opt/app',
      defaultNginxConfPath: '/etc/nginx/nginx.conf',
    })
  );

  const backendTarget = await runRequestContext(context, () =>
    store.createTarget({
      projectId: 201,
      projectSource: 'gitlab',
      projectName: '后端项目',
      projectPath: 'group/backend-app',
      repositoryUrl: 'https://gitlab.example/group/backend-app.git',
      defaultBranch: 'main',
      envName: '生产',
      serverId: server.id,
      projectType: 'backend',
      deployRoot: '/opt/app/backend',
      processMode: 'pid',
      serverPort: 8080,
      runtimeJavaHome: '/usr/lib/jvm/java-17',
      artifactPattern: 'target/*.jar',
    })
  );

  let responseData = null;
  const mockReq = { params: { id: backendTarget.id } };
  const mockRes = {
    json(payload) {
      responseData = payload;
      return this;
    },
    status() {
      return this;
    },
  };

  await runRequestContext(context, () => handleGetTargetCleanupPreview(mockReq, mockRes));

  assert.ok(responseData);
  assert.equal(responseData.success, true);
  assert.equal(responseData.data.riskLevel, 'ok');
  assert.deepEqual(responseData.data.willReplaceOrClean, []);
  assert.deepEqual(responseData.data.protected, []);
  assert.deepEqual(responseData.data.unknown, []);
});

test('回滚流程集成：部署根含 .yuyan-backups/子应用/未识别/assets 时成功回滚且当前备份范围精确', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-rollback-flow-'));
  try {
    const deployRoot = path.join(tmpDir, 'shared-html');
    const backupRoot = path.join(deployRoot, '.yuyan-backups');
    const manifestDir = path.join(deployRoot, '.yuyan-manifests');
    const sourceBackupDir = path.join(backupRoot, 'v1-source');

    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.mkdir(sourceBackupDir, { recursive: true });

    // 1. 准备部署根现场（含 .yuyan-backups、受保护子应用、未识别目录、assets、index.html）
    await fs.mkdir(path.join(deployRoot, 'sub-child'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'sub-child', 'child.js'), 'child code', 'utf8');

    await fs.mkdir(path.join(deployRoot, 'unknown-dir'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'unknown-dir', 'manual.doc'), 'doc content', 'utf8');

    await fs.mkdir(path.join(deployRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-v2.js'), 'v2 js', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-v1.js'), 'v1 js', 'utf8');

    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>v2 running</html>', 'utf8');
    await fs.writeFile(path.join(manifestDir, 'current.txt'), 'index.html\nassets/chunk-v2.js\n', 'utf8');

    // 2. 准备历史来源备份（entry-only 类型）
    await fs.writeFile(path.join(sourceBackupDir, '.backup-kind'), 'entry-only\n', 'utf8');
    await fs.writeFile(path.join(sourceBackupDir, '.backup-names'), 'index.html\n', 'utf8');
    await fs.writeFile(path.join(sourceBackupDir, 'index.html'), '<html>v1 original</html>', 'utf8');
    await fs.writeFile(path.join(sourceBackupDir, '.manifest.txt'), 'index.html\nassets/chunk-v1.js\n', 'utf8');

    // 3. 模拟 deploy-service.restoreRecordVersion 调用顺序
    // 步骤 A: 探测
    const entries = await fs.readdir(deployRoot);
    const existingNames = entries.filter((name) => name !== '.' && name !== '..');

    // 步骤 B: 规划 restorePlan
    const restorePlan = planRestore({
      backupKind: 'entry-only',
      backupNames: ['index.html'],
      backupTopEntries: ['index.html'],
      backupManifestTopNames: ['index.html', 'assets'],
      currentManifestTopNames: ['index.html', 'assets'],
      existingNames,
      protectedNames: ['sub-child'],
      hashedDirs: ['assets'],
    });

    assert.equal(restorePlan.kind, 'entry-only');
    assert.deepEqual(restorePlan.restoreNames, ['index.html']);
    assert.deepEqual(restorePlan.removeNames, ['index.html']);

    // 步骤 C: 备份当前目录：removeNames ∪ (restoreNames ∩ 已存在)
    const existingSet = new Set(existingNames);
    const namesToBackupSet = new Set(restorePlan.removeNames);
    for (const rName of restorePlan.restoreNames) {
      if (existingSet.has(rName)) namesToBackupSet.add(rName);
    }
    const currentBackupNames = [...namesToBackupSet].sort();
    assert.deepEqual(currentBackupNames, ['index.html']);

    const currentBackupDir = path.join(backupRoot, 'rollback-before');
    await fs.mkdir(currentBackupDir, { recursive: true });
    const backupCmd = buildBackupDeployRootCommand(
      deployRoot,
      currentBackupDir,
      ['sub-child'],
      false,
      {
        kind: restorePlan.kind,
        namesToBackup: currentBackupNames,
        isOverlayUpload: true,
      }
    );
    await execAsync(backupCmd);

    // 验证当前备份内容：必须只有 index.html，绝不含 .yuyan-backups、sub-child、unknown-dir、assets
    const currentBackupFiles = await fs.readdir(currentBackupDir);
    assert.ok(currentBackupFiles.includes('index.html'));
    assert.ok(currentBackupFiles.includes('.backup-names'));
    assert.ok(currentBackupFiles.includes('.backup-kind'));
    assert.equal(await fs.readFile(path.join(currentBackupDir, 'index.html'), 'utf8'), '<html>v2 running</html>');
    assert.ok(!currentBackupFiles.includes('.yuyan-backups'), '备份目录绝不能备份自身！');
    assert.ok(!currentBackupFiles.includes('sub-child'), '备份不能包含受保护子应用！');
    assert.ok(!currentBackupFiles.includes('unknown-dir'), '备份不能包含未识别目录！');
    assert.ok(!currentBackupFiles.includes('assets'), 'entry-only 备份不能包含静态资源！');

    // 步骤 D: 执行真实恢复命令
    const restoreCmd = buildRestoreDeployRootCommand(
      deployRoot,
      sourceBackupDir,
      ['sub-child'],
      false,
      {
        restoreNames: restorePlan.restoreNames,
        removeNames: restorePlan.removeNames,
        isEntryOnly: true,
      }
    );
    await execAsync(restoreCmd);

    // 4. 断言恢复结果：
    // index.html 成功还原为 v1
    assert.equal(await fs.readFile(path.join(deployRoot, 'index.html'), 'utf8'), '<html>v1 original</html>');
    // 受保护子应用不变
    assert.equal(await fs.readFile(path.join(deployRoot, 'sub-child', 'child.js'), 'utf8'), 'child code');
    // 未识别目录不变
    assert.equal(await fs.readFile(path.join(deployRoot, 'unknown-dir', 'manual.doc'), 'utf8'), 'doc content');
    // assets 静态资源完好
    assert.equal(await fs.readFile(path.join(deployRoot, 'assets', 'chunk-v2.js'), 'utf8'), 'v2 js');
    assert.equal(await fs.readFile(path.join(deployRoot, 'assets', 'chunk-v1.js'), 'utf8'), 'v1 js');
    // current.txt 清单恢复为来源版本清单
    assert.equal(await fs.readFile(path.join(manifestDir, 'current.txt'), 'utf8'), 'index.html\nassets/chunk-v1.js\n');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('buildRestoreDeployRootCommand: 恢复目标仍存在时报错退出，绝不嵌套拷贝', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-no-nest-copy-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    const backupDir = path.join(tmpDir, 'backup');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });

    // 根目录与备份目录均存在 subfolder 目录
    await fs.mkdir(path.join(deployRoot, 'subfolder'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'subfolder', 'file.txt'), 'root file', 'utf8');

    await fs.mkdir(path.join(backupDir, 'subfolder'), { recursive: true });
    await fs.writeFile(path.join(backupDir, 'subfolder', 'file.txt'), 'backup file', 'utf8');

    // 试图恢复 subfolder，但没有在 removeNames 中移除
    const restoreCmd = buildRestoreDeployRootCommand(deployRoot, backupDir, [], false, {
      restoreNames: ['subfolder'],
      removeNames: [],
    });

    let failed = false;
    let stderrOutput = '';
    try {
      await execAsync(restoreCmd);
    } catch (err) {
      failed = true;
      stderrOutput = err.stderr || err.message;
    }

    assert.ok(failed, '目标仍然存在时必须执行失败');
    assert.match(stderrOutput, /恢复前目标仍存在：subfolder/);
    // 绝不能在 subfolder 内生成嵌套的 subfolder 目录
    const nestedStat = await fs.stat(path.join(deployRoot, 'subfolder', 'subfolder')).catch(() => null);
    assert.equal(nestedStat, null, '绝不能生成嵌套拷贝！');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('detectBackupRestorePlan: 备份目录不存在时抛出白话错误，阻止只删不恢复', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-backup-nonexist-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    const nonExistentBackup = path.join(tmpDir, 'deleted-backup-dir');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>running</html>', 'utf8');

    // 本地连接模拟
    const localConn = {
      exec(command, cb) {
        const child = exec(command);
        const stream = {
          on(event, handler) {
            if (event === 'data') child.stdout?.on('data', handler);
            if (event === 'close') child.on('close', handler);
            if (event === 'exit') child.on('exit', handler);
            if (event === 'error') child.on('error', handler);
            return this;
          },
          stderr: {
            on(event, handler) {
              if (event === 'data') child.stderr?.on('data', handler);
              return this;
            },
          },
          close() { child.kill(); },
        };
        cb(null, stream);
      },
    };

    await assert.rejects(
      async () => {
        await detectBackupRestorePlan(localConn, deployRoot, nonExistentBackup, [], false);
      },
      (err) => {
        assert.match(err.message, new RegExp(`备份目录不存在或已被删除：${nonExistentBackup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}，已停止恢复，部署目录没有改动`));
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('真实 Shell 集成：备份目录只读时回滚失败，部署根完全不变', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-rollback-readonly-'));
  try {
    const deployRoot = path.join(tmpDir, 'shared-html');
    const backupRoot = path.join(deployRoot, '.yuyan-backups');
    const manifestDir = path.join(deployRoot, '.yuyan-manifests');
    const sourceBackupDir = path.join(backupRoot, 'v1-source');

    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.mkdir(sourceBackupDir, { recursive: true });

    // 1. 现场构建
    await fs.mkdir(path.join(deployRoot, 'sub-app'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'sub-app', 'sub.js'), 'sub code v2', 'utf8');
    await fs.mkdir(path.join(deployRoot, 'unregistered'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'unregistered', 'doc.txt'), 'manual doc', 'utf8');
    await fs.mkdir(path.join(deployRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk.js'), 'chunk v2', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>current running</html>', 'utf8');
    await fs.writeFile(path.join(manifestDir, 'current.txt'), 'index.html\nassets/chunk.js\n', 'utf8');

    // 记录操作前的现场完整状态（文件名与内容快照）
    async function snapshotDir(dir) {
      const result = {};
      const walk = async (curr, rel) => {
        const entries = await fs.readdir(curr, { withFileTypes: true });
        for (const e of entries) {
          const ePath = path.join(curr, e.name);
          const rPath = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (e.name === '.yuyan-backups') continue; // 忽略备份目录内部
            await walk(ePath, rPath);
          } else {
            result[rPath] = await fs.readFile(ePath, 'utf8');
          }
        }
      };
      await walk(dir, '');
      return result;
    }

    const beforeSnapshot = await snapshotDir(deployRoot);

    // 2. 准备历史来源备份
    await fs.writeFile(path.join(sourceBackupDir, '.backup-kind'), 'full\n', 'utf8');
    await fs.writeFile(path.join(sourceBackupDir, '.backup-names'), 'index.html\nassets\n', 'utf8');
    await fs.writeFile(path.join(sourceBackupDir, 'index.html'), '<html>v1 old</html>', 'utf8');
    await fs.writeFile(path.join(sourceBackupDir, '.manifest.txt'), 'index.html\nassets/chunk.js\n', 'utf8');

    // 3. 将 .yuyan-backups 设为只读 (555)，模拟无法创建新备份目录
    await fs.chmod(backupRoot, 0o555);

    // 4. 模拟 restoreRecordVersion 流程：
    let currentBackupCreated = false;
    let rollbackRootRestored = false;
    const logs = [];
    const log = (level, message, stage = '') => {
      logs.push({ level, message, stage });
    };

    const targetBackupDir = path.join(backupRoot, 'rollback-attempt-1');

    try {
      // 创建备份目录并备份当前目录
      await fs.mkdir(targetBackupDir, { recursive: true });
      const backupCmd = buildBackupDeployRootCommand(deployRoot, targetBackupDir, ['sub-app'], false, {
        kind: 'full',
        namesToBackup: ['index.html', 'assets'],
        isOverlayUpload: false,
      });
      await execAsync(backupCmd);
      currentBackupCreated = true;
    } catch (err) {
      // 捕获到备份失败（EACCES）
      if (currentBackupCreated) {
        // 如果已创建成功才自动恢复
        rollbackRootRestored = true;
      } else {
        // 清理未创建完成的备份目录，并在日志里记录
        await fs.rm(targetBackupDir, { recursive: true, force: true }).catch(() => {});
        log('info', '回滚前备份失败，部署目录没有改动', 'cleanup');
      }
    }

    // 5. 断言
    assert.equal(currentBackupCreated, false, '备份未成功时 currentBackupCreated 必须为 false');
    assert.equal(rollbackRootRestored, false, '未成功备份时绝不能执行自动恢复');
    assert.ok(logs.some((l) => l.message === '回滚前备份失败，部署目录没有改动'), '日志中必须明确提示部署目录未改动');

    // 逐项严格比对部署根目录所有内容，必须 100% 毫无改变
    const afterSnapshot = await snapshotDir(deployRoot);
    assert.deepEqual(afterSnapshot, beforeSnapshot, '回滚前备份失败时，部署根目录文件与内容必须完全保持不变！');
  } finally {
    // 恢复权限以便临时目录正常清理
    await fs.chmod(path.join(tmpDir, 'shared-html', '.yuyan-backups'), 0o777).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('托管实例父目录拦截：托管实例 nginxRoot=/opt/yuyan/nginx 时保存 deployRoot=/opt/yuyan 必须被 block', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-managed-nginx-block-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'test-secret-key-managed';

  const store = await import('../deploy-store.mjs');
  const { runRequestContext } = await import('../request-context.mjs');
  const { validateTargetPayload } = await import('../../controllers/deploy-controller.mjs');

  t.after(async () => {
    store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });

  const context = {
    accountId: 'acc-m',
    userId: 'user-m',
    deviceId: 'dev-m',
    teamId: 'team-m',
    role: 'admin',
    client: 'desktop',
    requestId: 'req-m',
  };

  const server = await runRequestContext(context, () =>
    store.createServer({
      name: '托管测试服务器',
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'pwd',
      defaultDeployRoot: '/opt/yuyan/html',
      defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    })
  );

  const managedInstance = await runRequestContext(context, () =>
    store.createNginxInstance(server.id, {
      name: '托管 Nginx 实例',
      instanceType: 'managed',
      nginxRoot: '/opt/yuyan/nginx',
      sitesDir: '/opt/yuyan/nginx/conf/sites-enabled',
      defaultDeployRoot: '/opt/yuyan/html',
      defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    })
  );

  // 尝试配置部署根为 Nginx 实例的祖先目录 /opt/yuyan -> 必须被硬 block
  const targetPayload = {
    projectId: 301,
    projectName: '风险前端项目',
    repositoryUrl: 'https://git.example/app.git',
    defaultBranch: 'main',
    serverId: server.id,
    nginxInstanceId: managedInstance.id,
    nginxConfPath: '/opt/yuyan/nginx/conf/sites-enabled/app.conf',
    projectType: 'frontend',
    deployRoot: '/opt/yuyan',
    deployRootRiskConfirmed: true, // 即使带显式确认也必须 block
  };

  await assert.rejects(
    () => validateTargetPayload(targetPayload),
    (err) => {
      assert.match(err.message, /父级目录/);
      return true;
    }
  );
});

test('边界与攻击防御：空名单不操作、特殊字符防注入且不生成 pwn 文件、模拟 df 空间不足退出', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-boundary-attack-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    const backupDir = path.join(tmpDir, 'backup');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });

    // 1. 备份/恢复名单为空不操作
    await fs.writeFile(path.join(deployRoot, 'keep-safe.txt'), 'safe content', 'utf8');
    const emptyBackupCmd = buildBackupDeployRootCommand(
      deployRoot,
      backupDir,
      [],
      false,
      {
        namesToBackup: [],
      }
    );
    await execAsync(emptyBackupCmd);
    assert.equal(await fs.readFile(path.join(backupDir, '.backup-kind'), 'utf8'), 'entry-only\n');
    assert.equal(await fs.readFile(path.join(backupDir, '.backup-names'), 'utf8'), '');
    assert.equal(await fs.stat(path.join(backupDir, 'keep-safe.txt')).catch(() => null), null, '空名单时不应备份任何文件！');

    const emptyRestoreCmd = buildRestoreDeployRootCommand(
      deployRoot,
      backupDir,
      [],
      false,
      {
        restoreNames: [],
        removeNames: [],
      }
    );
    await execAsync(emptyRestoreCmd);
    assert.equal(await fs.readFile(path.join(deployRoot, 'keep-safe.txt'), 'utf8'), 'safe content', '空名单时不应删除任何文件！');

    // 2. 特殊字符与注入防御：--restore, -rf, a b, $(touch pwn), 'quote
    const pwnFilePath = path.join(process.cwd(), 'pwn');
    const tmpPwnPath = path.join(tmpDir, 'pwn');
    await fs.rm(pwnFilePath, { force: true }).catch(() => {});
    await fs.rm(tmpPwnPath, { force: true }).catch(() => {});

    const attackNames = ['--restore', '-rf', 'a b', '$(touch pwn)', "'quote"];
    for (const name of attackNames) {
      await fs.writeFile(path.join(deployRoot, name), `attack payload for ${name}`, 'utf8');
    }

    const attackBackupDir = path.join(tmpDir, 'backup-attack');
    await fs.mkdir(attackBackupDir, { recursive: true });
    const attackBackupCmd = buildBackupDeployRootCommand(
      deployRoot,
      attackBackupDir,
      [],
      false,
      {
        namesToBackup: attackNames,
        isOverlayUpload: false,
      }
    );
    await execAsync(attackBackupCmd);

    // 断言绝没有在当前目录或 tmp 目录中执行注入命令生成 pwn 文件
    assert.equal(await fs.stat(pwnFilePath).catch(() => null), null, '绝不能发生命令注入生成 pwn 文件！');
    assert.equal(await fs.stat(tmpPwnPath).catch(() => null), null, '绝不能发生命令注入生成 pwn 文件！');

    // 验证特殊文件都安全备份成功
    for (const name of attackNames) {
      const content = await fs.readFile(path.join(attackBackupDir, name), 'utf8');
      assert.equal(content, `attack payload for ${name}`);
    }

    // 3. 模拟 df 空间不足时退出
    const mockBinDir = path.join(tmpDir, 'mock-bin');
    await fs.mkdir(mockBinDir, { recursive: true });
    const mockDfScript = path.join(mockBinDir, 'df');
    await fs.writeFile(
      mockDfScript,
      '#!/bin/sh\necho "Filesystem 1K-blocks Used Available Use% Mounted on"\necho "/dev/mock 1000000 999999 1 100% /mock"\n',
      { mode: 0o755 }
    );

    const dfTestBackupDir = path.join(tmpDir, 'backup-df-fail');
    const dfFailBackupCmd = buildBackupDeployRootCommand(
      deployRoot,
      dfTestBackupDir,
      [],
      false,
      {
        namesToBackup: attackNames,
        isOverlayUpload: false,
      }
    );

    let dfFailed = false;
    let dfStderr = '';
    try {
      await execAsync(dfFailBackupCmd, {
        env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` },
      });
    } catch (err) {
      dfFailed = true;
      dfStderr = String(err?.stderr || err?.message || '');
    }
    assert.equal(dfFailed, true, '磁盘空间不足时命令必须以非零退出！');
    assert.match(dfStderr, /磁盘空间不足/);
  } finally {
    await fs.rm(path.join(process.cwd(), 'pwn'), { force: true }).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

async function snapshotDirectory(dir, ignoreNames = ['.yuyan-backups']) {
  const result = {};
  const walk = async (curr, rel) => {
    const entries = await fs.readdir(curr, { withFileTypes: true });
    for (const e of entries) {
      if (ignoreNames.includes(e.name) && !rel) continue;
      const ePath = path.join(curr, e.name);
      const rPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(ePath, rPath);
      } else {
        result[rPath] = await fs.readFile(ePath, 'utf8');
      }
    }
  };
  await walk(dir, '');
  return result;
}

async function runShellIntegrationSuite(env = process.env, suiteLabel = '默认环境') {
  const suiteTmp = await fs.mkdtemp(path.join(os.tmpdir(), `yuyan-suite-${Date.now()}-`));
  try {
    // 1. 共享根清空（已登记子应用、未登记目录、手放文件、旧主应用文件）
    {
      const deployRoot = path.join(suiteTmp, 'shared-root');
      const backupDir = path.join(suiteTmp, 'shared-backup');
      await fs.mkdir(deployRoot, { recursive: true });
      await fs.mkdir(backupDir, { recursive: true });

      await fs.mkdir(path.join(deployRoot, 'registered-sub'), { recursive: true });
      await fs.writeFile(path.join(deployRoot, 'registered-sub', 'sub.html'), 'registered sub app', 'utf8');

      await fs.mkdir(path.join(deployRoot, 'unregistered-sub'), { recursive: true });
      await fs.writeFile(path.join(deployRoot, 'unregistered-sub', 'data.json'), '{"unregistered": true}', 'utf8');

      await fs.writeFile(path.join(deployRoot, 'manual-notes.txt'), 'manual notes file', 'utf8');
      await fs.writeFile(path.join(deployRoot, 'old-app.js'), 'console.log("old app")', 'utf8');
      await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>old index</html>', 'utf8');

      await fs.mkdir(path.join(deployRoot, '.yuyan-backups'), { recursive: true });
      await fs.writeFile(path.join(deployRoot, '.yuyan-backups', 'dummy.bak'), 'backup', 'utf8');

      const namesToBackup = ['old-app.js', 'index.html'];
      const protectedSubDirs = ['registered-sub'];

      const backupCmd = buildBackupDeployRootCommand(deployRoot, backupDir, protectedSubDirs, false, {
        namesToBackup,
        isOverlayUpload: false,
      });
      await execAsync(backupCmd, { env });

      const clearCmd = buildClearDeployRootCommand(deployRoot, namesToBackup, false);
      await execAsync(clearCmd, { env });

      // 断言：已登记子应用、未登记子应用、手放文件、.yuyan-backups 完好
      assert.equal(await fs.readFile(path.join(deployRoot, 'registered-sub', 'sub.html'), 'utf8'), 'registered sub app');
      assert.equal(await fs.readFile(path.join(deployRoot, 'unregistered-sub', 'data.json'), 'utf8'), '{"unregistered": true}');
      assert.equal(await fs.readFile(path.join(deployRoot, 'manual-notes.txt'), 'utf8'), 'manual notes file');
      assert.equal(await fs.readFile(path.join(deployRoot, '.yuyan-backups', 'dummy.bak'), 'utf8'), 'backup');

      // 断言：待清理的旧主应用文件被删除
      assert.equal(await fs.stat(path.join(deployRoot, 'old-app.js')).catch(() => null), null);
      assert.equal(await fs.stat(path.join(deployRoot, 'index.html')).catch(() => null), null);

      // 断言：备份目录内容完整
      assert.equal(await fs.readFile(path.join(backupDir, 'old-app.js'), 'utf8'), 'console.log("old app")');
      assert.equal(await fs.readFile(path.join(backupDir, 'index.html'), 'utf8'), '<html>old index</html>');
      assert.equal(await fs.readFile(path.join(backupDir, '.backup-kind'), 'utf8'), 'full\n');
      const backupNamesContent = await fs.readFile(path.join(backupDir, '.backup-names'), 'utf8');
      const backupNamesList = backupNamesContent.trim().split('\n').filter(Boolean).sort();
      assert.deepEqual(backupNamesList, ['index.html', 'old-app.js']);
    }

    // 2. 备份目录只读导致备份失败必须中止且部署根不变
    {
      const deployRoot = path.join(suiteTmp, 'readonly-root');
      const backupDir = path.join(suiteTmp, 'readonly-backup');
      await fs.mkdir(deployRoot, { recursive: true });
      await fs.mkdir(backupDir, { recursive: true });

      await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>keep untouched</html>', 'utf8');
      await fs.writeFile(path.join(deployRoot, 'app.js'), 'console.log("keep untouched")', 'utf8');
      await fs.mkdir(path.join(deployRoot, 'sub-dir'), { recursive: true });
      await fs.writeFile(path.join(deployRoot, 'sub-dir', 'file.txt'), 'sub file', 'utf8');

      const beforeSnapshot = await snapshotDirectory(deployRoot);

      // 设置备份目录只读 (0o555)
      await fs.chmod(backupDir, 0o555);

      const backupCmd = buildBackupDeployRootCommand(deployRoot, path.join(backupDir, 'target-bak'), [], false, {
        namesToBackup: ['index.html', 'app.js'],
        isOverlayUpload: false,
      });

      let backupFailed = false;
      try {
        await execAsync(backupCmd, { env });
      } catch {
        backupFailed = true;
      }
      assert.equal(backupFailed, true, `${suiteLabel}: 备份目录只读时备份命令必须非零退出`);

      // 验证部署根逐项内容完全不变
      const afterSnapshot = await snapshotDirectory(deployRoot);
      assert.deepEqual(afterSnapshot, beforeSnapshot, `${suiteLabel}: 备份失败后部署根必须保持 100% 不变`);

      // 恢复写权限便于清理
      await fs.chmod(backupDir, 0o777).catch(() => {});
    }

    // 3. 恢复预检失败不改动
    {
      // 场景 3A: 备份中缺少条目，预检失败，待删除项绝不被删，部署根保持不变
      const deployRootA = path.join(suiteTmp, 'restore-precheck-missing-root');
      const backupDirA = path.join(suiteTmp, 'restore-precheck-missing-bak');
      await fs.mkdir(deployRootA, { recursive: true });
      await fs.mkdir(backupDirA, { recursive: true });

      await fs.writeFile(path.join(deployRootA, 'to-remove.txt'), 'should not be deleted on precheck fail', 'utf8');
      await fs.writeFile(path.join(deployRootA, 'keep.txt'), 'keep me', 'utf8');
      await fs.writeFile(path.join(backupDirA, 'restore-ok.txt'), 'backup content', 'utf8');
      // backupDirA 中故意缺少 ghost-file.txt

      const snapshotBeforeA = await snapshotDirectory(deployRootA);

      const restoreCmdA = buildRestoreDeployRootCommand(deployRootA, backupDirA, [], false, {
        removeNames: ['to-remove.txt'],
        restoreNames: ['restore-ok.txt', 'ghost-file.txt'],
        isEntryOnly: false,
      });

      let failedA = false;
      let stderrA = '';
      try {
        await execAsync(restoreCmdA, { env });
      } catch (err) {
        failedA = true;
        stderrA = String(err?.stderr || err?.message || '');
      }
      assert.equal(failedA, true, `${suiteLabel}: 缺少备份条目时恢复预检必须失败`);
      assert.match(stderrA, /备份里缺少条目：ghost-file\.txt，已停止恢复，部署目录没有改动/);

      const snapshotAfterA = await snapshotDirectory(deployRootA);
      assert.deepEqual(snapshotAfterA, snapshotBeforeA, `${suiteLabel}: 预检失败时部署根文件内容必须完全不变（to-remove.txt 未被删除）`);

      // 场景 3B: 恢复目标仍存在且不在 remove 名单中，预检失败，待删除项绝不被删，部署根保持不变
      const deployRootB = path.join(suiteTmp, 'restore-precheck-exist-root');
      const backupDirB = path.join(suiteTmp, 'restore-precheck-exist-bak');
      await fs.mkdir(deployRootB, { recursive: true });
      await fs.mkdir(backupDirB, { recursive: true });

      await fs.writeFile(path.join(deployRootB, 'to-remove.txt'), 'should not be deleted on precheck fail', 'utf8');
      await fs.writeFile(path.join(deployRootB, 'conflict.txt'), 'already exists in root', 'utf8');
      await fs.writeFile(path.join(backupDirB, 'conflict.txt'), 'backup conflict content', 'utf8');

      const snapshotBeforeB = await snapshotDirectory(deployRootB);

      const restoreCmdB = buildRestoreDeployRootCommand(deployRootB, backupDirB, [], false, {
        removeNames: ['to-remove.txt'],
        restoreNames: ['conflict.txt'],
        isEntryOnly: false,
      });

      let failedB = false;
      let stderrB = '';
      try {
        await execAsync(restoreCmdB, { env });
      } catch (err) {
        failedB = true;
        stderrB = String(err?.stderr || err?.message || '');
      }
      assert.equal(failedB, true, `${suiteLabel}: 恢复目标仍存在时恢复预检必须失败`);
      assert.match(stderrB, /恢复前目标仍存在：conflict\.txt/);

      const snapshotAfterB = await snapshotDirectory(deployRootB);
      assert.deepEqual(snapshotAfterB, snapshotBeforeB, `${suiteLabel}: 预检失败时部署根文件内容必须完全不变（to-remove.txt 未被删除）`);
    }

    // 4. detectDeployRoot 和 detectBackupRestorePlan 用到的探测脚本能正确解析
    {
      const probeRealRoot = path.join(suiteTmp, 'probe-real-root');
      const probeSymlinkRoot = path.join(suiteTmp, 'probe-symlink-root');
      await fs.mkdir(probeRealRoot, { recursive: true });
      await fs.mkdir(path.join(probeRealRoot, 'assets'), { recursive: true });
      await fs.mkdir(path.join(probeRealRoot, '.yuyan-manifests'), { recursive: true });
      await fs.writeFile(path.join(probeRealRoot, 'index.html'), '<html>probe test</html>', 'utf8');
      await fs.writeFile(path.join(probeRealRoot, '.yuyan-manifests', 'current.txt'), 'index.html\nassets/app.js\n', 'utf8');
      await fs.symlink(probeRealRoot, probeSymlinkRoot);

      // 探测部署根
      const detectRootCmd = buildDetectDeployRootCommand(probeSymlinkRoot, false, false);
      const { stdout: rootStdout } = await execAsync(detectRootCmd, { env });
      const parsedRoot = parseDetectDeployRootOutput(rootStdout, probeSymlinkRoot);

      const expectedRealRoot = await fs.realpath(probeRealRoot);
      assert.equal(parsedRoot.exists, true);
      assert.equal(parsedRoot.realRoot, expectedRealRoot);
      assert.ok(parsedRoot.existingNames.includes('index.html'));
      assert.ok(parsedRoot.existingNames.includes('assets'));
      assert.ok(parsedRoot.existingNames.includes('.yuyan-manifests'));
      assert.match(parsedRoot.manifestText, /index\.html/);

      // 探测备份规划
      const probeBackupDir = path.join(suiteTmp, 'probe-backup-dir');
      await fs.mkdir(probeBackupDir, { recursive: true });
      await fs.writeFile(path.join(probeBackupDir, '.backup-kind'), 'entry-only\n', 'utf8');
      await fs.writeFile(path.join(probeBackupDir, '.backup-names'), 'index.html\n', 'utf8');
      await fs.writeFile(path.join(probeBackupDir, '.manifest.txt'), 'index.html\nassets/app.js\n', 'utf8');
      await fs.writeFile(path.join(probeBackupDir, 'index.html'), '<html>probe bak</html>', 'utf8');

      const detectPlanCmd = buildDetectBackupRestorePlanCommand(expectedRealRoot, probeBackupDir, false);
      const { stdout: planStdout } = await execAsync(detectPlanCmd, { env });
      const parsedPlan = parseDetectBackupRestorePlanOutput(planStdout, {
        rootPath: expectedRealRoot,
        backupPath: probeBackupDir,
        protectedSubDirs: [],
      });

      assert.equal(parsedPlan.kind, 'entry-only');
      assert.deepEqual(parsedPlan.restoreNames, ['index.html']);
      assert.deepEqual(parsedPlan.removeNames, ['index.html']);
    }

    // 5. df -Pk 空间检查
    {
      const checkDir = suiteTmp;
      const dfPipeline = `df -Pk "${checkDir}" 2>/dev/null | tail -n 1 | awk '{print $(NF-2)}'`;
      const dfShellCmd = `sh -c ${shellQuote(dfPipeline)}`;
      const { stdout: dfOut } = await execAsync(dfShellCmd, { env });
      const availKb = parseInt(dfOut.trim(), 10);
      assert.ok(!Number.isNaN(availKb) && availKb > 0, `${suiteLabel}: df -Pk 空间检查必须输出有效的正整数剩余 KB，实际输出: "${dfOut.trim()}"`);
    }
  } finally {
    await fs.rm(suiteTmp, { recursive: true, force: true }).catch(() => {});
  }
}

test('真实 Shell 集成：5 大核心场景套件（默认环境）', async () => {
  await runShellIntegrationSuite(process.env, '默认环境');
});

test('真实 Shell 集成：5 大核心场景套件（Busybox 参数化重跑）', async (t) => {
  const busyboxPath = process.env.YUYAN_TEST_BUSYBOX;
  if (!busyboxPath) {
    t.skip('未指定 YUYAN_TEST_BUSYBOX 环境变量，跳过 Busybox 参数化环境重跑');
    return;
  }

  const tmpBin = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-busybox-bin-'));
  try {
    let applets = [];
    try {
      const { stdout } = await execAsync(`"${busyboxPath}" --list`);
      applets = stdout.split(/\s+/).filter(Boolean);
    } catch {
      applets = ['sh', 'cp', 'rm', 'mkdir', 'ls', 'cat', 'df', 'du', 'awk', 'grep', 'sort', 'tail', 'wc', 'tr', 'pwd', 'printf', 'test', '['];
    }
    for (const applet of applets) {
      await fs.symlink(busyboxPath, path.join(tmpBin, applet)).catch(() => {});
    }
    await fs.symlink(busyboxPath, path.join(tmpBin, 'busybox')).catch(() => {});

    const busyboxEnv = { ...process.env, PATH: `${tmpBin}:${process.env.PATH}` };
    await runShellIntegrationSuite(busyboxEnv, 'Busybox 环境');
  } finally {
    await fs.rm(tmpBin, { recursive: true, force: true });
  }
});
