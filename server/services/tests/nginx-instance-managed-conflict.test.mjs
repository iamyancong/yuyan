import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from 'ssh2';

// 必须在加载任何业务模块前，提前设置隔离的临时数据库环境，严禁写入项目本地库
const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-nginx-instance-managed-'));
process.env.DEPLOY_DATA_DIR = testDataDir;
process.env.DEPLOY_DB_PATH = path.join(testDataDir, 'deploy.sqlite');
process.env.DEPLOY_SECRET_KEY = 'nginx-instance-managed-test-secret';

const store = await import('../deploy-store.mjs');
const {
  initializeNginxInstanceRuntime,
  inspectMainNginxConfigManagedState,
  renderMainNginxConfig,
  renderMainNginxConfigBody,
  attachManagedInstanceHeader,
  parseManagedInstanceHeader,
  computeConfigBodySha256,
} = await import('../nginx-runtime-service.mjs');

test('inspectMainNginxConfigManagedState: 完整覆盖主配置归属标记与安全性判定', () => {
  const instance = { id: 101 };
  const config = { id: 101, portStart: 8080, webRoot: '/opt/yuyan/html' };
  const generatedBody = renderMainNginxConfigBody(config);
  const cleanHeaderConfig = attachManagedInstanceHeader(generatedBody, 101);

  // 1. 空内容或不存在
  assert.equal(inspectMainNginxConfigManagedState('', instance, generatedBody).status, 'not_found');
  assert.equal(inspectMainNginxConfigManagedState('   ', instance, generatedBody).canAutoOverwrite, true);

  // 2. 正常平台托管且哈希匹配
  const cleanInspection = inspectMainNginxConfigManagedState(cleanHeaderConfig, instance, generatedBody);
  assert.equal(cleanInspection.status, 'clean_managed');
  assert.equal(cleanInspection.canAutoOverwrite, true);

  // 3. 标记为当前实例，但正文被手工改动（哈希不匹配）
  const tamperedConfig = cleanHeaderConfig.replace('worker_processes  1;', 'worker_processes  4;');
  const driftedInspection = inspectMainNginxConfigManagedState(tamperedConfig, instance, generatedBody);
  assert.equal(driftedInspection.status, 'drifted_managed');
  assert.equal(driftedInspection.canAutoOverwrite, false);
  assert.match(driftedInspection.reason, /已被手工修改过/);

  // 4. 标记为其他实例
  const otherInstanceConfig = attachManagedInstanceHeader(generatedBody, 202);
  const otherInspection = inspectMainNginxConfigManagedState(otherInstanceConfig, instance, generatedBody);
  assert.equal(otherInspection.status, 'drifted_managed');
  assert.equal(otherInspection.canAutoOverwrite, false);
  assert.match(otherInspection.reason, /其他 Nginx 实例/);

  // 5. 无标记但内容与平台模板一致的历史配置
  const legacyMatch = inspectMainNginxConfigManagedState(generatedBody, instance, generatedBody);
  assert.equal(legacyMatch.status, 'legacy_clean_match');
  assert.equal(legacyMatch.canAutoOverwrite, true);

  // 6. 无标记且内容不一致的手工配置
  const externalConfig = 'events {}\nhttp { server { listen 80; } }\n';
  const externalInspection = inspectMainNginxConfigManagedState(externalConfig, instance, generatedBody);
  assert.equal(externalInspection.status, 'unmanaged_external');
  assert.equal(externalInspection.canAutoOverwrite, false);
  assert.match(externalInspection.reason, /手工维护或已有实例文件/);
});

test('updateNginxInstance: 阻止已有 external 实例直接更改为 managed（返回 400 INSTANCE_TYPE_IMMUTABLE）', async () => {
  const server = await store.createServer({
    name: '类型保护测试机',
    host: '127.0.0.1',
    port: 22,
    username: 'ops',
    authType: 'password',
    password: 'secret',
  });
  const external = await store.createNginxInstance(server.id, {
    name: '已有生产 Nginx',
    instanceType: 'external',
    defaultDeployRoot: '/srv/html',
    defaultNginxConfPath: '/etc/nginx/nginx.conf',
  });

  await assert.rejects(
    async () => {
      await store.updateNginxInstance(external.id, {
        instanceType: 'managed',
        baseRoot: '/opt/yuyan',
      });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'INSTANCE_TYPE_IMMUTABLE');
      assert.match(err.message, /不可直接变更为平台托管实例/);
      return true;
    }
  );
});

test('initializeNginxInstanceRuntime: 安全防线与冲突覆写校验', async (t) => {
  t.after(() => fs.rm(testDataDir, { recursive: true, force: true }));

  const server = await store.createServer({
    name: '初始化测试服务器',
    host: '127.0.0.1',
    port: 22,
    username: 'ops',
    authType: 'password',
    password: 'secret',
  });
  const external = await store.createNginxInstance(server.id, {
    name: '外部已有 Nginx',
    instanceType: 'external',
    defaultDeployRoot: '/srv/html',
    defaultNginxConfPath: '/etc/nginx/nginx.conf',
  });
  const managed = await store.createNginxInstance(server.id, {
    name: '托管 Nginx 实例',
    instanceType: 'managed',
    baseRoot: '/opt/yuyan',
    defaultDeployRoot: '/opt/yuyan/html',
    defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    sitesDir: '/opt/yuyan/nginx/conf/conf.d',
    portStart: 8080,
  });

  const executedCommands = [];
  let connectionCount = 0;

  const originalConnect = Client.prototype.connect;
  const originalExec = Client.prototype.exec;
  const originalSftp = Client.prototype.sftp;

  t.after(() => {
    Client.prototype.connect = originalConnect;
    Client.prototype.exec = originalExec;
    Client.prototype.sftp = originalSftp;
  });

  Client.prototype.connect = function () {
    connectionCount++;
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

  let execHandler = (_cmd) => ({ code: 0, stdout: '', stderr: '' });

  Client.prototype.exec = function (command, callback) {
    executedCommands.push(command);
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

  // 1. 对 external 实例调用初始化：直接返回 409 NGINX_INSTANCE_NOT_MANAGED，且远端没有任何 SSH 操作
  await assert.rejects(
    async () => {
      await initializeNginxInstanceRuntime(external.id, { baseRoot: '/opt/yuyan' });
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'NGINX_INSTANCE_NOT_MANAGED');
      assert.match(err.message, /只有托管 Nginx 实例支持初始化/);
      return true;
    }
  );
  assert.equal(connectionCount, 0, '对 external 实例调用初始化不应产生任何 SSH 连接');
  assert.equal(executedCommands.length, 0, '对 external 实例调用初始化不应执行任何远端命令');

  // 验证 external 实例的类型依然为 external，未被隐式篡改
  const checkedExternal = await store.getNginxInstance(external.id);
  assert.equal(checkedExternal.instanceType, 'external');

  // 2. force=true 时未提供 expectedSha256，返回 400 INVALID_ARGUMENT
  await assert.rejects(
    async () => {
      await initializeNginxInstanceRuntime(managed.id, { force: true });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /expectedSha256/);
      return true;
    }
  );

  // 3. 对 managed 实例重新初始化：远程主配置存在且被手工改动，未带 force 返回 409 NGINX_CONFIG_CONFLICT
  // 并且验证：预检冲突未确认时，传入的 safePayload 不会提前污染写入数据库！
  const existingTamperedMainConf = `worker_processes 8;\n# 生产手工定制的主配置\nevents {}\nhttp { include conf.d/*.conf; }\n`;
  execHandler = (cmd) => {
    if (cmd.includes('uname -s')) {
      return { code: 0, stdout: 'Linux\nx86_64\n' };
    }
    if (cmd.includes('ldd --version') || cmd.includes('getconf GNU_LIBC_VERSION')) {
      return { code: 0, stdout: 'ldd (GNU libc) 2.31\n' };
    }
    if (cmd.includes('test -f') && cmd.includes('conf/nginx.conf')) {
      return { code: 0 }; // 文件已存在
    }
    if (cmd.includes('cat ') && cmd.includes('conf/nginx.conf')) {
      return { code: 0, stdout: existingTamperedMainConf };
    }
    if (cmd.includes('echo nginx=1')) {
      return { code: 0, stdout: 'nginx=1\nscript=1\nconf=1\n' };
    }
    return { code: 0, stdout: '' };
  };

  await assert.rejects(
    async () => {
      // 传入新的 baseRoot，模拟用户在表单里修改了路径并点初始化，但触发冲突
      await initializeNginxInstanceRuntime(managed.id, { baseRoot: '/opt/yuyan-unpersisted' });
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'NGINX_CONFIG_CONFLICT');
      assert.equal(err.details.instanceId, managed.id);
      assert.equal(err.details.currentContent, existingTamperedMainConf);
      assert.equal(typeof err.details.currentSha256, 'string');
      assert.equal(err.details.currentSha256.length, 64);
      assert.match(err.details.generatedContent, new RegExp(`# managed-by: yuyan instance=${managed.id}`));
      return true;
    }
  );

  // 关键断言：预检 409 冲突取消时，数据库中的实例配置必须保持原样，不得被提前修改
  const managedAfterConflict = await store.getNginxInstance(managed.id);
  assert.equal(managedAfterConflict.baseRoot, '/opt/yuyan', '409 冲突时数据库中的 baseRoot 不应被提前修改');

  // 4. force=true 但 expectedSha256 与当前实际不匹配（并发修改），返回 409 拦截
  await assert.rejects(
    async () => {
      await initializeNginxInstanceRuntime(managed.id, {
        force: true,
        expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      });
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'NGINX_CONFIG_CONFLICT');
      assert.match(err.message, /已被修改/);
      assert.match(err.details.reason, /并发改动/);
      return true;
    }
  );

  // 5. force=true 且 expectedSha256 匹配时，成功完成接管覆盖与初始化，并且数据库配置完成更新
  const tamperedSha256 = computeConfigBodySha256(existingTamperedMainConf);
  const overwriteResult = await initializeNginxInstanceRuntime(managed.id, {
    baseRoot: '/opt/yuyan-persisted',
    force: true,
    expectedSha256: tamperedSha256,
  });
  assert.equal(overwriteResult.status, 'running');
  const managedAfterOverwrite = await store.getNginxInstance(managed.id);
  assert.equal(managedAfterOverwrite.baseRoot, '/opt/yuyan-persisted', '接管覆盖成功后数据库实例 baseRoot 应成功更新');

  // 6. 新建 managed 实例首次初始化（主配置文件不存在，test -f 返回 1），直接初始化不受影响
  const secondServer = await store.createServer({
    name: '全新初始化测试机',
    host: '127.0.0.2',
    port: 22,
    username: 'ops',
    authType: 'password',
    password: 'secret',
  });
  const newManaged = await store.createNginxInstance(secondServer.id, {
    name: '全新托管实例',
    instanceType: 'managed',
    baseRoot: '/opt/yuyan-new',
    defaultDeployRoot: '/opt/yuyan-new/html',
    defaultNginxConfPath: '/opt/yuyan-new/nginx/conf/nginx.conf',
    sitesDir: '/opt/yuyan-new/nginx/conf/conf.d',
    portStart: 8090,
  });

  execHandler = (cmd) => {
    if (cmd.includes('uname -s')) {
      return { code: 0, stdout: 'Linux\nx86_64\n' };
    }
    if (cmd.includes('ldd --version') || cmd.includes('getconf GNU_LIBC_VERSION')) {
      return { code: 0, stdout: 'ldd (GNU libc) 2.31\n' };
    }
    if (cmd.includes('test -f /opt/yuyan-new/nginx/conf/nginx.conf')) {
      return { code: 1, stderr: 'No such file' }; // 首次初始化，主配置不存在
    }
    if (cmd.includes('echo nginx=1')) {
      return { code: 0, stdout: 'nginx=1\nscript=1\nconf=1\n' };
    }
    return { code: 0, stdout: '' };
  };

  const newInitResult = await initializeNginxInstanceRuntime(newManaged.id);
  assert.equal(newInitResult.status, 'running');
});
