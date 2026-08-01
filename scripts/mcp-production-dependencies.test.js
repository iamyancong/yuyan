import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpProductionDependencies } from './mcp-production-dependencies.js';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const mcpSourceDirectory = path.resolve(scriptsDirectory, '../mcp/src');

/** 递归读取 MCP Sidecar 源码模块。 */
function listMcpModules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listMcpModules(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

/** 将包子路径归一化为 package.json 中的依赖名。 */
function getPackageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

/** 提取静态 import、export from 与动态 import 中的外部包。 */
function collectExternalImports(source) {
  const imports = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
      imports.add(getPackageName(specifier));
    }
  }
  return imports;
}

test('MCP Sidecar 外部依赖均在根 package.json 中声明以便打包', () => {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.resolve(scriptsDirectory, '../package.json'), 'utf8')
  );
  const rootDependencies = rootPackage.dependencies || {};
  const importedPackages = new Set();
  for (const modulePath of listMcpModules(mcpSourceDirectory)) {
    for (const packageName of collectExternalImports(fs.readFileSync(modulePath, 'utf8'))) {
      importedPackages.add(packageName);
    }
  }
  const missingDeclared = [...importedPackages]
    .filter((packageName) => !mcpProductionDependencies[packageName])
    .sort();
  const missingInRoot = [...importedPackages]
    .filter((packageName) => !rootDependencies[packageName])
    .sort();
  assert.deepEqual(missingDeclared, [], `MCP 生产依赖清单缺少：${missingDeclared.join(', ')}`);
  assert.deepEqual(missingInRoot, [], `根 package.json 缺少 MCP 依赖：${missingInRoot.join(', ')}`);
});
