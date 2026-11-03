import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from 'ssh2';

// 隔离临时测试数据库
const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-storage-caller-test-'));
process.env.DEPLOY_DATA_DIR = testDataDir;
process.env.DEPLOY_DB_PATH = path.join(testDataDir, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'storage-caller-test-secret';

const store = await import('../deploy-store.mjs');
const {
  acquireNginxInstanceLock,
  attachManagedHeader,
  getNginxInstanceStatus,
  initializeNginxInstanceRuntime,
  refreshNginxInstanceScript,
  releaseNginxInstanceLock,
  renderSiteConfigBody,
  syncTargetNginxSite,
} = await import('../nginx-runtime-service.mjs');
const { saveNginxConfig } = await import('../deploy-service.mjs');

test('调用方测试 11a, 11b, 11c: skipped 失败不误回滚/不误删与初始化失败清理运行包', async (t) => {
  t.after(() => fs.rm(testDataDir, { recursive: true, force: true }));

  const server = await store.createServer({
    name: '调用方测试服务器',
    host: '127.0.0.1',
    port: 22,
    username: 'ops',
    authType: 'password',
    password: 'secret',
  });

  const managed = await store.createNginxInstance(server.id, {
    name: '托管 Nginx 实例',
    instanceType: 'managed',
    baseRoot: '/opt/yuyan',
    defaultDeployRoot: '/opt/yuyan/html',
    defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    sitesDir: '/opt/yuyan/nginx/conf/conf.d',
    runtimeVersion: '1.24.0',
    packageVariant: 'linux-x64',
    initializedAt: new Date().toISOString(),
    status: 'running',
  });

  const target = await store.createTarget({
    projectSource: 'ops',
    projectId: 1,
    projectName: 'caller-demo',
    projectPath: 'caller-demo',
    repositoryUrl: 'git@example.com:caller.git',
    defaultBranch: 'main',
    envName: 'test',
    serverId: server.id,
    nginxInstanceId: managed.id,
    deployRoot: '/opt/yuyan/html/caller-demo',
    nginxConfPath: '/opt/yuyan/nginx/conf/conf.d/caller-demo.conf',
    nginxSiteManaged: true,
    listenPort: 8099,
    serverName: 'caller.local',
  });

  const originalConnect = Client.prototype.connect;
  const originalExec = Client.prototype.exec;
  const originalSftp = Client.prototype.sftp;

  t.after(() => {
    Client.prototype.connect = originalConnect;
    Client.prototype.exec = originalExec;
    Client.prototype.sftp = originalSftp;
  });

  Client.prototype.connect = function () {
    process.nextTick(() => this.emit('ready'));
    return this;
  };

  Client.prototype.sftp = function (callback) {
    callback(null, {
      createWriteStream: () => new PassThrough(),
      fastPut: (_src, _dst, cb) => cb(null),
      writeFile: (_path, _data, _opt, cb) => (typeof _opt === 'function' ? _opt(null) : cb(null)),
      end: () => {},
    });
  };

  let executedCommands = [];
  let execHandler = (_cmd) => ({ code: 0, stdout: '', stderr: '' });

  Client.prototype.exec = function (command, callback) {
    executedCommands.push(command);
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    process.nextTick(() => {
      try {
        const result = execHandler(command);
        callback(null, stream);
        if (result.stdout) stream.write(result.stdout);
        if (result.stderr) stream.stderr.write(result.stderr);
        stream.end();
        stream.stderr.end();
        stream.emit('close', result.code ?? 0);
      } catch (err) {
        callback(err);
      }
    });
  };

  // ──────────────────────────────────────────────
  // 11a: syncTargetNginxSite: skipped 时 test 失败不执行 cp 回滚，不 rm -f，抛原错误
  // ──────────────────────────────────────────────
  const siteConfigContent = attachManagedHeader(renderSiteConfigBody(target), target.id);
  executedCommands = [];
  execHandler = (cmd) => {
    // 检查文件是否存在
    if (cmd.includes('test -f')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    // 读取文件内容：与平台生成的完全一致
    if (cmd.includes('cat ') || cmd.includes('exit 44')) {
      return { code: 0, stdout: siteConfigContent, stderr: '' };
    }
    // nginx -t 校验命令模拟失败
    if (cmd.includes('yuyan-nginx.sh') && cmd.includes('test')) {
      return { code: 1, stdout: '', stderr: 'nginx: [emerg] invalid directive in conf' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    async () => {
      await syncTargetNginxSite(target.id);
    },
    /nginx: \[emerg\] invalid directive/
  );

  // 断言：由于 skipped，未生成备份，失败时绝不执行 cp '' 回滚，也绝不能 rm -f 原配置文件
  const hasCpRestore = executedCommands.some((cmd) => cmd.includes('cp ') && cmd.includes('.bak.'));
  assert.equal(hasCpRestore, false, 'skipped 时失败绝不能执行 cp 恢复');
  const hasRmSite = executedCommands.some((cmd) => cmd.includes('rm -f ') && cmd.includes('caller-demo.conf'));
  assert.equal(hasRmSite, false, '原文件存在且 skipped 时失败绝不能 rm -f 站点配置');

  // ──────────────────────────────────────────────
  // 11b: saveNginxConfig: skipped 时 nginx -t 失败不执行 cp 回滚，抛原错误
  // ──────────────────────────────────────────────
  executedCommands = [];
  const testPayloadContent = 'server { listen 80; }';
  execHandler = (cmd) => {
    if (cmd.includes('exit 44')) {
      // 原内容与 payload 一致
      return { code: 0, stdout: testPayloadContent, stderr: '' };
    }
    if (cmd.includes('test') && (cmd.includes('nginx') || cmd.includes('yuyan-nginx.sh'))) {
      return { code: 1, stdout: '', stderr: 'nginx: configuration test failed' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    async () => {
      await saveNginxConfig(target.id, { content: testPayloadContent });
    },
    /configuration test failed/
  );

  const hasSaveCpRestore = executedCommands.some((cmd) => cmd.includes('cp ') && cmd.includes('.bak.'));
  assert.equal(hasSaveCpRestore, false, 'saveNginxConfig 在 skipped 时失败绝不能执行 cp 恢复');

  // ──────────────────────────────────────────────
  // 11c: initializeNginxInstanceRuntime: 解压失败时 finally 仍执行 rm -f 运行时包
  // ──────────────────────────────────────────────
  executedCommands = [];
  execHandler = (cmd) => {
    if (cmd.includes('uname')) {
      return { code: 0, stdout: 'Linux\nx86_64\n', stderr: '' };
    }
    if (cmd.includes('ldd --version') || cmd.includes('libc.so')) {
      return { code: 0, stdout: 'glibc 2.31', stderr: '' };
    }
    if (cmd.includes('test -f') && cmd.includes('libcrypt.so')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd.includes('test -f') && cmd.includes('nginx.conf')) {
      return { code: 1, stdout: '', stderr: '' }; // 主配置初次不存在
    }
    // 解压 tar 包阶段模拟失败
    if (cmd.includes('tar -xzf')) {
      return { code: 1, stdout: '', stderr: 'tar: archive is corrupted or disk full' };
    }
    if (cmd.startsWith('rm -f ')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    async () => {
      await initializeNginxInstanceRuntime(managed.id);
    },
    /tar: archive is corrupted/
  );

  // 断言：解压失败时，finally 中必须执行了 rm -f /tmp/yuyan-nginx-runtime-*.tar.gz
  const hasPkgCleanup = executedCommands.some(
    (cmd) => cmd.includes('rm -f ') && cmd.includes('/tmp/yuyan-nginx-runtime-')
  );
  assert.ok(hasPkgCleanup, '解压失败时 finally 必须执行清理运行时安装包');

  // ──────────────────────────────────────────────
  // 新增测试：refreshNginxInstanceScript 核心行为验证
  // ──────────────────────────────────────────────
  // 1. 非托管实例拒绝更新，返回 409 NGINX_INSTANCE_NOT_MANAGED
  const externalInstance = await store.createNginxInstance(server.id, {
    name: '外部接入 Nginx',
    instanceType: 'external',
    baseRoot: '',
    defaultDeployRoot: '/data/webapps',
    defaultNginxConfPath: '/etc/nginx/conf.d/{appName}.conf',
  });

  await assert.rejects(
    async () => {
      await refreshNginxInstanceScript(externalInstance.id);
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'NGINX_INSTANCE_NOT_MANAGED');
      return true;
    }
  );

  // 2. 托管实例但尚未初始化（test -d installRoot 或 test -x nginxPath 失败）时拒绝并提示
  executedCommands = [];
  execHandler = (cmd) => {
    if (cmd.includes('test -d') && cmd.includes('test -x')) {
      return { code: 1, stdout: '', stderr: 'No such file or directory' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    async () => {
      await refreshNginxInstanceScript(managed.id);
    },
    /实例尚未初始化，请先初始化/
  );

  // 3. 正常已初始化的托管实例执行 refreshNginxInstanceScript
  executedCommands = [];
  execHandler = (cmd) => {
    // 检查是否已初始化：通过
    if (cmd.includes('test -d') && cmd.includes('test -x')) {
      return { code: 0, stdout: '', stderr: '' };
    }
    // 写入探测与比较（模拟原文件存在且内容略有不同）
    if (cmd.includes('exit 44')) {
      return { code: 0, stdout: '# old script content', stderr: '' };
    }
    // crontab 安装命令
    if (cmd.includes('crontab')) {
      return { code: 0, stdout: 'yuyan-cron:installed\n', stderr: '' };
    }
    if (cmd.includes('uname')) {
      return { code: 0, stdout: 'Linux\nx86_64\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const refreshResult = await refreshNginxInstanceScript(managed.id);
  assert.ok(refreshResult);
  assert.equal(typeof refreshResult.script.skipped, 'boolean');
  assert.equal(refreshResult.cron.status, 'installed');
  assert.ok(refreshResult.status, '必须返回最新 status');

  // 关键安全断言：严禁执行任何 start/stop/reload/restart，严禁写主配置 nginx.conf，严禁写站点配置
  const hasStartCmd = executedCommands.some((cmd) => /\bstart\b/.test(cmd) && cmd.includes('yuyan-nginx.sh'));
  const hasStopCmd = executedCommands.some((cmd) => /\bstop\b/.test(cmd) && cmd.includes('yuyan-nginx.sh'));
  const hasReloadCmd = executedCommands.some((cmd) => (/\breload\b/.test(cmd) || /-s (reload|reopen)/.test(cmd)) && cmd.includes('yuyan-nginx.sh'));
  const hasMainConfWrite = executedCommands.some((cmd) => cmd.includes('nginx.conf') && (cmd.includes('cp ') || cmd.includes('.tmp')));
  const hasSiteConfWrite = executedCommands.some((cmd) => cmd.includes('caller-demo.conf') && (cmd.includes('cp ') || cmd.includes('.tmp')));

  assert.equal(hasStartCmd, false, 'refreshNginxInstanceScript 严禁启动 Nginx');
  assert.equal(hasStopCmd, false, 'refreshNginxInstanceScript 严禁停止 Nginx');
  assert.equal(hasReloadCmd, false, 'refreshNginxInstanceScript 严禁重载 Nginx');
  assert.equal(hasMainConfWrite, false, 'refreshNginxInstanceScript 严禁改写主配置文件');
  assert.equal(hasSiteConfWrite, false, 'refreshNginxInstanceScript 严禁改写站点配置文件');

  // 必须执行了管理脚本权限设置与 crontab 安装
  const hasChmodScript = executedCommands.some((cmd) => cmd.includes('chmod +x') && cmd.includes('yuyan-nginx.sh'));
  assert.ok(hasChmodScript, '必须设置管理脚本执行权限');

  // 3b. 测试 useSudo 继承：server.useSudo=true、instance.useSudo=false 时，cron 安装命令必须带 sudo -n crontab
  const sudoServer = await store.createServer({
    name: 'Sudo 服务器',
    host: '127.0.0.2',
    port: 22,
    username: 'ops_sudo',
    authType: 'password',
    password: 'secret',
    useSudo: true,
  });
  const sudoManaged = await store.createNginxInstance(sudoServer.id, {
    name: '托管实例(无 sudo 字段)',
    instanceType: 'managed',
    baseRoot: '/opt/yuyan',
    defaultDeployRoot: '/opt/yuyan/html',
    defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    useSudo: false,
    initializedAt: new Date().toISOString(),
    status: 'running',
  });

  executedCommands = [];
  await refreshNginxInstanceScript(sudoManaged.id);
  const cronCmdWithSudo = executedCommands.find((cmd) => cmd.includes('crontab'));
  assert.ok(cronCmdWithSudo, '应执行 crontab 安装命令');
  assert.ok(cronCmdWithSudo.includes('sudo -n crontab'), 'server.useSudo=true 时 cron 命令应带 sudo -n crontab');

  // ──────────────────────────────────────────────
  // 新增测试：按 instanceId 的进程内互斥锁
  // ──────────────────────────────────────────────
  // a. 同一 instanceId 并发两次，第二次立即抛 409 NGINX_INSTANCE_BUSY
  acquireNginxInstanceLock(managed.id, '正在测试操作');
  try {
    assert.throws(
      () => {
        acquireNginxInstanceLock(managed.id, '第二次并发操作');
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, 'NGINX_INSTANCE_BUSY');
        assert.ok(err.message.includes('正在执行其他操作（正在测试操作）'));
        return true;
      }
    );

    // b. 不同 instanceId 不互斥
    acquireNginxInstanceLock(externalInstance.id, '外部操作');
    releaseNginxInstanceLock(externalInstance.id);
  } finally {
    // c. 第一次结束后释放锁，可以再次获取
    releaseNginxInstanceLock(managed.id);
  }

  // 再次获取应成功
  acquireNginxInstanceLock(managed.id, '后续正常操作');
  releaseNginxInstanceLock(managed.id);

  // d. getNginxInstanceStatus 不受互斥锁影响
  acquireNginxInstanceLock(managed.id, '占用锁中');
  try {
    const statusWhileLocked = await getNginxInstanceStatus(managed.id);
    assert.ok(statusWhileLocked, 'status 查询不能受互斥锁影响');
  } finally {
    releaseNginxInstanceLock(managed.id);
  }
});
