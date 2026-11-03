import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { writeRemoteContent } from '../backend-runtime-service.mjs';

/**
 * 创建模拟 SSH 连接
 * @param {Function} onExec - 命令执行回调
 * @returns {Object} mock conn
 */
function createMockConn(onExec) {
  const executedCommands = [];
  const conn = {
    executedCommands,
    exec(command, callback) {
      executedCommands.push(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      process.nextTick(() => {
        try {
          const result = onExec(command);
          callback(null, stream);
          if (result.stdout) stream.emit('data', Buffer.from(result.stdout));
          if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr));
          stream.emit('close', result.code ?? 0);
        } catch (err) {
          callback(err);
        }
      });
    },
  };
  return conn;
}

test('writeRemoteContent: 目标写入失败时在 finally 中执行 rm -f 清理临时文件且不掩盖原始错误', async () => {
  let tempCreated = '';
  const conn = createMockConn((cmd) => {
    // 阶段 1：base64 准备临时文件
    if (cmd.includes('base64 -d >')) {
      const match = cmd.match(/> '(\/tmp\/yuyan-[^']+)'/);
      if (match) tempCreated = match[1];
      return { stdout: '', stderr: '', code: 0 };
    }
    // 阶段 2：mv 安装阶段模拟失败（例如磁盘满或权限拒绝）
    if (cmd.includes('mv ')) {
      return { stdout: '', stderr: 'mv: failed to access target: Permission denied', code: 1 };
    }
    // 阶段 3：finally 清理临时文件
    if (cmd.startsWith('rm -f ')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });

  await assert.rejects(
    async () => {
      await writeRemoteContent(conn, '/opt/yuyan/app.jar', 'dummy jar content', { sudo: false });
    },
    /Permission denied/
  );

  assert.ok(tempCreated, '应生成了临时文件路径');
  const rmCmd = conn.executedCommands.find((cmd) => cmd.includes(`rm -f '${tempCreated}'`));
  assert.ok(rmCmd, `在写入失败后，finally 中必须执行 rm -f '${tempCreated}'`);
});
