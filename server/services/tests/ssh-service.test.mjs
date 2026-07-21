import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { streamSshCommand } from '../ssh-service.mjs';

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
