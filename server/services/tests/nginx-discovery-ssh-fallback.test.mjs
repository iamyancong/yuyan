import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNginxBinaryFindCommand,
  discoverServerNginx,
  inferRelativeNginxProcessBinary,
  normalizeManualNginxBinaryPath,
} from '../nginx-discovery-service.mjs';

/**
 * 创建按 label 应答的假执行器。
 * @param {Record<string, Function|Object>} handlers - label 前缀到应答
 * @returns {{execute: Function, commands: Array<{command: string, label: string}>}} 执行器
 */
function createExecutor(handlers) {
  const commands = [];
  const execute = async (_conn, command, options = {}) => {
    const label = String(options.label || '');
    commands.push({ command, label });
    const key = Object.keys(handlers).find((prefix) => label.startsWith(prefix));
    if (!key) return { code: 1, stdout: '', stderr: 'not handled' };
    const handler = handlers[key];
    return typeof handler === 'function' ? handler(command) : handler;
  };
  return { execute, commands };
}

const fakeConnection = { withConnection: async (_server, task) => task({ fake: true }) };

test('find 搜索范围覆盖 /usr/local /data /app /srv 并跳过 node_modules/.git', () => {
  const command = buildNginxBinaryFindCommand(false);
  for (const dir of ['/home', '/opt', '/usr/local', '/data', '/app', '/srv']) assert.equal(command.includes(dir), true);
  assert.match(command, /-name node_modules -o -name \.git \\\) -prune/);
  assert.equal(buildNginxBinaryFindCommand(true).startsWith('sudo -n find /home /opt'), true);
});

test('开启 sudo 但 sudo 不可用：给出 sudo_unavailable 诊断并降级为普通账号继续扫描', async () => {
  const { execute, commands } = createExecutor({
    '检查 sudo': { code: 1, stdout: '', stderr: 'sudo: a password is required' },
    '扫描 Nginx master 进程': { code: 0, stdout: '101 root nginx: master process /home/nginx/sbin/nginx\n', stderr: '' },
    '扫描常见 Nginx 安装路径': { code: 0, stdout: '/home/nginx/sbin/nginx\n', stderr: '' },
    '读取 ': { code: 0, stdout: '', stderr: 'nginx version: nginx/1.26.2' },
  });
  const result = await discoverServerNginx(1, {}, {
    getServer: async () => ({ id: 1, useSudo: true, nginxInstances: [] }),
    ...fakeConnection,
    execute,
  });
  assert.equal(result.useSudo, true);
  assert.equal(result.effectiveUseSudo, false);
  assert.equal(result.diagnostics.some((item) => item.code === 'sudo_unavailable'), true);
  assert.equal(result.runtimes.length, 1);
  const scanCommands = commands.filter((item) => item.label !== '检查 sudo').map((item) => item.command);
  assert.equal(scanCommands.some((command) => command.includes('sudo -n')), false, '降级后不再使用 sudo');
});

test('sudo 可用时保持 sudo 扫描', async () => {
  const { execute, commands } = createExecutor({
    '检查 sudo': { code: 0, stdout: '', stderr: '' },
    '扫描 Nginx master 进程': { code: 0, stdout: '', stderr: '' },
    '扫描常见 Nginx 安装路径': { code: 0, stdout: '', stderr: '' },
  });
  const result = await discoverServerNginx(2, {}, { getServer: async () => ({ id: 2, useSudo: true, nginxInstances: [] }), ...fakeConnection, execute });
  assert.equal(result.effectiveUseSudo, true);
  assert.equal(commands.some((item) => item.command.includes('sudo -n find')), true);
});

test('相对路径启动的进程合并到唯一匹配的二进制，不再出现重复候选', async () => {
  assert.equal(inferRelativeNginxProcessBinary({ binary: './nginx' }, ['/home/nginx/sbin/nginx']), '/home/nginx/sbin/nginx');
  assert.equal(inferRelativeNginxProcessBinary({ binary: './nginx' }, ['/home/nginx/sbin/nginx', '/opt/nginx/sbin/nginx']), '');
  assert.equal(inferRelativeNginxProcessBinary({ binary: 'sbin/nginx', prefix: '/opt/nginx/' }, ['/home/nginx/sbin/nginx', '/opt/nginx/sbin/nginx']), '/opt/nginx/sbin/nginx');
  assert.equal(inferRelativeNginxProcessBinary({ binary: '/usr/sbin/nginx' }, ['/usr/sbin/nginx']), '');

  const { execute } = createExecutor({
    '扫描 Nginx master 进程': { code: 0, stdout: '202 root nginx: master process ./nginx\n', stderr: '' },
    '扫描常见 Nginx 安装路径': { code: 0, stdout: '/home/nginx/sbin/nginx\n', stderr: '' },
    '读取 ': { code: 0, stdout: '', stderr: 'nginx version: nginx/1.26.2' },
  });
  const result = await discoverServerNginx(3, {}, { getServer: async () => ({ id: 3, useSudo: false, nginxInstances: [] }), ...fakeConnection, execute });
  assert.equal(result.runtimes.length, 1);
  assert.equal(result.runtimes[0].binaryPath, '/home/nginx/sbin/nginx');
  assert.equal(result.runtimes[0].running, true);
  assert.equal(result.diagnostics.some((item) => item.code === 'binary_unresolved'), false);
  assert.equal(result.diagnostics.some((item) => item.code === 'binary_inferred'), true);
});

test('手动指定 Nginx 可执行文件：加入候选；不存在时给出诊断；非法路径拒绝', async () => {
  assert.throws(() => normalizeManualNginxBinaryPath('nginx'), /绝对路径/);
  assert.equal(normalizeManualNginxBinaryPath(' /data/web//nginx/sbin/nginx '), '/data/web/nginx/sbin/nginx');

  const { execute, commands } = createExecutor({
    '扫描 Nginx master 进程': { code: 0, stdout: '', stderr: '' },
    '扫描常见 Nginx 安装路径': { code: 0, stdout: '', stderr: '' },
  });
  const result = await discoverServerNginx(4, { binaryPath: '/data/web/nginx/sbin/nginx' }, {
    getServer: async () => ({ id: 4, useSudo: false, nginxInstances: [] }), ...fakeConnection, execute,
  });
  assert.equal(commands.some((item) => item.command.includes("'/data/web/nginx/sbin/nginx'")), true);
  assert.equal(result.diagnostics.some((item) => item.code === 'command_not_found' && item.summary.includes('/data/web/nginx/sbin/nginx')), true);
});
