import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..', '..');

test('stdio 初始化与工具列表可用且 stdout 保持协议纯净', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'mcp', 'dist', 'index.js'), '--client', 'generic'],
    cwd: projectRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'yuyan-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.equal(result.tools.length, 20);
    assert.ok(result.tools.every((tool) => tool.inputSchema?.type === 'object'));
    assert.ok(result.tools.find((tool) => tool.name === 'yuyan_deploy_target')?.annotations?.destructiveHint === false);
    assert.ok(result.tools.find((tool) => tool.name === 'yuyan_delete_deploy_target')?.annotations?.destructiveHint === true);
  } finally {
    await client.close();
  }
});
