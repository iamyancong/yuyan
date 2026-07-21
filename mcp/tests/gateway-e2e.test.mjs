import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** 获取一次性 Loopback 端口。 */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

/** 等待 HTTP 健康检查。 */
async function waitForHealth(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('测试 Agent Gateway 启动超时');
}

test('MCP Sidecar 通过轮换令牌访问 Loopback Agent Gateway', { timeout: 20_000 }, async () => {
  const port = await getFreePort();
  const token = 'gateway-e2e-session-token';
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-gateway-e2e-'));
  const runtimePath = path.join(tempRoot, 'agent-runtime.json');
  const serverProcess = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      IS_TAURI_SUBPROCESS: 'true',
      DEPLOY_DATA_DIR: path.join(tempRoot, 'deploy-data'),
      TEMPLATE_REPO_PATH: path.join(tempRoot, 'template'),
      YUYAN_AGENT_SESSION_TOKEN: token,
      YUYAN_APP_EXECUTABLE: process.execPath,
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  let client;
  try {
    await waitForHealth(port);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/agent-api/v1/snapshot`);
    assert.equal(unauthorized.status, 401);
    await fs.writeFile(runtimePath, JSON.stringify({
      schemaVersion: 1,
      appVersion: 'test',
      pid: serverProcess.pid,
      port,
      sessionToken: token,
      startedAt: new Date().toISOString(),
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('mcp/dist/index.js'), '--client', 'generic'],
      cwd: process.cwd(),
      env: { ...process.env, YUYAN_RUNTIME_DESCRIPTOR: runtimePath, YUYAN_APP_EXECUTABLE: process.execPath },
      stderr: 'pipe',
    });
    client = new Client({ name: 'gateway-e2e', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'yuyan_get_status', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.data?.gatewayReady, true);
  } finally {
    await client?.close().catch(() => undefined);
    serverProcess.stdin?.end();
    serverProcess.kill('SIGTERM');
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
