import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'ssh2';
import { __resetTestHooks, __setTestHooks } from '../test-hooks.mjs';

test('pid 自动修复与 upgrade 动作会写入审计钩子', async (t) => {
  process.env.YUYAN_ALLOW_TEST_HOOKS = '1';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-ngx-audit-'));
  process.env.DEPLOY_DATA_DIR = root;
  process.env.DEPLOY_DB_PATH = path.join(root, 'deploy.sqlite');
  process.env.DEPLOY_SECRET_KEY = 'nginx-audit-test-secret';

  const store = await import('../deploy-store.mjs');
  const runtime = await import('../nginx-runtime-service.mjs');

  t.after(async () => {
    __resetTestHooks();
    delete process.env.YUYAN_ALLOW_TEST_HOOKS;
    await store.closeDeployDb();
    await fs.rm(root, { recursive: true, force: true });
  });

  const server = await store.createServer({
    name: '审计测试机',
    host: '127.0.0.1',
    port: 22,
    username: 'ops',
    authType: 'password',
    password: 'secret',
    useSudo: false,
  });
  const managed = await store.createNginxInstance(server.id, {
    name: '托管审计',
    instanceType: 'managed',
    baseRoot: '/opt/yuyan',
    defaultDeployRoot: '/opt/yuyan/html',
    defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    sitesDir: '/opt/yuyan/nginx/conf/conf.d',
    scriptPath: '/opt/yuyan/nginx/yuyan-nginx.sh',
    useSudo: false,
  });
  // 标记已初始化所需字段
  await store.updateNginxInstanceState(managed.id, {
    status: 'running',
    runtimeVersion: 'nginx/1.24.0',
    initializedAt: new Date().toISOString(),
  });

  const audits = [];
  __setTestHooks({
    onNginxAudit: async (action, body) => {
      audits.push({ action, body });
    },
  });

  const originalConnect = Client.prototype.connect;
  const originalExec = Client.prototype.exec;
  const originalSftp = Client.prototype.sftp;
  t.after(() => {
    Client.prototype.connect = originalConnect;
    Client.prototype.exec = originalExec;
    Client.prototype.sftp = originalSftp;
  });
  Client.prototype.connect = function connect() {
    process.nextTick(() => this.emit('ready'));
    return this;
  };
  Client.prototype.sftp = function sftp(cb) {
    cb(null, { end() {} });
  };

  let mode = 'status-repair';
  Client.prototype.exec = function exec(command, callback) {
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    callback(null, stream);
    process.nextTick(() => {
      let code = 0;
      let stdout = '';
      let stderr = '';
      if (command.includes('uname')) {
        stdout = 'Linux\nx86_64\n';
      } else if (command.includes('echo nginx=')) {
        stdout = 'nginx=1\nscript=1\nconf=1\n';
      } else if (command.includes('test -f') && command.includes('yuyan-nginx.sh')) {
        code = 0;
      } else if (command.includes("sed -n '1,40p'") || command.includes('sed -n')) {
        stdout = '# yuyan-nginx-script-version: 2\n#!/usr/bin/env bash\n';
      } else if (command.includes('yuyan-nginx.sh') && command.includes('status')) {
        stdout =
          'pid_repaired: 1\npid_path: /opt/yuyan/nginx/run/nginx.pid\nrunning: 4242\nrunning_version: nginx/1.24.0\ndisk_version: nginx/1.24.0\nupgrade_pending: 0\n';
        code = 0;
      } else if (command.includes('yuyan-nginx.sh') && command.includes('upgrade')) {
        stdout = 'yuyan nginx upgraded\nrunning: 5252\nupgrade_pending: 0\n';
        code = 0;
      } else {
        stdout = '';
      }
      if (stdout) stream.write(stdout);
      if (stderr) stream.stderr.write(stderr);
      stream.end();
      stream.stderr.end();
      stream.emit('exit', code);
      stream.emit('close', code);
    });
  };

  const status = await runtime.getNginxInstanceStatus(managed.id);
  assert.equal(status.pidRepaired, true);
  assert.equal(status.running, true);
  assert.ok(
    audits.some((item) => item.action === 'nginx_pid_auto_repaired' && item.body.pid === 4242),
    'pid 修复应记审计'
  );

  audits.length = 0;
  const upgradeResult = await runtime.runNginxInstanceAction(managed.id, 'upgrade');
  assert.equal(upgradeResult.success, true);
  assert.ok(
    audits.some((item) => item.action === 'nginx_binary_hot_upgrade' && item.body.result === 'success'),
    'upgrade 应记审计'
  );
});
