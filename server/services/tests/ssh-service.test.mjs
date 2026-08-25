import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { listRemoteApplicationDirectories, streamSshCommand } from '../ssh-service.mjs';

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
