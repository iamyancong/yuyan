import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicWrite,
  resolveAgentClientConfigBackupKeep,
} from '../agent-client-config-service.mjs';

test('resolveAgentClientConfigBackupKeep: 参数与环境变量优先级及默认值解析', () => {
  assert.equal(resolveAgentClientConfigBackupKeep(3), 3);
  assert.equal(resolveAgentClientConfigBackupKeep('8'), 8);
  assert.equal(resolveAgentClientConfigBackupKeep(-2), 5);
  assert.equal(resolveAgentClientConfigBackupKeep('invalid'), 5);
  assert.equal(resolveAgentClientConfigBackupKeep(), 5);

  process.env.AGENT_CLIENT_CONFIG_BACKUP_KEEP = '7';
  try {
    assert.equal(resolveAgentClientConfigBackupKeep(), 7);
    assert.equal(resolveAgentClientConfigBackupKeep(2), 2); // 显式参数优先
  } finally {
    delete process.env.AGENT_CLIENT_CONFIG_BACKUP_KEEP;
  }
});

test('atomicWrite: 连续写入8次保留最近5份、相同内容跳过且不改mtime、干扰文件不受影响', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-atomic-test-'));
  const targetFile = path.join(tmpDir, 'config.toml');

  try {
    // 1. 创建干扰文件
    const distDir = path.join(tmpDir, 'config.toml.d');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'nested.toml'), 'nested');

    const distBackup = path.join(tmpDir, 'xconfig.toml.yuyan-backup-2020-01-01T00-00-00-000Z');
    fs.writeFileSync(distBackup, 'other client backup');

    const distOther = path.join(tmpDir, 'config.toml.other');
    fs.writeFileSync(distOther, 'other file');

    // 2. 连续写入 8 次不同内容
    let prev = '';
    for (let i = 1; i <= 8; i++) {
      const content = `[setting]\nversion = ${i}\n`;
      const backupPath = await atomicWrite(targetFile, content, prev);
      if (i > 1) {
        assert.ok(backupPath, `第 ${i} 次写入应生成备份`);
        assert.ok(fs.existsSync(backupPath));
      }
      prev = content;
      // 微小间隔确保每份备份的时间戳唯一
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // 断言当前文件内容为最新第 8 次的内容
    assert.equal(fs.readFileSync(targetFile, 'utf8'), '[setting]\nversion = 8\n');

    // 检查备份文件列表
    const allEntries = fs.readdirSync(tmpDir);
    const backups = allEntries.filter((name) => name.startsWith('config.toml.yuyan-backup-'));
    assert.equal(backups.length, 5, '超过5份时应只保留最近5份备份');

    // 干扰项未被触碰
    assert.ok(fs.existsSync(distDir), 'config.toml.d 目录未受影响');
    assert.ok(fs.existsSync(distBackup), 'xconfig.toml.yuyan-backup-* 未受影响');
    assert.ok(fs.existsSync(distOther), 'config.toml.other 未受影响');

    // 3. 相同内容再次写入：不备份、不写入、mtime 不变
    const statBefore = fs.statSync(targetFile);
    // 等待 50ms 确保若有修改 mtime 会产生可见差异
    await new Promise((resolve) => setTimeout(resolve, 50));

    const skipResult = await atomicWrite(targetFile, prev, prev);
    assert.equal(skipResult, '', '相同内容写入应返回空字符串');

    const statAfter = fs.statSync(targetFile);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, '相同内容写入时文件 mtime 应保持不变');

    const backupsAfterSkip = fs.readdirSync(tmpDir).filter((name) => name.startsWith('config.toml.yuyan-backup-'));
    assert.equal(backupsAfterSkip.length, 5, '跳过写入时不应生成任何新备份');

    // 4. 通过环境变量调整保留份数
    process.env.AGENT_CLIENT_CONFIG_BACKUP_KEEP = '3';
    try {
      const v9 = '[setting]\nversion = 9\n';
      await atomicWrite(targetFile, v9, prev);
      const backupsKeep3 = fs.readdirSync(tmpDir).filter((name) => name.startsWith('config.toml.yuyan-backup-'));
      assert.equal(backupsKeep3.length, 3, '配置 AGENT_CLIENT_CONFIG_BACKUP_KEEP=3 后应裁剪为3份');
    } finally {
      delete process.env.AGENT_CLIENT_CONFIG_BACKUP_KEEP;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
