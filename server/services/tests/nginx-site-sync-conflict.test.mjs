import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from 'ssh2';

// 必须在加载任何业务模块前，提前设置隔离的临时数据库环境，严禁写入项目本地库
const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-nginx-site-sync-'));
process.env.DEPLOY_DATA_DIR = testDataDir;
process.env.DEPLOY_DB_PATH = path.join(testDataDir, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'nginx-site-sync-test-secret';

const store = await import('../deploy-store.mjs');
const { syncTargetNginxSite } = await import('../nginx-runtime-service.mjs');

test('syncTargetNginxSite: force=true 未带 expectedSha256 时抛出 400 校验异常', async () => {
  await assert.rejects(
    async () => {
      await syncTargetNginxSite(9999, { force: true });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /expectedSha256/);
      return true;
    }
  );
});

test('syncTargetNginxSite: 存在性检查异常报错、读取失败不写、409 冲突拦截及并发哈希校验', async (t) => {
  t.after(() => fs.rm(testDataDir, { recursive: true, force: true }));

  const server = await store.createServer({
    name: '托管测试服务器',
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
    runtimeVersion: '1.0.0',
    packageVariant: 'linux-x64',
    initializedAt: new Date().toISOString(),
    status: 'running',
  });
  const target = await store.createTarget({
    projectSource: 'ops',
    projectId: 1,
    projectName: 'my-demo',
    projectPath: 'my-demo',
    repositoryUrl: 'git@example.com:demo.git',
    defaultBranch: 'main',
    envName: 'test',
    serverId: server.id,
    nginxInstanceId: managed.id,
    deployRoot: '/opt/yuyan/html/my-demo',
    nginxConfPath: '/opt/yuyan/nginx/conf/conf.d/my-demo.conf',
    nginxSiteManaged: true,
    listenPort: 8088,
    serverName: 'demo.local',
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
      end: () => {},
    });
  };

  /**
   * 模拟命令响应生成器
   */
  let execHandler = (_cmd) => ({ code: 0, stdout: '', stderr: '' });

  Client.prototype.exec = function (command, callback) {
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    callback(null, stream);

    process.nextTick(() => {
      const resp = execHandler(command);
      if (resp.stdout) stream.write(resp.stdout);
      if (resp.stderr) stream.stderr.write(resp.stderr);
      stream.end();
      stream.stderr.end();
      stream.emit('exit', resp.code ?? 0);
      stream.emit('close', resp.code ?? 0);
    });
  };

  // 1. 存在性检查命令返回码为异常值（如 exit code 2，目录权限不足或其它系统故障）时抛错，阻断执行
  execHandler = (cmd) => {
    if (cmd.includes('test -f')) return { code: 2, stderr: 'test: permission denied' };
    return { code: 0, stdout: '' };
  };
  await assert.rejects(
    async () => {
      await syncTargetNginxSite(target.id);
    },
    /检查配置文件是否存在失败（退出码 2）/
  );

  // 2. 文件存在但读取失败（cat 退出码为 1），直接抛错，绝不把空内容当作不存在覆盖
  execHandler = (cmd) => {
    if (cmd.includes('test -f')) return { code: 0 };
    if (cmd.includes('cat ')) return { code: 1, stderr: 'cat: /opt/yuyan/nginx/conf/conf.d/my-demo.conf: Input/output error' };
    return { code: 0 };
  };
  await assert.rejects(
    async () => {
      await syncTargetNginxSite(target.id);
    },
    (err) => {
      assert.match(err.message, /Input\/output error/);
      return true;
    }
  );

  // 3. 文件存在且被手工改动，未传 force 时返回 409 NGINX_SITE_CONFLICT
  const existingTamperedConf = `server {\n  listen 8088;\n  # 手工配置的业务代理\n  location /api { proxy_pass http://127.0.0.1:3000; }\n}\n`;
  execHandler = (cmd) => {
    if (cmd.includes('test -f')) return { code: 0 };
    if (cmd.includes('cat ')) return { code: 0, stdout: existingTamperedConf };
    return { code: 0 };
  };

  await assert.rejects(
    async () => {
      await syncTargetNginxSite(target.id);
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'NGINX_SITE_CONFLICT');
      assert.equal(err.details.path, '/opt/yuyan/nginx/conf/conf.d/my-demo.conf');
      assert.equal(err.details.currentContent, existingTamperedConf);
      assert.equal(typeof err.details.currentSha256, 'string');
      assert.equal(err.details.currentSha256.length, 64);
      assert.match(err.details.generatedContent, new RegExp(`# managed-by: yuyan target=${target.id}`));
      return true;
    }
  );

  // 4. force=true 但 expectedSha256 与当前实际不匹配（并发改动），返回 409 拦截
  await assert.rejects(
    async () => {
      await syncTargetNginxSite(target.id, {
        force: true,
        expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      });
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'NGINX_SITE_CONFLICT');
      assert.match(err.message, /已被修改/);
      assert.match(err.details.reason, /并发改动/);
      return true;
    }
  );
});
