/**
 * 文件系统操作工具
 * @description 封装常用的文件和目录操作
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 确保目录存在，不存在则递归创建
 * @param {string} dir - 目录路径
 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * 确保项目目录中存在 .gitignore 文件
 * @param {string} targetDirectory - 项目目录路径
 */
export async function ensureGitignore(targetDirectory) {
  const gitignorePath = path.join(targetDirectory, '.gitignore');

  try {
    await fs.stat(gitignorePath);
    return; // 已存在，直接返回
  } catch {}

  // 如果模板中提供了不带点的 gitignore，优先重命名为 .gitignore
  const noDotGitignorePath = path.join(targetDirectory, 'gitignore');
  try {
    await fs.rename(noDotGitignorePath, gitignorePath);
    return;
  } catch {}

  // 创建默认的 .gitignore 文件
  const defaultGitignore = `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

# Dependencies
node_modules
.pnpm
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Generated files
# 允许 API 生成文件被提交
!packages/src/api/generated/

# Build outputs
build/
out/

# Coverage
coverage/
*.lcov

# TypeScript
*.tsbuildinfo

# Optional npm cache directory
.npm

# Optional eslint cache
.eslintcache

# Microbundle cache
.rpt2_cache/
.rts2_cache_cjs/
.rts2_cache_es/
.rts2_cache_umd/

# Optional REPL history
.node_repl_history

# Output of 'npm pack'
*.tgz

# Yarn Integrity file
.yarn-integrity

# parcel-bundler cache (https://parceljs.org/)
.cache
.parcel-cache

# Next.js build output
.next

# Nuxt.js build / generate output
.nuxt

# Storybook build outputs
.out
.storybook-out

# Temporary folders
tmp/
temp/
.cursor/
packages/dist/
packages/node_modules/
packages/.DS_Store
`;

  await fs.writeFile(gitignorePath, defaultGitignore, 'utf8');
}

/**
 * 清理临时目录
 * @param {string} dirPath - 要清理的目录路径
 */
export async function cleanup(dirPath) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    console.log(`[cleanup] 已清理目录: ${dirPath}`);
  } catch (error) {
    console.warn(`[cleanup] 清理目录失败: ${dirPath}`, error);
  }
}

/**
 * 规范化 base 路径（确保以 / 结尾）
 * @param {string} v - 路径字符串
 * @returns {string} 规范化后的路径
 */
export function normalizeBase(v) {
  return !v ? '/' : v.endsWith('/') ? v : `${v}/`;
}
