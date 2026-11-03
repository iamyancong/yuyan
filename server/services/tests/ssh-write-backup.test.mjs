import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { resolveNginxConfigBackupKeep, writeRemoteTextWithBackup } from '../ssh-service.mjs';

/**
 * 创建模拟 SSH 连接
 * @param {Object} handlers - 命令应答处理函数
 * @returns {Object} mock conn
 */
function createMockConn(handlers = {}) {
  const executedCommands = [];
  let sftpWriteCalled = false;

  const conn = {
    executedCommands,
    getSftpWriteCalled: () => sftpWriteCalled,
    exec(command, callback) {
      executedCommands.push(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();

      process.nextTick(() => {
        try {
          const handler = handlers.onExec;
          const result = handler ? handler(command) : { stdout: '', stderr: '', code: 0 };
          if (result instanceof Error) {
            callback(result);
            return;
          }
          callback(null, stream);
          if (result.stdout) stream.emit('data', Buffer.from(result.stdout));
          if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr));
          stream.emit('close', result.code ?? 0);
        } catch (err) {
          callback(err);
        }
      });
    },
    sftp(callback) {
      process.nextTick(() => {
        callback(null, {
          writeFile(filePath, content, encoding, done) {
            sftpWriteCalled = true;
            if (handlers.onSftpWrite) {
              const err = handlers.onSftpWrite(filePath, content);
              if (err) return done(err);
            }
            done(null);
          },
        });
      });
    },
  };

  return conn;
}

test('resolveNginxConfigBackupKeep: 参数与环境变量优先级及默认值解析', () => {
  assert.equal(resolveNginxConfigBackupKeep(7), 7);
  assert.equal(resolveNginxConfigBackupKeep('15'), 15);
  assert.equal(resolveNginxConfigBackupKeep(-1), 10);
  assert.equal(resolveNginxConfigBackupKeep('invalid'), 10);
  assert.equal(resolveNginxConfigBackupKeep(), 10);

  process.env.NGINX_CONFIG_BACKUP_KEEP = '20';
  try {
    assert.equal(resolveNginxConfigBackupKeep(), 20);
    assert.equal(resolveNginxConfigBackupKeep(5), 5); // 显式参数优先
  } finally {
    delete process.env.NGINX_CONFIG_BACKUP_KEEP;
  }
});

test('writeRemoteTextWithBackup: 内容相同（含 CRLF vs LF）跳过且没有 cp/sftp 写入', async () => {
  const remoteContent = 'server {\r\n    listen 80;\r\n}\r\n';
  const newContent = 'server {\n    listen 80;\n}\n';

  const conn = createMockConn({
    onExec(cmd) {
      if (cmd.includes('exit 44')) {
        return { stdout: remoteContent, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  });

  const result = await writeRemoteTextWithBackup(conn, { useSudo: false }, '/etc/nginx/nginx.conf', newContent);

  assert.equal(result.skipped, true);
  assert.equal(result.backupPath, '');
  assert.equal(conn.getSftpWriteCalled(), false);
  // 只执行了探测命令，没有 cp 备份也没有 cp 写入
  assert.equal(conn.executedCommands.length, 1);
  assert.ok(conn.executedCommands[0].includes('exit 44'));
});

test('writeRemoteTextWithBackup: cp 写入失败时抛错且 finally 执行了 rm -f tmp', async () => {
  const conn = createMockConn({
    onExec(cmd) {
      if (cmd.includes('exit 44')) {
        return { stdout: 'old content', stderr: '', code: 0 };
      }
      if (cmd.includes('.bak.')) {
        return { stdout: '', stderr: '', code: 0 }; // 备份成功
      }
      if (cmd.startsWith('cp ') && cmd.includes('/tmp/yuyan-nginx-conf-')) {
        // cp 写入目标失败
        return { stdout: '', stderr: 'cp: cannot write: No space left on device', code: 1 };
      }
      if (cmd.startsWith('rm -f ')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  });

  await assert.rejects(
    async () => {
      await writeRemoteTextWithBackup(conn, { useSudo: false }, '/etc/nginx/nginx.conf', 'new content');
    },
    /写入.*执行失败/
  );

  // 断言 finally 中执行了 rm -f tmp
  const rmCmd = conn.executedCommands.find((cmd) => cmd.startsWith('rm -f ') && cmd.includes('/tmp/yuyan-nginx-conf-'));
  assert.ok(rmCmd, 'finally 里必须执行 rm -f 临时文件');
});

test('writeRemoteTextWithBackup: prune 失败时保存仍成功并返回 backupPath', async () => {
  const conn = createMockConn({
    onExec(cmd) {
      if (cmd.includes('exit 44')) {
        return { stdout: 'original content', stderr: '', code: 0 };
      }
      if (cmd.includes('.bak.')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (cmd.includes('sh -c') && !cmd.includes('exit 44')) {
        // prune 命令执行返回非 0
        return { stdout: '', stderr: 'prune failed unexpectedly', code: 2 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  });

  const result = await writeRemoteTextWithBackup(conn, { useSudo: false }, '/etc/nginx/nginx.conf', 'updated content');
  assert.equal(result.skipped, false);
  assert.match(result.backupPath, /\/etc\/nginx\/nginx\.conf\.bak\.\d{14}$/);
});

test('writeRemoteTextWithBackup: 探针返回 44（原文件不存在）时 backupPath 为空且不执行 bak cp', async () => {
  const conn = createMockConn({
    onExec(cmd) {
      if (cmd.includes('exit 44')) {
        // 文件不存在返回 44
        return { stdout: '', stderr: '', code: 44 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  });

  const result = await writeRemoteTextWithBackup(conn, { useSudo: false }, '/etc/nginx/nginx.conf', 'first content');
  assert.equal(result.skipped, false);
  assert.equal(result.backupPath, '');

  // 验证没有执行备份 cp（排除 prune 命令中的 prefix 参数）
  const hasBakCp = conn.executedCommands.some((cmd) => (cmd.startsWith('cp ') || cmd.startsWith('sudo -n cp ')) && cmd.includes('.bak.'));
  assert.equal(hasBakCp, false);
  // 但执行了目标写入 cp
  const hasWriteCp = conn.executedCommands.some((cmd) => cmd.startsWith('cp ') && cmd.includes('/tmp/yuyan-nginx-conf-'));
  assert.equal(hasWriteCp, true);
});

test('writeRemoteTextWithBackup: 探针返回其他非 0 退出码（文件存在但读不到）时仍尝试 cp 备份', async () => {
  const conn = createMockConn({
    onExec(cmd) {
      if (cmd.includes('exit 44')) {
        // 例如因权限或读取限制导致退出码为 1
        return { stdout: '', stderr: 'cat: /etc/nginx/nginx.conf: Permission denied', code: 1 };
      }
      if (cmd.includes('.bak.')) {
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  });

  const result = await writeRemoteTextWithBackup(conn, { useSudo: false }, '/etc/nginx/nginx.conf', 'updated content');
  assert.equal(result.skipped, false);
  assert.ok(result.backupPath, '读不到时仍应尝试 cp 备份并保留 backupPath');
  assert.match(result.backupPath, /\/etc\/nginx\/nginx\.conf\.bak\.\d{14}$/);

  // 验证执行了备份 cp
  const hasBakCp = conn.executedCommands.some((cmd) => (cmd.startsWith('cp ') || cmd.startsWith('sudo -n cp ')) && cmd.includes('.bak.'));
  assert.equal(hasBakCp, true);
});

test('writeRemoteTextWithBackup: useSudo 时命令带 sudo -n（tmp rm -f 不带 sudo）', async () => {
  const conn = createMockConn({
    onExec(cmd) {
      if (cmd.includes('exit 44')) {
        return { stdout: 'old', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
  });

  const result = await writeRemoteTextWithBackup(conn, { useSudo: true }, '/etc/nginx/nginx.conf', 'new');
  assert.equal(result.skipped, false);
  assert.ok(result.backupPath);

  // 1. 探针读取命令带 sudo -n
  const probeCmd = conn.executedCommands.find((cmd) => cmd.includes('exit 44'));
  assert.ok(probeCmd?.startsWith('sudo -n sh -c'));

  // 2. bak cp 带 sudo -n
  const bakCmd = conn.executedCommands.find((cmd) => cmd.includes('.bak.'));
  assert.ok(bakCmd?.startsWith('sudo -n cp'));

  // 3. 写入 cp 带 sudo -n
  const writeCmd = conn.executedCommands.find((cmd) => cmd.includes('/tmp/yuyan-nginx-conf-') && cmd.includes('cp '));
  assert.ok(writeCmd?.startsWith('sudo -n cp'));

  // 4. tmp 清理不带 sudo
  const rmCmd = conn.executedCommands.find((cmd) => cmd.startsWith('rm -f ') && cmd.includes('/tmp/yuyan-nginx-conf-'));
  assert.ok(rmCmd);
  assert.doesNotMatch(rmCmd, /^sudo/);

  // 5. prune 带 sudo -n
  const pruneCmd = conn.executedCommands.find((cmd) => cmd.includes('sh -c') && !cmd.includes('exit 44'));
  assert.ok(pruneCmd?.startsWith('sudo -n sh -c'));
});
