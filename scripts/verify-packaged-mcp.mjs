#!/usr/bin/env node

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** 启动安装包内嵌 MCP Sidecar，校验依赖可解析且工具列表可用。 */
async function main() {
  const [rawNodePath, rawMcpEntryPath] = process.argv.slice(2);
  if (!rawNodePath || !rawMcpEntryPath) {
    throw new Error('用法: node scripts/verify-packaged-mcp.mjs <node-path> <mcp-entry-path>');
  }

  const nodePath = path.resolve(rawNodePath);
  const mcpEntryPath = path.resolve(rawMcpEntryPath);

  const transport = new StdioClientTransport({
    command: nodePath,
    args: [mcpEntryPath, '--client', 'generic'],
    cwd: path.dirname(mcpEntryPath),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'yuyan-packaged-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    if (!Array.isArray(result.tools) || result.tools.length === 0) {
      throw new Error('安装包 MCP Sidecar 未返回工具列表');
    }
    console.log(`✅ 安装包 MCP Sidecar 冒烟通过，工具数=${result.tools.length}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
