#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 获取一个仅供本次冒烟测试使用的空闲本机端口。 */
async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('无法为安装包冒烟测试分配端口');
  return port;
}

/** 等待安装包内嵌服务通过健康检查。 */
async function waitForHealth(port, child, readOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`内嵌服务提前退出，code=${child.exitCode}\n${readOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && (await response.text()).trim() === 'ok') return;
    } catch {
      /** 服务仍在启动，继续轮询。 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`内嵌服务健康检查超时\n${readOutput()}`);
}

/** 结束冒烟测试子进程并清理其进程组中的所有孙进程（如后台 git clone）。 */
async function stopChild(child) {
  const killGroup = (signal) => {
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        /** 进程或进程组可能已退出。 */
      }
    }
  };

  // 1. 若主进程尚未退出，先尝试向进程组发送 SIGTERM 优雅退出，并等待退出（最多 3 秒）
  if (child.exitCode === null && child.signalCode === null) {
    killGroup('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }

  // 2. 无论主进程是否已退出，无条件补发 SIGKILL 彻底清理残留的后台孙进程（如 git clone），
  //    防止在临时目录被删除时仍有写入导致 ENOTEMPTY。若进程组已不在，killGroup 内部会安全捕获 ESRCH。
  killGroup('SIGKILL');
}

/** 启动安装包内嵌服务并执行健康检查。 */
async function main() {
  const [rawNodePath, rawServerPath] = process.argv.slice(2);
  if (!rawNodePath || !rawServerPath) {
    throw new Error('用法: node scripts/verify-packaged-server.mjs <node-path> <server-entry-path>');
  }
  const nodePath = path.resolve(rawNodePath);
  const serverPath = path.resolve(rawServerPath);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-packaged-server-'));
  const port = await getAvailablePort();
  let output = '';
  const child = spawn(nodePath, [serverPath], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      DEPLOY_DATA_DIR: path.join(temporaryDirectory, 'data'),
      TEMPLATE_REPO_PATH: path.join(temporaryDirectory, 'template'),
      DEPLOY_SECRET_KEY: crypto.randomBytes(32).toString('hex'),
      YUYAN_AGENT_AUDIT_KEY: crypto.randomBytes(32).toString('hex'),
      YUYAN_AGENT_SESSION_TOKEN: crypto.randomBytes(32).toString('hex'),
      IS_TAURI_SUBPROCESS: 'true',
      PORT: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const appendOutput = (chunk) => {
    output = `${output}${chunk}`.slice(-12_000);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);
  try {
    await waitForHealth(port, child, () => output);
    console.log('✅ 安装包内嵌服务健康检查通过');
  } finally {
    await stopChild(child);
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
      .catch((error) => console.warn(`⚠️ 清理临时目录失败（不影响校验结果）: ${error.message}`));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
