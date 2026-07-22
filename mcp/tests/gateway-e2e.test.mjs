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

/** 在限定时间内读取到指定名称的 SSE 事件。 */
async function readSseEvent(reader, decoder, eventName, timeoutMs = 3_000) {
  const startedAt = Date.now();
  let buffer = '';
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`等待 SSE ${eventName} 事件超时`)), remaining)),
    ]);
    if (result.done) throw new Error(`SSE 在收到 ${eventName} 前结束`);
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    const frame = frames.find((item) => item.split(/\r?\n/).includes(`event: ${eventName}`));
    if (frame) return frame;
  }
  throw new Error(`等待 SSE ${eventName} 事件超时`);
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
  let eventController;
  try {
    await waitForHealth(port);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/agent-api/v1/snapshot`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedEvents = await fetch(`http://127.0.0.1:${port}/agent-api/v1/events`);
    assert.equal(unauthorizedEvents.status, 401);

    eventController = new AbortController();
    const eventResponse = await fetch(`http://127.0.0.1:${port}/agent-api/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: eventController.signal,
    });
    assert.equal(eventResponse.status, 200);
    assert.match(eventResponse.headers.get('content-type') || '', /text\/event-stream/);
    const eventReader = eventResponse.body.getReader();
    const eventDecoder = new TextDecoder();
    const readyFrame = await readSseEvent(eventReader, eventDecoder, 'ready');
    assert.match(readyFrame, /"revision":0/);

    const policyResponse = await fetch(`http://127.0.0.1:${port}/agent-api/v1/approval-policy`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoApproveGrantedProjects: false, changedBy: 'gateway-e2e' }),
    });
    assert.equal(policyResponse.status, 200);
    const changeFrame = await readSseEvent(eventReader, eventDecoder, 'change');
    assert.match(changeFrame, /"policy"/);
    assert.match(changeFrame, /"audit"/);
    eventController.abort();
    await eventReader.cancel().catch(() => undefined);

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
    eventController?.abort();
    await client?.close().catch(() => undefined);
    serverProcess.stdin?.end();
    serverProcess.kill('SIGTERM');
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
