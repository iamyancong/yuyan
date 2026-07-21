import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { serverProductionDependencies } from './server-production-dependencies.js';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(scriptsDirectory, '../server');

/** 递归读取内嵌服务的非测试模块。 */
function listServerModules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tests') return [];
      return listServerModules(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.mjs') ? [entryPath] : [];
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

test('内嵌服务声明全部生产依赖', () => {
  const importedPackages = new Set();
  for (const modulePath of listServerModules(serverDirectory)) {
    for (const packageName of collectExternalImports(fs.readFileSync(modulePath, 'utf8'))) {
      importedPackages.add(packageName);
    }
  }
  const missingPackages = [...importedPackages]
    .filter((packageName) => !serverProductionDependencies[packageName])
    .sort();
  assert.deepEqual(missingPackages, [], `安装包缺少生产依赖：${missingPackages.join(', ')}`);
});
