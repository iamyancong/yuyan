import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  YUYAN_NGINX_SCRIPT_VERSION,
  formatNginxVersionDisplay,
  parseNginxPidDirective,
  parseRemoteScriptVersion,
  parseRuntimeScriptStatusOutput,
  pathBelongsToBase,
  renderRuntimeScript,
} from '../nginx-runtime-service.mjs';
import {
  extractNginxBinaryFromCommand,
  parseNginxVersionOutput,
} from '../nginx-discovery-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_NGINX = path.resolve(__dirname, '../../assets/nginx-runtime/linux-x64-static/sbin/nginx');

test('parseNginxPidDirective: 指令、注释、缺省候选', () => {
  assert.deepEqual(parseNginxPidDirective('pid run/nginx.pid;', '/opt/yuyan/nginx').absolutePath, '/opt/yuyan/nginx/run/nginx.pid');
  assert.equal(parseNginxPidDirective('# pid logs/nginx.pid;\npid /var/run/x.pid;', '/opt/yuyan/nginx').absolutePath, '/var/run/x.pid');
  const absent = parseNginxPidDirective('worker_processes 1;', '/opt/yuyan/nginx');
  assert.equal(absent.directive, null);
  assert.deepEqual(absent.candidates, ['/opt/yuyan/nginx/run/nginx.pid', '/opt/yuyan/nginx/logs/nginx.pid']);
});

test('pathBelongsToBase: 严格前缀，不误匹配 nginx2', () => {
  assert.equal(pathBelongsToBase('/opt/yuyan/nginx/sbin/nginx', '/opt/yuyan/nginx'), true);
  assert.equal(pathBelongsToBase('nginx: master process /opt/yuyan/nginx/sbin/nginx -p /opt/yuyan/nginx/', '/opt/yuyan/nginx'), true);
  assert.equal(pathBelongsToBase('nginx: master process /opt/yuyan/nginx2/sbin/nginx -p /opt/yuyan/nginx2/', '/opt/yuyan/nginx'), false);
  assert.equal(pathBelongsToBase('/opt/yuyan/nginx2/sbin/nginx', '/opt/yuyan/nginx'), false);
});

test('extractNginxBinaryFromCommand: 引号/sudo/env/危险命令', () => {
  assert.equal(extractNginxBinaryFromCommand("'/home/nginx/sbin/nginx' -t -p '/home/nginx'"), '/home/nginx/sbin/nginx');
  assert.equal(extractNginxBinaryFromCommand('sudo -n /opt/nginx/sbin/nginx -t'), '/opt/nginx/sbin/nginx');
  assert.equal(extractNginxBinaryFromCommand('env FOO=1 BAR=2 /usr/sbin/nginx -t'), '/usr/sbin/nginx');
  assert.equal(extractNginxBinaryFromCommand('/bin/nginx -t; rm -rf /'), null);
  assert.equal(extractNginxBinaryFromCommand('nginx -t'), null); // 相对路径拒绝
  assert.equal(extractNginxBinaryFromCommand('$(curl evil)'), null);
});

test('parseNginxVersionOutput: nginx/openresty/tengine', () => {
  assert.equal(parseNginxVersionOutput('nginx version: nginx/1.24.0\n').version, 'nginx/1.24.0');
  assert.equal(parseNginxVersionOutput('nginx version: openresty/1.21.4.1\n').version, 'openresty/1.21.4.1');
  assert.equal(parseNginxVersionOutput('nginx version: Tengine/2.3.3\n').version, 'Tengine/2.3.3');
});

test('parseRuntimeScriptStatusOutput + formatNginxVersionDisplay', () => {
  const parsed = parseRuntimeScriptStatusOutput('pid_repaired: 1\nrunning: 42\nrunning_version: nginx/1.24.0\ndisk_version: nginx/1.25.0\nupgrade_pending: 1\n');
  assert.equal(parsed.running, true);
  assert.equal(parsed.pid, 42);
  assert.equal(parsed.pidRepaired, true);
  assert.equal(parsed.upgradePending, true);
  const display = formatNginxVersionDisplay(parsed);
  assert.match(display.label, /待平滑升级/);
  assert.equal(display.upgradePending, true);
  const unknown = formatNginxVersionDisplay({ versionDetectError: '无法提取' });
  assert.equal(unknown.label, '未知');
  assert.match(unknown.tooltip, /无法提取/);
});

test('renderRuntimeScript: 含协议版本标记且不再写死仅 run/nginx.pid', () => {
  const script = renderRuntimeScript();
  assert.equal(parseRemoteScriptVersion(script), YUYAN_NGINX_SCRIPT_VERSION);
  assert.match(script, /yuyan-nginx-script-version:\s*2/);
  assert.doesNotMatch(script, /^PID="\$BASE_DIR\/run\/nginx\.pid"$/m);
  assert.match(script, /find_master_by_proc/);
  assert.match(script, /KILL_BIN.*-HUP|"\$KILL_BIN" -HUP/);
  assert.match(script, /upgrade\)/);
});

test('buildNginxCommand managed 使用 server.useSudo 兜底', async () => {
  const { buildNginxCommand } = await import('../deploy-service.mjs');
  const cmd = buildNginxCommand(
    { useSudo: true },
    { instanceType: 'managed', useSudo: false, scriptPath: '/opt/yuyan/nginx/yuyan-nginx.sh' },
    'reload'
  );
  assert.equal(cmd, "sudo -n '/opt/yuyan/nginx/yuyan-nginx.sh' reload");
});

// worker 用户取当前运行测试的账号，避免绑死某台机器上才有的用户名（CI runner 没有 box 用户）
const WORKER_USER = os.userInfo().username;
const WORKER_GROUP = (() => {
  try {
    return execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim() || WORKER_USER;
  } catch {
    return WORKER_USER;
  }
})();

function setupPrefix(baseDir, { pidDirective = 'pid run/nginx.pid;', listen = 18080 } = {}) {
  for (const dir of ['sbin', 'conf', 'conf/conf.d', 'logs', 'run', 'html']) {
    fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
  }
  fs.copyFileSync(STATIC_NGINX, path.join(baseDir, 'sbin/nginx'));
  fs.chmodSync(path.join(baseDir, 'sbin/nginx'), 0o755);
  fs.writeFileSync(
    path.join(baseDir, 'conf/nginx.conf'),
    [
      'worker_processes 1;',
      `user ${WORKER_USER} ${WORKER_GROUP};`,
      pidDirective,
      'error_log logs/error.log warn;',
      'events { worker_connections 64; }',
      'http {',
      '  access_log off;',
      '  server {',
      `    listen 127.0.0.1:${listen};`,
      '    server_name _;',
      '    location / { return 200 "ok"; }',
      '  }',
      '}',
      '',
    ].join('\n')
  );
  const scriptPath = path.join(baseDir, 'yuyan-nginx.sh');
  fs.writeFileSync(scriptPath, renderRuntimeScript(), { mode: 0o755 });
  return scriptPath;
}

const BUSYBOX = process.env.YUYAN_TEST_BUSYBOX || '/workspace/tools/busybox/busybox';
const nextListen = (() => {
  let n = 22000 + Math.floor(Math.random() * 1000);
  return () => {
    n += 1;
    return n;
  };
})();

function runScript(scriptPath, args, opts = {}) {
  return execFileSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

test('真实 nginx：pid 文件缺失仍识别运行中，reload 不撞端口，并写回 pid', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-detect-'));
  const listen = nextListen();
  const scriptPath = setupPrefix(baseDir, { listen });
  t.after(() => {
    try { runScript(scriptPath, ['stop']); } catch {}
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  runScript(scriptPath, ['start']);
  const pidFile = path.join(baseDir, 'run/nginx.pid');
  assert.equal(fs.existsSync(pidFile), true);
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  fs.rmSync(pidFile);

  const statusOut = runScript(scriptPath, ['status']);
  assert.match(statusOut, new RegExp(`running: ${pid}`));
  assert.match(statusOut, /pid_repaired: 1/);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), pid);

  // reload 不应再 start 撞端口
  const reloadOut = runScript(scriptPath, ['reload']);
  assert.match(reloadOut, /reloaded|yuyan nginx reloaded/);
  assert.doesNotMatch(reloadOut, /Address already in use/i);
});

test('真实 nginx：conf 使用 logs/nginx.pid 仍能识别', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-pidlogs-'));
  const listen = nextListen();
  const scriptPath = setupPrefix(baseDir, { pidDirective: 'pid logs/nginx.pid;', listen });
  t.after(() => {
    try { runScript(scriptPath, ['stop']); } catch {}
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  runScript(scriptPath, ['start']);
  assert.equal(fs.existsSync(path.join(baseDir, 'logs/nginx.pid')), true);
  const statusOut = runScript(scriptPath, ['status']);
  assert.match(statusOut, /running: \d+/);
  assert.match(statusOut, /pid_path: .*logs\/nginx\.pid/, statusOut);
});

test('相似前缀另一实例不被误匹配', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-multi-'));
  const a = path.join(root, 'nginx');
  const b = path.join(root, 'nginx2');
  const scriptA = setupPrefix(a, { listen: nextListen() });
  const scriptB = setupPrefix(b, { listen: nextListen() });
  t.after(() => {
    try { runScript(scriptA, ['stop']); } catch {}
    try { runScript(scriptB, ['stop']); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  runScript(scriptA, ['start']);
  // B 未启动：status 应 stopped，且不能误报 A 的 pid
  let failed = false;
  try {
    runScript(scriptB, ['status']);
  } catch (error) {
    failed = true;
    const out = `${error.stdout || ''}${error.stderr || ''}`;
    assert.match(out, /stopped/);
    assert.doesNotMatch(out, /running: /);
  }
  assert.equal(failed, true, 'nginx2 status 应失败(stopped)');
});

test('磁盘版本探测：status 输出 disk_version', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-ver-'));
  const scriptPath = setupPrefix(baseDir, { listen: nextListen() });
  t.after(() => {
    try { runScript(scriptPath, ['stop']); } catch {}
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  runScript(scriptPath, ['start']);
  const statusOut = runScript(scriptPath, ['status']);
  assert.match(statusOut, /running_version: nginx\//);
  assert.match(statusOut, /disk_version: nginx\//);
});

function runWithShell(shellArgs, scriptPath, args) {
  return execFileSync(shellArgs[0], [...shellArgs.slice(1), scriptPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('parseNginxVersionOutput: 独立 Tengine version 行与 stderr 形态', () => {
  assert.equal(parseNginxVersionOutput('Tengine version: Tengine/2.4.1\n').version, 'Tengine/2.4.1');
  assert.equal(
    parseNginxVersionOutput('nginx version: nginx/1.24.0\nbuilt by gcc\n').version,
    'nginx/1.24.0'
  );
});

test('extractNginxBinaryFromCommand: 双引号路径与管道注入拒绝', () => {
  assert.equal(extractNginxBinaryFromCommand('"/opt/openresty/nginx/sbin/nginx" -t'), '/opt/openresty/nginx/sbin/nginx');
  assert.equal(extractNginxBinaryFromCommand('/opt/nginx/sbin/nginx -t | tee /tmp/x'), null);
  assert.equal(extractNginxBinaryFromCommand('sudo /opt/nginx/sbin/nginx -t && id'), null);
});

test('陈旧 pid 指向无关存活进程时不信任，回退 /proc 扫描并修复', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-stale-'));
  const listen = nextListen();
  const scriptPath = setupPrefix(baseDir, { listen });
  t.after(() => {
    try {
      runScript(scriptPath, ['stop']);
    } catch {}
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  runScript(scriptPath, ['start']);
  const realPid = fs.readFileSync(path.join(baseDir, 'run/nginx.pid'), 'utf8').trim();
  // 无关存活进程：sleep
  const decoy = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
  decoy.unref();
  t.after(() => {
    try {
      process.kill(decoy.pid);
    } catch {}
  });
  fs.writeFileSync(path.join(baseDir, 'run/nginx.pid'), String(decoy.pid));
  const statusOut = runScript(scriptPath, ['status']);
  assert.match(statusOut, new RegExp(`running: ${realPid}`));
  assert.match(statusOut, /pid_repaired: 1/);
  assert.equal(fs.readFileSync(path.join(baseDir, 'run/nginx.pid'), 'utf8').trim(), realPid);
  assert.notEqual(fs.readFileSync(path.join(baseDir, 'run/nginx.pid'), 'utf8').trim(), String(decoy.pid));
});

test('busybox sh：缺 pid 时 status/reload/pid 修复仍可用', async (t) => {
  if (!fs.existsSync(STATIC_NGINX) || !fs.existsSync(BUSYBOX)) {
    t.skip('static nginx or busybox missing');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-bb-'));
  const listen = nextListen();
  const scriptPath = setupPrefix(baseDir, { listen });
  t.after(() => {
    try {
      runWithShell([BUSYBOX, 'sh'], scriptPath, ['stop']);
    } catch {}
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  runWithShell([BUSYBOX, 'sh'], scriptPath, ['start']);
  const pidFile = path.join(baseDir, 'run/nginx.pid');
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  fs.rmSync(pidFile);
  const statusOut = runWithShell([BUSYBOX, 'sh'], scriptPath, ['status']);
  assert.match(statusOut, new RegExp(`running: ${pid}`));
  assert.match(statusOut, /pid_repaired: 1/);
  const reloadOut = runWithShell([BUSYBOX, 'sh'], scriptPath, ['reload']);
  assert.match(reloadOut, /reloaded/);
});

test('非 root 对 root master 的 EPERM：needs_sudo，不标 stopped，reload 不 start', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  // 需要免密 sudo 才能用 root 拉起 master
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
  } catch {
    t.skip('passwordless sudo unavailable');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-eperm-'));
  const listen = nextListen();
  const scriptPath = setupPrefix(baseDir, { listen });
  // root 可写 pid/logs
  execFileSync('sudo', ['-n', 'chmod', '777', baseDir, path.join(baseDir, 'run'), path.join(baseDir, 'logs')], {
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      execFileSync('sudo', ['-n', scriptPath, 'stop'], { stdio: 'ignore' });
    } catch {}
    try {
      execFileSync('sudo', ['-n', 'rm', '-rf', baseDir], { stdio: 'ignore' });
    } catch {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
  execFileSync('sudo', ['-n', scriptPath, 'start'], { encoding: 'utf8' });
  const pid = fs.readFileSync(path.join(baseDir, 'run/nginx.pid'), 'utf8').trim();
  // 确认 master 属 root
  const uid = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s+(\d+)/m)?.[1];
  assert.equal(uid, '0', 'master 应为 root');

  let statusFailed = false;
  let statusOut = '';
  try {
    statusOut = runScript(scriptPath, ['status']);
  } catch (error) {
    statusFailed = true;
    statusOut = `${error.stdout || ''}${error.stderr || ''}`;
    assert.equal(error.status, 4);
  }
  assert.equal(statusFailed, true, '无权限时应非 0 退出');
  assert.match(statusOut, /needs_sudo: 1/);
  assert.match(statusOut, new RegExp(`running: ${pid}`));
  assert.doesNotMatch(statusOut, /(^|\n)stopped(\n|$)/);

  // reload 不得回退 start 撞端口
  let reloadOut = '';
  try {
    reloadOut = runScript(scriptPath, ['reload']);
    assert.fail('reload 应失败');
  } catch (error) {
    reloadOut = `${error.stdout || ''}${error.stderr || ''}`;
    assert.equal(error.status, 4);
  }
  assert.match(reloadOut, /needs_sudo: 1/);
  assert.doesNotMatch(reloadOut, /Address already in use/i);
  assert.doesNotMatch(reloadOut, /yuyan nginx started/);
  // 原 root master 仍在
  assert.equal(fs.existsSync(`/proc/${pid}`), true);
});

test('原地替换二进制：upgrade_pending + USR2/QUIT 平滑升级成功（同版本）', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-upgrade-'));
  const listen = nextListen();
  const scriptPath = setupPrefix(baseDir, { listen });
  t.after(() => {
    try {
      runScript(scriptPath, ['stop']);
    } catch {}
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  runScript(scriptPath, ['start']);
  const oldPid = fs.readFileSync(path.join(baseDir, 'run/nginx.pid'), 'utf8').trim();
  // 原地替换制造 (deleted)；箱内仅有同一版本 static nginx，故同版本升级
  const bin = path.join(baseDir, 'sbin/nginx');
  const bak = path.join(baseDir, 'sbin/nginx.bakcopy');
  fs.copyFileSync(bin, bak);
  fs.rmSync(bin);
  fs.copyFileSync(bak, bin);
  fs.chmodSync(bin, 0o755);
  const exeLink = fs.readlinkSync(`/proc/${oldPid}/exe`);
  assert.match(exeLink, /deleted/);

  const statusOut = runScript(scriptPath, ['status']);
  assert.match(statusOut, /upgrade_pending: 1/);
  assert.match(statusOut, /running_version: nginx\//);
  assert.match(statusOut, /disk_version: nginx\//);

  const upgradeOut = runScript(scriptPath, ['upgrade']);
  assert.match(upgradeOut, /yuyan nginx upgraded/);
  const newPid = fs.readFileSync(path.join(baseDir, 'run/nginx.pid'), 'utf8').trim();
  assert.notEqual(newPid, oldPid);
  assert.equal(fs.existsSync(`/proc/${oldPid}`), false, '旧 master 应退出');
  assert.equal(fs.existsSync(`/proc/${newPid}`), true);
  // 端口仍可服务
  const body = execFileSync('curl', ['-fsS', `http://127.0.0.1:${listen}/`], { encoding: 'utf8' });
  assert.equal(body, 'ok');
});

test('平滑升级失败：新二进制 -t 失败时保留旧 master', async (t) => {
  if (!fs.existsSync(STATIC_NGINX)) {
    t.skip('static nginx binary missing');
    return;
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-ngx-upfail-'));
  const listen = nextListen();
  const scriptPath = setupPrefix(baseDir, { listen });
  t.after(() => {
    try {
      runScript(scriptPath, ['stop']);
    } catch {}
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  runScript(scriptPath, ['start']);
  const oldPid = fs.readFileSync(path.join(baseDir, 'run/nginx.pid'), 'utf8').trim();
  const bin = path.join(baseDir, 'sbin/nginx');
  const good = path.join(baseDir, 'sbin/nginx.good');
  fs.copyFileSync(bin, good);
  fs.rmSync(bin);
  fs.writeFileSync(
    bin,
    '#!/bin/sh\necho "broken nginx -t" >&2\nexit 1\n',
    { mode: 0o755 }
  );
  let failed = false;
  let out = '';
  try {
    runScript(scriptPath, ['upgrade']);
  } catch (error) {
    failed = true;
    out = `${error.stdout || ''}${error.stderr || ''}`;
  }
  assert.equal(failed, true);
  assert.match(out, /broken nginx -t|test is failed|emerg|exit/i);
  assert.equal(fs.existsSync(`/proc/${oldPid}`), true, '旧 master 必须保留');
  // 恢复可执行文件以便 after 清理
  fs.copyFileSync(good, bin);
  fs.chmodSync(bin, 0o755);
});
