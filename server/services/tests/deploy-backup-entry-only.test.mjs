import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BACKUP_KINDS,
  BACKUP_KIND_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  DEPLOY_CURRENT_MANIFEST_NAME,
  DEFAULT_HASHED_ASSET_DIRS,
  resolveDeployRetentionCounts,
  buildBackupDeployRootCommand,
  buildRestoreDeployRootCommand,
  buildPreflightCheckRollbackCommand,
  buildPruneRemoteArtifactManifestsCommand,
  preflightCheckRollback,
} from '../deploy-service.mjs';

const execAsync = promisify(exec);

/**
 * 创建模拟 SSH 连接桩
 * @param {string} stdoutText - 输出内容
 * @param {number} exitCode - 退出码
 * @returns {Object} SSH 连接桩
 */
const createMockConn = (stdoutText = '', exitCode = 0) => ({
  exec(_command, callback) {
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    callback(null, stream);

    setTimeout(() => {
      if (stdoutText) stream.write(stdoutText);
      stream.end();
      stream.stderr.end();
      stream.emit('close', exitCode);
    }, 5);
  },
});

test('resolveDeployRetentionCounts: 强制保证清单保留份数大于等于备份保留份数', () => {
  // 1. 默认情况
  const defaultResult = resolveDeployRetentionCounts();
  assert.equal(defaultResult.backupKeepCount, 8);
  assert.equal(defaultResult.manifestKeepCount, 8);

  // 2. 清单保留份数小于备份保留份数时，代码层面强制调整相等
  const conflictResult = resolveDeployRetentionCounts({
    backupKeepCount: 8,
    manifestKeepCount: 3,
  });
  assert.equal(conflictResult.backupKeepCount, 8);
  assert.equal(conflictResult.manifestKeepCount, 8, '清单保留份数必须强制提升至不小于备份保留份数');

  // 3. 清单保留份数大于备份保留份数时，保留各自设置
  const customResult = resolveDeployRetentionCounts({
    backupKeepCount: 5,
    manifestKeepCount: 12,
  });
  assert.equal(customResult.backupKeepCount, 5);
  assert.equal(customResult.manifestKeepCount, 12);

  // 4. 非法输入兜底
  const fallbackResult = resolveDeployRetentionCounts({
    backupKeepCount: -1,
    manifestKeepCount: 0,
  });
  assert.equal(fallbackResult.backupKeepCount, 8);
  assert.equal(fallbackResult.manifestKeepCount, 8);
});

test('buildBackupDeployRootCommand: 覆盖保留旧资源模式下生成 entry-only 轻量备份逻辑', () => {
  const target = { deployRoot: '/opt/yuyan/html/outsourced' };
  const backupPath = '/opt/yuyan/html/outsourced/.yuyan-backups/20261009150000';
  const protectedSubDirs = ['sub-app'];

  const cmd = buildBackupDeployRootCommand(target, backupPath, protectedSubDirs, false, {
    isOverlayUpload: true,
    hashedDirs: ['assets'],
  });

  // 验证排除项：排除 .yuyan-backups、.yuyan-manifests、sub-app、assets
  assert.match(cmd, /! -name .*assets/);
  assert.match(cmd, /! -name .*sub-app/);
  assert.match(cmd, /! -name .*\.yuyan-backups/);
  assert.match(cmd, /! -name .*\.yuyan-manifests/);

  // 验证优先读取 current.txt，并兜底查找最新清单
  assert.match(cmd, /current\.txt/);
  assert.match(cmd, /\.manifest\.txt/);

  // 验证标记写入 entry-only
  assert.match(cmd, /entry-only/);
  assert.match(cmd, /\.backup-kind/);

  // 验证无清单时降级为 full
  assert.match(cmd, /echo "full" > "\$backup\/\.backup-kind"/);
});

test('buildBackupDeployRootCommand: 清空后替换策略下保持整目录 full 备份', () => {
  const target = { deployRoot: '/opt/yuyan/html/system' };
  const backupPath = '/opt/yuyan/html/system/.yuyan-backups/20261009151000';

  const cmd = buildBackupDeployRootCommand(target, backupPath, [], true, {
    isOverlayUpload: false,
  });

  // 清空后替换不排除 assets
  assert.doesNotMatch(cmd, /! -name .*assets/);
  assert.match(cmd, /sudo -n find '\/opt\/yuyan\/html\/system'/);
  assert.match(cmd, /echo "full" > "\$1\/\.backup-kind"/);
});

test('buildPreflightCheckRollbackCommand: 正确构建预检命令与静态资源存在性检测', () => {
  const target = { deployRoot: '/opt/yuyan/html/outsourced' };
  const backupPath = '/opt/yuyan/html/outsourced/.yuyan-backups/20261009150000';

  const cmd = buildPreflightCheckRollbackCommand(target, backupPath, ['assets'], false);

  assert.match(cmd, /\.backup-kind/);
  assert.match(cmd, /\.manifest\.txt/);
  assert.match(cmd, /assets\/\*\|assets/);
  assert.match(cmd, /missing_count/);
  assert.match(cmd, /===MISSING_FILES===/);
});

test('buildRestoreDeployRootCommand: 分流处理 entry-only 恢复与 full 恢复', () => {
  const target = { deployRoot: '/opt/yuyan/html/outsourced' };
  const backupPath = '/opt/yuyan/html/outsourced/.yuyan-backups/20261009150000';
  const protectedSubDirs = ['risk'];

  const cmd = buildRestoreDeployRootCommand(target, backupPath, protectedSubDirs, false, {
    hashedDirs: ['assets'],
  });

  // entry-only 分支：清理部署目录时必须排除 assets 和受保护目录，绝不能删掉 assets
  assert.match(cmd, /if \[ "\$kind" = "entry-only" \]/);
  assert.match(cmd, /! -name .*assets/);
  assert.match(cmd, /! -name .*risk/);

  // 恢复后更新 current.txt 指针
  assert.match(cmd, /current\.txt/);

  // full 分支：常规全量恢复
  assert.match(cmd, /else/);
});

test('buildPruneRemoteArtifactManifestsCommand: 将存活备份清单并入白名单保护', () => {
  const cmd = buildPruneRemoteArtifactManifestsCommand('/opt/yuyan/html/outsourced', 8, false);

  // 验证合并了备份目录下的 .manifest.txt
  assert.match(cmd, /\.yuyan-backups/);
  assert.match(cmd, /\.manifest\.txt/);
  assert.match(cmd, /current\.txt/);
  assert.match(cmd, /tmp_recent_raw/);
});

test('preflightCheckRollback: 历史 full 备份直接通过预检', async () => {
  const logs = [];
  const target = { deployRoot: '/opt/yuyan/html/legacy' };
  const conn = createMockConn('kind=full missing_count=0\n', 0);

  const result = await preflightCheckRollback(
    conn,
    target,
    '/opt/yuyan/html/legacy/.yuyan-backups/old-release',
    (lvl, msg) => logs.push({ lvl, msg }),
    false
  );

  assert.equal(result.passed, true);
  assert.equal(result.kind, 'full');
  assert.equal(result.missingCount, 0);
  assert.ok(logs.some((l) => l.msg.includes('依赖静态资源完好')));
});

test('preflightCheckRollback: entry-only 备份静态资源完好时预检通过', async () => {
  const logs = [];
  const target = { deployRoot: '/opt/yuyan/html/outsourced' };
  const conn = createMockConn('kind=entry-only missing_count=0\n', 0);

  const result = await preflightCheckRollback(
    conn,
    target,
    '/opt/yuyan/html/outsourced/.yuyan-backups/20261009150000',
    (lvl, msg) => logs.push({ lvl, msg }),
    false
  );

  assert.equal(result.passed, true);
  assert.equal(result.kind, 'entry-only');
  assert.equal(result.missingCount, 0);
});

test('preflightCheckRollback: entry-only 备份缺失关键 chunk 时阻断回滚并抛出详细错误', async () => {
  const logs = [];
  const target = { deployRoot: '/opt/yuyan/html/outsourced' };
  const simulatedOutput = [
    'kind=entry-only missing_count=2',
    '===MISSING_FILES===',
    'assets/chunk-core.12345678.js',
    'assets/style-theme.87654321.css',
  ].join('\n');
  const conn = createMockConn(simulatedOutput, 0);

  let caughtError = null;
  try {
    await preflightCheckRollback(
      conn,
      target,
      '/opt/yuyan/html/outsourced/.yuyan-backups/20261009150000',
      (lvl, msg) => logs.push({ lvl, msg }),
      false
    );
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, '必须阻断回滚并抛出错误');
  assert.match(caughtError.message, /回滚预检失败/);
  assert.match(caughtError.message, /共缺失 2 个文件/);
  assert.match(caughtError.message, /assets\/chunk-core\.12345678\.js/);
  assert.match(caughtError.message, /避免页面出现白屏故障/);
});

test('preflightCheckRollback: entry-only 备份清单文件丢失时拦截回滚', async () => {
  const logs = [];
  const target = { deployRoot: '/opt/yuyan/html/outsourced' };
  const simulatedOutput = 'kind=entry-only missing_count=-1 error=missing_manifest\n';
  const conn = createMockConn(simulatedOutput, 0);

  let caughtError = null;
  try {
    await preflightCheckRollback(
      conn,
      target,
      '/opt/yuyan/html/outsourced/.yuyan-backups/20261009150000',
      (lvl, msg) => logs.push({ lvl, msg }),
      false
    );
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError);
  assert.match(caughtError.message, /未找到依赖清单文件/);
});

test('真实 Shell 集成测试：模拟「部署 v1 → 部署 v2 备份 v1 → 回滚至 v1 → 删 chunk 拦截回滚」全生命周期', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-e2e-test-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    const manifestDir = path.join(deployRoot, '.yuyan-manifests');
    const backupRoot = path.join(deployRoot, '.yuyan-backups');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.mkdir(path.join(deployRoot, 'assets'), { recursive: true });

    // 1. 初始化部署 v1
    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>v1</html>', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-v1.js'), 'console.log("v1")', 'utf8');
    await fs.writeFile(path.join(manifestDir, '20261009100000.txt'), 'index.html\nassets/chunk-v1.js\n', 'utf8');
    await fs.writeFile(path.join(manifestDir, 'current.txt'), 'index.html\nassets/chunk-v1.js\n', 'utf8');

    // 2. 模拟部署 v2：触发对当前部署目录（v1）的备份
    const v1BackupPath = path.join(backupRoot, '20261009100100');
    await fs.mkdir(v1BackupPath, { recursive: true });
    const backupCmd = buildBackupDeployRootCommand({ deployRoot }, v1BackupPath, [], false, {
      isOverlayUpload: true,
      hashedDirs: ['assets'],
    });
    // 真实执行备份命令！
    await execAsync(backupCmd);

    // 验证备份目录产物：entry-only 模式
    const backupKind = (await fs.readFile(path.join(v1BackupPath, '.backup-kind'), 'utf8')).trim();
    assert.equal(backupKind, 'entry-only');
    const backupManifest = await fs.readFile(path.join(v1BackupPath, '.manifest.txt'), 'utf8');
    assert.match(backupManifest, /assets\/chunk-v1\.js/);
    const backupHtml = await fs.readFile(path.join(v1BackupPath, 'index.html'), 'utf8');
    assert.equal(backupHtml, '<html>v1</html>');
    // 关键断言：备份目录内绝不包含 assets/chunk-v1.js（体积保持数 KB）
    const backupAssetsExist = await fs.stat(path.join(v1BackupPath, 'assets')).catch(() => null);
    assert.equal(backupAssetsExist, null, 'entry-only 备份不得拷贝 assets 目录！');

    // 模拟 v2 产物覆盖写入部署根目录
    await fs.writeFile(path.join(deployRoot, 'index.html'), '<html>v2</html>', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-v2.js'), 'console.log("v2")', 'utf8');
    await fs.writeFile(path.join(manifestDir, '20261009100100.txt'), 'index.html\nassets/chunk-v2.js\n', 'utf8');
    await fs.writeFile(path.join(manifestDir, 'current.txt'), 'index.html\nassets/chunk-v2.js\n', 'utf8');

    // 3. 执行回滚前预检：检查 v1BackupPath
    const preflightCmd = buildPreflightCheckRollbackCommand({ deployRoot }, v1BackupPath, ['assets'], false);
    const preflightResult = await execAsync(preflightCmd);
    assert.match(preflightResult.stdout, /kind=entry-only missing_count=0/);

    // 执行真实回滚恢复命令！
    const restoreCmd = buildRestoreDeployRootCommand({ deployRoot }, v1BackupPath, [], false, {
      hashedDirs: ['assets'],
    });
    await execAsync(restoreCmd);

    // 验证部署根目录：
    // index.html 成功还原为 v1
    assert.equal(await fs.readFile(path.join(deployRoot, 'index.html'), 'utf8'), '<html>v1</html>');
    // assets 目录没有被误清空，v1 和 v2 的 chunk 依然完整保留
    assert.ok(await fs.stat(path.join(deployRoot, 'assets', 'chunk-v1.js')).catch(() => null));
    assert.ok(await fs.stat(path.join(deployRoot, 'assets', 'chunk-v2.js')).catch(() => null));
    // current.txt 指针成功恢复为 v1 的清单
    const currentManifest = await fs.readFile(path.join(manifestDir, 'current.txt'), 'utf8');
    assert.match(currentManifest, /assets\/chunk-v1\.js/);

    // 4. 模拟静态资源被误删/人为删掉一个 chunk
    await fs.rm(path.join(deployRoot, 'assets', 'chunk-v1.js'));

    // 再次执行预检命令！
    const failedPreflightResult = await execAsync(preflightCmd);
    assert.match(failedPreflightResult.stdout, /kind=entry-only missing_count=1/);
    assert.match(failedPreflightResult.stdout, /assets\/chunk-v1\.js/);

    // 验证：部署目录未受预检任何破坏
    assert.equal(await fs.readFile(path.join(deployRoot, 'index.html'), 'utf8'), '<html>v1</html>');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('真实 Shell 集成测试：按存活备份引用保护静态资源，彻底消除清单数量差一导致的 chunk 误删', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-retention-test-'));
  try {
    const deployRoot = path.join(tmpDir, 'html');
    const manifestDir = path.join(deployRoot, '.yuyan-manifests');
    const backupRoot = path.join(deployRoot, '.yuyan-backups');
    await fs.mkdir(deployRoot, { recursive: true });
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.mkdir(path.join(deployRoot, 'assets'), { recursive: true });

    // 创建 3 个版本的 chunk
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-old.js'), 'old', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-mid.js'), 'mid', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-new.js'), 'new', 'utf8');
    await fs.writeFile(path.join(deployRoot, 'assets', 'chunk-abandoned.js'), 'abandoned', 'utf8');

    // 写入 2 份清单：
    // 旧清单 20261009100100.txt 记录了 chunk-old.js 和 chunk-abandoned.js
    // 新清单 20261009100300.txt 记录了 chunk-new.js
    // 当 keepCount=1 时，旧清单被判定为过期清单
    await fs.writeFile(path.join(manifestDir, '20261009100100.txt'), 'index.html\nassets/chunk-old.js\nassets/chunk-abandoned.js\n', 'utf8');
    await fs.writeFile(path.join(manifestDir, '20261009100300.txt'), 'index.html\nassets/chunk-new.js\n', 'utf8');
    await fs.writeFile(path.join(manifestDir, 'current.txt'), 'index.html\nassets/chunk-new.js\n', 'utf8');

    // 以前的一份历史备份还存活在 .yuyan-backups/20261009100100 中，它依赖 chunk-old.js
    const oldBackupDir = path.join(backupRoot, '20261009100100');
    await fs.mkdir(oldBackupDir, { recursive: true });
    await fs.writeFile(path.join(oldBackupDir, '.backup-kind'), 'entry-only\n', 'utf8');
    await fs.writeFile(path.join(oldBackupDir, '.manifest.txt'), 'index.html\nassets/chunk-old.js\n', 'utf8');
    await fs.writeFile(path.join(oldBackupDir, 'index.html'), '<html>old</html>', 'utf8');

    // 运行真实的 pruneRemoteArtifactManifests 命令（keepCount=1）
    const pruneCmd = buildPruneRemoteArtifactManifestsCommand(deployRoot, 1, false);
    const pruneResult = await execAsync(pruneCmd);
    assert.equal(pruneResult.stderr, '');

    // 验证核心防线：
    // 1. chunk-new.js（被当前清单引用）存活
    assert.ok(await fs.stat(path.join(deployRoot, 'assets', 'chunk-new.js')).catch(() => null));
    // 2. chunk-old.js（虽然其原始发布清单已被删除，但备份依然存活在 .yuyan-backups 中）必须存活！
    assert.ok(await fs.stat(path.join(deployRoot, 'assets', 'chunk-old.js')).catch(() => null), '存活备份依赖的 chunk 绝不能被误删！');
    // 3. chunk-abandoned.js（既不被最新清单引用，也不在任何存活备份中）必须被清理掉
    assert.equal(await fs.stat(path.join(deployRoot, 'assets', 'chunk-abandoned.js')).catch(() => null), null, '无任何备份引用的孤儿 chunk 必须被清理');

    // 4. 对该存活备份执行预检，顺利通过并可回滚！
    const preflightCmd = buildPreflightCheckRollbackCommand({ deployRoot }, oldBackupDir, ['assets'], false);
    const preflightRes = await execAsync(preflightCmd);
    assert.match(preflightRes.stdout, /missing_count=0/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('真实 Shell 集成测试：统计脚本在目录不存在或无法获取大小时稳定输出 - 而非空值', async () => {
  const statsScript = [
    'root="$1"',
    'backup="$2"',
    'get_size() {',
    '  val=""',
    '  if command -v timeout >/dev/null 2>&1; then',
    '    val=$(timeout 5 du -sh "$1" 2>/dev/null | cut -f1) || true',
    '  else',
    '    val=$(du -sh "$1" 2>/dev/null | cut -f1) || true',
    '  fi',
    '  if [ -n "$val" ]; then echo "$val"; else echo "-"; fi',
    '}',
    'b_size=$(get_size "$backup")',
    'all_b_size=$(get_size "$root/.yuyan-backups")',
    'assets_size=$(get_size "$root/assets")',
    'echo "backup=$b_size all_backups=$all_b_size assets=$assets_size"',
  ].join('\n');

  // 对一个不存在的目录执行该统计脚本
  const { stdout } = await execAsync(`sh -c '${statsScript}' sh '/path/to/nonexistent-root' '/path/to/nonexistent-backup'`);
  assert.equal(stdout.trim(), 'backup=- all_backups=- assets=-');

  // 验证正则解析
  const bMatch = stdout.match(/backup=([^\s]+)/);
  const allMatch = stdout.match(/all_backups=([^\s]+)/);
  const assetsMatch = stdout.match(/assets=([^\s]+)/);
  assert.equal(bMatch[1], '-');
  assert.equal(allMatch[1], '-');
  assert.equal(assetsMatch[1], '-');
});

