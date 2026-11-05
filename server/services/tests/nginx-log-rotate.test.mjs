import assert from 'node:assert/strict';
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLogRotateCronInstallCommand,
  parseLogRotateCronResult,
  renderRuntimeScript,
  resolveNginxLogKeepDays,
} from '../nginx-runtime-service.mjs';

function startFakeMaster(baseDir) {
  const label = `nginx: master process ${baseDir}/sbin/nginx -p ${baseDir}/`;
  const child = spawn('bash', ['-c', `exec -a ${JSON.stringify(label)} sleep 600`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

test('resolveNginxLogKeepDays: 显式参数 > 环境变量 > 默认值 14', () => {
  assert.equal(resolveNginxLogKeepDays(7), 7);
  assert.equal(resolveNginxLogKeepDays('30'), 30);
  assert.equal(resolveNginxLogKeepDays(-1), 14);
  assert.equal(resolveNginxLogKeepDays('invalid'), 14);
  assert.equal(resolveNginxLogKeepDays(), 14);

  process.env.NGINX_LOG_KEEP_DAYS = '21';
  try {
    assert.equal(resolveNginxLogKeepDays(), 21);
    assert.equal(resolveNginxLogKeepDays(3), 3); // 显式参数优先
  } finally {
    delete process.env.NGINX_LOG_KEEP_DAYS;
  }
});

test('yuyan-nginx.sh: rotate-logs 轮转、gzip 压缩、reopen 信号、过期清理与未运行安全退出', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-logrotate-test-'));

  try {
    const sbinDir = path.join(baseDir, 'sbin');
    const confDir = path.join(baseDir, 'conf');
    const runDir = path.join(baseDir, 'run');
    const logsDir = path.join(baseDir, 'logs');
    fs.mkdirSync(sbinDir);
    fs.mkdirSync(confDir);
    fs.mkdirSync(runDir);
    fs.mkdirSync(logsDir);

    // 1. 假 nginx 可执行程序（记录命令行参数）
    const nginxArgsLog = path.join(baseDir, 'nginx-args.log');
    const fakeNginx = path.join(sbinDir, 'nginx');
    fs.writeFileSync(
      fakeNginx,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${nginxArgsLog}'\nexit 0\n`,
      { mode: 0o755 }
    );

    // 2. 配置文件与存活的 PID
    fs.writeFileSync(path.join(confDir, 'nginx.conf'), 'pid run/nginx.pid;\n');
    const pidFile = path.join(runDir, 'nginx.pid');
    const fakePid = startFakeMaster(baseDir);
    fs.writeFileSync(pidFile, String(fakePid));
    t.after(() => { try { process.kill(fakePid); } catch {} });

    // 3. 日志文件：非空 access.log、空 error.log、20 天前和 3 天前的历史轮转日志
    const accessLog = path.join(logsDir, 'access.log');
    const errorLog = path.join(logsDir, 'error.log');
    fs.writeFileSync(accessLog, '127.0.0.1 - - [01/Jan/2026] "GET / HTTP/1.1" 200 1234');
    fs.writeFileSync(errorLog, '');

    const oldLog20 = path.join(logsDir, 'access.log.20200101000000.gz');
    fs.writeFileSync(oldLog20, 'old 20 days log content');
    const past20Days = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    fs.utimesSync(oldLog20, past20Days, past20Days);

    const oldLog3 = path.join(logsDir, 'access.log.20260101000000.gz');
    fs.writeFileSync(oldLog3, 'old 3 days log content');
    const past3Days = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    fs.utimesSync(oldLog3, past3Days, past3Days);

    // 4. 写入管理脚本
    const scriptPath = path.join(baseDir, 'yuyan-nginx.sh');
    fs.writeFileSync(scriptPath, renderRuntimeScript(), { mode: 0o755 });

    // 5. 执行 rotate-logs 14（nginx 在运行）
    execFileSync('bash', [scriptPath, 'rotate-logs', '14'], { stdio: 'pipe' });

    // 断言：
    // a. access.log 被重命名并压缩为 .gz
    assert.equal(fs.existsSync(accessLog), false, '原 access.log 应被轮转走');
    const newRotatedGzFiles = fs.readdirSync(logsDir).filter((name) => /^access\.log\.\d{14}(\.\d+)?\.gz$/.test(name) && name !== 'access.log.20260101000000.gz');
    assert.equal(newRotatedGzFiles.length, 1, '应生成一份新的 access.log.<timestamp>.gz 压缩轮转文件');

    // b. 0 字节的 error.log 保持原样不被轮转
    assert.equal(fs.existsSync(errorLog), true, '空 error.log 应保留在原地');
    assert.equal(fs.readFileSync(errorLog, 'utf8'), '');

    // c. 假 nginx 接收到 reopen 命令
    const argsContent = fs.readFileSync(nginxArgsLog, 'utf8');
    assert.match(argsContent, /-s reopen/);

    // d. 20 天前的轮转文件被删除，3 天前的保留
    assert.equal(fs.existsSync(oldLog20), false, '20 天前的轮转文件应被删除');
    assert.equal(fs.existsSync(oldLog3), true, '3 天前的轮转文件应保留');

    // 6. 测试 Nginx 未运行（无进程且无 pid）时的行为：退出码 0 且不调用 reopen
    fs.rmSync(pidFile, { force: true });
    try { process.kill(fakePid); } catch {}
    // 等进程退出，避免 cmdline 扫描仍命中
    for (let i = 0; i < 20; i += 1) {
      try { process.kill(fakePid, 0); } catch { break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    fs.writeFileSync(nginxArgsLog, '');
    fs.writeFileSync(accessLog, 'new content while nginx stopped');

    execFileSync('bash', [scriptPath, 'rotate-logs', '14'], { stdio: 'pipe' });

    assert.equal(fs.existsSync(accessLog), false, '未运行时日志也被轮转');
    const nginxStoppedArgs = fs.readFileSync(nginxArgsLog, 'utf8');
    assert.doesNotMatch(nginxStoppedArgs, /-s reopen/, '未运行时不应调用 -s reopen');

    // 7. 测试 -s reopen 失败时的行为：退出码 1，输出错误，且没有生成 .gz
    const fakePid2 = startFakeMaster(baseDir);
    fs.writeFileSync(pidFile, String(fakePid2));
    t.after(() => { try { process.kill(fakePid2); } catch {} });
    fs.writeFileSync(accessLog, 'content before reopen fails');
    // 清理已有的 .gz 文件
    for (const f of fs.readdirSync(logsDir)) {
      if (f.endsWith('.gz')) fs.rmSync(path.join(logsDir, f));
    }
    fs.writeFileSync(
      fakeNginx,
      '#!/bin/sh\ncase "$*" in *-s\\ reopen*) echo "reopen failed" >&2; exit 1;; esac\nexit 0\n',
      { mode: 0o755 }
    );
    const reopenFailRes = spawnSync('bash', [scriptPath, 'rotate-logs', '14'], { encoding: 'utf8' });
    assert.equal(reopenFailRes.status, 1, 'reopen 失败应以非 0 退出');
    assert.ok(reopenFailRes.stderr.includes('reopen 信号发送失败'));
    const gzFilesAfterReopenFail = fs.readdirSync(logsDir).filter((name) => name.endsWith('.gz'));
    assert.equal(gzFilesAfterReopenFail.length, 0, 'reopen 失败时绝不能 gzip 刚 mv 出来的日志');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('buildLogRotateCronInstallCommand: 命令快照覆盖 useSudo、% 符号转义及真 shell 幂等与错误防护', () => {
  // 1. 命令快照与 sudo 分流
  const configNoSudo = { scriptPath: '/opt/yuyan/nginx/yuyan-nginx.sh', useSudo: false };
  const resultNoSudo = buildLogRotateCronInstallCommand(configNoSudo, 14);
  assert.match(resultNoSudo.cronLine, /^\d+ 3 \* \* \* '\/opt\/yuyan\/nginx\/yuyan-nginx\.sh' rotate-logs 14 >\/dev\/null 2>&1 # yuyan-nginx-rotate-logs:[a-f0-9]{12}$/);
  assert.ok(resultNoSudo.command.includes('crontab -l'));
  assert.ok(resultNoSudo.command.includes('crontab -'));
  assert.doesNotMatch(resultNoSudo.command, /sudo -n crontab/);

  const configSudo = { scriptPath: '/opt/yuyan/nginx/yuyan-nginx.sh', useSudo: true };
  const resultSudo = buildLogRotateCronInstallCommand(configSudo, 7);
  assert.ok(resultSudo.cronLine.includes('rotate-logs 7'));
  assert.ok(resultSudo.command.includes('sudo -n crontab -l'));
  assert.ok(resultSudo.command.includes('sudo -n crontab -'));

  // 2. scriptPath 包含 % 时转义为 \%
  const configWithPercent = { scriptPath: '/opt/yuyan%20app/nginx.sh', useSudo: false };
  const resultWithPercent = buildLogRotateCronInstallCommand(configWithPercent);
  assert.ok(resultWithPercent.cronLine.includes('/opt/yuyan\\%20app/nginx.sh'));

  // 3. 真 shell 幂等性、用户空行保留与错误防御测试
  const tmpEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-cron-test-'));

  try {
    const binDir = path.join(tmpEnvDir, 'bin');
    fs.mkdirSync(binDir);
    const storeFile = path.join(tmpEnvDir, 'fake-crontab.txt');
    const callsLog = path.join(tmpEnvDir, 'calls.log');

    // 假 crontab 脚本
    const fakeCrontab = path.join(binDir, 'crontab');
    fs.writeFileSync(
      fakeCrontab,
      [
        '#!/bin/sh',
        `STORE='${storeFile}'`,
        `CALLS='${callsLog}'`,
        'printf "%s\\n" "$*" >> "$CALLS"',
        'if [ "$1" = "-l" ]; then',
        '  if [ -n "$FAKE_CRON_ERROR" ]; then',
        '    printf "%s\\n" "$FAKE_CRON_ERROR" >&2',
        '    exit 1',
        '  fi',
        '  if [ -f "$STORE" ]; then',
        '    cat "$STORE"',
        '    exit 0',
        '  else',
        '    echo "no crontab for user" >&2',
        '    exit 1',
        '  fi',
        'elif [ "$1" = "-" ]; then',
        '  if [ -n "$FAKE_CRON_WRITE_FAIL" ]; then',
        '    echo "write failed" >&2',
        '    exit 1',
        '  fi',
        '  cat > "$STORE"',
        '  exit 0',
        'else',
        '  exit 1',
        'fi',
      ].join('\n'),
      { mode: 0o755 }
    );

    const baseEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

    // 场景 A：crontab 初始不存在时安装
    assert.equal(fs.existsSync(storeFile), false);
    execSync(resultNoSudo.command, { env: baseEnv, stdio: 'pipe' });

    assert.equal(fs.existsSync(storeFile), true);
    const linesInitial = fs.readFileSync(storeFile, 'utf8').trim().split('\n');
    assert.equal(linesInitial.length, 1);
    assert.ok(linesInitial[0].includes(resultNoSudo.marker));

    // 场景 B：存在用户中间空行、注释与其他 cron 时，多次运行保持幂等且空行完好保留
    fs.writeFileSync(
      storeFile,
      ['0 1 * * * /usr/local/bin/backup.sh', '', '# a comment line', linesInitial[0], ''].join('\n')
    );

    execSync(resultNoSudo.command, { env: baseEnv, stdio: 'pipe' });
    execSync(resultNoSudo.command, { env: baseEnv, stdio: 'pipe' });

    const finalContent = fs.readFileSync(storeFile, 'utf8');
    const finalLines = finalContent.split('\n');
    // 断言其他用户任务、注释与中间空行完整保留（不被 sed 抹除）
    assert.ok(finalLines.includes('0 1 * * * /usr/local/bin/backup.sh'));
    assert.ok(finalLines.includes('# a comment line'));
    assert.ok(finalLines.includes(''), '中间空行应被完整保留');

    // 断言带标记的行有且仅有一行
    const matchedMarkerLines = finalLines.filter((line) => line.includes(resultNoSudo.marker));
    assert.equal(matchedMarkerLines.length, 1, '重复执行后同一标记只能有一行');

    // 场景 C：crontab -l 因权限（permission denied）或非 0 失败时，命令退出码 46，store 不变，crontab - 未被调用
    fs.writeFileSync(storeFile, 'CRITICAL_USER_CRON_CONTENT\n');
    fs.writeFileSync(callsLog, '');

    const permDeniedRes = spawnSync('sh', ['-c', resultNoSudo.command], {
      env: { ...baseEnv, FAKE_CRON_ERROR: 'crontab: /var/spool/cron: permission denied' },
      encoding: 'utf8',
    });
    assert.equal(permDeniedRes.status, 46, 'crontab -l 遇到权限错误应退出码 46');
    assert.ok(permDeniedRes.stderr.includes('permission denied'));

    // 断言 store 内容完好无损，没有被只写入我们的单行
    const preservedContent = fs.readFileSync(storeFile, 'utf8');
    assert.equal(preservedContent, 'CRITICAL_USER_CRON_CONTENT\n', '失败时绝不能覆盖用户现有 crontab');

    // 断言 crontab - 从未被调用
    const calls = fs.readFileSync(callsLog, 'utf8');
    assert.doesNotMatch(calls, /^-$/, '发生非预期权限错误时绝不应调用 crontab - 写入');

    // 场景 D：无 crontab 命令存在时，命令退出码 45
    const shOnlyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-sh-bin-'));
    try {
      const shPath = fs.realpathSync('/bin/sh');
      fs.symlinkSync(shPath, path.join(shOnlyBinDir, 'sh'));
      const noCronRes = spawnSync(shPath, ['-c', resultNoSudo.command], {
        env: { PATH: shOnlyBinDir },
        encoding: 'utf8',
      });
      assert.equal(noCronRes.status, 45, '无 crontab 命令时应退出码 45');
    } finally {
      fs.rmSync(shOnlyBinDir, { recursive: true, force: true });
    }

    // 场景 E：busybox 1.3x 真实空 crontab 错误文案 ("crontab: can't open 'root': No such file or directory") 正常安装
    fs.rmSync(storeFile, { force: true });
    const busyboxRes = spawnSync('sh', ['-c', resultNoSudo.command], {
      env: { ...baseEnv, FAKE_CRON_ERROR: "crontab: can't open 'root': No such file or directory" },
      encoding: 'utf8',
    });
    assert.equal(busyboxRes.status, 0);
    assert.ok(busyboxRes.stdout.includes('yuyan-cron:installed'));
    assert.equal(fs.existsSync(storeFile), true);

    // 场景 E2：stderr 为 "sudo: crontab: No such file or directory"（无 can't open）时必须退出码 46 且不写入
    fs.rmSync(storeFile, { force: true });
    fs.writeFileSync(callsLog, '');
    const sudoNoSuchFileRes = spawnSync('sh', ['-c', resultNoSudo.command], {
      env: { ...baseEnv, FAKE_CRON_ERROR: 'sudo: crontab: No such file or directory' },
      encoding: 'utf8',
    });
    assert.equal(sudoNoSuchFileRes.status, 46, 'sudo crontab No such file 错误应退出码 46');
    assert.equal(fs.existsSync(storeFile), false, '非空 crontab 错误时绝不写入');
    const callsAfterSudoNoSuchFile = fs.readFileSync(callsLog, 'utf8');
    assert.doesNotMatch(callsAfterSudoNoSuchFile, /^-$/, '非空 crontab 错误时不应调用 crontab - 写入');

    // 场景 F：已有完全相同行且仅一行时，输出 unchanged，退出码 0，且不调用 crontab -
    fs.writeFileSync(storeFile, `${resultNoSudo.cronLine}\n`);
    fs.writeFileSync(callsLog, '');
    const unchangedRes = spawnSync('sh', ['-c', resultNoSudo.command], {
      env: baseEnv,
      encoding: 'utf8',
    });
    assert.equal(unchangedRes.status, 0);
    assert.ok(unchangedRes.stdout.includes('yuyan-cron:unchanged'));
    const callsAfterUnchanged = fs.readFileSync(callsLog, 'utf8');
    assert.doesNotMatch(callsAfterUnchanged, /^-$/, '已有完全相同行时不应调用 crontab - 写入');

    // 场景 G：已有旧 marker 行（keepDays 14 变 7），替换旧 marker 并保留其他行和空行
    const resultKeep7 = buildLogRotateCronInstallCommand(configNoSudo, 7);
    fs.writeFileSync(
      storeFile,
      ['# header comment', '', '10 * * * * /usr/bin/job', fs.readFileSync(storeFile, 'utf8').trim()].join('\n')
    );
    const replaceRes = spawnSync('sh', ['-c', resultKeep7.command], {
      env: baseEnv,
      encoding: 'utf8',
    });
    assert.equal(replaceRes.status, 0);
    assert.ok(replaceRes.stdout.includes('yuyan-cron:installed'));
    const replacedLines = fs.readFileSync(storeFile, 'utf8').split('\n');
    assert.ok(replacedLines.includes('# header comment'));
    assert.ok(replacedLines.includes('10 * * * * /usr/bin/job'));
    assert.ok(replacedLines.some((l) => l.includes('rotate-logs 7')));
    assert.ok(!replacedLines.some((l) => l.includes('rotate-logs 14')));

    // 场景 H：写入失败（crontab - 失败）时，退出码 47
    fs.rmSync(storeFile, { force: true });
    const writeFailRes = spawnSync('sh', ['-c', resultKeep7.command], {
      env: { ...baseEnv, FAKE_CRON_WRITE_FAIL: '1' },
      encoding: 'utf8',
    });
    assert.equal(writeFailRes.status, 47, '写入失败时应退出码 47');
  } finally {
    fs.rmSync(tmpEnvDir, { recursive: true, force: true });
  }
});

test('parseLogRotateCronResult: 各种退出码及状态解析与 message 提示', () => {
  const cronLine = '15 3 * * * /opt/yuyan/nginx/yuyan-nginx.sh rotate-logs 14 # marker';

  // 1. installed
  const installedRes = parseLogRotateCronResult({ code: 0, stdout: 'yuyan-cron:installed\n' }, cronLine);
  assert.equal(installedRes.status, 'installed');
  assert.equal(installedRes.cronLine, cronLine);
  assert.ok(installedRes.message.includes('成功安装'));

  // 2. unchanged
  const unchangedRes = parseLogRotateCronResult({ code: 0, stdout: 'yuyan-cron:unchanged\n' }, cronLine);
  assert.equal(unchangedRes.status, 'unchanged');
  assert.equal(unchangedRes.cronLine, cronLine);
  assert.ok(unchangedRes.message.includes('无需更新'));

  // 3. no_crontab (code 45)
  const noCronRes = parseLogRotateCronResult({ code: 45 }, cronLine, { useSudo: false });
  assert.equal(noCronRes.status, 'no_crontab');
  assert.ok(noCronRes.message.includes('未安装 crontab（cron）'));
  assert.ok(noCronRes.message.includes('平台不提供 SSH 兜底轮转'));
  assert.ok(noCronRes.message.includes('crontab -e'));
  assert.ok(noCronRes.message.includes(cronLine));

  // 3b. no_crontab 带 sudo
  const noCronSudoRes = parseLogRotateCronResult({ code: 45 }, cronLine, { useSudo: true });
  assert.ok(noCronSudoRes.message.includes('sudo crontab -e'));

  // 4. read_failed (code 46)
  const readFailRes = parseLogRotateCronResult({ code: 46, stderr: 'permission denied' }, cronLine, { useSudo: false });
  assert.equal(readFailRes.status, 'read_failed');
  assert.ok(readFailRes.message.includes('读取服务器定时任务失败'));
  assert.ok(readFailRes.message.includes('permission denied'));
  assert.ok(readFailRes.message.includes('crontab -e'));
  assert.ok(readFailRes.message.includes(cronLine));

  // 5. write_failed (code 47)
  const writeFailRes = parseLogRotateCronResult({ code: 47, stderr: 'disk full' }, cronLine, { useSudo: true });
  assert.equal(writeFailRes.status, 'write_failed');
  assert.ok(writeFailRes.message.includes('写入服务器定时任务失败'));
  assert.ok(writeFailRes.message.includes('disk full'));
  assert.ok(writeFailRes.message.includes('sudo crontab -e'));
  assert.ok(writeFailRes.message.includes(cronLine));

  // 6. 异常退出码（例如 1 或网络异常）
  const otherFailRes = parseLogRotateCronResult({ code: 1, stderr: 'timeout' }, cronLine);
  assert.equal(otherFailRes.status, 'write_failed');
  assert.ok(otherFailRes.message.includes('写入服务器定时任务失败'));
  assert.ok(otherFailRes.message.includes(cronLine));
});
