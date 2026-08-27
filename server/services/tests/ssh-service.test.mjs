import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { execSsh, listRemoteApplicationDirectories, streamSshCommand } from '../ssh-service.mjs';

/**
 * 创建 exit 先于 stdout close 触发的 SSH 连接桩。
 * @returns {Object} SSH 连接桩
 */
const createExitBeforeCloseConn = () => ({
  exec(_command, callback) {
    const stream = new PassThrough();
    stream.stderr = new PassThrough();
    callback(null, stream);

    setTimeout(() => {
      stream.emit('exit', 0);
    }, 0);

    setTimeout(() => {
      stream.write('tail');
      stream.end();
      stream.stderr.end();
      stream.emit('close', 0);
    }, 30);
  },
});

test('流式 SSH 命令等待 close 后再结束，避免 exit 早到截断 stdout', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));

  let settled = false;
  const commandPromise = streamSshCommand(createExitBeforeCloseConn(), 'printf tail', output)
    .then((result) => {
      settled = true;
      return result;
    });

  await delay(10);
  assert.equal(settled, false);

  const result = await commandPromise;
  assert.equal(result.code, 0);
  assert.equal(Buffer.concat(chunks).toString(), 'tail');
});

/**
 * 创建不会自行退出的 SSH 命令连接桩。
 * @param {(stream: PassThrough) => void} setup - 流初始化逻辑
 * @returns {{conn: Object, isClosed: () => boolean}} 连接桩和关闭状态
 */
const createExecSshConn = (setup = () => {}) => {
  let closed = false;
  return {
    conn: {
      exec(_command, callback) {
        const stream = new PassThrough();
        stream.stderr = new PassThrough();
        stream.close = () => {
          closed = true;
          stream.destroy();
          stream.stderr.destroy();
        };
        callback(null, stream);
        setup(stream);
      },
    },
    isClosed: () => closed,
  };
};

test('普通 SSH 命令超时后拒绝并关闭远程 channel', async () => {
  const fixture = createExecSshConn();
  await assert.rejects(
    execSsh(fixture.conn, 'nginx -T', { timeoutMs: 10, label: '扫描配置' }),
    /扫描配置执行超时/,
  );
  assert.equal(fixture.isClosed(), true);
});

test('普通 SSH 命令输出超过上限后拒绝并关闭远程 channel', async () => {
  const fixture = createExecSshConn((stream) => stream.write('123456'));
  await assert.rejects(
    execSsh(fixture.conn, 'nginx -T', { maxOutputBytes: 5, label: '扫描配置' }),
    /扫描配置输出超过 5 字节限制/,
  );
  assert.equal(fixture.isClosed(), true);
});

/**
 * 创建 SFTP 目录扫描连接桩。
 * @returns {Object} SSH 连接桩
 */
const createDirectoryScanConn = () => {
  const directories = new Set(['css', 'js', 'img', 'fonts', 'assets', 'dmJurisdictionBuilder', 'outsourced', 'empty-app', '.yuyan-backups']);
  const files = new Set([
    '/opt/yuyan/html/index.html',
    '/opt/yuyan/html/assets/index.html',
    '/opt/yuyan/html/dmJurisdictionBuilder/index.html',
    '/opt/yuyan/html/outsourced/index.html',
  ]);
  return {
    sftp(callback) {
      callback(null, {
        readdir(_dirPath, done) {
          done(null, [
            ...Array.from(directories).map((filename) => ({ filename, attrs: { isDirectory: () => true } })),
            { filename: 'report.html', attrs: { isDirectory: () => false } },
          ]);
        },
        stat(filePath, done) {
          if (files.has(filePath)) {
            done(null, { isFile: () => true });
            return;
          }
          const error = new Error('not found');
          error.code = 2;
          done(error);
        },
      });
    },
  };
};

test('远程应用目录仅保留含 index.html 的直属业务目录', async () => {
  const result = await listRemoteApplicationDirectories(createDirectoryScanConn(), '/opt/yuyan/html');

  assert.equal(result.rootHasIndex, true);
  assert.deepEqual(result.directories, [
    { name: 'dmJurisdictionBuilder', path: '/opt/yuyan/html/dmJurisdictionBuilder' },
    { name: 'outsourced', path: '/opt/yuyan/html/outsourced' },
  ]);
  assert.equal(result.truncated, false);
});

test('远程应用目录达到上限时返回截断标识', async () => {
  const result = await listRemoteApplicationDirectories(createDirectoryScanConn(), '/opt/yuyan/html', { limit: 1 });

  assert.equal(result.directories.length, 1);
  assert.equal(result.truncated, true);
});
