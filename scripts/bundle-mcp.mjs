#!/usr/bin/env node
/**
 * 将 MCP Sidecar 打包为可独立运行的单文件，避免安装包缺少 node_modules。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPath = path.join(rootDirectory, 'mcp/src/index.ts');
const outfile = path.join(rootDirectory, 'mcp/dist/index.js');

await build({
  entryPoints: [entryPath],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
});

console.log(`✅ MCP Sidecar 已打包: ${outfile}`);
