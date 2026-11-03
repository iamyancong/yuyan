import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPruneByCountCommand } from '../ssh-service.mjs';

test('buildPruneByCountCommand: 命令快照、keep 值、sudo 与安全转义', () => {
  // 1. 基本命令结构与默认 keep (10)
  const cmdDefault = buildPruneByCountCommand({
    dir: '/etc/nginx/conf.d',
    prefix: 'app.conf.bak.',
  });
  assert.match(cmdDefault, /^sh -c '.*' sh '\/etc\/nginx\/conf\.d' 'app\.conf\.bak\.' '10'$/);
  assert.doesNotMatch(cmdDefault, /^sudo/);

  // 2. 指定合法 keep 与非法 keep 回退
  const cmdKeep5 = buildPruneByCountCommand({
    dir: '/etc/nginx',
    prefix: 'test.bak.',
    keep: 5,
  });
  assert.ok(cmdKeep5.endsWith("'test.bak.' '5'"));

  const cmdInvalidKeep = buildPruneByCountCommand({
    dir: '/etc/nginx',
    prefix: 'test.bak.',
    keep: -3,
  });
  assert.ok(cmdInvalidKeep.endsWith("'test.bak.' '10'"));

  // 3. useSudo 时命令前缀为 sudo -n sh -c
  const cmdSudo = buildPruneByCountCommand({
    dir: '/etc/nginx',
    prefix: 'app.bak.',
    keep: 7,
    useSudo: true,
  });
  assert.match(cmdSudo, /^sudo -n sh -c '.*' sh '\/etc\/nginx' 'app\.bak\.' '7'$/);

  // 4. 特殊字符与单引号转义边界
  const cmdSpecial = buildPruneByCountCommand({
    dir: "/var/nginx/user's site/conf",
    prefix: "site's-*.bak.",
    keep: 10,
  });
  assert.ok(cmdSpecial.includes("'/var/nginx/user'\\''s site/conf'"));
  assert.ok(cmdSpecial.includes("'site'\\''s-*.bak.'"));
});

test('buildPruneByCountCommand: 真实 Shell 集成测试（新旧混合备份、干扰项、软链接与特殊字符）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-prune-test-'));

  try {
    // 1. 创建 25 个 a.conf.bak.<14位时间戳>（乱序时间戳与乱序创建）
    const timestamps = [];
    for (let i = 1; i <= 25; i++) {
      const pad = String(i).padStart(2, '0');
      timestamps.push(`202601010000${pad}`);
    }
    // 打乱创建顺序以证明依据文件名排序而非创建时间
    const shuffled = [...timestamps].reverse();
    for (const ts of shuffled) {
      fs.writeFileSync(path.join(tmpDir, `a.conf.bak.${ts}`), `backup content for ${ts}`);
    }

    // 2. 干扰文件
    fs.writeFileSync(path.join(tmpDir, 'a.conf'), 'origin main conf');
    fs.mkdirSync(path.join(tmpDir, 'a.conf.d'));
    fs.writeFileSync(path.join(tmpDir, 'a.conf.d', 'sub.conf'), 'sub conf');
    fs.writeFileSync(path.join(tmpDir, 'ab.conf'), 'another conf');
    fs.writeFileSync(path.join(tmpDir, 'ab.conf.bak.20200101000000'), 'ab old backup');
    fs.writeFileSync(path.join(tmpDir, 'xa.conf.bak.20200101000000'), 'xa old backup');

    // 软链接与目录干扰（同前缀但不是普通文件）
    fs.mkdirSync(path.join(tmpDir, 'a.conf.bak.20260101000099.dir'));
    fs.symlinkSync(path.join(tmpDir, 'a.conf.bak.20260101000025'), path.join(tmpDir, 'a.conf.bak.20260101000098.link'));

    // 带空格与星号等特殊字符的文件与干扰项
    fs.writeFileSync(path.join(tmpDir, 'my site*.conf'), 'site with space and asterisk');
    fs.mkdirSync(path.join(tmpDir, 'my site*.conf.d'));
    fs.writeFileSync(path.join(tmpDir, 'my site*.conf.bak.20260101000001'), 'special backup 1');
    fs.writeFileSync(path.join(tmpDir, 'my site*.conf.bak.20260101000002'), 'special backup 2');
    fs.writeFileSync(path.join(tmpDir, 'my site*.conf.bak.20260101000003'), 'special backup 3');

    // 3. 执行 a.conf 的清理命令，保留最近 10 份
    const pruneCmdA = buildPruneByCountCommand({
      dir: tmpDir,
      prefix: 'a.conf.bak.',
      keep: 10,
      useSudo: false,
    });
    execSync(pruneCmdA, { stdio: 'pipe' });

    // 断言 1：旧的 15 份（01 到 15）被删除，最新的 10 份（16 到 25）保留
    for (let i = 1; i <= 15; i++) {
      const pad = String(i).padStart(2, '0');
      assert.equal(fs.existsSync(path.join(tmpDir, `a.conf.bak.202601010000${pad}`)), false, `旧备份 0000${pad} 应被删除`);
    }
    for (let i = 16; i <= 25; i++) {
      const pad = String(i).padStart(2, '0');
      assert.equal(fs.existsSync(path.join(tmpDir, `a.conf.bak.202601010000${pad}`)), true, `新备份 0000${pad} 应被保留`);
    }

    // 断言 2：干扰项必须全部完好存在
    assert.equal(fs.existsSync(path.join(tmpDir, 'a.conf')), true, 'a.conf 原文件未受影响');
    assert.equal(fs.existsSync(path.join(tmpDir, 'a.conf.d')), true, 'a.conf.d 目录未受影响');
    assert.equal(fs.existsSync(path.join(tmpDir, 'ab.conf')), true, 'ab.conf 未受影响');
    assert.equal(fs.existsSync(path.join(tmpDir, 'ab.conf.bak.20200101000000')), true, 'ab.conf 备份未受影响');
    assert.equal(fs.existsSync(path.join(tmpDir, 'xa.conf.bak.20200101000000')), true, 'xa.conf 备份未受影响');
    assert.equal(fs.existsSync(path.join(tmpDir, 'a.conf.bak.20260101000099.dir')), true, '同名前缀目录未被删除');
    assert.equal(fs.existsSync(path.join(tmpDir, 'a.conf.bak.20260101000098.link')), true, '同名前缀软链接未被删除');

    // 4. 执行特殊字符 my site*.conf 的清理，保留最近 1 份
    const pruneCmdSpecial = buildPruneByCountCommand({
      dir: tmpDir,
      prefix: 'my site*.conf.bak.',
      keep: 1,
      useSudo: false,
    });
    execSync(pruneCmdSpecial, { stdio: 'pipe' });

    assert.equal(fs.existsSync(path.join(tmpDir, 'my site*.conf.bak.20260101000001')), false, '特殊字符备份 1 被删');
    assert.equal(fs.existsSync(path.join(tmpDir, 'my site*.conf.bak.20260101000002')), false, '特殊字符备份 2 被删');
    assert.equal(fs.existsSync(path.join(tmpDir, 'my site*.conf.bak.20260101000003')), true, '特殊字符备份 3 保留');
    assert.equal(fs.existsSync(path.join(tmpDir, 'my site*.conf')), true, '原文件 my site*.conf 未受影响');
    assert.equal(fs.existsSync(path.join(tmpDir, 'my site*.conf.d')), true, 'my site*.conf.d 目录未受影响');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
