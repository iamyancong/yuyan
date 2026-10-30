/**
 * 单测用最小 SSH 服务器（基于 ssh2 Server）。
 * @description 支持密码 / 仅 keyboard-interactive 两种登录方式，固定应答连接探测与 sudo 检查命令。
 */

import net from 'node:net';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;

/**
 * 生成 ed25519 主机私钥。
 * @returns {string} OpenSSH 私钥文本
 */
export function generateHostKey() {
  // ssh2 偶发生成无法再被自身解析的 ed25519 私钥（约 1/50），这里校验后重试，避免测试抖动。
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const key = utils.generateKeyPairSync('ed25519').private;
    if (!(utils.parseKey(key) instanceof Error)) return key;
  }
  throw new Error('无法生成可用的测试主机密钥');
}

/**
 * 启动测试 SSH 服务器。
 * @param {{username?: string, password?: string, mode?: 'password'|'keyboard', hostKey?: string, sudoOk?: boolean}} options - 服务器选项
 * @returns {Promise<{port: number, hostKey: string, attempts: string[], setHostKey: (key: string) => Promise<void>, close: () => Promise<void>}>} 服务器句柄
 */
export async function startSshTestServer(options = {}) {
  const username = options.username || 'tester';
  const password = options.password || 'secret';
  const mode = options.mode || 'password';
  const attempts = [];
  let hostKey = options.hostKey || generateHostKey();
  let server;
  let port = 0;

  const listen = () => new Promise((resolve) => {
    server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('error', () => undefined);
      client.on('authentication', (ctx) => {
        attempts.push(ctx.method);
        if (ctx.username !== username) return ctx.reject();
        if (mode === 'password' && ctx.method === 'password') {
          return ctx.password === password ? ctx.accept() : ctx.reject();
        }
        if (mode === 'keyboard' && ctx.method === 'keyboard-interactive') {
          return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
            if (answers[0] === password) ctx.accept();
            else ctx.reject();
          });
        }
        return ctx.reject(mode === 'keyboard' ? ['keyboard-interactive'] : ['password']);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec();
            if (info.command.includes('whoami')) {
              stream.write(`yuyan-ops-ready\n${username}\n`);
              stream.exit(0);
            } else if (info.command.trim() === 'sudo -n true') {
              if (options.sudoOk === false) stream.stderr.write('sudo: a password is required\n');
              stream.exit(options.sudoOk === false ? 1 : 0);
            } else {
              stream.exit(0);
            }
            stream.end();
          });
        });
      });
    });
    server.listen(port, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });

  await listen();
  return {
    get port() { return port; },
    get hostKey() { return hostKey; },
    attempts,
    async setHostKey(nextKey) {
      await new Promise((resolve) => server.close(resolve));
      hostKey = nextKey;
      await listen();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 获取一个当前无人监听的本机端口。
 * @returns {Promise<number>} 端口
 */
export async function getClosedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
