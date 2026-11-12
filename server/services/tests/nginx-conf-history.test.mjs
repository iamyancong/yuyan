import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSafeBackupName,
  buildListBackupsCommand,
  buildReadTextCommand,
  classifyBackupName,
  computeContentSha256,
  decodeReadTextOutput,
  isSudoUnavailable,
  listRemoteBackups,
  parseBackupTimestampUtc,
  parseListBackupsOutput,
  readRemoteBackup,
  readRemoteTextSafe,
  resolveBackupLocation,
} from '../nginx-conf-history.mjs';
import { buildPruneByCountCommand } from '../ssh-service.mjs';
import { performNginxConfigSave } from '../deploy-service.mjs';

/**
 * 在本机 sh 中真实执行命令的模拟 SSH 连接（sftp 写本地文件）。
 * @param {Object} [options] - 选项
 * @param {Object} [options.env] - 额外环境变量
 * @param {(command: string) => Object|null} [options.intercept] - 拦截命令并返回伪造结果
 * @returns {Object} mock conn
 */
function createLocalConn(options = {}) {
  const commands = [];
  return {
    commands,
    exec(command, callback) {
      commands.push(command);
      const fake = options.intercept?.(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      if (fake) {
        process.nextTick(() => {
          callback(null, stream);
          if (fake.stdout) stream.emit('data', Buffer.from(fake.stdout));
          if (fake.stderr) stream.stderr.emit('data', Buffer.from(fake.stderr));
          stream.emit('close', fake.code ?? 0);
        });
        return;
      }
      const child = spawn('sh', ['-c', command], { env: { ...process.env, ...(options.env || {}) } });
      callback(null, stream);
      child.stdout.on('data', (chunk) => stream.emit('data', chunk));
      child.stderr.on('data', (chunk) => stream.stderr.emit('data', chunk));
      child.on('close', (code) => stream.emit('close', code ?? 0));
    },
    sftp(callback) {
      process.nextTick(() => callback(null, {
        writeFile(filePath, content, encoding, done) {
          try {
            fs.writeFileSync(filePath, content, encoding);
            done(null);
          } catch (error) {
            done(error);
          }
        },
      }));
    },
  };
}

/** 运行本地命令并返回结果。 */
function runLocal(command, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 创建临时目录并在结束后清理。 */
function withTmpDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-nginx-history-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('parseBackupTimestampUtc: 按 UTC 解析 14 位时间戳，拒绝非法日期', () => {
  assert.equal(parseBackupTimestampUtc('20261112083005'), '2026-11-12T08:30:05.000Z');
  assert.equal(parseBackupTimestampUtc('20240229000000'), '2024-02-29T00:00:00.000Z');
  assert.equal(parseBackupTimestampUtc('20230229000000'), '');
  assert.equal(parseBackupTimestampUtc('20261312000000'), '');
  assert.equal(parseBackupTimestampUtc('20261112246000'), '');
  assert.equal(parseBackupTimestampUtc('2026111208300'), '');
  assert.equal(parseBackupTimestampUtc('2026111208300x'), '');
  assert.equal(parseBackupTimestampUtc(''), '');
});

test('classifyBackupName / assertSafeBackupName: 前缀、路径穿越、控制字符与外部命名', () => {
  assert.deepEqual(classifyBackupName('nginx.conf', 'nginx.conf.bak.20261112083005'), {
    name: 'nginx.conf.bak.20261112083005',
    suffix: '20261112083005',
    source: 'yuyan',
    createdAt: '2026-11-12T08:30:05.000Z',
  });
  assert.equal(classifyBackupName('nginx.conf', 'nginx.conf.bak.old')?.source, 'external');
  assert.equal(classifyBackupName('nginx.conf', 'nginx.conf.bak.before-upgrade')?.source, 'external');
  // 14 位数字但不是合法日期 → 视为外部
  assert.equal(classifyBackupName('nginx.conf', 'nginx.conf.bak.20261399000000')?.source, 'external');

  const invalid = [
    '../nginx.conf.bak.20261112083005',
    '/etc/passwd',
    'nginx.conf.bak.../../etc/passwd',
    'nginx.conf.bak.a/b',
    'nginx.conf.bak.a\\b',
    'nginx.conf.bak.',
    'nginx.conf.bak..hidden',
    'nginx.conf.bak.x..y',
    'nginx.conf.bak.20261112\n083005',
    'nginx.conf.bak.ok\u0000',
    'nginx.conf',
    'nginx.conf.bak',
    'other.conf.bak.20261112083005',
    'xnginx.conf.bak.20261112083005',
    'nginx.conf.bak.has space',
    `nginx.conf.bak.${'a'.repeat(300)}`,
    '',
  ];
  for (const name of invalid) {
    assert.equal(classifyBackupName('nginx.conf', name), null, `应拒绝 ${JSON.stringify(name)}`);
    assert.throws(() => assertSafeBackupName('nginx.conf', name), (error) => error.statusCode === 400 && error.code === 'NGINX_HISTORY_NAME_INVALID');
  }
});

test('resolveBackupLocation: 只接受服务端绝对路径', () => {
  assert.deepEqual(resolveBackupLocation('/home/nginx/conf/nginx.conf'), { dir: '/home/nginx/conf', base: 'nginx.conf', prefix: 'nginx.conf.bak.' });
  assert.deepEqual(resolveBackupLocation('/etc/nginx//conf.d/../nginx.conf'), { dir: '/etc/nginx', base: 'nginx.conf', prefix: 'nginx.conf.bak.' });
  assert.throws(() => resolveBackupLocation('conf/nginx.conf'), /路径无效/);
  assert.throws(() => resolveBackupLocation(''), /路径无效/);
  assert.throws(() => resolveBackupLocation('/'), /路径无效/);
});

test('parseListBackupsOutput: 平台备份按文件名 UTC 时间、外部备份按 mtime 倒序，过滤非法名', () => {
  const stdout = [
    '100\t1762900000.123\tnginx.conf.bak.20261110010101',
    '200\t1762936205.5\tnginx.conf.bak.20261112083005',
    '50\t1900000000\tnginx.conf.bak.old',
    '30\t1700000000\tnginx.conf.bak.bad name',
    '10\t1700000000\tother.conf.bak.20261112083005',
    'garbage line',
    '200\t1762936205.5\tnginx.conf.bak.20261112083005',
    '',
  ].join('\n');
  const { items, truncated } = parseListBackupsOutput(stdout, 'nginx.conf');
  assert.equal(truncated, false);
  assert.deepEqual(items.map((item) => item.name), [
    'nginx.conf.bak.old',
    'nginx.conf.bak.20261112083005',
    'nginx.conf.bak.20261110010101',
  ]);
  assert.equal(items[1].size, 200);
  assert.equal(items[1].createdAt, '2026-11-12T08:30:05.000Z');
  assert.equal(items[0].source, 'external');
  assert.equal(items[0].mtime, new Date(1900000000 * 1000).toISOString());

  const many = Array.from({ length: 5 }, (_, i) => `1\t1\tnginx.conf.bak.2026111208300${i}`).join('\n');
  const limited = parseListBackupsOutput(many, 'nginx.conf', 3);
  assert.equal(limited.items.length, 3);
  assert.equal(limited.truncated, true);
  assert.equal(limited.items[0].name, 'nginx.conf.bak.20261112083004');
});

test('buildListBackupsCommand: 真实 shell（GNU find）只列同目录、同前缀的普通文件', withTmpDir(async (dir) => {
  fs.writeFileSync(path.join(dir, 'nginx.conf'), 'current');
  fs.writeFileSync(path.join(dir, 'nginx.conf.bak.20261112083005'), 'v1-content');
  fs.writeFileSync(path.join(dir, 'nginx.conf.bak.old'), 'old');
  fs.writeFileSync(path.join(dir, 'ab.conf.bak.20261112083005'), 'x');
  fs.mkdirSync(path.join(dir, 'nginx.conf.bak.20261112083006'));
  fs.symlinkSync('/etc/passwd', path.join(dir, 'nginx.conf.bak.20261112083007'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'nginx.conf.bak.20261112083008'), 'nested');

  const result = await runLocal(buildListBackupsCommand({ dir, prefix: 'nginx.conf.bak.' }));
  assert.equal(result.code, 0, result.stderr);
  const { items } = parseListBackupsOutput(result.stdout, 'nginx.conf');
  assert.deepEqual(items.map((i) => i.name).sort(), ['nginx.conf.bak.20261112083005', 'nginx.conf.bak.old']);
  assert.equal(items.find((i) => i.name === 'nginx.conf.bak.20261112083005').size, 10);

  // 目录不存在时返回空
  const missing = await runLocal(buildListBackupsCommand({ dir: path.join(dir, 'nope'), prefix: 'nginx.conf.bak.' }));
  assert.equal(missing.code, 0);
  assert.equal(missing.stdout, '');
}));

test('buildListBackupsCommand: find 不支持 -printf（BusyBox）时回退逐文件 stat，结果一致', withTmpDir(async (dir) => {
  const work = path.join(dir, 'conf dir*');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'my*.conf'), 'current');
  fs.writeFileSync(path.join(work, 'my*.conf.bak.20261112083005'), 'abc');
  fs.writeFileSync(path.join(work, 'my*.conf.bak.20261112083006'), 'abcdef');
  fs.writeFileSync(path.join(work, 'myx.conf.bak.20261112083007'), 'glob 不能误匹配');
  fs.symlinkSync(path.join(work, 'my*.conf'), path.join(work, 'my*.conf.bak.20261112083009'));

  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'find'), '#!/bin/sh\necho "find: unrecognized: -printf" >&2\nexit 1\n', { mode: 0o755 });
  const result = await runLocal(buildListBackupsCommand({ dir: work, prefix: 'my*.conf.bak.' }), { PATH: `${fakeBin}:${process.env.PATH}` });
  assert.equal(result.code, 0, result.stderr);
  const { items } = parseListBackupsOutput(result.stdout, 'my*.conf');
  assert.deepEqual(items.map((i) => [i.name, i.size]), [
    ['my*.conf.bak.20261112083006', 6],
    ['my*.conf.bak.20261112083005', 3],
  ]);
  assert.ok(items[0].mtime, '回退路径也应拿到 mtime');
}));

test('buildReadTextCommand + decodeReadTextOutput: 真实 shell 读取、软链拒绝、超限、缺失、二进制、多字节 UTF-8', withTmpDir(async (dir) => {
  const text = `# 中文注释 ✓\n${'server { listen 80; }\n'.repeat(20)}`;
  const file = path.join(dir, 'nginx.conf.bak.20261112083005');
  fs.writeFileSync(file, text);
  const ok = await runLocal(buildReadTextCommand({ filePath: file, maxBytes: 4096, rejectSymlink: true }));
  assert.equal(ok.code, 0, ok.stderr);
  const decoded = decodeReadTextOutput(ok.stdout);
  assert.equal(decoded.content, text);
  assert.equal(decoded.size, Buffer.byteLength(text));
  assert.equal(decoded.encodingWarning, false);

  const link = path.join(dir, 'nginx.conf.bak.20261112083006');
  fs.symlinkSync(file, link);
  assert.equal((await runLocal(buildReadTextCommand({ filePath: link, maxBytes: 4096, rejectSymlink: true }))).code, 45);
  // 主配置允许是软链（例如 sites-enabled 风格）
  assert.equal((await runLocal(buildReadTextCommand({ filePath: link, maxBytes: 4096, rejectSymlink: false }))).code, 0);

  const tooLarge = await runLocal(buildReadTextCommand({ filePath: file, maxBytes: 16, rejectSymlink: true }));
  assert.equal(tooLarge.code, 48);
  assert.equal(Number(tooLarge.stderr.trim()), Buffer.byteLength(text));

  assert.equal((await runLocal(buildReadTextCommand({ filePath: path.join(dir, 'missing'), maxBytes: 16 }))).code, 44);
  assert.equal((await runLocal(buildReadTextCommand({ filePath: dir, maxBytes: 16 }))).code, 46);

  const bin = path.join(dir, 'bin.bak.1');
  fs.writeFileSync(bin, Buffer.from([0x73, 0x00, 0x01, 0x02]));
  const binOut = await runLocal(buildReadTextCommand({ filePath: bin, maxBytes: 4096 }));
  assert.throws(() => decodeReadTextOutput(binOut.stdout), (error) => error.statusCode === 415);

  const gbk = path.join(dir, 'gbk.conf');
  fs.writeFileSync(gbk, Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
  const gbkOut = decodeReadTextOutput((await runLocal(buildReadTextCommand({ filePath: gbk, maxBytes: 4096 }))).stdout);
  assert.equal(gbkOut.encodingWarning, true);

  // 带空格、引号与 $ 的路径不会被 shell 解释
  const weird = path.join(dir, "a b'$(touch pwned).conf");
  fs.writeFileSync(weird, 'safe');
  const weirdOut = await runLocal(buildReadTextCommand({ filePath: weird, maxBytes: 4096 }));
  assert.equal(decodeReadTextOutput(weirdOut.stdout).content, 'safe');
  assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false);

  assert.throws(() => decodeReadTextOutput('???'), /输出格式无法识别/);
  assert.equal(decodeReadTextOutput('RAW\n\ufeffhello').content, 'hello');
}));

test('isSudoUnavailable: 识别 sudo 需要密码 / 无授权 / 未安装', () => {
  assert.equal(isSudoUnavailable({ code: 1, stderr: 'sudo: a password is required' }), true);
  assert.equal(isSudoUnavailable({ code: 1, stderr: 'deploy is not in the sudoers file.' }), true);
  assert.equal(isSudoUnavailable({ code: 127, stderr: 'sh: sudo: not found' }), true);
  assert.equal(isSudoUnavailable({ code: 44, stderr: '' }), false);
  assert.equal(isSudoUnavailable({ code: 0, stderr: 'sudo: x' }), false);
});

test('readRemoteTextSafe: sudo 不可用时回退普通读取；缺失文件按 allowMissing 处理', withTmpDir(async (dir) => {
  const file = path.join(dir, 'nginx.conf');
  fs.writeFileSync(file, 'user nginx;\n');
  const conn = createLocalConn({
    intercept: (command) => (command.startsWith('sudo -n ') ? { code: 1, stderr: 'sudo: a password is required\n' } : null),
  });
  const result = await readRemoteTextSafe(conn, { filePath: file, useSudo: true });
  assert.equal(result.content, 'user nginx;\n');
  assert.equal(result.usedSudo, false);
  assert.equal(result.sha256, computeContentSha256('user nginx;\n'));
  assert.equal(conn.commands.length, 2);

  const missing = await readRemoteTextSafe(createLocalConn(), { filePath: path.join(dir, 'none.conf'), allowMissing: true });
  assert.equal(missing.exists, false);
  assert.equal(missing.content, '');
  await assert.rejects(() => readRemoteTextSafe(createLocalConn(), { filePath: path.join(dir, 'none.conf') }), (error) => error.statusCode === 404);

  // sudo 可用但真实失败（例如权限）不回退，直接报错
  const permConn = createLocalConn({ intercept: () => ({ code: 47, stderr: 'Permission denied' }) });
  await assert.rejects(() => readRemoteTextSafe(permConn, { filePath: file, useSudo: true }), (error) => error.statusCode === 403 && /Permission denied/.test(error.message));
  assert.equal(permConn.commands.length, 1);
}));

test('listRemoteBackups / readRemoteBackup: 端到端只读同目录备份，拒绝穿越与软链', withTmpDir(async (dir) => {
  const confPath = path.join(dir, 'nginx.conf');
  fs.writeFileSync(confPath, 'current');
  fs.writeFileSync(path.join(dir, 'nginx.conf.bak.20261112083005'), 'history-1');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'nginx.conf.bak.20261112083006'));
  const conn = createLocalConn();

  const list = await listRemoteBackups(conn, { confPath });
  assert.deepEqual(list.items.map((i) => i.name), ['nginx.conf.bak.20261112083005']);

  const item = await readRemoteBackup(conn, { confPath, name: 'nginx.conf.bak.20261112083005' });
  assert.equal(item.content, 'history-1');
  assert.equal(item.source, 'yuyan');
  assert.equal(item.sha256, computeContentSha256('history-1'));

  await assert.rejects(() => readRemoteBackup(conn, { confPath, name: 'nginx.conf.bak.20261112083006' }), (error) => error.code === 'NGINX_HISTORY_SYMLINK');
  const before = conn.commands.length;
  await assert.rejects(() => readRemoteBackup(conn, { confPath, name: '../secret.txt' }), (error) => error.statusCode === 400);
  await assert.rejects(() => readRemoteBackup(conn, { confPath, name: 'secret.txt' }), (error) => error.statusCode === 400);
  assert.equal(conn.commands.length, before, '非法文件名不应执行任何远程命令');
  await assert.rejects(() => readRemoteBackup(conn, { confPath, name: 'nginx.conf.bak.20261112083009' }), (error) => error.statusCode === 404);
}));

test('buildPruneByCountCommand timestampSuffixOnly: 只清理 .bak.<14 位数字>，外部命名备份不计数不删除', withTmpDir(async (dir) => {
  for (let i = 1; i <= 12; i += 1) {
    fs.writeFileSync(path.join(dir, `nginx.conf.bak.202611120000${String(i).padStart(2, '0')}`), String(i));
  }
  fs.writeFileSync(path.join(dir, 'nginx.conf.bak.old'), 'manual');
  fs.writeFileSync(path.join(dir, 'nginx.conf.bak.before-upgrade'), 'manual');
  fs.writeFileSync(path.join(dir, 'nginx.conf.bak.2026111200000'), '13 位');
  fs.writeFileSync(path.join(dir, 'nginx.conf.bak.202611120000011'), '15 位');
  const command = buildPruneByCountCommand({ dir, prefix: 'nginx.conf.bak.', keep: 10, timestampSuffixOnly: true });
  const result = await runLocal(command);
  assert.equal(result.code, 0, result.stderr);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.filter((n) => /\.bak\.\d{14}$/.test(n)).length, 10);
  assert.equal(left.includes('nginx.conf.bak.20261112000001'), false);
  assert.equal(left.includes('nginx.conf.bak.20261112000002'), false);
  assert.equal(left.includes('nginx.conf.bak.20261112000012'), true);
  for (const name of ['nginx.conf.bak.old', 'nginx.conf.bak.before-upgrade', 'nginx.conf.bak.2026111200000', 'nginx.conf.bak.202611120000011']) {
    assert.equal(left.includes(name), true, `${name} 不应被删除`);
  }
}));

/**
 * 构造一个用本地 shell 命令模拟 nginx -t / reload 的外部实例。
 * @param {string} confPath - 配置路径
 * @param {Object} [options] - 选项
 * @returns {{ server: Object, nginxInstance: Object }} 上下文
 */
function createSaveContext(confPath, { reloadCommand = 'true', testCommand } = {}) {
  return {
    server: { useSudo: false },
    nginxInstance: {
      instanceType: 'external',
      useSudo: false,
      // 内容含 BROKEN 视为语法错误
      nginxTestCommand: testCommand || `! grep -q BROKEN '${confPath}' || { echo "nginx: [emerg] unexpected end of file in ${confPath}:3" >&2; exit 1; }`,
      nginxReloadCommand: reloadCommand,
    },
  };
}

test('performNginxConfigSave: nginx -t 失败时还原并返回 stage=test / rolledBack=true', withTmpDir(async (dir) => {
  const confPath = path.join(dir, 'nginx.conf');
  fs.writeFileSync(confPath, 'good-v1\n');
  const ctx = createSaveContext(confPath);
  await assert.rejects(
    () => performNginxConfigSave(createLocalConn(), { ...ctx, confPath, payload: { content: 'BROKEN\n' } }),
    (error) => {
      assert.equal(error.code, 'NGINX_TEST_FAILED');
      assert.equal(error.details.stage, 'test');
      assert.equal(error.details.rolledBack, true);
      assert.match(error.message, /unexpected end of file/);
      assert.match(error.details.backupPath, /nginx\.conf\.bak\.\d{14}$/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(confPath, 'utf8'), 'good-v1\n');
}));

test('performNginxConfigSave: reload 失败时自动回滚、再次校验，返回 stage=reload', withTmpDir(async (dir) => {
  const confPath = path.join(dir, 'nginx.conf');
  fs.writeFileSync(confPath, 'good-v1\n');
  const ctx = createSaveContext(confPath, { reloadCommand: 'echo "nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)" >&2; exit 1' });
  const conn = createLocalConn();
  await assert.rejects(
    () => performNginxConfigSave(conn, { ...ctx, confPath, payload: { content: 'good-v2\n' } }),
    (error) => {
      assert.equal(error.code, 'NGINX_RELOAD_FAILED');
      assert.equal(error.details.stage, 'reload');
      assert.equal(error.details.rolledBack, true);
      assert.equal(error.details.restoreTestOk, true);
      assert.match(error.details.reason, /Address already in use/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(confPath, 'utf8'), 'good-v1\n');
  const testRuns = conn.commands.filter((c) => c.includes('grep -q BROKEN')).length;
  assert.equal(testRuns, 2, '保存校验一次 + 回滚后复检一次');
}));

test('performNginxConfigSave: 回滚本身失败时 rolledBack=false 并带备份路径', withTmpDir(async (dir) => {
  const confPath = path.join(dir, 'nginx.conf');
  fs.writeFileSync(confPath, 'good-v1\n');
  const ctx = createSaveContext(confPath, { reloadCommand: 'exit 1' });
  const conn = createLocalConn({
    intercept: (command) => (command.startsWith('cp ') && command.includes('.bak.') && command.indexOf('.bak.') < command.lastIndexOf(" '")
      ? { code: 1, stderr: 'cp: Read-only file system' }
      : null),
  });
  await assert.rejects(
    () => performNginxConfigSave(conn, { ...ctx, confPath, payload: { content: 'good-v2\n' } }),
    (error) => {
      assert.equal(error.details.stage, 'reload');
      assert.equal(error.details.rolledBack, false);
      assert.match(error.details.rollbackError, /Read-only/);
      assert.match(error.details.backupPath, /\.bak\.\d{14}$/);
      return true;
    }
  );
}));

test('performNginxConfigSave: 原文件不存在且校验失败时删除新文件', withTmpDir(async (dir) => {
  const confPath = path.join(dir, 'new.conf');
  const ctx = createSaveContext(confPath);
  await assert.rejects(
    () => performNginxConfigSave(createLocalConn(), { ...ctx, confPath, payload: { content: 'BROKEN' } }),
    (error) => error.details.stage === 'test' && error.details.rolledBack === true && error.details.backupPath === ''
  );
  assert.equal(fs.existsSync(confPath), false);
}));

test('performNginxConfigSave: expectedSha256 不一致返回 409 NGINX_CONF_CHANGED 且不写入；一致或未传时正常保存', withTmpDir(async (dir) => {
  const confPath = path.join(dir, 'nginx.conf');
  fs.writeFileSync(confPath, 'changed-by-someone\n');
  const ctx = createSaveContext(confPath);
  await assert.rejects(
    () => performNginxConfigSave(createLocalConn(), { ...ctx, confPath, payload: { content: 'mine\n', expectedSha256: computeContentSha256('opened-v1\n') } }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'NGINX_CONF_CHANGED');
      assert.equal(error.details.currentContent, 'changed-by-someone\n');
      assert.equal(error.details.currentSha256, computeContentSha256('changed-by-someone\n'));
      return true;
    }
  );
  assert.equal(fs.readFileSync(confPath, 'utf8'), 'changed-by-someone\n');
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.bak.')).length, 0, '冲突时不应生成备份');

  const ok = await performNginxConfigSave(createLocalConn(), {
    ...ctx,
    confPath,
    payload: { content: 'mine\n', expectedSha256: computeContentSha256('changed-by-someone\n').toUpperCase() },
  });
  assert.equal(ok.success, true);
  assert.equal(fs.readFileSync(confPath, 'utf8'), 'mine\n');

  const legacyConn = createLocalConn();
  const legacy = await performNginxConfigSave(legacyConn, { ...ctx, confPath, payload: { content: 'legacy\n' } });
  assert.equal(legacy.success, true);
  assert.equal(fs.readFileSync(confPath, 'utf8'), 'legacy\n');
  assert.equal(legacyConn.commands.some((c) => c.includes('base64')), false, '老客户端不传 expectedSha256 时不做额外读取');
}));
