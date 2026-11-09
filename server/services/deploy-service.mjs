/**
 * 独立服务器部署核心服务
 * @description 负责本地构建、远程发布、Nginx 配置文件管理和回滚
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { buildAuthUrl } from './git-service.mjs';
import {
  createRecord,
  fetchGitlabCommitMeta,
  getLatestSuccessfulRecord,
  getNginxInstance,
  getRecord,
  getServerWithCredential,
  getTarget,
  listTargets,
  listPhysicalServerTargets,
  pruneProjectRecords,
  pruneTargetBackupReferences,
  updateRecord,
  updateTargetBuildMemoryMb,
  updateTargetBuildPeakMb,
  updateTargetCleanupConfirmed,
  getManagedNginxInstanceByServerId,
  getJdk,
} from './deploy-store.mjs';
import { DEPLOY_BACKUP_KEEP_PER_TARGET, DEPLOY_DATA_DIR, DEPLOY_RECORD_KEEP_PER_PROJECT } from '../config/constants.mjs';
import { withHiddenWindow } from '../utils/child-process.mjs';
import { resolveStderrLogLevel, splitProcessOutputLines, stripAnsi, TOOL_LOG_SOURCE } from '../utils/process-output.mjs';
import {
  normalizeDeployRootPath,
  classifyDeployRootRisk,
  manifestTopNames,
  computeCleanupPlan,
  computeCleanupScopeFingerprint,
  verifyPublishCleanupGate,
  isSharedDeployRoot,
  planRestore,
  isValidEntryName,
  filterManifestRelativeFiles,
  RESERVED_DEPLOY_ENTRIES,
  isReservedDeployEntry,
  assertCleanupSafetyCeiling,
  isPathNestedOrConflicting,
  resolveTopmostLockRoot,
} from './deploy-cleanup-policy.mjs';
import {
  execSsh,
  shellQuote,
  uploadDirectory,
  uploadFile,
  withSsh,
  writeRemoteTextWithBackup,
} from './ssh-service.mjs';
import { getTestHooks, __setTestHooks, __resetTestHooks } from './test-hooks.mjs';

export { __setTestHooks, __resetTestHooks };
import { getSshFailureEventExtra, logOperationFailure } from './ssh-errors.mjs';
import { deployBackendTarget, restoreBackendRecord } from './backend-runtime-service.mjs';
import {
  applyLowProcessPriority,
  buildIsolatedCommandEnv,
  createProcessTreeRssSampler,
  DEFAULT_MAVEN_BUILD_MEMORY_MB,
  executeBuildWithOomRetry,
  extractInlineCommandEnv,
  formatBuildWaitStage,
  resolveBuildHeapLimitMb,
  resolveBuildMemoryRequirementMb,
} from './build-isolation-service.mjs';

/** 发布任务停止错误 */
class DeployStoppedError extends Error {
  /**
   * 创建发布任务停止错误。
   * @param {string} message - 错误消息
   */
  constructor(message = '发布任务已停止') {
    super(message);
    this.name = 'DeployStoppedError';
    this.code = 'DEPLOY_STOPPED';
  }
}

/** 依赖缓存元信息文件名 */
const DEPENDENCY_CACHE_META_FILE = 'dependency-cache.json';

/** 依赖缓存锁文件名 */
const DEPENDENCY_LOCK_FILE_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']);

/** 依赖指纹输入文件名 */
const DEPENDENCY_INPUT_FILE_NAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.yarnrc.yml',
]);

/** 依赖指纹扫描时跳过的目录 */
const DEPENDENCY_SCAN_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.vite',
  '.yuyan-deploy',
]);

/** 依赖安装缓存保留目录 */
const GIT_CLEAN_NODE_MODULES_EXCLUDES = "-e node_modules -e node_modules/ -e '*/node_modules' -e '**/node_modules'";

/** 静态资源上传策略 */
const DEPLOY_UPLOAD_STRATEGIES = {
  cleanReplace: 'cleanReplace',
  overlayKeepAssets: 'overlayKeepAssets',
};

/** 发布产物清单目录名 */
const DEPLOY_MANIFEST_DIR_NAME = '.yuyan-manifests';

/** 默认带哈希静态资源目录名 */
export const DEFAULT_HASHED_ASSET_DIRS = ['assets'];

/** 部署备份类型 */
export const BACKUP_KINDS = {
  entryOnly: 'entry-only',
  full: 'full',
};

/** 部署备份类型标记文件名 */
export const BACKUP_KIND_FILE_NAME = '.backup-kind';

/** 部署备份包含顶层条目记录文件名 */
export const BACKUP_NAMES_FILE_NAME = '.backup-names';

/** 部署备份清单文件名 */
export const BACKUP_MANIFEST_FILE_NAME = '.manifest.txt';

/** 当前生效产物清单指针文件名 */
export const DEPLOY_CURRENT_MANIFEST_NAME = 'current.txt';

/**
 * 解析部署目标的保留份数配置，强制保证清单保留份数 >= 备份保留份数。
 * @param {Object} [target] - 部署目标对象
 * @returns {{ backupKeepCount: number, manifestKeepCount: number }} 保留份数配置
 */
export function resolveDeployRetentionCounts(target = {}) {
  const defaultKeep = Math.max(1, Number(DEPLOY_BACKUP_KEEP_PER_TARGET || 8));
  const configuredBackup = Number(target?.backupKeepCount);
  const backupKeepCount = Number.isInteger(configuredBackup) && configuredBackup > 0 ? configuredBackup : defaultKeep;

  const configuredManifest = Number(target?.manifestKeepCount);
  let manifestKeepCount = Number.isInteger(configuredManifest) && configuredManifest > 0 ? configuredManifest : backupKeepCount;

  if (manifestKeepCount < backupKeepCount) {
    manifestKeepCount = backupKeepCount;
  }

  return { backupKeepCount, manifestKeepCount };
}

/**
 * 判断错误是否为发布任务停止。
 * @param {unknown} error - 错误对象
 * @returns {boolean} 是否停止错误
 */
function isDeployStoppedError(error) {
  return Boolean(error && (error.name === 'DeployStoppedError' || error.code === 'DEPLOY_STOPPED'));
}

/**
 * 根据取消信号创建停止错误。
 * @param {AbortSignal} signal - 取消信号
 * @returns {DeployStoppedError} 停止错误
 */
function createDeployStoppedError(signal) {
  const reason = signal?.reason;
  if (isDeployStoppedError(reason)) return reason;
  const message = reason instanceof Error ? reason.message : String(reason || '发布任务已停止');
  return new DeployStoppedError(message);
}

/**
 * 检查发布任务是否已被停止。
 * @param {AbortSignal} signal - 取消信号
 */
function throwIfDeployStopped(signal) {
  if (signal?.aborted) throw createDeployStoppedError(signal);
}

/**
 * 生成发布版本号
 * @returns {string} 发布版本号
 */
function createReleaseName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 生成 SHA-256 哈希。
 * @param {string|Buffer} value - 原始内容
 * @returns {string} 哈希值
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 生成部署工作区路径。
 * @param {number|string} targetId - 部署目标 ID
 * @param {string} branch - 分支名
 * @returns {{workspaceRoot: string, repoDir: string, metaPath: string}} 工作区路径信息
 */
function resolveDeployWorkspace(targetId, branch) {
  const branchHash = sha256(String(branch || 'default')).slice(0, 16);
  const workspaceRoot = path.join(DEPLOY_DATA_DIR, 'cache', 'workspaces', String(targetId), branchHash);
  return {
    workspaceRoot,
    repoDir: path.join(workspaceRoot, 'repo'),
    metaPath: path.join(workspaceRoot, DEPENDENCY_CACHE_META_FILE),
  };
}

/**
 * 解析 npm registry 对应的认证配置 key。
 * @param {string} registry - npm 私服地址
 * @returns {string} npmrc 认证 key，格式为 //host/path/
 */
function resolveNpmAuthKey(registry) {
  try {
    const url = new URL(registry);
    const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return `//${url.host}${pathname}`;
  } catch {
    return '';
  }
}

/**
 * 根据容器环境变量生成临时 npm 配置。
 * @returns {string} npmrc 文件内容，空字符串表示未配置
 */
function createRuntimeNpmrcContent() {
  if (process.env.NPMRC_CONTENT) {
    return String(process.env.NPMRC_CONTENT).trim();
  }

  const registry = String(process.env.NPM_REGISTRY || '').trim();
  const token = String(process.env.NPM_AUTH_TOKEN || '').trim();
  if (!registry && !token) return '';

  const lines = [];
  if (registry) {
    lines.push(`registry=${registry}`);
  }
  lines.push(`always-auth=${process.env.NPM_ALWAYS_AUTH || 'true'}`);

  const authKey = resolveNpmAuthKey(registry);
  if (authKey && token) {
    lines.push(`${authKey}:_authToken=${token}`);
  }

  return lines.join('\n');
}

/**
 * 为本次发布准备临时 npm 认证配置与 CI 环境优化参数。
 * @param {string} repoDir - 本次发布 clone 出来的仓库目录
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @returns {Promise<Object>} 需要注入命令执行环境的变量
 */
export async function prepareRuntimeNpmConfig(repoDir, log) {
  const baseCiEnv = {
    CYPRESS_INSTALL_BINARY: '0',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  };
  const content = createRuntimeNpmrcContent();
  if (!content) return baseCiEnv;

  const npmrcPath = path.join(repoDir, '.yuyan.npmrc');
  await fs.writeFile(npmrcPath, `${content}\n`, { mode: 0o600 });
  log('info', '已注入运行时 npm 私服配置，用于本次依赖安装', 'install');
  return {
    ...baseCiEnv,
    NPM_CONFIG_USERCONFIG: npmrcPath,
  };
}

/**
 * 为老项目 prepare 脚本补齐 husky 占位文件。
 * @param {string} repoDir - 仓库目录
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 */
async function ensureLegacyHuskyPreparePlaceholder(repoDir, log) {
  const packageJsonPath = path.join(repoDir, 'package.json');
  const content = await fs.readFile(packageJsonPath, 'utf8').catch(() => '');
  if (!content) return;

  let packageJson = null;
  try {
    packageJson = JSON.parse(content);
  } catch {
    return;
  }

  const prepareScript = String(packageJson?.scripts?.prepare || '');
  if (!prepareScript.includes('husky')) return;

  const huskyDir = path.join(repoDir, '.husky');
  const entries = await fs.readdir(huskyDir).catch(() => []);
  const hasGlobMatchedEntry = entries.some((entry) => !entry.startsWith('.'));
  if (hasGlobMatchedEntry) return;

  await fs.mkdir(huskyDir, { recursive: true });
  await fs.writeFile(path.join(huskyDir, 'yuyan-deploy-placeholder'), '#!/bin/sh\n', { mode: 0o755 });
  log('warn', '检测到 prepare 脚本依赖 husky，但仓库缺少 .husky 钩子文件，已为本次发布补充临时占位文件', 'install');
}

/**
 * 标准化产物目录配置
 * @param {string} artifactDir - 用户配置的产物目录
 * @returns {string} 仓库内相对产物目录，空字符串表示自动识别
 */
function normalizeArtifactDir(artifactDir) {
  const configured = String(artifactDir || '').trim().replace(/\\/g, '/');
  if (!configured || configured === '.') return configured;
  return configured.replace(/^\/+/, '').replace(/\/+$/, '') || 'dist';
}

/**
 * 标准化远程部署目录。
 * @param {string} dirPath - 原始部署目录
 * @returns {string} 标准 POSIX 目录
 */
function normalizeDeployRoot(dirPath) {
  const normalized = path.posix.normalize(String(dirPath || '').trim().replace(/\\/g, '/'));
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

/**
 * 解析手动配置的保留子目录。
 * @param {string} value - 逗号分隔的目录名
 * @returns {string[]} 顶层目录名列表
 */
export function parsePreserveSubDirs(value) {
  const dirs = String(value || '')
    .split(/[,，]/)
    .map((item) => item.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .map((item) => item.split('/')[0])
    .filter((item) => isValidEntryName(item) && !['.yuyan-backups', DEPLOY_MANIFEST_DIR_NAME].includes(item));
  return [...new Set(dirs)];
}

/**
 * 标准化静态资源上传策略。
 * @param {string} value - 原始策略
 * @returns {'cleanReplace'|'overlayKeepAssets'} 上传策略
 */
export function normalizeUploadStrategy(value) {
  return value === DEPLOY_UPLOAD_STRATEGIES.cleanReplace ? DEPLOY_UPLOAD_STRATEGIES.cleanReplace : DEPLOY_UPLOAD_STRATEGIES.overlayKeepAssets;
}

/**
 * 获取静态资源上传策略展示文案。
 * @param {string} strategy - 上传策略
 * @returns {string} 展示文案
 */
function getUploadStrategyLabel(strategy) {
  return strategy === DEPLOY_UPLOAD_STRATEGIES.overlayKeepAssets ? '覆盖上传并保留旧资源' : '清空后替换';
}

/**
 * 获取 childRoot 相对 parentRoot 的顶层子目录。
 * @param {string} parentRoot - 父部署目录
 * @param {string} childRoot - 子部署目录
 * @returns {string} 顶层子目录名
 */
function getNestedDeploySubDir(parentRoot, childRoot) {
  let parent = '';
  let child = '';
  try {
    parent = normalizeDeployRootPath(parentRoot);
    child = normalizeDeployRootPath(childRoot);
  } catch {
    parent = normalizeDeployRoot(parentRoot);
    child = normalizeDeployRoot(childRoot);
  }
  const prefix = parent === '/' ? '/' : `${parent}/`;
  if (!child.startsWith(prefix) || child === parent) return '';
  return child.slice(prefix.length).split('/')[0] || '';
}

/**
 * 获取当前部署目标的受保护条目详情（包含来源）。
 * @param {Object} target - 当前部署目标
 * @param {Object} [options={}] - 配置项
 * @param {string} [options.currentRealRoot] - 当前目标的真实绝对路径（已解析软链接）
 * @param {Map<number, string>} [options.realRootsByTargetId] - 其他目标的真实路径映射
 * @returns {Promise<{
 *   manualEntries: string[],
 *   nestedEntries: string[],
 *   allProtected: string[],
 *   protectedList: Array<{ name: string, source: 'nested'|'manual' }>
 * }>} 受保护条目详情
 */
export async function resolveProtectedEntriesWithDetails(target, options = {}) {
  const manualEntries = parsePreserveSubDirs(target.preserveSubDirs);
  let targets = [];
  try {
    targets = await listPhysicalServerTargets({ serverId: target.serverId });
  } catch (error) {
    if (typeof options.log === 'function') {
      options.log('warn', `查询物理服务器部署目标失败，降级使用逻辑服务器目标：${error.message || error}`, 'upload');
    } else {
      console.warn(`[Deploy] 查询物理服务器部署目标失败，降级使用逻辑服务器目标：${error.message || error}`);
    }
    targets = await listTargets({ serverId: target.serverId });
  }

  const parentRoot = options.currentRealRoot || target.realDeployRoot || target.deployRoot;

  const nestedEntries = targets
    .filter((item) => Number(item.id) !== Number(target.id))
    .map((item) => {
      const childRoot = options.realRootsByTargetId?.get(item.id) || item.realDeployRoot || item.deployRoot;
      // 真实路径与配置路径双重判定，任一命中嵌套均视为受保护子应用
      return getNestedDeploySubDir(parentRoot, childRoot) || getNestedDeploySubDir(target.deployRoot, item.deployRoot);
    })
    .filter((item) => isValidEntryName(item) && !isReservedDeployEntry(item));

  const uniqueNested = [...new Set(nestedEntries)];
  const uniqueManual = [...new Set(manualEntries.filter((m) => !uniqueNested.includes(m)))];

  const protectedList = [
    ...uniqueNested.map((name) => ({ name, source: 'nested' })),
    ...uniqueManual.map((name) => ({ name, source: 'manual' })),
  ];

  const allProtected = [...new Set([...uniqueNested, ...uniqueManual])].sort();
  return {
    manualEntries: uniqueManual,
    nestedEntries: uniqueNested,
    allProtected,
    protectedList,
  };
}

/**
 * 获取当前部署目标需要保护的顶层子目录。
 * @param {Object} target - 当前部署目标
 * @param {Object} [options={}] - 配置项
 * @returns {Promise<string[]>} 保留子目录列表
 */
export async function resolveProtectedSubDirs(target, options = {}) {
  const details = await resolveProtectedEntriesWithDetails(target, options);
  return details.allProtected;
}

/**
 * 判断目录是否包含源码目录特征
 * @param {string[]} entries - 目录项名称
 * @returns {boolean} 是否源码目录
 */
function hasSourceDirMarkers(entries) {
  return ['package.json', 'src', 'vite.config.ts', 'vite.config.js', 'tsconfig.json'].some((name) => entries.includes(name));
}

/**
 * 判断目录是否像前端静态产物目录
 * @param {string} dirPath - 本地目录
 * @returns {Promise<boolean>} 是否静态产物目录
 */
async function isStaticArtifactDir(dirPath) {
  const stat = await fs.stat(dirPath).catch(() => null);
  if (!stat?.isDirectory()) return false;
  const entries = await fs.readdir(dirPath).catch(() => []);
  if (hasSourceDirMarkers(entries)) return false;
  const hasIndex = entries.includes('index.html');
  const hasStaticAssets = entries.some((name) => ['assets', 'static', 'js', 'css'].includes(name));
  return hasIndex && hasStaticAssets;
}

/**
 * 扫描仓库内的静态产物目录。
 * @param {string} repoDir - 仓库根目录
 * @returns {Promise<string[]>} 仓库相对产物目录列表
 */
async function discoverStaticArtifactDirs(repoDir) {
  const discovered = [];
  const walk = async (dirPath, depth) => {
    if (depth > 4 || discovered.length > 10) return;
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['node_modules', '.git', '.yuyan-deploy'].includes(entry.name)) continue;
      const child = path.join(dirPath, entry.name);
      if (await isStaticArtifactDir(child)) {
        discovered.push(path.relative(repoDir, child) || '.');
        continue;
      }
      await walk(child, depth + 1);
    }
  };
  await walk(repoDir, 1);
  return [...new Set(discovered)];
}

/**
 * 自动识别构建产物目录
 * @param {string} repoDir - 仓库根目录
 * @param {string} artifactDir - 用户配置的产物目录
 * @returns {Promise<{artifactPath: string, artifactDir: string}>} 产物目录信息
 */
async function resolveArtifactPath(repoDir, artifactDir) {
  const configured = normalizeArtifactDir(artifactDir);
  const shouldAutoResolve = !configured || configured.toLowerCase() === 'auto';
  const candidates = [];
  if (shouldAutoResolve) {
    candidates.push('dist', 'packages/dist', 'build', 'packages/build');
  } else {
    candidates.push(configured);
  }

  for (const candidate of candidates) {
    const artifactPath = path.resolve(repoDir, candidate);
    if (await isStaticArtifactDir(artifactPath)) {
      return { artifactPath, artifactDir: candidate };
    }
  }

  if (!shouldAutoResolve) {
    const discovered = await discoverStaticArtifactDirs(repoDir);
    const suggestion = discovered.length
      ? `已自动发现合法产物目录：${discovered.join('、')}。建议将产物目录改为 ${discovered[0]}，或留空让系统自动识别。`
      : '本次构建后未自动发现合法静态产物目录。请确认构建命令已输出 index.html 和 assets/js/css/static。';
    throw new Error(`配置的产物目录 ${configured} 不存在或不是合法静态产物目录。${suggestion}`);
  }

  const discovered = await discoverStaticArtifactDirs(repoDir);

  if (discovered.length) {
    const artifactDir = discovered[0];
    return { artifactPath: path.resolve(repoDir, artifactDir), artifactDir };
  }

  throw new Error(`构建产物目录不存在或未找到 index.html/assets。已检查：${[...new Set(candidates)].join('、')}`);
}

/**
 * 生成 tar 打包排除参数。
 * @param {string[]} protectedSubDirs - 保留的顶层子目录
 * @param {string[]} deferredRootFileNames - 需要延后发布的根目录文件名
 * @returns {string} tar 排除参数
 */
export function buildLocalTarExcludeArgs(protectedSubDirs = [], deferredRootFileNames = []) {
  return [
    ...protectedSubDirs.flatMap((name) => [`./${name}`, `./${name}/*`]),
    ...deferredRootFileNames.map((name) => `./${name}`),
  ]
    .map((pattern) => `--exclude=${shellQuote(pattern)}`)
    .join(' ');
}

/**
 * 统计可上传的产物文件数量。
 * @param {string} localDir - 本地产物目录
 * @param {string[]} protectedSubDirs - 需要跳过的顶层目录
 * @returns {Promise<number>} 文件数量
 */
async function countUploadableArtifactFiles(localDir, protectedSubDirs = []) {
  return (await collectUploadableArtifactFiles(localDir, protectedSubDirs)).length;
}

/**
 * 收集可上传产物文件相对路径。
 * @param {string} localDir - 本地产物目录
 * @param {string[]} protectedSubDirs - 需要跳过的顶层目录
 * @returns {Promise<string[]>} 相对文件路径列表
 */
async function collectUploadableArtifactFiles(localDir, protectedSubDirs = []) {
  const excluded = new Set((protectedSubDirs || []).map((name) => String(name || '').trim()).filter(Boolean));
  const files = [];

  /**
   * 递归统计目录文件。
   * @param {string} currentDir - 当前目录
   * @param {boolean} rootLevel - 是否产物根目录
   */
  const walk = async (currentDir, rootLevel) => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (rootLevel && excluded.has(entry.name)) continue;
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, false);
        continue;
      }
      if (entry.isFile()) {
        files.push(path.relative(localDir, entryPath).replace(/\\/g, '/'));
      }
    }
  };

  await walk(localDir, true);
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * 创建本地产物压缩包。
 * @param {string} artifactPath - 本地产物目录
 * @param {string} archivePath - 压缩包路径
 * @param {string[]} protectedSubDirs - 需要跳过的顶层目录
 * @param {AbortSignal} signal - 停止信号
 * @param {string[]} deferredRootFileNames - 需要延后发布的根目录文件名
 * @returns {Promise<void>}
 */
async function createArtifactArchive(artifactPath, archivePath, protectedSubDirs = [], signal, deferredRootFileNames = []) {
  await fs.rm(archivePath, { force: true }).catch(() => {});
  const excludeArgs = buildLocalTarExcludeArgs(protectedSubDirs, deferredRootFileNames);
  await runLocalCommand(`tar -czf ${shellQuote(archivePath)} ${excludeArgs} -C ${shellQuote(artifactPath)} .`, {
    label: '打包发布产物',
    signal,
  });
}

/**
 * 使用 sudo 解压远程产物包。
 * @param {Object} conn - SSH 连接
 * @param {string} remoteArchivePath - 远程压缩包路径
 * @param {string} remoteDir - 远程部署目录
 * @returns {Promise<void>}
 */
async function extractRemoteArchiveWithSudo(conn, remoteArchivePath, remoteDir) {
  const primary = await execSsh(conn, `sudo -n tar --no-same-owner -xzf ${shellQuote(remoteArchivePath)} -C ${shellQuote(remoteDir)}`, {
    allowFailure: true,
    label: '解压发布产物',
  });
  if (primary.code === 0) return;

  const primaryOutput = `${primary.stderr || ''}${primary.stdout || ''}`;
  const unsupportedNoSameOwner = /no-same-owner|unrecognized option|unknown option|illegal option/i.test(primaryOutput);
  if (unsupportedNoSameOwner) {
    const fallback = await execSsh(conn, `sudo -n tar -xzf ${shellQuote(remoteArchivePath)} -C ${shellQuote(remoteDir)}`, {
      allowFailure: true,
      label: '解压发布产物',
    });
    if (fallback.code === 0) return;
    throw new Error(`解压发布产物执行失败，退出码 ${fallback.code}\n${fallback.stderr || fallback.stdout}`);
  }

  throw new Error(`解压发布产物执行失败，退出码 ${primary.code}\n${primary.stderr || primary.stdout}`);
}

/**
 * 通过 /tmp 临时包和 sudo tar 上传产物。
 * @param {Object} conn - SSH 连接
 * @param {string} artifactPath - 本地产物目录
 * @param {string} remoteDir - 远程部署目录
 * @param {Object} options - 上传选项
 * @param {string} options.archivePath - 本地压缩包路径
 * @param {string} options.releaseName - 发布版本名
 * @param {string[]} options.protectedSubDirs - 需要跳过的顶层目录
 * @param {AbortSignal} options.signal - 停止信号
 * @param {(level: string, message: string, stage?: string) => void} options.log - 日志函数
 * @param {string[]} options.deferRootFileNames - 需要延后发布的根目录文件名
 * @returns {Promise<number>} 上传文件数量
 */
async function uploadDirectoryWithSudoTar(conn, artifactPath, remoteDir, options = {}) {
  const protectedSubDirs = options.protectedSubDirs || [];
  const archivePath = options.archivePath;
  const releaseName = options.releaseName || createReleaseName();
  const remoteArchivePath = `/tmp/yuyan-deploy-${releaseName}-${Math.random().toString(16).slice(2)}.tar.gz`;
  const deferRootFileNames = options.deferRootFileNames || [];
  const deferredTempPaths = [];
  if (!archivePath) throw new Error('sudo 上传产物缺少本地临时压缩包路径');
  const fileCount = await countUploadableArtifactFiles(artifactPath, protectedSubDirs);

  try {
    await createArtifactArchive(artifactPath, archivePath, protectedSubDirs, options.signal, deferRootFileNames);
    options.log?.('info', `已打包发布产物：${fileCount} 个文件`, 'upload');
    await uploadFile(conn, archivePath, remoteArchivePath);
    options.log?.('info', `产物包已上传到临时目录：${remoteArchivePath}`, 'upload');
    await extractRemoteArchiveWithSudo(conn, remoteArchivePath, remoteDir);
    for (const fileName of deferRootFileNames) {
      const localEntryPath = path.join(artifactPath, fileName);
      const entryStat = await fs.stat(localEntryPath).catch(() => null);
      if (!entryStat?.isFile()) continue;
      const remoteTempPath = `/tmp/yuyan-deploy-entry-${releaseName}-${Math.random().toString(16).slice(2)}-${path.basename(fileName)}`;
      deferredTempPaths.push(remoteTempPath);
      await uploadFile(conn, localEntryPath, remoteTempPath);
      await execSsh(conn, `sudo -n cp ${shellQuote(remoteTempPath)} ${shellQuote(path.posix.join(remoteDir, fileName))}`, {
        label: `发布入口文件 ${fileName}`,
      });
      options.log?.('info', `已最后发布入口文件：${fileName}`, 'upload');
    }
    return fileCount;
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => {});
    await execSsh(conn, `rm -f ${shellQuote(remoteArchivePath)}`, {
      allowFailure: true,
      label: '清理远程临时产物包',
    }).catch(() => {});
    if (deferredTempPaths.length) {
      await execSsh(conn, `rm -f ${deferredTempPaths.map((filePath) => shellQuote(filePath)).join(' ')}`, {
        allowFailure: true,
        label: '清理远程入口临时文件',
      }).catch(() => {});
    }
  }
}

/**
 * 创建本次发布产物清单文件。
 * 强制过滤掉顶层为受保护子目录或系统保留目录的文件，确保不会记录雨燕未发布项。
 * @param {string} workspaceRoot - 发布工作区
 * @param {string} releaseName - 发布版本号
 * @param {string[]} relativeFiles - 本次上传文件相对路径
 * @param {string[]} [protectedSubDirs=[]] - 受保护的顶层子目录
 * @returns {Promise<string>} 本地清单路径
 */
export async function createArtifactManifestFile(workspaceRoot, releaseName, relativeFiles, protectedSubDirs = []) {
  const manifestPath = path.join(workspaceRoot, `artifact-manifest-${releaseName}.txt`);
  const safeFiles = filterManifestRelativeFiles(relativeFiles, protectedSubDirs);
  const content = safeFiles.length ? `${safeFiles.join('\n')}\n` : '';
  await fs.writeFile(manifestPath, content, 'utf8');
  return manifestPath;
}

/**
 * 上传发布产物清单到部署目录。
 * @param {Object} conn - SSH 连接
 * @param {string} manifestPath - 本地清单路径
 * @param {Object} target - 部署目标
 * @param {string} releaseName - 发布版本号
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {Promise<string>} 远程清单路径
 */
async function uploadArtifactManifest(conn, manifestPath, target, releaseName, useSudo = false) {
  const manifestDir = path.posix.join(target.deployRoot, DEPLOY_MANIFEST_DIR_NAME);
  const remoteManifestPath = path.posix.join(manifestDir, `${releaseName}.txt`);
  const currentManifestPath = path.posix.join(manifestDir, DEPLOY_CURRENT_MANIFEST_NAME);
  if (!useSudo) {
    await uploadFile(conn, manifestPath, remoteManifestPath);
    await execSsh(conn, `cp -f ${shellQuote(remoteManifestPath)} ${shellQuote(currentManifestPath)}`, {
      allowFailure: true,
      label: '更新当前产物清单指针',
    }).catch(() => {});
    return remoteManifestPath;
  }

  const remoteTempPath = `/tmp/yuyan-deploy-manifest-${releaseName}-${Math.random().toString(16).slice(2)}.txt`;
  await uploadFile(conn, manifestPath, remoteTempPath);
  try {
    await execSsh(
      conn,
      [
        buildRemoteMkdirCommand(manifestDir, true),
        `sudo -n cp ${shellQuote(remoteTempPath)} ${shellQuote(remoteManifestPath)}`,
        `sudo -n chmod 644 ${shellQuote(remoteManifestPath)}`,
        `sudo -n cp ${shellQuote(remoteManifestPath)} ${shellQuote(currentManifestPath)}`,
        `sudo -n chmod 644 ${shellQuote(currentManifestPath)}`,
      ].join(' && '),
      { label: '写入发布产物清单' }
    );
    return remoteManifestPath;
  } finally {
    await execSsh(conn, `rm -f ${shellQuote(remoteTempPath)}`, {
      allowFailure: true,
      label: '清理远程临时产物清单',
    }).catch(() => {});
  }
}

/**
 * 构建按发布清单与现存备份快照清理旧静态资源的远程 shell 命令。
 * 保护白名单包含：最近 keepCount 份清单、当前运行清单 current.txt、以及所有现存备份目录下的 .manifest.txt。
 * 彻底解决「备份存上一版清单、清单比备份早一个版本」导致的差一误删 chunk 问题。
 * @param {string} deployRoot - 部署根目录
 * @param {number} keepCount - 清单保留数量
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildPruneRemoteArtifactManifestsCommand(deployRoot, keepCount, useSudo = false) {
  const script = [
    'set -eu',
    'root="$1"',
    'keep="$2"',
    `manifest_dir="$root/${DEPLOY_MANIFEST_DIR_NAME}"`,
    'if [ ! -d "$manifest_dir" ]; then echo "deleted_files=0 deleted_manifests=0"; exit 0; fi',
    'tmp_all=$(mktemp)',
    'tmp_recent_raw=$(mktemp)',
    'tmp_recent=$(mktemp)',
    'tmp_stale_files=$(mktemp)',
    'tmp_stale_manifests=$(mktemp)',
    'tmp_delete=$(mktemp)',
    'cleanup() { rm -f "$tmp_all" "$tmp_recent_raw" "$tmp_recent" "$tmp_stale_files" "$tmp_stale_manifests" "$tmp_delete"; }',
    'trap cleanup EXIT',
    `find "$manifest_dir" -maxdepth 1 -type f -name "*.txt" ! -name "${DEPLOY_CURRENT_MANIFEST_NAME}" | sort > "$tmp_all"`,
    'total=$(wc -l < "$tmp_all" | tr -d " ")',
    'if [ "$total" -le "$keep" ]; then echo "deleted_files=0 deleted_manifests=0"; exit 0; fi',
    'stale_count=$((total - keep))',
    'tail -n "$keep" "$tmp_all" | while IFS= read -r manifest; do [ -f "$manifest" ] && cat "$manifest"; done >> "$tmp_recent_raw"',
    `if [ -f "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then`,
    `  cat "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" >> "$tmp_recent_raw"`,
    'fi',
    'if [ -d "$root/.yuyan-backups" ]; then',
    `  find "$root/.yuyan-backups" -mindepth 2 -maxdepth 2 -type f -name "${BACKUP_MANIFEST_FILE_NAME}" 2>/dev/null | while IFS= read -r b_manifest; do`,
    '    [ -f "$b_manifest" ] && cat "$b_manifest"',
    '  done >> "$tmp_recent_raw"',
    'fi',
    'sed "/^$/d" "$tmp_recent_raw" | sort -u > "$tmp_recent"',
    'head -n "$stale_count" "$tmp_all" > "$tmp_stale_manifests"',
    'while IFS= read -r manifest; do [ -f "$manifest" ] && cat "$manifest"; done < "$tmp_stale_manifests" | sed "/^$/d" | sort -u > "$tmp_stale_files"',
    'if [ -s "$tmp_recent" ]; then grep -Fvx -f "$tmp_recent" "$tmp_stale_files" > "$tmp_delete" || true; else cp "$tmp_stale_files" "$tmp_delete"; fi',
    'deleted_files=0',
    'while IFS= read -r rel; do',
    '  case "$rel" in ""|/*|*../*|../*|.*|*/.*) continue ;; esac',
    '  if [ -f "$root/$rel" ]; then rm -f "$root/$rel" && deleted_files=$((deleted_files + 1)); fi',
    'done < "$tmp_delete"',
    'deleted_manifests=0',
    'while IFS= read -r manifest; do rm -f "$manifest" && deleted_manifests=$((deleted_manifests + 1)); done < "$tmp_stale_manifests"',
    'echo "deleted_files=$deleted_files deleted_manifests=$deleted_manifests"',
  ].join('\n');
  return buildRemoteShellCommand(script, [deployRoot, String(keepCount)], useSudo);
}

/**
 * 按最近发布清单及现存备份引用清理旧静态资源。
 * @param {Object} conn - SSH 连接
 * @param {Object} target - 部署目标
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {Promise<boolean>} 是否清理成功
 */
async function pruneRemoteArtifactManifests(conn, target, log, useSudo = false) {
  const { manifestKeepCount: keepCount } = resolveDeployRetentionCounts(target);
  const command = buildPruneRemoteArtifactManifestsCommand(target.deployRoot, keepCount, useSudo);
  const result = await execSsh(conn, command, {
    allowFailure: true,
    label: `保留最近 ${keepCount} 次发布及现存备份静态资源`,
  });
  if (result.code !== 0) {
    log('warn', `旧静态资源清理失败：${result.stderr || result.stdout || `退出码 ${result.code}`}`, 'cleanup');
    return false;
  }
  const output = String(result.stdout || '').trim();
  log('info', `已执行静态资源保留策略：最近 ${keepCount} 次发布及现存备份引用；${output || 'deleted_files=0 deleted_manifests=0'}`, 'cleanup');
  return true;
}

/**
 * 过滤命令执行失败时 stderr 中的打包期无关告警噪音（如 Rollup "use client" 忽略提示、分包体积提示等），保留核心错误上下文。
 * @param {string} rawOutput - 原始错误或标准输出
 * @returns {string} 精简后的错误输出
 */
function summarizeCommandFailureOutput(rawOutput) {
  const raw = stripAnsi(rawOutput);
  if (!raw.includes('\n')) return raw;
  const lines = raw.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.includes('Module level directives cause errors when bundled') && trimmed.includes('was ignored')) {
      return false;
    }
    if (trimmed.startsWith('<script') && trimmed.includes("can't be bundled")) return false;
    if (trimmed.startsWith('(!) Some chunks are larger than')) return false;
    if (
      trimmed.startsWith('- Using dynamic import()') ||
      trimmed.startsWith('- Use build.rollupOptions') ||
      trimmed.startsWith('- Adjust chunk size')
    ) {
      return false;
    }
    return true;
  });
  return filtered.length > 0 ? filtered.join('\n') : raw;
}

/**
 * 执行本地命令
 * @param {string} command - 命令
 * @param {Object} options - 选项
 * @returns {Promise<{stdout: string, stderr: string}>} 执行结果
 */
function runLocalCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createDeployStoppedError(options.signal));
      return;
    }

    const { cleanedCommand } = extractInlineCommandEnv(command);
    const executableCommand = cleanedCommand || command;

    const child = spawn(executableCommand, withHiddenWindow({
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildIsolatedCommandEnv(options.env || {}, {
        command,
        maxOldSpaceMb: options.maxOldSpaceMb,
      }),
      detached: process.platform !== 'win32',
    }));
    applyLowProcessPriority(child.pid);
    const rssSampler = options.onPeakRssMb
      ? createProcessTreeRssSampler(child.pid, {
          onPeak: (peakMb) => options.onPeakRssMb?.(peakMb),
        })
      : null;

    let stdout = '';
    let stderr = '';
    let stopped = false;
    let killTimer = null;
    let lastOutputSampleAt = 0;

    const triggerOutputRssSample = () => {
      if (!rssSampler) return;
      const nowMs = Date.now();
      if (nowMs - lastOutputSampleAt >= 500) {
        lastOutputSampleAt = nowMs;
        void rssSampler.sampleOnce();
      }
    };

    const cleanupAbortListener = () => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener?.('abort', handleAbort);
    };

    const killChildTree = (signalName) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill(signalName);
          return;
        }
        process.kill(-child.pid, signalName);
      } catch {
        child.kill(signalName);
      }
    };

    const handleAbort = () => {
      stopped = true;
      options.onLog?.('warn', '已收到停止指令，正在终止当前命令');
      killChildTree('SIGTERM');
      killTimer = setTimeout(() => killChildTree('SIGKILL'), 3000);
    };

    options.signal?.addEventListener?.('abort', handleAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      triggerOutputRssSample();
      const text = chunk.toString();
      stdout += text;
      for (const line of splitProcessOutputLines(text)) options.onLog?.('info', line, TOOL_LOG_SOURCE);
    });

    child.stderr?.on('data', (chunk) => {
      triggerOutputRssSample();
      const text = chunk.toString();
      stderr += text;
      // stderr 不等于告警：vite / pnpm / git 会把正常进度写入 stderr，按内容判定级别
      for (const line of splitProcessOutputLines(text)) options.onLog?.(resolveStderrLogLevel(line), line, TOOL_LOG_SOURCE);
    });

    child.on('error', async (error) => {
      cleanupAbortListener();
      await rssSampler?.stop();
      reject(stopped || options.signal?.aborted ? createDeployStoppedError(options.signal) : error);
    });
    child.on('close', async (code) => {
      cleanupAbortListener();
      await rssSampler?.stop();
      if (stopped || options.signal?.aborted) {
        reject(createDeployStoppedError(options.signal));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const failureOutput = summarizeCommandFailureOutput(stderr || stdout);
      reject(new Error(`${options.label || command} 执行失败，退出码 ${code}\n${failureOutput}`));
    });
  });
}

/**
 * 拆分多行命令文本。
 * @param {string} commandText - 命令文本
 * @returns {string[]} 命令列表
 */
function splitCommandList(commandText) {
  return String(commandText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 按顺序执行多行本地命令。
 * @param {string} commandText - 多行命令文本
 * @param {Object} options - 执行选项
 * @returns {Promise<{stdout: string, stderr: string}>} 合并后的执行结果
 */
async function runLocalCommandList(commandText, options = {}) {
  const commands = splitCommandList(commandText);
  if (!commands.length) throw new Error(`${options.label || '命令'}不能为空`);
  if (commands.length === 1) return runLocalCommand(commands[0], options);

  const outputs = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const label = `${options.label || '命令'} ${index + 1}/${commands.length}`;
    options.onLog?.('info', `执行${label}：${command}`);
    outputs.push(
      await runLocalCommand(command, {
        ...options,
        label,
      })
    );
  }
  return {
    stdout: outputs.map((item) => item.stdout).join('\n'),
    stderr: outputs.map((item) => item.stderr).join('\n'),
  };
}

/**
 * 判断目录是否为可复用 Git 工作区。
 * @param {string} repoDir - 仓库目录
 * @returns {Promise<boolean>} 是否 Git 工作区
 */
async function isGitWorkspace(repoDir) {
  const stat = await fs.stat(path.join(repoDir, '.git')).catch(() => null);
  return Boolean(stat?.isDirectory());
}

/**
 * 将持久发布工作区恢复到目标分支最新提交，同时保留 node_modules。
 * @param {Object} options - 工作区参数
 * @param {Object} options.target - 部署目标
 * @param {string} options.branch - 发布分支
 * @param {string} options.cloneUrl - 带认证的仓库地址
 * @param {string} options.repoDir - 本地仓库目录
 * @param {AbortSignal} options.signal - 停止信号
 * @param {(level: string, message: string, stage?: string) => void} options.log - 日志函数
 */
async function syncDeployWorkspace({ target, branch, cloneUrl, repoDir, signal, log }) {
  const hasWorkspace = await isGitWorkspace(repoDir);
  if (!hasWorkspace) {
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.dirname(repoDir), { recursive: true });
    log('info', '未找到可复用发布工作区，正在首次克隆仓库', 'clone');
    await runLocalCommand(`git clone --depth 1 --branch ${shellQuote(branch)} ${shellQuote(cloneUrl)} ${shellQuote(repoDir)}`, {
      label: 'git clone',
      onLog: (level, message, source) => log(level, message, 'clone', source),
      signal,
    });
    await runLocalCommand(`git remote set-url origin ${shellQuote(target.repositoryUrl)}`, {
      cwd: repoDir,
      label: '重置仓库远程地址',
      signal,
    }).catch(() => {});
    return;
  }

  log('info', '复用发布工作区，正在同步目标分支最新代码', 'clone');
  try {
    await runLocalCommand(`git remote set-url origin ${shellQuote(cloneUrl)}`, { cwd: repoDir, label: '设置仓库远程地址', signal });
    await runLocalCommand(`git fetch --depth 1 origin ${shellQuote(branch)}`, {
      cwd: repoDir,
      label: 'git fetch',
      onLog: (level, message, source) => log(level, message, 'clone', source),
      signal,
    });
    await runLocalCommand('git reset --hard', { cwd: repoDir, label: '重置工作区', signal });
    await runLocalCommand(`git clean -fdx ${GIT_CLEAN_NODE_MODULES_EXCLUDES}`, { cwd: repoDir, label: '清理构建残留', signal });
    await runLocalCommand(`git checkout -B ${shellQuote(branch)} FETCH_HEAD`, { cwd: repoDir, label: '切换发布分支', signal });
    await runLocalCommand('git reset --hard FETCH_HEAD', { cwd: repoDir, label: '重置到最新提交', signal });
    await runLocalCommand(`git clean -fdx ${GIT_CLEAN_NODE_MODULES_EXCLUDES}`, { cwd: repoDir, label: '清理构建残留', signal });
  } finally {
    await runLocalCommand(`git remote set-url origin ${shellQuote(target.repositoryUrl)}`, {
      cwd: repoDir,
      label: '还原仓库远程地址',
      signal,
    }).catch(() => {});
  }
}

/**
 * 标准化安装命令展示与指纹输入。
 * @param {string} command - 安装命令
 * @returns {string} 标准化命令
 */
function normalizeInstallCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ');
}

/**
 * 判断安装命令是否包含 shell 串联或自定义副作用。
 * @param {string} command - 安装命令
 * @returns {boolean} 是否包含控制符
 */
function hasShellControlOperator(command) {
  return /[\n;&|]/.test(String(command || ''));
}

/**
 * 从安装命令中推断包管理器。
 * @param {string} command - 安装命令
 * @returns {string} 包管理器名称
 */
function inferPackageManager(command) {
  const tokens = normalizeInstallCommand(command).split(/\s+/).filter(Boolean);
  const manager = tokens[0] === 'corepack' ? tokens[1] : tokens[0];
  return ['pnpm', 'npm', 'yarn', 'bun'].includes(manager) ? manager : '';
}

/**
 * 判断安装命令是否为可安全跳过的标准依赖安装命令。
 * 支持 yarn、yarn [flags...]、yarn install [flags...]（flags 可在 action 前后）等规范写法。
 * @param {string} command - 安装命令
 * @returns {boolean} 是否标准安装命令
 */
export function isStandardInstallCommand(command) {
  if (splitCommandList(command).length !== 1) return false;
  const normalized = normalizeInstallCommand(command);
  if (!normalized || hasShellControlOperator(normalized)) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const managerIndex = tokens[0] === 'corepack' ? 1 : 0;
  const manager = tokens[managerIndex];
  if (!['pnpm', 'npm', 'yarn', 'bun'].includes(manager)) return false;

  const args = tokens.slice(managerIndex + 1);
  const subcommands = args.filter((token) => !token.startsWith('-'));

  if (manager === 'yarn') {
    return subcommands.length === 0 || (subcommands.length === 1 && subcommands[0] === 'install');
  }
  if (manager === 'npm') {
    return subcommands.length === 1 && ['install', 'i', 'ci'].includes(subcommands[0]);
  }
  if (manager === 'pnpm') {
    return subcommands.length === 0 || (subcommands.length === 1 && ['install', 'i'].includes(subcommands[0]));
  }
  if (manager === 'bun') {
    return subcommands.length === 0 || (subcommands.length === 1 && ['install', 'i'].includes(subcommands[0]));
  }
  return false;
}

/**
 * 获取包管理器版本。
 * @param {string} command - 安装命令
 * @param {string} cwd - 执行目录
 * @param {AbortSignal} signal - 停止信号
 * @returns {Promise<{packageManager: string, packageManagerVersion: string}>} 包管理器信息
 */
async function resolvePackageManagerInfo(command, cwd, signal) {
  if (splitCommandList(command).length !== 1) return { packageManager: '', packageManagerVersion: 'unknown' };
  const packageManager = inferPackageManager(command);
  if (!packageManager) return { packageManager: '', packageManagerVersion: 'unknown' };
  const tokens = normalizeInstallCommand(command).split(/\s+/).filter(Boolean);
  const versionCommand = tokens[0] === 'corepack' ? `corepack ${packageManager} --version` : `${packageManager} --version`;
  const result = await runLocalCommand(versionCommand, {
    cwd,
    label: `获取 ${packageManager} 版本`,
    signal,
  }).catch(() => null);
  return {
    packageManager,
    packageManagerVersion: result?.stdout?.trim()?.split(/\s+/)[0] || 'unknown',
  };
}

/**
 * 收集依赖指纹输入文件。
 * @param {string} repoDir - 仓库目录
 * @returns {Promise<string[]>} 绝对文件路径列表
 */
async function collectDependencyInputFiles(repoDir) {
  const files = [];
  const walk = async (dirPath, inPatchesDir = false) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (DEPENDENCY_SCAN_SKIP_DIRS.has(entry.name)) continue;
        await walk(childPath, inPatchesDir || entry.name === 'patches');
        continue;
      }
      if (!entry.isFile()) continue;
      if (inPatchesDir || DEPENDENCY_INPUT_FILE_NAMES.has(entry.name)) {
        files.push(childPath);
      }
    }
  };
  await walk(repoDir);
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * 生成依赖缓存指纹。
 * @param {Object} options - 指纹参数
 * @param {string} options.repoDir - 仓库目录
 * @param {string} options.installCommand - 安装命令
 * @param {AbortSignal} options.signal - 停止信号
 * @returns {Promise<Object>} 依赖指纹信息
 */
async function createDependencyCacheFingerprint({ repoDir, installCommand, signal }) {
  const files = await collectDependencyInputFiles(repoDir);
  const runtimeNpmConfigHash = sha256(createRuntimeNpmrcContent());
  const packageManagerInfo = await resolvePackageManagerInfo(installCommand, repoDir, signal);
  const header = {
    installCommand: normalizeInstallCommand(installCommand),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    runtimeNpmConfigHash,
    ...packageManagerInfo,
  };
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(header));
  for (const filePath of files) {
    const relativePath = path.relative(repoDir, filePath).replace(/\\/g, '/');
    const content = await fs.readFile(filePath);
    hash.update('\0');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(content);
  }
  return {
    ...header,
    dependencyCacheKey: hash.digest('hex'),
    hasLockfile: files.some((filePath) => DEPENDENCY_LOCK_FILE_NAMES.has(path.basename(filePath))),
    inputFileCount: files.length,
  };
}

/**
 * 判断 node_modules 是否可作为依赖缓存。
 * @param {string} repoDir - 仓库目录
 * @returns {Promise<boolean>} 是否存在可用依赖目录
 */
async function hasUsableNodeModules(repoDir) {
  const nodeModulesPath = path.join(repoDir, 'node_modules');
  const stat = await fs.stat(nodeModulesPath).catch(() => null);
  if (!stat?.isDirectory()) return false;
  const entries = await fs.readdir(nodeModulesPath).catch(() => []);
  return entries.length > 0;
}

/**
 * 读取依赖缓存元信息。
 * @param {string} metaPath - 元信息路径
 * @returns {Promise<Object|null>} 元信息
 */
async function readDependencyCacheMeta(metaPath) {
  const content = await fs.readFile(metaPath, 'utf8').catch(() => '');
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 写入依赖缓存元信息。
 * @param {string} metaPath - 元信息路径
 * @param {Object} meta - 元信息
 */
async function writeDependencyCacheMeta(metaPath, meta) {
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * 清理仓库中的 node_modules 依赖目录。
 * @param {string} repoDir - 仓库目录
 */
async function removeDependencyInstallArtifacts(repoDir) {
  const walk = async (dirPath) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPath = path.join(dirPath, entry.name);
      if (entry.name === '.git') continue;
      if (entry.name === 'node_modules') {
        await fs.rm(childPath, { recursive: true, force: true });
        continue;
      }
      await walk(childPath);
    }
  };
  await walk(repoDir);
}

/**
 * 执行依赖安装命令，在检测到 Yarn 全局缓存损坏时自动清理并重试。
 * @param {Object} options - 安装参数
 * @param {string} options.command - 安装命令
 * @param {string} options.cwd - 执行目录
 * @param {Object} options.env - 环境变量
 * @param {AbortSignal} [options.signal] - 停止信号
 * @param {(level: string, message: string, stage?: string) => void} options.log - 日志函数
 */
export async function executeDependencyInstallWithHealing({ command, cwd, env, signal, log }) {
  try {
    await runLocalCommandList(command, {
      cwd,
      env,
      label: '安装依赖',
      onLog: (level, message, source) => log(level, message, 'install', source),
      signal,
    });
  } catch (error) {
    const combinedOutput = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`;
    const isYarnMetadataCorrupted =
      combinedOutput.includes('Unexpected end of JSON input') &&
      (combinedOutput.includes('.yarn-metadata.json') || combinedOutput.includes('.cache/yarn'));

    if (isYarnMetadataCorrupted && !signal?.aborted) {
      log('warn', '检测到 Yarn 全局缓存损坏（.yarn-metadata.json 出现 Unexpected end of JSON input），正在自动清理全局缓存并重新安装...', 'install');
      await runLocalCommand('yarn cache clean', {
        cwd,
        env,
        label: '清理损坏的 Yarn 全局缓存',
        signal,
      }).catch((cleanErr) => {
        log('warn', `执行 yarn cache clean 遇到异常: ${cleanErr.message}，将直接重试依赖安装`, 'install');
      });

      log('info', '正在进行依赖安装重试（第 2 次）...', 'install');
      await runLocalCommandList(command, {
        cwd,
        env,
        label: '安装依赖（重试）',
        onLog: (level, message, source) => log(level, message, 'install', source),
        signal,
      });
      log('success', '依赖安装重试成功，Yarn 缓存损坏已自动自愈', 'install');
      return;
    }

    throw error;
  }
}

/**
 * 生成依赖安装执行计划。
 * @param {Object} options - 计划参数
 * @param {string} options.repoDir - 仓库目录
 * @param {string} options.metaPath - 缓存元信息路径
 * @param {Object} options.target - 部署目标
 * @param {string} options.branch - 分支
 * @param {string} options.commitSha - Commit SHA
 * @param {boolean} options.forceInstallDependencies - 是否强制重新安装
 * @param {AbortSignal} options.signal - 停止信号
 * @returns {Promise<Object>} 依赖安装计划
 */
async function resolveDependencyInstallPlan({ repoDir, metaPath, target, branch, commitSha, forceInstallDependencies, signal }) {
  const fingerprint = await createDependencyCacheFingerprint({ repoDir, installCommand: target.installCommand, signal });
  const cacheMeta = await readDependencyCacheMeta(metaPath);
  const nodeModulesReady = await hasUsableNodeModules(repoDir);
  const standardInstallCommand = isStandardInstallCommand(target.installCommand);
  const cacheable = standardInstallCommand && fingerprint.hasLockfile;
  const reasons = [];

  if (forceInstallDependencies) reasons.push('已选择本次重新安装依赖');
  if (!standardInstallCommand) reasons.push('安装命令包含自定义逻辑');
  if (!fingerprint.hasLockfile) reasons.push('未检测到依赖锁文件');
  if (!nodeModulesReady) reasons.push('依赖目录不存在');
  if (!cacheMeta?.dependencyCacheKey) {
    reasons.push('未找到依赖缓存记录');
  } else if (cacheMeta.dependencyCacheKey !== fingerprint.dependencyCacheKey) {
    reasons.push('依赖指纹已变化');
  }

  return {
    ...fingerprint,
    branch,
    commitSha,
    cacheMeta,
    cacheable,
    nodeModulesReady,
    standardInstallCommand,
    shouldInstall: reasons.length > 0,
    reasons: [...new Set(reasons)],
  };
}

/**
 * 获取可 clone 的仓库地址
 * @param {string} repositoryUrl - 仓库 URL
 * @param {string} token - GitLab token
 * @returns {string} 认证后的仓库 URL
 */
function resolveCloneUrl(repositoryUrl, token) {
  if (!token || !/^https?:\/\//i.test(repositoryUrl)) return repositoryUrl;
  return buildAuthUrl(repositoryUrl, token);
}

/**
 * 从仓库地址提取 GitLab 服务地址。
 * @param {string} repositoryUrl - 仓库 URL
 * @returns {string} GitLab 服务地址
 */
function resolveGitlabHost(repositoryUrl) {
  try {
    const url = new URL(repositoryUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/**
 * 读取目标及服务器，并根据路径自动推导最合适的有效 Nginx 实例
 * @param {number} targetId - 部署目标 ID
 * @returns {Promise<{target: Object, server: Object, nginxInstance: Object}>} 目标、服务器和有效 Nginx 实例
 */
export async function getTargetContext(targetId) {
  const target = await getTarget(targetId);
  if (!target) throw new Error('部署目标不存在');
  const server = await getServerWithCredential(target.serverId);
  if (!server) throw new Error('部署服务器不存在');
  let nginxInstance = target.nginxInstanceId ? await getNginxInstance(target.nginxInstanceId) : null;
  if (!nginxInstance && target.projectType !== 'backend') throw new Error('部署目标未绑定 Nginx 实例，请编辑部署目标后重试');
  if (!nginxInstance) return { target, server, nginxInstance: null };

  // 如果绑定的不是托管实例，但配置文件的路径位于托管路径下（例如以 /opt/yuyan 开头），
  // 则自动路由到同一服务器下的托管实例以兼容并确保配置热重载能够正确生效。
  if (nginxInstance.instanceType !== 'managed') {
    const managedInstance = await getManagedNginxInstanceByServerId(target.serverId);
    if (managedInstance) {
      const baseRoot = managedInstance.baseRoot || '/opt/yuyan';
      const confPath = String(target.nginxConfPath || '').trim();
      if (confPath.startsWith(baseRoot) || confPath.startsWith('/opt/yuyan')) {
        nginxInstance = managedInstance;
      }
    }
  }

  return { target, server, nginxInstance };
}

/**
 * 解析可编辑的 Nginx 配置文件路径。
 * @param {Object} target - 部署目标
 * @param {Object} nginxInstance - Nginx 实例
 * @returns {string} 配置文件路径
 */
function resolveEditableNginxConfPath(target, nginxInstance) {
  const rawPath = String(target.nginxConfPath || '').trim();
  if (rawPath) return rawPath;
  if (nginxInstance?.instanceType === 'managed') return `${nginxInstance.nginxRoot || '/opt/yuyan/nginx'}/conf/nginx.conf`;
  return '';
}

/**
 * 生成服务器上的 Nginx 操作命令
 * @param {Object} server - 服务器配置
 * @param {Object} nginxInstance - Nginx 实例配置
 * @param {'test'|'reload'} type - 命令类型
 * @returns {string} 可直接执行的远程命令
 */
export function buildNginxCommand(server, nginxInstance, type) {
  if (nginxInstance?.instanceType === 'managed') {
    const sudo = resolveEffectiveDeploySudo(server, nginxInstance) ? 'sudo -n ' : '';
    const scriptPath = nginxInstance.scriptPath || '/opt/yuyan/nginx/yuyan-nginx.sh';
    return `${sudo}${shellQuote(scriptPath)} ${type}`;
  }
  const command =
    type === 'reload'
      ? (nginxInstance ? nginxInstance.nginxReloadCommand || 'nginx -s reload' : server.nginxReloadCommand || 'nginx -s reload')
      : (nginxInstance ? nginxInstance.nginxTestCommand || 'nginx -t' : server.nginxTestCommand || 'nginx -t');
  const sudo = (nginxInstance ? nginxInstance.useSudo : server.useSudo) ? 'sudo -n ' : '';
  const workDir = String(nginxInstance ? (nginxInstance.nginxWorkDir || '') : (server.nginxWorkDir || '')).trim();
  const cdPrefix = workDir ? `cd ${shellQuote(workDir)} && ` : '';
  return `${cdPrefix}${sudo}${command}`;
}

/**
 * 获取 Nginx 命令展示文本
 * @param {Object} server - 服务器配置
 * @param {Object} nginxInstance - Nginx 实例配置
 * @param {'test'|'reload'} type - 命令类型
 * @returns {string} 命令展示文本
 */
export function getNginxCommandLabel(server, nginxInstance, type) {
  if (nginxInstance?.instanceType === 'managed') {
    const scriptPath = nginxInstance.scriptPath || '/opt/yuyan/nginx/yuyan-nginx.sh';
    return `${scriptPath} ${type}`;
  }
  const command =
    type === 'reload'
      ? (nginxInstance ? nginxInstance.nginxReloadCommand || 'nginx -s reload' : server.nginxReloadCommand || 'nginx -s reload')
      : (nginxInstance ? nginxInstance.nginxTestCommand || 'nginx -t' : server.nginxTestCommand || 'nginx -t');
  const workDir = String(nginxInstance ? (nginxInstance.nginxWorkDir || '') : (server.nginxWorkDir || '')).trim();
  return workDir ? `cd ${workDir} && ${command}` : command;
}

/**
 * 解析发布目录操作是否使用 sudo。
 * @param {Object} server - 服务器配置
 * @param {Object} nginxInstance - Nginx 实例配置
 * @returns {boolean} 是否使用 sudo
 */
export function resolveEffectiveDeploySudo(server, nginxInstance) {
  return Boolean(nginxInstance?.useSudo || server?.useSudo);
}

/**
 * 生成 sudo 命令前缀。
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} sudo 前缀
 */
function buildSudoPrefix(useSudo) {
  return useSudo ? 'sudo -n ' : '';
}

/**
 * 校验当前账号是否可免密 sudo。
 * @param {Object} conn - SSH 连接
 * @param {Object} server - 服务器配置
 * @param {boolean} useSudo - 是否需要 sudo
 * @returns {Promise<void>}
 */
async function assertPasswordlessSudo(conn, server, useSudo) {
  if (!useSudo) return;
  const result = await execSsh(conn, 'sudo -n true', {
    allowFailure: true,
    label: '校验免密 sudo',
  });
  if (result.code === 0) return;
  const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
  throw new Error(
    `当前账号 ${server.username || ''} 无法执行免密 sudo。发布 root-owned 部署目录需要 sudo -n true 通过，请配置 sudoers 免密权限，或执行 sudo chown -R ${server.username || '<ssh用户>'}:${server.username || '<ssh用户>'} <部署目录> 后让 SSH 用户直接写入。${output ? `\n${output}` : ''}`
  );
}

/**
 * 构建远程 mkdir 命令。
 * @param {string|string[]} dirPaths - 目录路径
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} mkdir 命令
 */
function buildRemoteMkdirCommand(dirPaths, useSudo) {
  const paths = (Array.isArray(dirPaths) ? dirPaths : [dirPaths]).map((dirPath) => shellQuote(dirPath)).join(' ');
  return `${buildSudoPrefix(useSudo)}mkdir -p ${paths}`;
}

/**
 * 构建远程 sh -c 命令。
 * @param {string} script - Shell 脚本
 * @param {string[]} args - 脚本参数
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} 远程命令
 */
function buildRemoteShellCommand(script, args = [], useSudo = false) {
  const argv = args.map((arg) => shellQuote(arg)).join(' ');
  return `${buildSudoPrefix(useSudo)}sh -c ${shellQuote(script)} sh${argv ? ` ${argv}` : ''}`;
}

/**
 * 确认远程 tar 可用于 sudo 上传。
 * @param {Object} conn - SSH 连接
 * @returns {Promise<void>}
 */
async function assertRemoteTarAvailable(conn) {
  const result = await execSsh(conn, 'command -v tar >/dev/null 2>&1 && sudo -n tar --help >/dev/null 2>&1', {
    allowFailure: true,
    label: '校验远程 tar',
  });
  if (result.code === 0) return;
  const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
  throw new Error(`远程服务器未安装 tar，或 sudo 环境无法执行 tar，不能使用 sudo 上传产物。${output ? `\n${output}` : ''}`);
}

/**
 * 校验部署目录是否可由当前策略操作。
 * @param {Object} conn - SSH 连接
 * @param {Object} server - 服务器配置
 * @param {Object} target - 部署目标
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {Promise<boolean>} SSH 登录用户是否可直接写入
 */
async function ensureDeployRootOperable(conn, server, target, useSudo) {
  await assertPasswordlessSudo(conn, server, useSudo);

  const mkdirResult = await execSsh(conn, buildRemoteMkdirCommand(target.deployRoot, useSudo), {
    allowFailure: true,
    label: '创建部署目录',
  });
  if (mkdirResult.code !== 0) {
    const output = `${mkdirResult.stderr || ''}${mkdirResult.stdout || ''}`.trim();
    throw new Error(
      `创建部署目录失败：${target.deployRoot}。请确认当前 SSH 用户 ${server.username || ''} 对该路径有写权限，或启用 sudo 并确保 sudo -n true 通过。${output ? `\n${output}` : ''}`
    );
  }

  const writableResult = await execSsh(conn, `[ -d ${shellQuote(target.deployRoot)} ] && [ -w ${shellQuote(target.deployRoot)} ]`, {
    allowFailure: true,
    label: '检测部署目录写权限',
  });
  if (writableResult.code === 0) {
    return true;
  }

  if (!useSudo) {
    throw new Error(
      `部署目录 ${target.deployRoot} 当前 SSH 用户 ${server.username || ''} 不可写。请在服务器执行 sudo chown -R ${server.username || '<ssh用户>'}:${server.username || '<ssh用户>'} ${target.deployRoot}，或在绑定的 Nginx 实例/服务器启用 sudo 并确保 sudo -n true 通过。`
    );
  }

  return false;
}

/**
 * 发布前校验部署目录访问方式。
 * @param {Object} conn - SSH 连接
 * @param {Object} server - 服务器配置
 * @param {Object} target - 部署目标
 * @param {boolean} useSudo - 是否使用 sudo
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @returns {Promise<{useSudo: boolean, uploadMode: 'sftp'|'sudoTar', userWritable: boolean}>} 访问策略
 */
async function resolveDeployRootAccess(conn, server, target, useSudo, log) {
  const userWritable = await ensureDeployRootOperable(conn, server, target, useSudo);
  if (userWritable) {
    return { useSudo, uploadMode: 'sftp', userWritable: true };
  }

  await assertRemoteTarAvailable(conn);
  log('info', `部署目录 ${target.deployRoot} 当前 SSH 用户不可写，将使用 sudo tar 上传产物`, 'validate');
  return { useSudo, uploadMode: 'sudoTar', userWritable: false };
}

/**
 * 清理远程路径
 * @param {Object} conn - SSH 连接
 * @param {Object} server - 服务器
 * @param {string} remotePath - 远程路径
 * @param {string} label - 操作标签
 * @param {boolean} useSudo - 是否使用 sudo
 */
async function removeRemotePath(conn, server, remotePath, label, useSudo = server.useSudo) {
  if (!remotePath) return;
  const sudo = buildSudoPrefix(useSudo);
  await execSsh(conn, `${sudo}rm -rf ${shellQuote(remotePath)}`, {
    allowFailure: true,
    label,
  });
}

/**
 * 解析 Nginx 实例与部署目标的关联目录路径列表（用于风险判定）。
 * @param {Object|null} nginxInstance - Nginx 实例
 * @param {Object|null} target - 部署目标
 * @returns {string[]} 关键路径列表
 */
export function resolveNginxPaths(nginxInstance, target) {
  let nginxRoot = '';
  const criticalDirs = [];
  if (nginxInstance) {
    const rawRoot = nginxInstance.nginxRoot || nginxInstance.runtimeNginxRoot || '';
    if (rawRoot) {
      try {
        nginxRoot = normalizeDeployRootPath(rawRoot);
        criticalDirs.push(path.posix.join(nginxRoot, 'conf'));
        criticalDirs.push(path.posix.join(nginxRoot, 'logs'));
        criticalDirs.push(path.posix.join(nginxRoot, 'sbin'));
      } catch {}
    }
    const sitesDir = nginxInstance.sitesDir || nginxInstance.runtimeSitesDir || '';
    if (sitesDir) {
      try {
        criticalDirs.push(normalizeDeployRootPath(sitesDir));
      } catch {}
    }
  }
  if (target?.nginxConfPath) {
    try {
      const confDir = path.posix.dirname(normalizeDeployRootPath(target.nginxConfPath));
      if (confDir && confDir !== '/') criticalDirs.push(confDir);
    } catch {}
  }
  return {
    nginxRoot,
    criticalDirs: [...new Set(criticalDirs.filter(Boolean))],
  };
}

/**
 * 校验部署目标存量配置的安全性。
 * @param {Object} target - 部署目标
 * @param {Object} [options={}] - 配置选项
 */
export async function assertDeployTargetSafety(target, options = {}) {
  if (target?.projectType === 'backend') return;
  const { mode = 'deploy', isCleanReplace = false, log = () => {}, nginxInstance = null } = options;

  let normalizedDeployRoot = '';
  try {
    normalizedDeployRoot = normalizeDeployRootPath(target.deployRoot);
  } catch (err) {
    throw new Error(`当前部署目标的部署根目录不合法（${err.message}）。这是旧配置，系统不会自动修改，请到部署目标里改成独立目录后再发布`);
  }

  const nginxPaths = resolveNginxPaths(nginxInstance, target);
  const risk = classifyDeployRootRisk(normalizedDeployRoot, { nginxPaths });
  if (risk.level === 'block') {
    throw new Error(`当前部署根目录存在高危风险（${risk.reason}）。这是旧配置，系统不会自动修改，请到部署目标里改成独立目录后再发布`);
  }

  const allTargets = await listTargets({ serverId: target.serverId });
  const conflict = allTargets.find((t) => {
    if (Number(t.id) === Number(target.id)) return false;
    if (t.projectType === 'backend') return false;
    try {
      return normalizeDeployRootPath(t.deployRoot) === normalizedDeployRoot;
    } catch {
      return false;
    }
  });

  if (conflict) {
    if (isCleanReplace || mode === 'rollback' || mode === 'undoRollback') {
      const actionText = mode === 'rollback' ? '回滚' : (mode === 'undoRollback' ? '撤销回滚' : '清空后替换发布');
      throw new Error(`同服务器已存在部署根目录相同的其他前端目标「${conflict.projectName}」（#${conflict.id}）。为避免相互影响，${actionText}已中止。这是旧配置，系统不会自动修改，请到部署目标里改成独立目录后再发布`);
    } else {
      log('warn', `同服务器已存在部署根目录相同的其他前端目标「${conflict.projectName}」（#${conflict.id}），请注意不同项目间的静态文件冲突`, 'validate');
    }
  }
}

/**
 * 探测远程部署根目录的真实路径、顶层项与当前发布清单。
 * 仅使用 POSIX sh 和基本命令，必须在 GNU 和 busybox 下都工作。
 * @param {Object} conn - SSH 连接
 * @param {string} deployRoot - 目标部署目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @param {boolean} [options.ensureDir=true] - 是否确保目录存在（清理预览为只读，传 false）
 * @param {(level: string, message: string) => void} [options.log] - 日志函数
 * @returns {Promise<{ exists: boolean, realRoot: string, existingNames: string[], manifestText: string }>} 探测结果
 */
/**
 * 生成探测远程部署根目录的远程 Shell 命令。
 * @param {string} deployRoot - 目标部署目录
 * @param {boolean} [ensureDir=true] - 是否确保目录存在
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildDetectDeployRootCommand(deployRoot, ensureDir = true, useSudo = false) {
  const script = [
    'set -eu',
    'root="$1"',
    'ensure_dir="$2"',
    'if [ "$ensure_dir" = "0" ] && [ ! -d "$root" ] && [ ! -L "$root" ]; then',
    '  echo "===EXISTS===0"',
    '  exit 0',
    'fi',
    'echo "===EXISTS===1"',
    'cd -P "$root" && real_root=$(pwd -P)',
    'echo "===REAL_ROOT==="',
    'printf \'%s\\n\' "$real_root"',
    'printf \'===ENTRIES===\\n\'',
    'for f in "$real_root"/* "$real_root"/.*; do',
    '  name="${f##*/}"',
    '  case "$name" in ""|"."|".."|"*"|".*") continue ;; esac',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    '  printf \'%s\\0\' "$name"',
    'done',
    'printf \'\\n===END_ENTRIES===\\n\'',
    'echo "===MANIFEST==="',
    `manifest_dir="$real_root/${DEPLOY_MANIFEST_DIR_NAME}"`,
    'current_manifest=""',
    `if [ -f "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then`,
    `  current_manifest="$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}"`,
    'elif [ -d "$manifest_dir" ]; then',
    `  latest=$(ls -1 "$manifest_dir"/*.txt 2>/dev/null | grep -v "/${DEPLOY_CURRENT_MANIFEST_NAME}$" | sort | tail -n 1 || true)`,
    '  if [ -n "$latest" ] && [ -f "$latest" ]; then current_manifest="$latest"; fi',
    'fi',
    'if [ -n "$current_manifest" ] && [ -f "$current_manifest" ]; then',
    '  cat "$current_manifest"',
    'fi',
  ].join('\n');

  return buildRemoteShellCommand(script, [deployRoot, ensureDir ? '1' : '0'], useSudo);
}

/**
 * 解析探测远程部署根目录的输出。
 * @param {string} raw - 原始标准输出
 * @param {string} deployRoot - 目标部署目录
 * @param {Object} [options={}] - 配置选项
 * @returns {{ exists: boolean, realRoot: string, existingNames: string[], manifestText: string }} 探测结果
 */
export function parseDetectDeployRootOutput(raw, deployRoot, options = {}) {
  const { log = null } = options;
  if (!raw || raw.includes('===EXISTS===0')) {
    return {
      exists: false,
      realRoot: deployRoot,
      existingNames: [],
      manifestText: '',
    };
  }

  const realRootMarker = '===REAL_ROOT===\n';
  const entriesStartMarker = '===ENTRIES===\n';
  const entriesEndMarker = '\n===END_ENTRIES===\n';
  const manifestMarker = '===MANIFEST===\n';

  const realRootIdx = raw.indexOf(realRootMarker);
  const entriesStartIdx = raw.indexOf(entriesStartMarker);
  const entriesEndIdx = raw.indexOf(entriesEndMarker);
  const manifestIdx = raw.indexOf(manifestMarker);

  let realRoot = '';
  const existingNames = [];
  let manifestText = '';

  if (realRootIdx !== -1 && entriesStartIdx !== -1) {
    realRoot = raw.slice(realRootIdx + realRootMarker.length, entriesStartIdx).trim();
  }

  let discardedCount = 0;
  if (entriesStartIdx !== -1 && entriesEndIdx !== -1) {
    const entriesBlock = raw.slice(entriesStartIdx + entriesStartMarker.length, entriesEndIdx);
    const parts = entriesBlock.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    for (const name of parts) {
      if (isValidEntryName(name)) {
        existingNames.push(name);
      } else {
        discardedCount += 1;
      }
    }
  }

  if (discardedCount > 0 && log) {
    log('warn', `探测部署根目录时忽略了 ${discardedCount} 个非法条目名称`);
  }

  if (manifestIdx !== -1) {
    manifestText = raw.slice(manifestIdx + manifestMarker.length).trim();
  }

  return {
    exists: true,
    realRoot: realRoot || deployRoot,
    existingNames: [...new Set(existingNames)].sort(),
    manifestText,
  };
}

/**
 * 探测远程部署根目录的真实路径、顶层项与当前发布清单。
 * 仅使用 POSIX sh 和基本命令，必须在 GNU 和 busybox 下都工作。
 * @param {Object} conn - SSH 连接
 * @param {string} deployRoot - 目标部署目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @param {boolean} [options.ensureDir=true] - 是否确保目录存在（清理预览为只读，传 false）
 * @param {(level: string, message: string) => void} [options.log] - 日志函数
 * @returns {Promise<{ exists: boolean, realRoot: string, existingNames: string[], manifestText: string }>} 探测结果
 */
export async function detectDeployRoot(conn, deployRoot, useSudo = false, options = {}) {
  const { ensureDir = true, log = null } = options;

  if (ensureDir) {
    await execSsh(conn, buildRemoteMkdirCommand(deployRoot, useSudo), {
      label: '确保部署根目录存在',
    });
  }

  const cmd = buildDetectDeployRootCommand(deployRoot, ensureDir, useSudo);
  const result = await execSsh(conn, cmd, {
    label: '探测部署根目录与清单',
  });
  if (result.code !== 0) {
    throw new Error(`探测部署根目录失败：${result.stderr || result.stdout || `退出码 ${result.code}`}`);
  }

  return parseDetectDeployRootOutput(String(result.stdout || ''), deployRoot, { log });
}

/**
 * 远程批量解析路径真实规范路径（穿透软链接，支持尚不存在的子路径）。
 * 每行输出带序号前缀（如 <i>\t<path>），JS 端按序号解析，缺失或失败回退为原路径。
 * @param {Object} conn - SSH 连接
 * @param {string[]} paths - 待解析路径列表
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {Promise<string[]>} 解析后的真实路径列表（与输入顺序严格对应）
 */
export async function batchDetectRealRoots(conn, paths = [], useSudo = false) {
  if (!paths || !paths.length) return [];
  const script = [
    'idx=0',
    'for p in "$@"; do',
    '  out=""',
    '  if [ -d "$p" ]; then',
    '    out=$(cd -P "$p" 2>/dev/null && pwd -P) || out="$p"',
    '  else',
    '    dir="$(dirname "$p")"',
    '    base="$(basename "$p")"',
    '    if [ -d "$dir" ]; then',
    '      real_dir=$(cd -P "$dir" 2>/dev/null && pwd -P) || true',
    '      if [ -n "$real_dir" ]; then',
    '        if [ "$real_dir" = "/" ]; then',
    '          out="/$base"',
    '        else',
    '          out="$real_dir/$base"',
    '        fi',
    '      else',
    '        out="$p"',
    '      fi',
    '    else',
    '      out="$p"',
    '    fi',
    '  fi',
    '  if [ -z "$out" ]; then',
    '    out="$p"',
    '  fi',
    '  printf "%d\\t%s\\n" "$idx" "$out"',
    '  idx=$((idx + 1))',
    'done',
  ].join('\n');
  const result = await execSsh(conn, buildRemoteShellCommand(script, paths, useSudo), {
    allowFailure: true,
    label: '批量探测路径真实映射',
  });
  if (result.code !== 0) {
    return [...paths];
  }
  const resultMap = new Map();
  const rawLines = (result.stdout || '').split(/\r?\n/);
  for (const line of rawLines) {
    if (!line) continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex !== -1) {
      const idx = Number(line.slice(0, tabIndex));
      const val = line.slice(tabIndex + 1).trim();
      if (!Number.isNaN(idx) && val) {
        resultMap.set(idx, val);
      }
    }
  }
  return paths.map((original, i) => resultMap.get(i) || original);
}

/**
 * 清理部署根目录下过期的暂存与垃圾箱目录（超过 60 分钟）。
 * 必须在持有目录锁后、执行探测前调用。删除只针对 .yuyan-retiring-* 与 .yuyan-trash-* 前缀。
 * @param {Object} conn - SSH 连接
 * @param {string} rootPath - 部署真实根路径
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Function} [log] - 日志记录函数
 */
export async function cleanupExpiredStagingAndTrash(conn, rootPath, useSudo = false, log = null) {
  const script = [
    '# yuyan:prune-stale-staging',
    'root="$1"',
    'if [ -d "$root" ]; then',
    '  find "$root" -maxdepth 1 -mindepth 1 \\( -name ".yuyan-retiring-*" -o -name ".yuyan-trash-*" \\) -mmin +60 2>/dev/null | while IFS= read -r dir; do',
    '    base=$(basename "$dir")',
    '    case "$base" in',
    '      .yuyan-retiring-*|.yuyan-trash-*)',
    '        if rm -rf "$dir" 2>/dev/null; then',
    '          echo "cleaned: $base"',
    '        else',
    '          echo "failed: $base" >&2',
    '        fi',
    '        ;;',
    '    esac',
    '  done',
    'fi',
  ].join('\n');

  try {
    const result = await execSsh(conn, buildRemoteShellCommand(script, [rootPath], useSudo), {
      allowFailure: true,
      label: '清理过期暂存与垃圾箱目录',
    });
    if (result.code === 0 && result.stdout) {
      const cleaned = result.stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith('cleaned:'))
        .map((l) => l.replace('cleaned:', '').trim())
        .filter(Boolean);
      if (cleaned.length > 0 && typeof log === 'function') {
        log('info', `已清理 ${cleaned.length} 个过期暂存/垃圾箱目录：${cleaned.join('、')}`, 'cleanup');
      }
    } else if (result.code !== 0 && typeof log === 'function') {
      log('warn', `清理过期暂存目录异常（退出码 ${result.code}）：${result.stderr || ''}`, 'cleanup');
    }
  } catch (error) {
    if (typeof log === 'function') {
      log('warn', `清理过期暂存目录失败：${error.message || error}`, 'cleanup');
    }
  }
}

/**
 * 获取远程前端部署目录锁（防多实例踩踏与父子目录并发冲突）。
 * 锁目录为 .yuyan-deploy.lock，在内部记录 owner 文件：host=<hostname> pid=<pid> record=<recordId> at=<ISO时间>。
 * 全程不用 rm -rf，使用 mkdir 原子加锁；如已有锁但 owner 超过 120 分钟未更新则尝试清理过期锁并重新竞争获取。
 * @param {Object} conn - SSH 连接
 * @param {string} deployRoot - 部署根目录（通常为最外层 lockRoot）
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @param {number|string} [options.recordId] - 当前部署/回滚记录 ID
 * @param {Function} [options.log] - 日志记录函数
 * @returns {Promise<string>} ownerToken（用于释放锁时的校验）
 */
export async function acquireFrontendDeployLock(conn, deployRoot, useSudo = false, options = {}) {
  if (typeof useSudo === 'object') {
    options = useSudo;
    useSudo = options.useSudo || false;
  }
  const lockDir = path.posix.join(deployRoot, '.yuyan-deploy.lock');
  const recordId = options.recordId || 0;
  const ownerToken = `host=${os.hostname()} pid=${process.pid} record=${recordId} at=${new Date().toISOString()}`;

  const script = [
    '# yuyan:deploy-lock',
    'set -u',
    'lock="$1"',
    'owner_str="$2"',
    'owner_file="$lock/owner"',
    '',
    'if [ -d "$lock" ]; then',
    '  # 检查 owner 文件是否存在且超过 120 分钟未修改（使用 find 检查 mtime）',
    '  if [ -f "$owner_file" ] && find "$owner_file" -maxdepth 0 -mmin +120 2>/dev/null | grep -q .; then',
    '    # 说明仍有极小竞争窗口：并发下两个进程可能同时判定过期，但随后的 mkdir 保证原子性',
    '    rm -f "$owner_file" 2>/dev/null || true',
    '    rmdir "$lock" 2>/dev/null || true',
    '  elif [ ! -f "$owner_file" ] && find "$lock" -maxdepth 0 -mmin +120 2>/dev/null | grep -q .; then',
    '    rmdir "$lock" 2>/dev/null || true',
    '  fi',
    'fi',
    '',
    'if mkdir "$lock" 2>/dev/null; then',
    '  if ! printf \'%s\\n\' "$owner_str" > "$owner_file"; then',
    '    rmdir "$lock" 2>/dev/null || true',
    '    echo "LOCK_FAILED: 写入持有者信息失败" >&2',
    '    exit 1',
    '  fi',
    '  exit 0',
    'else',
    '  cur_owner=$(cat "$owner_file" 2>/dev/null || echo "未知持有者")',
    '  echo "LOCK_FAILED: $cur_owner" >&2',
    '  exit 1',
    'fi',
  ].join('\n');

  const result = await execSsh(conn, buildRemoteShellCommand(script, [lockDir, ownerToken], useSudo), {
    allowFailure: true,
    label: '获取远程部署目录锁',
  });

  if (result.code !== 0) {
    const stderr = String(result.stderr || '');
    const match = stderr.match(/LOCK_FAILED:\s*(.+)/);
    const ownerInfo = match ? match[1].trim() : '未知持有者';
    throw new Error(
      `无法获取远程部署目录锁（${lockDir} 已存在或无权创建）。当前持有者：${ownerInfo}。可能已有其他雨燕进程正在向该目录部署，请稍后重试`
    );
  }

  return ownerToken;
}

/**
 * 释放远程前端部署目录锁。
 * 先比对 owner 文件内容，完全一致才执行 rm -f owner && rmdir lock；不一致则不删并记录 warn。全程不用 rm -rf。
 * @param {Object} conn - SSH 连接
 * @param {string} deployRoot - 部署根目录
 * @param {string} [ownerToken] - 获取锁时返回的 ownerToken
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Function} [log] - 日志记录函数
 */
export async function releaseFrontendDeployLock(conn, deployRoot, ownerToken = '', useSudo = false, log = null) {
  if (typeof ownerToken === 'boolean') {
    useSudo = ownerToken;
    ownerToken = '';
  }

  const lockDir = path.posix.join(deployRoot, '.yuyan-deploy.lock');
  const script = [
    '# yuyan:deploy-lock',
    'set -u',
    'lock="$1"',
    'expected_owner="$2"',
    'owner_file="$lock/owner"',
    '',
    'if [ ! -d "$lock" ]; then',
    '  exit 0',
    'fi',
    '',
    'if [ -f "$owner_file" ]; then',
    '  actual_owner=$(cat "$owner_file" 2>/dev/null || echo "")',
    '  if [ -n "$expected_owner" ] && [ "$actual_owner" != "$expected_owner" ]; then',
    '    echo "OWNER_MISMATCH: actual=[$actual_owner] expected=[$expected_owner]" >&2',
    '    exit 2',
    '  fi',
    '  rm -f "$owner_file" && rmdir "$lock"',
    '  exit 0',
    'else',
    '  echo "OWNER_FILE_MISSING: $lock/owner not found" >&2',
    '  exit 2',
    'fi',
  ].join('\n');

  try {
    const result = await execSsh(conn, buildRemoteShellCommand(script, [lockDir, ownerToken || ''], useSudo), {
      allowFailure: true,
      label: '释放远程部署目录锁',
    });
    if (result.code === 2) {
      const stderr = (result.stderr || '').trim();
      const msg = stderr.includes('OWNER_FILE_MISSING')
        ? `释放部署目录锁警告：未找到持有者信息文件，未删除锁（${lockDir}，${stderr}）`
        : `释放部署目录锁失败：锁持有者与预期不一致，未删除锁（${lockDir}，${stderr}）`;
      if (typeof log === 'function') {
        log('warn', msg, 'cleanup');
      } else {
        console.warn(`[Deploy] ${msg}`);
      }
    }
  } catch (err) {
    if (typeof log === 'function') {
      log('warn', `释放部署目录锁时发生异常：${err.message || err}`, 'cleanup');
    }
  }
}

/**
 * 生成备份部署目录命令。
 * 遵循白名单显式拷贝原则，通过 "$@" 传入需备份条目，逐项校验存在且备份前检查可用磁盘空间。
 * @param {Object|string} target - 部署目标或部署路径
 * @param {string} backupPath - 备份目录
 * @param {string[]} [protectedSubDirs=[]] - 保留的顶层子目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @returns {string} 远程命令
 */
export function buildBackupDeployRootCommand(target, backupPath, protectedSubDirs = [], useSudo = false, options = {}) {
  const rootPath = typeof target === 'object' ? target.deployRoot : target;
  const {
    isOverlayUpload = true,
    kind = isOverlayUpload ? BACKUP_KINDS.entryOnly : BACKUP_KINDS.full,
    namesToBackup = null,
    hashedDirs = DEFAULT_HASHED_ASSET_DIRS,
  } = options;

  const reservedSet = new Set(RESERVED_DEPLOY_ENTRIES);
  const protectedSet = new Set(protectedSubDirs.filter(isValidEntryName));
  const hashedSet = new Set(hashedDirs.filter(isValidEntryName));

  // Node 侧前置过滤（双保险）
  const names = (Array.isArray(namesToBackup) ? namesToBackup : [])
    .filter(isValidEntryName)
    .filter((n) => !reservedSet.has(n) && !protectedSet.has(n))
    .filter((n) => (kind === BACKUP_KINDS.entryOnly ? !hashedSet.has(n) : true));

  // 列表以换行包裹，供 Shell 安全匹配
  const protectedListStr = '\n' + protectedSubDirs.filter(isValidEntryName).join('\n') + '\n';
  const hashedListStr = '\n' + hashedDirs.filter(isValidEntryName).join('\n') + '\n';

  const script = [
    'set -eu',
    'root="$1"',
    'backup="$2"',
    'kind="$3"',
    'protected_list="$4"',
    'hashed_list="$5"',
    'shift 5',
    '',
    'nl=\'',
    '\'',
    '',
    'mkdir -p "$backup"',
    `printf '%s\\n' "$kind" > "$backup/${BACKUP_KIND_FILE_NAME}"`,
    `: > "$backup/${BACKUP_NAMES_FILE_NAME}"`,
    '',
    'if [ "$#" -gt 0 ]; then',
    '  needed_kb=0',
    '  for name in "$@"; do',
    '    case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests") continue ;; esac',
    '    case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '    if [ "$kind" = "entry-only" ]; then',
    '      case "$hashed_list" in *"$nl$name$nl"*) continue ;; esac',
    '    fi',
    '    if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '      size=$(du -sk "$root/$name" 2>/dev/null | awk \'{print $1}\')',
    '      case "$size" in \'\'|*[!0-9]*) size=0 ;; esac',
    '      needed_kb=$((needed_kb + size))',
    '    fi',
    '  done',
    '',
    '  required_kb=$((needed_kb * 11 / 10 + 10240))',
    '  avail_kb=$(df -Pk "$backup" 2>/dev/null | awk \'NR==2 {print $4}\')',
    '  case "$avail_kb" in \'\'|*[!0-9]*) avail_kb=0 ;; esac',
    '  if [ "$avail_kb" -gt 0 ] && [ "$avail_kb" -lt "$required_kb" ]; then',
    '    echo "磁盘空间不足：备份需要至少 $((required_kb / 1024))MB（含安全冗余），当前磁盘剩余 $((avail_kb / 1024))MB" >&2',
    '    exit 1',
    '  fi',
    '',
    '  for name in "$@"; do',
    '    case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests") continue ;; esac',
    '    case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '    if [ "$kind" = "entry-only" ]; then',
    '      case "$hashed_list" in *"$nl$name$nl"*) continue ;; esac',
    '    fi',
    '    if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '      if ! cp -a "$root/$name" "$backup/$name"; then',
    '        echo "备份条目失败：$name" >&2',
    '        exit 1',
    '      fi',
    '      if [ ! -e "$backup/$name" ] && [ ! -L "$backup/$name" ]; then',
    '        echo "校验备份条目失败，目标未生成：$name" >&2',
    '        exit 1',
    '      fi',
    `      printf '%s\\n' "$name" >> "$backup/${BACKUP_NAMES_FILE_NAME}"`,
    '    fi',
    '  done',
    'fi',
    '',
    // full 和 entry-only 统一保存当时的发布清单
    `manifest_dir="$root/${DEPLOY_MANIFEST_DIR_NAME}"`,
    'current_manifest=""',
    `if [ -f "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then`,
    `  current_manifest="$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}"`,
    'elif [ -d "$manifest_dir" ]; then',
    `  latest=$(ls -1 "$manifest_dir"/*.txt 2>/dev/null | grep -v "/${DEPLOY_CURRENT_MANIFEST_NAME}$" | sort | tail -n 1 || true)`,
    '  if [ -n "$latest" ] && [ -f "$latest" ]; then current_manifest="$latest"; fi',
    'fi',
    'if [ -n "$current_manifest" ] && [ -f "$current_manifest" ]; then',
    `  cp -a "$current_manifest" "$backup/${BACKUP_MANIFEST_FILE_NAME}"`,
    'fi',
  ].join('\n');

  return buildRemoteShellCommand(script, [rootPath, backupPath, kind, protectedListStr, hashedListStr, ...names], useSudo);
}

/**
 * 生成清理部署目录命令。
 * 仅对明确给出的 deleteNames 列表逐个执行 rm -rf，严禁使用盲目通配或 find 清空。
 * @param {Object|string} target - 部署目标或部署路径
 * @param {string[]} [deleteNames=[]] - 待删除的顶层条目名单
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildClearDeployRootCommand(target, deleteNames = [], useSudo = false) {
  const rootPath = typeof target === 'object' ? target.deployRoot : target;
  const script = [
    'set -eu',
    'root="$1"',
    'shift 1',
    'for name in "$@"; do',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests") continue ;; esac',
    '  if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '    if ! rm -rf "$root/$name"; then',
    '      echo "清理条目失败：$name" >&2',
    '      exit 1',
    '    fi',
    '    if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '      echo "校验清理条目失败，文件仍存在：$name" >&2',
    '      exit 1',
    '    fi',
    '  fi',
    'done',
  ].join('\n');

  const safeNames = (deleteNames || []).filter(
    (name) => isValidEntryName(name) && !isReservedDeployEntry(name)
  );

  return buildRemoteShellCommand(script, [rootPath, ...safeNames], useSudo);
}

/**
 * 生成暂存待清理条目的远程 shell 命令。
 * 采用同文件系统暂存重命名（Staging Rename）策略：在部署根目录内创建 .yuyan-retiring-<releaseName>，
 * 逐个将待删除条目原子移动到暂存目录；如果任何一项移动失败，自动捕获退出并在 trap 中执行反向回退恢复现场。
 * 全程绝不使用 rm -rf，回退失败或暂存区非空时保留并报错。
 * @param {Object|string} target - 部署目标或部署路径
 * @param {string[]} [deleteNames=[]] - 待暂存的条目名单
 * @param {string} releaseName - 发布版本号
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildStagedRetireCommand(target, deleteNames = [], releaseName, useSudo = false) {
  const rootPath = typeof target === 'object' ? target.deployRoot : target;
  const stagingName = `.yuyan-retiring-${releaseName}`;
  const script = [
    '# yuyan:staged-retire',
    'set -eu',
    'root="$1"',
    'staging="$root/$2"',
    'shift 2',
    'mkdir -p "$staging"',
    '',
    'rollback_on_error() {',
    '  err=$?',
    '  trap - EXIT',
    '  set +e',
    '  echo "暂存旧条目失败（退出码 ${err}），正在反向还原已移动条目..." >&2',
    '  rollback_failed=0',
    '  for name in "$@"; do',
    '    case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests"|".yuyan-deploy.lock"|".yuyan-retiring-"*|".yuyan-trash-"*) continue ;; esac',
    '    if [ -e "$staging/$name" ] || [ -L "$staging/$name" ]; then',
    '      if [ ! -e "$root/$name" ] && [ ! -L "$root/$name" ]; then',
    '        if ! mv -- "$staging/$name" "$root/$name" 2>/dev/null; then',
    '          echo "反向还原条目失败：$name" >&2',
    '          rollback_failed=1',
    '        fi',
    '      fi',
    '    fi',
    '  done',
    '  if ! rmdir "$staging" 2>/dev/null; then',
    '    echo "暂存区仍有未还原条目，已保留：$staging" >&2',
    '  fi',
    '  if [ "$err" -ne 0 ]; then',
    '    exit "$err"',
    '  elif [ "$rollback_failed" -ne 0 ]; then',
    '    exit 1',
    '  fi',
    '}',
    'trap \'rollback_on_error "$@"\' EXIT',
    '',
    'for name in "$@"; do',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests"|".yuyan-deploy.lock"|".yuyan-retiring-"*|".yuyan-trash-"*) continue ;; esac',
    '  if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '    if [ -e "$staging/$name" ] || [ -L "$staging/$name" ]; then',
    '      echo "暂存区已存在同名冲突条目：$name" >&2',
    '      exit 1',
    '    fi',
    '    if ! mv -- "$root/$name" "$staging/$name"; then',
    '      echo "移动条目到暂存区失败：$name" >&2',
    '      exit 1',
    '    fi',
    '  fi',
    'done',
    '',
    'trap - EXIT',
  ].join('\n');

  const safeNames = (deleteNames || []).filter(
    (name) => isValidEntryName(name) && !isReservedDeployEntry(name)
  );

  return buildRemoteShellCommand(script, [rootPath, stagingName, ...safeNames], useSudo);
}

/**
 * 生成从暂存区还原旧条目的远程 shell 命令（用于发布失败后现场恢复）。
 * 对每个条目名，若 root 下已有同名项（新上传产物），先挪入 .yuyan-trash-<releaseName>，
 * 再把暂存区中的旧条目挪回部署根；随后清理垃圾箱（允许且仅允许在此处针对 trash 目录执行 rm -rf）；
 * 最后 rmdir 暂存区，若非空则保留并报错。
 * @param {Object|string} target - 部署目标或部署路径
 * @param {string} releaseName - 发布版本号
 * @param {string[]} [names=[]] - 需还原的条目名单
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildRestoreFromStagingCommand(target, releaseName, names = [], useSudo = false) {
  const rootPath = typeof target === 'object' ? target.deployRoot : target;
  const script = [
    '# yuyan:restore-from-staging',
    'set -eu',
    'root="$1"',
    'staging="$root/.yuyan-retiring-$2"',
    'trash="$root/.yuyan-trash-$2"',
    'shift 2',
    'rm -rf "$trash" 2>/dev/null || true',
    'mkdir -p "$trash"',
    '',
    'failed=0',
    'for name in "$@"; do',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests"|".yuyan-deploy.lock"|".yuyan-retiring-"*|".yuyan-trash-"*) continue ;; esac',
    '  if [ -e "$staging/$name" ] || [ -L "$staging/$name" ]; then',
    '    if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '      if ! mv -- "$root/$name" "$trash/$name" 2>/dev/null; then',
    '        echo "移动新产物到垃圾箱失败：$name" >&2',
    '        failed=1',
    '        continue',
    '      fi',
    '    fi',
    '    if ! mv -- "$staging/$name" "$root/$name" 2>/dev/null; then',
    '      echo "从暂存区还原条目失败：$name" >&2',
    '      failed=1',
    '    fi',
    '  fi',
    'done',
    '',
    'rm -rf "$trash" 2>/dev/null || true',
    '',
    'if [ -d "$staging" ]; then',
    '  if ! rmdir "$staging" 2>/dev/null; then',
    '    echo "暂存区仍有未还原条目，已保留：$staging" >&2',
    '    failed=1',
    '  fi',
    'fi',
    '',
    'if [ "$failed" -ne 0 ]; then',
    '  exit 1',
    'fi',
  ].join('\n');

  const safeNames = (names || []).filter(
    (name) => isValidEntryName(name) && !isReservedDeployEntry(name)
  );

  return buildRemoteShellCommand(script, [rootPath, releaseName, ...safeNames], useSudo);
}

/**
 * 生成清理退休暂存目录的远程 shell 命令。
 * @param {Object|string} target - 部署目标或部署路径
 * @param {string} releaseName - 发布版本号
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildPurgeStagedRetireCommand(target, releaseName, useSudo = false) {
  const rootPath = typeof target === 'object' ? target.deployRoot : target;
  const stagingName = `.yuyan-retiring-${releaseName}`;
  const script = [
    'set -eu',
    'root="$1"',
    'staging="$root/$2"',
    'if [ -d "$staging" ]; then',
    '  rm -rf "$staging"',
    'fi',
  ].join('\n');
  return buildRemoteShellCommand(script, [rootPath, stagingName], useSudo);
}

/**
 * 生成从备份恢复部署目录命令。
 * 按 restoreNames 与 removeNames 精确恢复，避免覆盖已保护的子应用，并在失败时中止。
 * @param {Object|string} target - 部署目标或部署路径
 * @param {string} backupPath - 备份目录
 * @param {string[]} [protectedSubDirs=[]] - 保留的顶层子目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @returns {string} 远程命令
 */
export function buildRestoreDeployRootCommand(target, backupPath, protectedSubDirs = [], useSudo = false, options = {}) {
  const rootPath = typeof target === 'object' ? target.deployRoot : target;
  const restoreNames = options.restoreNames || options.plan?.restoreNames || [];
  const removeNames = options.removeNames || options.plan?.removeNames || [];
  const isEntryOnly = options.isEntryOnly ?? (options.plan?.kind === BACKUP_KINDS.entryOnly);

  const reservedSet = new Set(RESERVED_DEPLOY_ENTRIES);
  const protectedSet = new Set(protectedSubDirs.filter(isValidEntryName));

  const validRemove = removeNames
    .filter(isValidEntryName)
    .filter((n) => !reservedSet.has(n) && !protectedSet.has(n));
  const validRestore = restoreNames
    .filter(isValidEntryName)
    .filter((n) => !reservedSet.has(n) && !protectedSet.has(n));

  const protectedListStr = '\n' + protectedSubDirs.filter(isValidEntryName).join('\n') + '\n';
  const removeListStr = '\n' + validRemove.join('\n') + '\n';

  const script = [
    'set -eu',
    'root="$1"',
    'backup="$2"',
    'is_entry_only="$3"',
    'remove_count="$4"',
    'protected_list="$5"',
    'remove_list="$6"',
    'shift 6',
    '',
    'nl=\'',
    '\'',
    '',
    '# 1. 恢复前严格预检：任何条目缺失或冲突直接退出，绝不进入删除阶段',
    'idx=0',
    'for name in "$@"; do',
    '  idx=$((idx + 1))',
    '  if [ "$idx" -le "$remove_count" ]; then',
    '    continue',
    '  fi',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests") continue ;; esac',
    '  case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '  case "$remove_list" in',
    '    *"$nl$name$nl"*) in_remove=1 ;;',
    '    *) in_remove=0 ;;',
    '  esac',
    '  if [ "$in_remove" = "0" ] && { [ -e "$root/$name" ] || [ -L "$root/$name" ]; }; then',
    '    echo "恢复前目标仍存在：$name" >&2',
    '    exit 1',
    '  fi',
    '  if [ ! -e "$backup/$name" ] && [ ! -L "$backup/$name" ]; then',
    '    echo "备份里缺少条目：${name}，已停止恢复，部署目录没有改动" >&2',
    '    exit 1',
    '  fi',
    'done',
    '',
    '# 2. 预检全部通过后，移除旧条目',
    'idx=0',
    'for name in "$@"; do',
    '  idx=$((idx + 1))',
    '  if [ "$idx" -gt "$remove_count" ]; then',
    '    break',
    '  fi',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests") continue ;; esac',
    '  case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '  if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '    if ! rm -rf "$root/$name"; then',
    '      echo "移除旧条目失败：$name" >&2',
    '      exit 1',
    '    fi',
    '  fi',
    'done',
    '',
    '# 3. 逐个拷回恢复条目',
    'idx=0',
    'for name in "$@"; do',
    '  idx=$((idx + 1))',
    '  if [ "$idx" -le "$remove_count" ]; then',
    '    continue',
    '  fi',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests") continue ;; esac',
    '  case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '  if [ -e "$backup/$name" ] || [ -L "$backup/$name" ]; then',
    '    if ! cp -a "$backup/$name" "$root/$name"; then',
    '      echo "恢复条目失败：$name" >&2',
    '      exit 1',
    '    fi',
    '    if [ ! -e "$root/$name" ] && [ ! -L "$root/$name" ]; then',
    '      echo "校验恢复条目失败，文件未生成：$name" >&2',
    '      exit 1',
    '    fi',
    '  fi',
    'done',
    '',
    // 恢复时只要备份里有 .manifest.txt，就写回 current.txt
    `if [ -f "$backup/${BACKUP_MANIFEST_FILE_NAME}" ]; then`,
    `  mkdir -p "$root/${DEPLOY_MANIFEST_DIR_NAME}"`,
    `  cp -a "$backup/${BACKUP_MANIFEST_FILE_NAME}" "$root/${DEPLOY_MANIFEST_DIR_NAME}/${DEPLOY_CURRENT_MANIFEST_NAME}"`,
    'fi',
  ].join('\n');

  const args = [
    rootPath,
    backupPath,
    isEntryOnly ? '1' : '0',
    String(validRemove.length),
    protectedListStr,
    removeListStr,
    ...validRemove,
    ...validRestore,
  ];

  return buildRemoteShellCommand(script, args, useSudo);
}

/**
 * 探测远程备份并规划恢复条目。
 * @param {Object} conn - SSH 连接
 * @param {Object|string} target - 部署目标或路径
 * @param {string} backupPath - 备份目录
 * @param {string[]} [protectedSubDirs=[]] - 当前需保护的子目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @returns {Promise<Object>} 规划结果
 */
/**
 * 生成探测远程备份元信息的远程 Shell 命令。
 * @param {string} rootPath - 部署根目录
 * @param {string} backupPath - 备份目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildDetectBackupRestorePlanCommand(rootPath, backupPath, useSudo = false) {
  const detectScript = [
    'set -eu',
    'root="$1"',
    'backup="$2"',
    'if [ ! -d "$backup" ]; then',
    '  echo "===BACKUP_EXISTS===0"',
    '  exit 0',
    'fi',
    'echo "===BACKUP_EXISTS===1"',
    'echo "===BACKUP_KIND==="',
    `if [ -f "$backup/${BACKUP_KIND_FILE_NAME}" ]; then cat "$backup/${BACKUP_KIND_FILE_NAME}"; fi`,
    'echo "===BACKUP_NAMES==="',
    `if [ -f "$backup/${BACKUP_NAMES_FILE_NAME}" ]; then`,
    '  echo "HAS_BACKUP_NAMES=1"',
    `  cat "$backup/${BACKUP_NAMES_FILE_NAME}"`,
    'else',
    '  echo "HAS_BACKUP_NAMES=0"',
    'fi',
    'echo "===END_BACKUP_NAMES==="',
    'printf \'===BACKUP_ENTRIES===\\n\'',
    'for f in "$backup"/* "$backup"/.*; do',
    '  name="${f##*/}"',
    '  case "$name" in ""|"."|".."|"*"|".*") continue ;; esac',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    '  printf \'%s\\0\' "$name"',
    'done',
    'printf \'\\n===END_BACKUP_ENTRIES===\\n\'',
    'printf \'===BACKUP_DIRS===\\n\'',
    'for f in "$backup"/* "$backup"/.*; do',
    '  name="${f##*/}"',
    '  case "$name" in ""|"."|".."|"*"|".*") continue ;; esac',
    '  [ -d "$f" ] || continue',
    '  printf \'%s\\0\' "$name"',
    'done',
    'printf \'\\n===END_BACKUP_DIRS===\\n\'',
    'echo "===BACKUP_MANIFEST==="',
    `if [ -f "$backup/${BACKUP_MANIFEST_FILE_NAME}" ]; then cat "$backup/${BACKUP_MANIFEST_FILE_NAME}"; fi`,
    'echo "===END_BACKUP_MANIFEST==="',
    'printf \'===ROOT_ENTRIES===\\n\'',
    'for f in "$root"/* "$root"/.*; do',
    '  name="${f##*/}"',
    '  case "$name" in ""|"."|".."|"*"|".*") continue ;; esac',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    '  printf \'%s\\0\' "$name"',
    'done',
    'printf \'\\n===END_ROOT_ENTRIES===\\n\'',
    'printf \'===ROOT_DIRS===\\n\'',
    'for f in "$root"/* "$root"/.*; do',
    '  name="${f##*/}"',
    '  case "$name" in ""|"."|".."|"*"|".*") continue ;; esac',
    '  [ -d "$f" ] || continue',
    '  printf \'%s\\0\' "$name"',
    'done',
    'printf \'\\n===END_ROOT_DIRS===\\n\'',
    'echo "===CURRENT_MANIFEST==="',
    `if [ -f "$root/${DEPLOY_MANIFEST_DIR_NAME}/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then cat "$root/${DEPLOY_MANIFEST_DIR_NAME}/${DEPLOY_CURRENT_MANIFEST_NAME}"; fi`,
    'echo "===END_CURRENT_MANIFEST==="',
  ].join('\n');

  return buildRemoteShellCommand(detectScript, [rootPath, backupPath], useSudo);
}

/**
 * 解析探测远程备份元信息的输出并生成恢复规划。
 * @param {string} stdout - 命令标准输出
 * @param {Object} [options={}] - 配置选项
 * @returns {Object} 规划结果
 */
export function parseDetectBackupRestorePlanOutput(stdout, options = {}) {
  const {
    rootPath = '',
    backupPath = '',
    protectedSubDirs = [],
    extraRemoveNames = [],
    hashedDirs = DEFAULT_HASHED_ASSET_DIRS,
    log = null,
  } = options;

  if (stdout.includes('===BACKUP_EXISTS===0')) {
    throw new Error(`备份目录不存在或已被删除：${backupPath}，已停止恢复，部署目录没有改动`);
  }

  const parseSection = (startMarker, endMarker) => {
    const sIdx = stdout.indexOf(startMarker);
    if (sIdx === -1) return '';
    const start = sIdx + startMarker.length;
    if (!endMarker) return stdout.slice(start);
    const eIdx = stdout.indexOf(endMarker, start);
    return eIdx === -1 ? stdout.slice(start) : stdout.slice(start, eIdx);
  };

  const backupKindRaw = parseSection('===BACKUP_KIND===\n', '===BACKUP_NAMES===').trim();
  const backupNamesBlock = parseSection('===BACKUP_NAMES===\n', '\n===END_BACKUP_NAMES===');
  const backupEntriesBlock = parseSection('===BACKUP_ENTRIES===\n', '\n===END_BACKUP_ENTRIES===');
  const backupDirsBlock = parseSection('===BACKUP_DIRS===\n', '\n===END_BACKUP_DIRS===');
  const backupManifestRaw = parseSection('===BACKUP_MANIFEST===\n', '===END_BACKUP_MANIFEST===').trim();
  const rootEntriesBlock = parseSection('===ROOT_ENTRIES===\n', '\n===END_ROOT_ENTRIES===');
  const rootDirsBlock = parseSection('===ROOT_DIRS===\n', '\n===END_ROOT_DIRS===');
  const currentManifestRaw = parseSection('===CURRENT_MANIFEST===\n', '===END_CURRENT_MANIFEST===').trim();

  const backupKind = backupKindRaw === BACKUP_KINDS.entryOnly ? BACKUP_KINDS.entryOnly : BACKUP_KINDS.full;

  let backupNames = null;
  let discardedNamesCount = 0;
  if (backupNamesBlock.startsWith('HAS_BACKUP_NAMES=1')) {
    backupNames = [];
    const lines = backupNamesBlock.split('\n').slice(1);
    for (const line of lines) {
      if (line === '') continue;
      if (isValidEntryName(line)) {
        backupNames.push(line);
      } else {
        discardedNamesCount += 1;
      }
    }
  }

  const backupTopEntries = [];
  if (backupEntriesBlock) {
    const parts = backupEntriesBlock.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    for (const name of parts) {
      if (isValidEntryName(name)) {
        backupTopEntries.push(name);
      } else {
        discardedNamesCount += 1;
      }
    }
  }

  const backupDirs = [];
  if (backupDirsBlock) {
    const parts = backupDirsBlock.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    for (const name of parts) {
      if (isValidEntryName(name)) {
        backupDirs.push(name);
      }
    }
  }

  const existingNames = [];
  if (rootEntriesBlock) {
    const parts = rootEntriesBlock.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    for (const name of parts) {
      if (isValidEntryName(name)) {
        existingNames.push(name);
      } else {
        discardedNamesCount += 1;
      }
    }
  }

  const existingDirs = [];
  if (rootDirsBlock) {
    const parts = rootDirsBlock.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    for (const name of parts) {
      if (isValidEntryName(name)) {
        existingDirs.push(name);
      }
    }
  }

  if (discardedNamesCount > 0 && log) {
    log('warn', `探测恢复备份元信息时忽略了 ${discardedNamesCount} 个非法条目名称`, 'cleanup');
  }

  const backupManifestTopNames = manifestTopNames(backupManifestRaw);
  const currentManifestTopNames = manifestTopNames(currentManifestRaw);

  const plan = planRestore({
    backupKind,
    backupNames,
    backupTopEntries,
    backupDirs,
    backupManifestTopNames,
    currentManifestTopNames,
    existingNames,
    existingDirs,
    protectedNames: protectedSubDirs,
    extraRemoveNames,
    hashedDirs,
  });

  return {
    ...plan,
    backupPath,
    rootPath,
  };
}

/**
 * 探测远程备份并规划恢复条目。
 * @param {Object} conn - SSH 连接
 * @param {Object|string} target - 部署目标或路径
 * @param {string} backupPath - 备份目录
 * @param {string[]} [protectedSubDirs=[]] - 当前需保护的子目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @returns {Promise<Object>} 规划结果
 */
export async function detectBackupRestorePlan(conn, target, backupPath, protectedSubDirs = [], useSudo = false, options = {}) {
  const rootPath = options.realRoot || (typeof target === 'object' ? target.deployRoot : target);
  const cmd = buildDetectBackupRestorePlanCommand(rootPath, backupPath, useSudo);
  const result = await execSsh(conn, cmd, { label: '探测恢复备份元信息', allowFailure: true });
  if (result.code !== 0) {
    throw new Error(`探测恢复备份失败（退出码 ${result.code}）：${result.stderr || result.stdout || '未知错误'}`);
  }
  return parseDetectBackupRestorePlanOutput(String(result.stdout || ''), {
    rootPath,
    backupPath,
    protectedSubDirs,
    extraRemoveNames: options.extraRemoveNames || [],
    hashedDirs: options.hashedDirs || DEFAULT_HASHED_ASSET_DIRS,
    log: options.log,
  });
}

/**
 * 生成回滚前静态资源完整性预检命令。
 * @param {Object} target - 部署目标
 * @param {string} backupPath - 备份目录
 * @param {string[]} [hashedDirs=DEFAULT_HASHED_ASSET_DIRS] - 带哈希目录
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildPreflightCheckRollbackCommand(target, backupPath, hashedDirs = DEFAULT_HASHED_ASSET_DIRS, useSudo = false) {
  const dirCasePatterns = hashedDirs.map((dir) => `${dir}/*|${dir}`).join('|');
  const script = [
    'set -eu',
    'root="$1"',
    'backup="$2"',
    `kind_file="$backup/${BACKUP_KIND_FILE_NAME}"`,
    'if [ ! -f "$kind_file" ]; then echo "kind=full missing_count=0"; exit 0; fi',
    'kind=$(cat "$kind_file" | tr -d "[:space:]")',
    `if [ "$kind" != "${BACKUP_KINDS.entryOnly}" ]; then echo "kind=$kind missing_count=0"; exit 0; fi`,
    `manifest_file="$backup/${BACKUP_MANIFEST_FILE_NAME}"`,
    'if [ ! -f "$manifest_file" ]; then echo "kind=entry-only missing_count=-1 error=missing_manifest"; exit 0; fi',
    'tmp_missing=$(mktemp)',
    'cleanup() { rm -f "$tmp_missing"; }',
    'trap cleanup EXIT',
    'while IFS= read -r rel; do',
    '  case "$rel" in ""|/*|*../*|../*|.*|*/.*) continue ;; esac',
    `  case "$rel" in ${dirCasePatterns})`,
    '    if [ ! -f "$root/$rel" ] && [ ! -d "$root/$rel" ]; then',
    '      echo "$rel" >> "$tmp_missing"',
    '    fi',
    '    ;;',
    '  esac',
    'done < "$manifest_file"',
    'missing_count=$(wc -l < "$tmp_missing" | tr -d " ")',
    'if [ "$missing_count" -gt 0 ]; then',
    '  echo "kind=entry-only missing_count=$missing_count"',
    '  echo "===MISSING_FILES==="',
    '  head -n 20 "$tmp_missing"',
    'else',
    '  echo "kind=entry-only missing_count=0"',
    'fi',
  ].join('\n');

  return buildRemoteShellCommand(script, [target.deployRoot, backupPath], useSudo);
}

/**
 * 远程回滚前预检：校验 entry-only 备份所依赖的静态资源是否完好存在于部署根目录。
 * @param {Object} conn - SSH 连接
 * @param {Object} target - 部署目标
 * @param {string} backupPath - 备份目录
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @param {string[]} [hashedDirs=DEFAULT_HASHED_ASSET_DIRS] - 带哈希目录
 * @returns {Promise<{ passed: boolean, kind: string, missingCount: number }>}
 */
export async function preflightCheckRollback(conn, target, backupPath, log, useSudo = false, hashedDirs = DEFAULT_HASHED_ASSET_DIRS) {
  log('info', `正在执行回滚前静态资源完整性预检：${backupPath}`, 'validate');
  const command = buildPreflightCheckRollbackCommand(target, backupPath, hashedDirs, useSudo);
  const result = await execSsh(conn, command, {
    allowFailure: true,
    label: '回滚资源完整性预检',
  });

  const stdout = String(result.stdout || '').trim();
  const kindMatch = stdout.match(/kind=([a-zA-Z0-9_-]+)/);
  const countMatch = stdout.match(/missing_count=(-?\d+)/);
  const kind = kindMatch ? kindMatch[1] : 'unknown';
  const missingCount = countMatch ? Number(countMatch[1]) : 0;

  if (missingCount === -1) {
    throw new Error('回滚预检失败：该轻量备份损坏，未找到依赖清单文件（.manifest.txt），无法保证回滚安全性');
  }

  if (missingCount > 0) {
    const missingIndex = stdout.indexOf('===MISSING_FILES===');
    let missingPreview = '';
    if (missingIndex !== -1) {
      missingPreview = stdout
        .slice(missingIndex + '===MISSING_FILES==='.length)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join('、');
    }
    const errMessage = `回滚预检失败：备份所依赖的静态资源已在当前部署目录中缺失（共缺失 ${missingCount} 个文件${missingPreview ? `，例如：${missingPreview}` : ''}）。为避免页面出现白屏故障，已终止回滚。建议重新构建并发布该版本。`;
    log('error', errMessage, 'validate');
    throw new Error(errMessage);
  }

  log('success', `回滚预检通过：备份类型 [${kind}]，依赖静态资源完好`, 'validate');
  return { passed: true, kind, missingCount: 0 };
}

/**
 * 从远程备份恢复部署根目录。
 * @param {Object} conn - SSH 连接
 * @param {Object} target - 部署目标
 * @param {string} backupPath - 备份目录
 * @param {string} label - 操作标签
 * @param {string[]} protectedSubDirs - 保留的顶层子目录
 * @param {boolean} useSudo - 是否使用 sudo
 * @param {Object} [options={}] - 配置选项
 * @returns {Promise<boolean>} 是否恢复成功
 */
async function restoreDeployRootFromBackup(conn, target, backupPath, label, protectedSubDirs = [], useSudo = false, options = {}) {
  if (!backupPath) return false;
  try {
    const plan = await detectBackupRestorePlan(conn, target, backupPath, protectedSubDirs, useSudo, options);
    if (plan.warningMessage && options.log) {
      options.log('warn', plan.warningMessage, 'cleanup');
    }
    if (plan.skippedOldBackupNames?.length && options.log) {
      options.log(
        'info',
        `旧备份里有未识别的项，没有自动恢复，如需要可手动从 ${backupPath}/${plan.skippedOldBackupNames.join('、')} 拷回`,
        'cleanup'
      );
    }
    const cmd = buildRestoreDeployRootCommand(target, backupPath, protectedSubDirs, useSudo, {
      restoreNames: plan.restoreNames,
      removeNames: plan.removeNames,
      isEntryOnly: plan.kind === BACKUP_KINDS.entryOnly,
    });
    const result = await execSsh(conn, cmd, {
      allowFailure: true,
      label,
    });
    return result.code === 0;
  } catch (error) {
    if (options.log) {
      options.log('error', `从备份恢复部署根目录失败：${error?.message || error}`, 'cleanup');
    }
    return false;
  }
}

/**
 * 清理部署目标超过保留数量的远程备份目录
 * @param {Object} conn - SSH 连接
 * @param {Object} target - 部署目标
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {Promise<boolean>} 是否清理成功
 */
async function pruneRemoteBackups(conn, target, log, useSudo = false) {
  const { backupKeepCount: keepCount } = resolveDeployRetentionCounts(target);
  const backupRoot = path.posix.join(target.deployRoot, '.yuyan-backups');
  const script = [
    'if [ -d "$1" ]; then',
    `old_dirs=$(ls -1dt "$1"/* 2>/dev/null | tail -n +${keepCount + 1});`,
    'if [ -n "$old_dirs" ]; then printf \'%s\\n\' "$old_dirs" | while IFS= read -r old_dir; do rm -rf "$old_dir"; done; fi;',
    'fi',
  ].join(' ');
  const command = useSudo
    ? `sudo -n sh -c ${shellQuote(script)} sh ${shellQuote(backupRoot)}`
    : `sh -c ${shellQuote(script)} sh ${shellQuote(backupRoot)}`;
  const result = await execSsh(conn, command, {
    allowFailure: true,
    label: `保留最近 ${keepCount} 个部署备份`,
  });
  if (result.code === 0) {
    log('info', `已执行备份保留策略：最多保留最近 ${keepCount} 个版本`, 'cleanup');
    return true;
  }
  log('warn', `备份保留策略执行失败，本次不隐藏旧回滚入口：${result.stderr || result.stdout || `退出码 ${result.code}`}`, 'cleanup');
  return false;
}

/**
 * 清理本地超过备份保留上限的回滚引用
 * @param {number} targetId - 部署目标 ID
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @param {Object} [target=null] - 部署目标对象
 */
async function pruneLocalBackupReferences(targetId, log, target = null) {
  const { backupKeepCount: keepCount } = resolveDeployRetentionCounts(target || { id: targetId });
  const result = await pruneTargetBackupReferences(targetId, keepCount);
  if (result.clearedRecords > 0) {
    log('info', `已隐藏 ${result.clearedRecords} 条旧记录的回滚入口，当前目标最多保留最近 ${keepCount} 个可回滚版本`, 'cleanup');
  }
  return result;
}

/**
 * 清理项目超过保留数量的发布记录
 * @param {number} projectId - 项目 ID
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 */
async function pruneLocalRecords(projectId, log) {
  const keepCount = Math.max(1, Number(DEPLOY_RECORD_KEEP_PER_PROJECT || 20));
  const result = await pruneProjectRecords(projectId, keepCount);
  if (result.deletedRecords > 0) {
    log('info', `已清理 ${result.deletedRecords} 条旧发布记录，当前项目最多保留最近 ${keepCount} 条`, 'cleanup');
  }
  return result;
}

/**
 * 执行 Nginx 配置文件语法校验
 * @param {Object} conn - SSH 连接
 * @param {Object} server - 服务器
 * @returns {Promise<Object>} 校验结果
 */
export async function runNginxTest(conn, server, nginxInstance) {
  return execSsh(conn, buildNginxCommand(server, nginxInstance, 'test'), { label: getNginxCommandLabel(server, nginxInstance, 'test') });
}

/**
 * 执行 Nginx 重载
 * @param {Object} conn - SSH 连接
 * @param {Object} server - 服务器
 * @returns {Promise<Object>} 重载结果
 */
export async function reloadNginx(conn, server, nginxInstance) {
  return execSsh(conn, buildNginxCommand(server, nginxInstance, 'reload'), { label: getNginxCommandLabel(server, nginxInstance, 'reload') });
}

/**
 * 测试服务器连接
 * @param {number} serverId - 服务器 ID
 * @returns {Promise<Object>} 测试结果
 */
export async function testServer(serverId) {
  const server = await getServerWithCredential(serverId);
  if (!server) throw new Error('服务器不存在');
  return withSsh(server, async (conn) => {
    const result = await execSsh(conn, 'echo yuyan-ops-ready && whoami', { label: '连接测试' });
    return {
      success: true,
      output: result.stdout.trim(),
    };
  });
}

/**
 * 读取 Nginx 配置文件
 * @param {number} targetId - 部署目标 ID
 * @returns {Promise<{content: string, path: string}>} 配置内容
 */
export async function readNginxConfig(targetId) {
  const { target, server, nginxInstance } = await getTargetContext(targetId);
  const confPath = resolveEditableNginxConfPath(target, nginxInstance);
  return withSsh(server, async (conn) => {
    const result = await execSsh(conn, `[ -f ${shellQuote(confPath)} ] && cat ${shellQuote(confPath)} || true`, {
      label: `读取 ${confPath}`,
      allowFailure: true,
    });
    return {
      path: confPath,
      content: result.stdout || '',
    };
  });
}

/**
 * 保存 Nginx 配置文件并可选重载
 * @param {number} targetId - 部署目标 ID
 * @param {Object} payload - 保存参数
 * @returns {Promise<Object>} 保存结果
 */
export async function saveNginxConfig(targetId, payload) {
  const { target, server, nginxInstance } = await getTargetContext(targetId);
  const confPath = resolveEditableNginxConfPath(target, nginxInstance);
  return withSsh(server, async (conn) => {
    const effectiveUseSudo = Boolean(nginxInstance?.useSudo || server?.useSudo);
    const effectiveServer = { ...server, useSudo: effectiveUseSudo };
    const { backupPath = '', skipped = false } = await writeRemoteTextWithBackup(conn, effectiveServer, confPath, payload.content || '');
    let testResult;
    try {
      testResult = await runNginxTest(conn, server, nginxInstance);
    } catch (error) {
      if (backupPath) {
        const sudo = effectiveUseSudo ? 'sudo -n ' : '';
        await execSsh(conn, `${sudo}cp ${shellQuote(backupPath)} ${shellQuote(confPath)}`, {
          allowFailure: true,
          label: '恢复 Nginx 配置文件备份',
        });
      }
      throw error;
    }
    if (payload.reload !== false) {
      await reloadNginx(conn, server, nginxInstance);
    }
    return {
      success: true,
      backupPath,
      skipped,
      testOutput: `${testResult.stdout || ''}${testResult.stderr || ''}`.trim(),
    };
  });
}

/**
 * 单独执行 Nginx 配置文件校验
 * @param {number} targetId - 部署目标 ID
 * @returns {Promise<Object>} 校验结果
 */
export async function testTargetNginx(targetId) {
  const { server, nginxInstance } = await getTargetContext(targetId);
  return withSsh(server, async (conn) => {
    const result = await runNginxTest(conn, server, nginxInstance);
    return {
      success: true,
      output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    };
  });
}

/**
 * 执行独立服务器发布
 * @param {number} targetId - 部署目标 ID
 * @param {Object} payload - 发布参数
 * @param {Object} emit - 进度输出器
 * @returns {Promise<Object>} 发布记录
 */
export async function deployTarget(targetId, payload, emit) {
  const { target, server, nginxInstance } = await getTargetContext(targetId);
  if (target.projectType === 'backend') return deployBackendTarget(targetId, payload, emit);
  const protectedSubDirs = await resolveProtectedSubDirs(target);
  const uploadStrategy = normalizeUploadStrategy(target.uploadStrategy);
  const isOverlayUpload = uploadStrategy === DEPLOY_UPLOAD_STRATEGIES.overlayKeepAssets;
  const deployUseSudo = resolveEffectiveDeploySudo(server, nginxInstance);
  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;
  const branch = payload.branch || target.defaultBranch || 'dev';
  const operator = String(payload.operator || '').trim() || '未知操作人';
  const signal = payload.signal;
  const logs = [];
  const log = (level, message, stage = '', source = '', extra = {}) => {
    logs.push({ level, message, stage, ...(source ? { source } : {}), ...(extra?.code ? { code: extra.code } : {}), timestamp: new Date().toISOString() });
    emit?.log(level, message, stage, source, extra);
  };
  log('info', `操作人 ${operator} 发起发布`, 'validate');
  log('info', `保留子目录：${protectedSubDirs.length ? protectedSubDirs.join('、') : '无'}`, 'validate');
  log('info', `资源上传策略：${getUploadStrategyLabel(uploadStrategy)}`, 'validate');
  const previousSuccessRecord = await getLatestSuccessfulRecord(target.id);

  const record = await createRecord({
    targetId: target.id,
    projectId: target.projectId,
    projectName: target.projectName,
    envName: target.envName || '测试',
    branch,
    action: 'deploy',
    status: 'running',
    operator,
    logs,
  });

  const { workspaceRoot, repoDir, metaPath } = resolveDeployWorkspace(target.id, branch);
  const releaseName = createReleaseName();
  let releasePath = target.deployRoot;
  let realRoot = target.deployRoot;
  let backupPath = '';
  let commitSha = '';
  let commitMessage = '';
  let commitAuthor = '';
  let backupRetentionSynced = false;
  let backupCreated = false;
  let stagedRetireCreated = false;
  let deployRootRestored = false;
  let recoveryAttempted = false;
  let existingNames = [];
  let uploadStarted = false;
  let artifactManifestPath = '';
  let artifactTopNames = [];
  let rawArtifactTopNames = [];
  let filteredArtifactTopNames = [];
  let cleanupPlan = null;
  let uploadableFiles = [];
  let deployAccess = { useSudo: deployUseSudo, uploadMode: 'sftp', userWritable: false };
  let currentStage = 'validate';
  let currentPercent = 0;

  const stage = (key, percent, message, detail = '') => {
    currentStage = key;
    currentPercent = percent;
    emit?.stage(key, percent, message, detail);
  };

  try {
    throwIfDeployStopped(signal);
    stage('validate', 5, '参数校验', '检查部署目标、服务器和构建参数');

    // 存量部署目标配置安全性校验
    await assertDeployTargetSafety(target, {
      mode: 'deploy',
      isCleanReplace: uploadStrategy === DEPLOY_UPLOAD_STRATEGIES.cleanReplace,
      isOverlayUpload,
      log,
      nginxInstance,
    });

    if (uploadStrategy === DEPLOY_UPLOAD_STRATEGIES.cleanReplace) {
      const allServerTargets = await listTargets({ serverId: target.serverId });
      const isSharedRoot = isSharedDeployRoot({ target, allServerTargets, nginxInstance });
      const hasExtraCleanup = Array.isArray(payload.extraCleanupNames) && payload.extraCleanupNames.length > 0;
      if (hasExtraCleanup && payload.cleanReplaceConfirmed !== true) {
        throw new Error('额外清理项需要二次确认后才能发布');
      }
      if (isSharedRoot) {
        if (!target.cleanupConfirmedFingerprint && payload.cleanReplaceConfirmed !== true) {
          throw new Error('该共享根目录此前未确认过清理范围或服务器目录已有变化，请先前往界面确认发布一次');
        }
      }
    }

    await fs.mkdir(workspaceRoot, { recursive: true });
    deployAccess = await effectiveWithSsh(server, async (conn) => resolveDeployRootAccess(conn, server, target, deployUseSudo, log));

    if (testHooks?.skipBuild) {
      commitSha = 'test-sha-123456';
      commitMessage = 'test commit message';
      commitAuthor = 'test-author';
      if (typeof testHooks.prepareArtifacts === 'function') {
        await testHooks.prepareArtifacts({ workspaceRoot, repoDir, target, releaseName });
      }
    } else {
      throwIfDeployStopped(signal);
      stage('clone', 15, '拉取代码', `正在拉取 ${target.projectName}#${branch}`);
      const cloneUrl = resolveCloneUrl(target.repositoryUrl, payload.gitlabToken || '');
      await syncDeployWorkspace({
        target,
        branch,
        cloneUrl,
        repoDir,
        signal,
        log,
      });
      const rev = await runLocalCommand('git rev-parse HEAD', { cwd: repoDir, label: '获取 commit', signal });
      commitSha = rev.stdout.trim();
      const commitMessageResult = await runLocalCommand('git log -1 --pretty=%s', { cwd: repoDir, label: '获取 commit 信息', signal });
      commitMessage = commitMessageResult.stdout.trim();
      const commitAuthorResult = await runLocalCommand('git log -1 --pretty=%an', { cwd: repoDir, label: '获取 commit 提交人', signal });
      commitAuthor = commitAuthorResult.stdout.trim();
      const gitlabCommitMeta = await fetchGitlabCommitMeta(target.projectId, commitSha, payload.gitlabToken || '', resolveGitlabHost(target.repositoryUrl)).catch(() => null);
      commitMessage = gitlabCommitMeta?.message || commitMessage;
      commitAuthor = gitlabCommitMeta?.author || commitAuthor;
      log('success', `代码拉取完成：${commitSha.slice(0, 8)}${commitMessage ? ` ${commitMessage}` : ''}`, 'clone');
    }
    const isBackend = target.projectType === 'backend';
    const jdkEnv = {};
    if (isBackend && target.jdkId) {
      log('info', `正在获取绑定的 JDK (ID: ${target.jdkId}) 配置...`, 'validate');
      const jdk = await getJdk(target.jdkId);
      if (jdk && jdk.homePath) {
        log('info', `已绑定 JDK: ${jdk.name} -> ${jdk.homePath}`, 'validate');
        jdkEnv.JAVA_HOME = jdk.homePath;
        jdkEnv.PATH = `${jdk.homePath}/bin:${process.env.PATH}`;
      } else {
        log('warn', `未找到绑定的 JDK (ID: ${target.jdkId}) 配置，将沿用宿主机默认 Java 环境`, 'validate');
      }
    }

    let npmConfigEnv = {};
    let installPlan = null;
    if (!isBackend) {
      npmConfigEnv = await prepareRuntimeNpmConfig(repoDir, log);

      throwIfDeployStopped(signal);
      installPlan = await resolveDependencyInstallPlan({
        repoDir,
        metaPath,
        target,
        branch,
        commitSha,
        forceInstallDependencies: Boolean(payload.forceInstallDependencies),
        signal,
      });
    }

    const baseBuildEnv = isBackend ? { ...process.env, ...jdkEnv } : npmConfigEnv;
    const initialHeapMb = isBackend
      ? Math.max(DEFAULT_MAVEN_BUILD_MEMORY_MB, Number(target.buildMemoryMb || 0))
      : resolveBuildHeapLimitMb({
          command: target.buildCommand,
          env: npmConfigEnv,
          targetBuildMemoryMb: target.buildMemoryMb,
        });
    const initialReserveMb = isBackend
      ? Math.max(DEFAULT_MAVEN_BUILD_MEMORY_MB, Number(target.buildMemoryMb || 0))
      : resolveBuildMemoryRequirementMb({
          command: target.buildCommand,
          env: npmConfigEnv,
          targetBuildMemoryMb: target.buildMemoryMb,
          targetBuildPeakMb: target.buildPeakMb,
        });

    if (!testHooks?.skipBuild) {
      await executeBuildWithOomRetry({
      initialHeapMb,
      initialReserveMb,
      enableOomRetry: !isBackend,
      targetId: target.id,
      label: `${target.projectName || 'target'}#${target.id}`,
      signal,
      prepareInInitialSlot: async () => {
        if (!isBackend) {
          stage(
            'install',
            30,
            '安装依赖',
            installPlan.shouldInstall ? installPlan.reasons.join('；') || target.installCommand : '依赖缓存命中，跳过安装依赖'
          );
          if (installPlan.shouldInstall) {
            log('info', `依赖缓存未命中：${installPlan.reasons.join('；')}`, 'install');
            await removeDependencyInstallArtifacts(repoDir);
            log('info', '已清理旧依赖目录，准备重新安装依赖', 'install');
            await ensureLegacyHuskyPreparePlaceholder(repoDir, log);
            await executeDependencyInstallWithHealing({
              command: target.installCommand,
              cwd: repoDir,
              env: npmConfigEnv,
              signal,
              log,
            });
            if (installPlan.cacheable) {
              await writeDependencyCacheMeta(metaPath, {
                targetId: target.id,
                projectId: target.projectId,
                projectName: target.projectName,
                branch,
                commitSha,
                dependencyCacheKey: installPlan.dependencyCacheKey,
                installCommand: normalizeInstallCommand(target.installCommand),
                packageManager: installPlan.packageManager,
                packageManagerVersion: installPlan.packageManagerVersion,
                nodeVersion: installPlan.nodeVersion,
                platform: installPlan.platform,
                arch: installPlan.arch,
                inputFileCount: installPlan.inputFileCount,
                updatedAt: new Date().toISOString(),
              });
              log('success', `依赖安装完成，已更新依赖缓存指纹：${installPlan.dependencyCacheKey.slice(0, 12)}`, 'install');
            } else {
              log('success', '依赖安装完成；当前安装命令或锁文件不满足跳过安装条件，本次不写入跳过安装缓存', 'install');
            }
          } else {
            log('success', `依赖缓存命中，跳过安装依赖：${installPlan.dependencyCacheKey.slice(0, 12)}`, 'install');
          }
        } else if (target.installCommand) {
          stage('install', 30, '下载依赖', target.installCommand);
          await runLocalCommandList(target.installCommand, {
            cwd: repoDir,
            env: { ...process.env, ...jdkEnv },
            label: '下载依赖',
            onLog: (level, message, source) => log(level, message, 'install', source),
            signal,
          });
        } else {
          stage('install', 30, '跳过依赖安装', '未配置依赖安装命令，依赖将通过打包命令自动下载');
        }
      },
      runBuild: async (heapMb, isRetry, slotContext) => {
        throwIfDeployStopped(signal);
        if (!isRetry) {
          if (!isBackend) {
            log(
              'info',
              `构建内存预算池已预占 ${initialReserveMb}MB（上次峰值 ${Number(target.buildPeakMb || 0)}MB，子进程堆上限 --max-old-space-size=${heapMb}）`,
              'build'
            );
          }
          stage('build', 48, '构建产物', target.buildCommand);
        } else {
          stage('build', 52, '构建产物（扩容重试）', `${target.buildCommand} (--max-old-space-size=${heapMb})`);
        }
        await runLocalCommandList(target.buildCommand, {
          cwd: repoDir,
          env: baseBuildEnv,
          maxOldSpaceMb: isBackend ? undefined : heapMb,
          label: '构建产物',
          onLog: (level, message, source) => log(level, message, 'build', source),
          onPeakRssMb: (peakMb) => slotContext?.reportPeakRssMb?.(peakMb),
          signal,
        });
      },
      onInitialWait: (waitInfo) => {
        const formatted = formatBuildWaitStage(waitInfo);
        stage(formatted.stageKey, 26, formatted.message, formatted.detail);
        log('info', formatted.logMessage, 'waiting-build-slot');
      },
      onInitialPositionChange: (waitInfo) => {
        const formatted = formatBuildWaitStage(waitInfo);
        stage(formatted.stageKey, 26, formatted.message, formatted.detail);
      },
      onBeforeRetry: (failedHeapMb, retryHeapMb) => {
        throwIfDeployStopped(signal);
        log(
          'warn',
          `检测到构建过程 Node.js 堆内存触及上限（${failedHeapMb}MB），正在释放原预占（${initialReserveMb}MB）并向内存预算池重新申请 ${retryHeapMb}MB (--max-old-space-size=${retryHeapMb}) 重试构建...`,
          'build'
        );
      },
      onRetryWait: (waitInfo) => {
        const formatted = formatBuildWaitStage(waitInfo);
        stage(formatted.stageKey, 50, formatted.message, formatted.detail);
        log('info', formatted.logMessage, 'waiting-build-slot');
      },
      onRetryPositionChange: (waitInfo) => {
        const formatted = formatBuildWaitStage(waitInfo);
        stage(formatted.stageKey, 50, formatted.message, formatted.detail);
      },
      onRetrySuccess: async (retryHeapMb) => {
        await updateTargetBuildMemoryMb(target.id, retryHeapMb);
        target.buildMemoryMb = retryHeapMb;
        log(
          'success',
          `扩容重试构建成功，已将该部署目标的构建预占内存持久化为 ${retryHeapMb}MB（下次部署将按 ${retryHeapMb}MB 预占并注入）`,
          'build'
        );
      },
      onFinally: async ({ peakRssMb, succeeded }) => {
        if (peakRssMb > 0) {
          target.buildPeakMb = await updateTargetBuildPeakMb(target.id, peakRssMb, { succeeded });
        }
      },
    });
    }

    let localJarPath = '';
    let jarFileName = '';
    let artifactPath = '';
    let artifactDir = '';

    if (isBackend) {
      const configured = String(target.artifactDir || '').trim();
      if (!configured) {
        throw new Error('未配置 Jar 产物路径，请检查部署目标的“产物目录”配置项（如：target/app.jar 或 app-starter/target/app-starter-1.0.0.jar）');
      }
      localJarPath = path.resolve(repoDir, configured);
      const fileStat = await fs.stat(localJarPath).catch(() => null);
      if (!fileStat) {
        throw new Error(`未找到 Jar 产物文件，请确认打包命令是否正确执行。检查路径：${localJarPath}`);
      }
      if (!fileStat.isFile()) {
        throw new Error(`配置的产物路径不是文件，必须直接指向 jar 包文件：${localJarPath}`);
      }
      jarFileName = path.basename(localJarPath);
      log('success', `识别到后端构建产物 Jar 包：${jarFileName}`, 'build');
    } else {
      log(
        'info',
        target.artifactDir
          ? `产物目录配置：${normalizeArtifactDir(target.artifactDir)}。该路径按仓库根目录计算，不按构建命令 cd 后的目录计算`
          : '产物目录配置为空，将自动识别本次构建生成的静态产物目录',
        'build'
      );
      const resolved = await resolveArtifactPath(repoDir, target.artifactDir);
      artifactPath = resolved.artifactPath;
      artifactDir = resolved.artifactDir;
      log('success', `识别到构建产物目录：${artifactDir}`, 'build');
      uploadableFiles = await collectUploadableArtifactFiles(artifactPath, protectedSubDirs);
      artifactManifestPath = await createArtifactManifestFile(workspaceRoot, releaseName, uploadableFiles, protectedSubDirs);
      log('info', `本次发布产物清单：${uploadableFiles.length} 个文件`, 'build');
      const artifactEntries = await fs.readdir(artifactPath).catch(() => []);
      rawArtifactTopNames = artifactEntries.filter(isValidEntryName);
      const manualProtectedNames = parsePreserveSubDirs(target.preserveSubDirs);
      const skippedManual = rawArtifactTopNames.filter((name) => manualProtectedNames.includes(name));
      if (skippedManual.length > 0) {
        log('info', `构建产物项「${skippedManual.join('、')}」命中手填保留目录，已按保留配置跳过上传`, 'build');
      }
      artifactTopNames = artifactEntries.filter((name) => isValidEntryName(name) && !protectedSubDirs.includes(name));
    }

    throwIfDeployStopped(signal);
    uploadStarted = true;
    stage('upload', 66, '上传产物', isBackend ? `上传 Jar 包到 ${server.name}:${target.deployRoot}` : `上传到 ${server.name}:${target.deployRoot}`);
    await effectiveWithSsh(server, async (conn) => {
      await execSsh(conn, buildRemoteMkdirCommand(target.deployRoot, deployUseSudo), {
        label: '创建部署目录',
      });

      // 1. 先做只读探测以获取初始 realRoot，并探测同物理服务器目标以计算最外层 lockRoot
      const initialProbe = await detectDeployRoot(conn, target.deployRoot, deployUseSudo, { ensureDir: false });
      const currentRealRoot = initialProbe.realRoot || target.deployRoot;
      const candidateRoots = [currentRealRoot];

      let allHostTargets = [];
      try {
        allHostTargets = await listPhysicalServerTargets({ serverId: target.serverId });
      } catch (err) {
        log('warn', `查询物理服务器同宿主目标失败，降级使用逻辑服务器目标：${err.message || err}`, 'upload');
        allHostTargets = await listTargets({ serverId: target.serverId }).catch(() => [target]);
      }
      const otherTargets = allHostTargets.filter((t) => Number(t.id) !== Number(target.id));
      let otherRealRootsMap = new Map();
      if (otherTargets.length > 0) {
        const otherPaths = otherTargets.map((t) => t.deployRoot);
        try {
          const detectedOthers = await batchDetectRealRoots(conn, otherPaths, deployUseSudo);
          otherTargets.forEach((t, i) => {
            const rPath = detectedOthers[i] || otherPaths[i];
            otherRealRootsMap.set(t.id, rPath);
            candidateRoots.push(rPath);
          });
        } catch (err) {
          log('warn', `批量探测其他目标真实路径失败：${err.message || err}`, 'upload');
          otherTargets.forEach((t) => {
            otherRealRootsMap.set(t.id, t.deployRoot);
            candidateRoots.push(t.deployRoot);
          });
        }
      }

      const lockRoot = resolveTopmostLockRoot(currentRealRoot, candidateRoots);
      const lockToken = await acquireFrontendDeployLock(conn, lockRoot, deployUseSudo, { recordId: record.id, log });

      try {
        if (isBackend) {
          throw new Error('后端目标必须使用版本化后端发布流程');
        } else {
          // 拿到锁之后、探测之前，清理过期的暂存与垃圾箱目录（超过 60 分钟）
          await cleanupExpiredStagingAndTrash(conn, currentRealRoot, deployUseSudo, log);

          // 加锁后重新探测部署根目录的真实路径与顶层条目
          const probe = await detectDeployRoot(conn, target.deployRoot, deployUseSudo);
          realRoot = probe.realRoot || target.deployRoot;
          releasePath = realRoot;
          let normConfig = target.deployRoot;
          try { normConfig = normalizeDeployRootPath(target.deployRoot); } catch {}
          let normReal = realRoot;
          try { normReal = normalizeDeployRootPath(realRoot); } catch {}
          if (normReal !== normConfig) {
            log('info', `检测到部署目录为软链接或存在重定向，真实路径为 ${realRoot}（配置路径为 ${target.deployRoot}），后续操作将在真实路径下执行`, 'upload');
          }

          // 在执行备份与清空前，重新计算保留名单（并入构建期间新登记的子应用与 realpath 穿透）
          const currentProtectedDetails = await resolveProtectedEntriesWithDetails(target, {
            currentRealRoot: realRoot,
            realRootsByTargetId: otherRealRootsMap,
            log,
          });
          const currentProtectedSubDirs = currentProtectedDetails.allProtected;
          const currentNestedEntries = currentProtectedDetails.nestedEntries;
          const newProtectedAdded = currentProtectedSubDirs.filter((d) => !protectedSubDirs.includes(d));
          if (newProtectedAdded.length) {
            log('info', `检测到构建期间新增受保护子目录：${newProtectedAdded.join('、')}，已自动并入保留名单`, 'upload');
            protectedSubDirs.push(...newProtectedAdded);
            if (artifactManifestPath && uploadableFiles.length > 0) {
              artifactManifestPath = await createArtifactManifestFile(workspaceRoot, releaseName, uploadableFiles, protectedSubDirs);
            }
          }

          // 重新计算保留名单后，过滤产物顶层名，排除受保护项与系统保留项
          const protectedSet = new Set(protectedSubDirs);
          filteredArtifactTopNames = artifactTopNames.filter(
            (name) => !protectedSet.has(name) && !isReservedDeployEntry(name)
          );

          // 用探测到的真实路径再次执行安全分级校验
          const nginxPaths = resolveNginxPaths(nginxInstance, target);
          const realRootRisk = classifyDeployRootRisk(realRoot, { nginxPaths });
          if (realRootRisk.level === 'block') {
            throw new Error(`探测到的真实部署根目录 ${realRoot} 存在高危风险（${realRootRisk.reason}），发布已中止`);
          }

          existingNames = probe.existingNames || [];
          const lastManifestTops = manifestTopNames(probe.manifestText);
          if (!lastManifestTops.length) {
            log('info', '没有找到上次发布清单，本次只清理产物里出现的顶层项', 'upload');
          }

          // 2. 计算清理范围指纹与门禁判定
          const extraCleanupNames = isOverlayUpload ? [] : (Array.isArray(payload.extraCleanupNames) ? payload.extraCleanupNames : []);
          const replaceOrCleanItems = lastManifestTops.filter(
            (name) => existingNames.includes(name) && !protectedSet.has(name) && !isReservedDeployEntry(name)
          );
          const replaceOrCleanSet = new Set(replaceOrCleanItems);
          const currentUnknown = existingNames.filter(
            (name) => !protectedSet.has(name) && !isReservedDeployEntry(name) && !replaceOrCleanSet.has(name)
          );
          const currentFingerprint = computeCleanupScopeFingerprint(realRoot, protectedSubDirs, currentUnknown);

          let allServerTargets = [];
          try {
            allServerTargets = await listPhysicalServerTargets({ serverId: target.serverId });
          } catch (err) {
            log('warn', `查询物理服务器部署目标失败，降级使用逻辑服务器目标：${err.message || err}`, 'upload');
            allServerTargets = await listTargets({ serverId: target.serverId });
          }
          const isSharedRoot = isSharedDeployRoot({ target, allServerTargets, nginxInstance });

          const publishGateResult = verifyPublishCleanupGate({
            isCleanReplace: uploadStrategy === DEPLOY_UPLOAD_STRATEGIES.cleanReplace,
            isSharedRoot,
            currentFingerprint,
            confirmedFingerprint: payload.confirmedFingerprint || '',
            savedFingerprint: target.cleanupConfirmedFingerprint || '',
            cleanReplaceConfirmed: payload.cleanReplaceConfirmed === true,
            extraCleanupNames,
          });

          if (!publishGateResult.allowed) {
            throw new Error(publishGateResult.reason || '清理范围门禁校验未通过，已中止发布');
          }

          cleanupPlan = computeCleanupPlan({
            existingNames,
            artifactTopNames: filteredArtifactTopNames,
            manifestTopNames: lastManifestTops,
            protectedNames: protectedSubDirs,
            extraCleanupNames,
            mode: uploadStrategy,
          });

          if (cleanupPlan.rejectedExtra.length) {
            log('warn', `以下勾选的额外清理项已被跳过（仅允许清理当前未识别项）：${cleanupPlan.rejectedExtra.join('、')}`, 'upload');
          }

          // 部署日志记录
          log('info', `部署真实路径：${realRoot}`, 'upload');
          log('info', `保留名单（嵌套目标/手填保留/系统目录）：${[...cleanupPlan.keptProtected, ...cleanupPlan.keptReserved].join('、') || '无'}`, 'upload');
          log('info', `待删除名单：${cleanupPlan.deleteNames.join('、') || '无'}`, 'upload');
          log('info', `未识别已保留名单：${cleanupPlan.keptUnknown.join('、') || '无'}`, 'upload');
          if (extraCleanupNames.length) {
            log('info', `用户确认额外清理项：${extraCleanupNames.join('、')}`, 'upload');
          }
          // 如果实际删除名单里有只因产物同名而删的未识别项，单独记录一行日志
          const replacedByArtifact = cleanupPlan.deleteNames.filter(
            (name) => !lastManifestTops.includes(name) && !extraCleanupNames.includes(name) && filteredArtifactTopNames.includes(name)
          );
          if (replacedByArtifact.length > 0) {
            log('info', `以下项因与本次产物同名而被替换：${replacedByArtifact.join('、')}`, 'upload');
          }

          // 上限保护与子应用重名防御拦截
          assertCleanupSafetyCeiling({
            cleanupPlan,
            rawArtifactTopNames,
            filteredArtifactTopNames,
            nestedNames: currentNestedEntries,
            manifestTopNames: lastManifestTops,
            extraCleanupNames,
          });

          // 3. 计算备份包含的顶层条目
          backupPath = path.posix.join(realRoot, '.yuyan-backups', releaseName);
          let backupKind = BACKUP_KINDS.full;
          let namesToBackup = [];
          if (isOverlayUpload) {
            if (lastManifestTops.length > 0) {
              backupKind = BACKUP_KINDS.entryOnly;
              const candidateBackup = new Set([...filteredArtifactTopNames, ...lastManifestTops]);
              const hashedSet = new Set(DEFAULT_HASHED_ASSET_DIRS);
              namesToBackup = existingNames.filter(
                (name) => candidateBackup.has(name) && !protectedSubDirs.includes(name) && !isReservedDeployEntry(name) && !hashedSet.has(name)
              );
            } else {
              backupKind = BACKUP_KINDS.full;
              const candidateBackup = new Set([...filteredArtifactTopNames, ...lastManifestTops]);
              namesToBackup = existingNames.filter(
                (name) => candidateBackup.has(name) && !protectedSubDirs.includes(name) && !isReservedDeployEntry(name)
              );
            }
          } else {
            backupKind = BACKUP_KINDS.full;
            namesToBackup = cleanupPlan.deleteNames;
          }

          // 4. 拆成两次独立执行：备份成功后立刻置 backupCreated = true，再执行暂存/清空
          await execSsh(
            conn,
            [
              buildRemoteMkdirCommand(backupPath, deployUseSudo),
              buildBackupDeployRootCommand(realRoot, backupPath, protectedSubDirs, deployUseSudo, {
                kind: backupKind,
                namesToBackup,
                isOverlayUpload,
              }),
            ].join(' && '),
            {
              label: '备份部署目录',
            }
          );
          backupCreated = true;
          log('info', `备份已完成（路径：${backupPath}，包含顶层条目：${namesToBackup.join('、') || '无'}）`, 'upload');

          if (!isOverlayUpload) {
            if (cleanupPlan.deleteNames.length > 0) {
              await execSsh(conn, buildStagedRetireCommand(realRoot, cleanupPlan.deleteNames, releaseName, deployUseSudo), {
                label: '暂存旧版本条目',
              });
              stagedRetireCreated = true;
              log('info', `旧版本条目已安全移入暂存区（.yuyan-retiring-${releaseName}）`, 'cleanup');
            }
            if (isSharedRoot && payload.cleanReplaceConfirmed === true && publishGateResult.requireSaveConfirmation) {
              try {
                await updateTargetCleanupConfirmed(target.id, {
                  fingerprint: currentFingerprint,
                  at: new Date().toISOString(),
                  by: payload.operator || target.createdBy || 'unknown',
                  scope: {
                    protected: [...protectedSubDirs].sort(),
                    unknown: [...currentUnknown].sort(),
                  },
                });
                log('info', `已更新共享根目录清理确认指纹（${currentFingerprint.slice(0, 8)}）与审计记录`, 'cleanup');
              } catch (confirmError) {
                log('warn', `保存清理确认指纹失败：${confirmError.message || confirmError}`, 'cleanup');
              }
            }
          } else {
            log('info', '覆盖上传模式已跳过清空部署目录，旧 hash 静态资源将暂时保留', 'upload');
          }

          let uploaded = 0;
          if (deployAccess.uploadMode === 'sudoTar') {
            uploaded = await uploadDirectoryWithSudoTar(conn, artifactPath, realRoot, {
              archivePath: path.join(workspaceRoot, `artifact-${releaseName}.tar.gz`),
              releaseName,
              protectedSubDirs,
              signal,
              log,
              deferRootFileNames: ['index.html'],
            });
          } else {
            await uploadDirectory(conn, artifactPath, realRoot, ({ remotePath }) => {
              uploaded += 1;
              if (uploaded <= 5 || uploaded % 30 === 0) {
                log('info', `已上传：${remotePath}`, 'upload');
              }
            }, { excludeTopLevelNames: protectedSubDirs, deferRootFileNames: ['index.html'] });
          }
          log('success', `产物上传完成，共 ${uploaded} 个文件`, 'upload');

          if (target.enableNginxTest) {
            stage('nginx', 82, '校验 Nginx', `执行 ${getNginxCommandLabel(server, nginxInstance, 'test')}`);
            const testResult = await runNginxTest(conn, server, nginxInstance);
            log('success', `${testResult.stderr || testResult.stdout}`.trim() || 'nginx -t 校验通过', 'nginx');
          }

          if (target.enableNginxReload) {
            stage('reload', 92, '重载 Nginx', `执行 ${getNginxCommandLabel(server, nginxInstance, 'reload')}`);
            await reloadNginx(conn, server, nginxInstance);
            log('success', 'Nginx 重载完成', 'reload');
          }

          if (stagedRetireCreated) {
            const purgeResult = await execSsh(conn, buildPurgeStagedRetireCommand(realRoot, releaseName, deployUseSudo), {
              allowFailure: true,
              label: '清理暂存旧版本条目',
            }).catch((err) => ({ code: 1, stderr: err?.message || String(err) }));
            stagedRetireCreated = false;
            if (purgeResult.code !== 0) {
              const stagingPath = path.posix.join(realRoot, `.yuyan-retiring-${releaseName}`);
              log('warn', `清理暂存区失败，目录已保留：${stagingPath}（${purgeResult.stderr || '未知错误'}）`, 'cleanup');
            }
          }

          if (artifactManifestPath) {
            try {
              const remoteManifestPath = await uploadArtifactManifest(conn, artifactManifestPath, { ...target, deployRoot: realRoot }, releaseName, deployUseSudo);
              log('info', `已写入发布产物清单：${remoteManifestPath}`, 'cleanup');
            } catch (manifestError) {
              log('warn', `发布产物清单写入失败，本次发布不回滚：${manifestError.message || manifestError}`, 'cleanup');
            }
          }
        }

        // 1. 先清理超出保留上限的旧备份目录，淘汰最老版本
        backupRetentionSynced = await pruneRemoteBackups(conn, { ...target, deployRoot: realRoot }, log, deployUseSudo);

        // 2. 再按现存备份目录下的 .manifest.txt 以及最近清单清理静态资源，确保所有存活备份依赖的 chunk 绝不误删
        if (artifactManifestPath) {
          try {
            await pruneRemoteArtifactManifests(conn, { ...target, deployRoot: realRoot }, log, deployUseSudo);
          } catch (manifestError) {
            log('warn', `旧静态资源清理失败，本次发布不回滚：${manifestError.message || manifestError}`, 'cleanup');
          }
        }

        try {
          const statsScript = [
            'root="$1"',
            'backup="$2"',
            'get_size() {',
            '  val=""',
            '  if command -v timeout >/dev/null 2>&1; then',
            '    val=$(timeout 5 du -sh "$1" 2>/dev/null | cut -f1) || true',
            '  else',
            '    val=$(du -sh "$1" 2>/dev/null | cut -f1) || true',
            '  fi',
            '  if [ -n "$val" ]; then echo "$val"; else echo "-"; fi',
            '}',
            'b_size=$(get_size "$backup")',
            'all_b_size=$(get_size "$root/.yuyan-backups")',
            'assets_size=$(get_size "$root/assets")',
            'echo "backup=$b_size all_backups=$all_b_size assets=$assets_size"',
          ].join('\n');
          const statsResult = await execSsh(conn, buildRemoteShellCommand(statsScript, [realRoot, backupPath], deployUseSudo), {
            allowFailure: true,
            label: '采集备份与存储占用统计',
          });
          if (statsResult.code === 0) {
            const out = String(statsResult.stdout || '');
            const bMatch = out.match(/backup=([^\s]+)/);
            const allMatch = out.match(/all_backups=([^\s]+)/);
            const assetsMatch = out.match(/assets=([^\s]+)/);
            const bSize = bMatch ? bMatch[1] : '-';
            const allSize = allMatch ? allMatch[1] : '-';
            const assetsSize = assetsMatch ? assetsMatch[1] : '-';
            log('info', `存储可观测：本次备份体积 ${bSize}，备份目录总体积 ${allSize}，静态资源(assets)体积 ${assetsSize}`, 'cleanup');
          }
        } catch {
          // 可观测性统计采集异常不影响发布主流程
        }
      } catch (deployError) {
        recoveryAttempted = true;
        if (stagedRetireCreated) {
          const restoreStagingRes = await execSsh(
            conn,
            buildRestoreFromStagingCommand(realRoot, releaseName, cleanupPlan?.deleteNames || [], deployUseSudo),
            {
              allowFailure: true,
              label: '从暂存区还原旧条目',
            }
          ).catch((err) => ({ code: 1, stderr: err?.message || String(err) }));
          if (restoreStagingRes.code === 0) {
            stagedRetireCreated = false;
            log('info', `发布失败，已成功从暂存区还原旧版本条目（.yuyan-retiring-${releaseName}）`, 'cleanup');

            const candidateNames = (filteredArtifactTopNames || []).filter(
              (name) => !cleanupPlan?.deleteNames?.includes(name) && !existingNames.includes(name)
            );
            let clearSuccess = true;
            if (candidateNames.length > 0) {
              const clearRes = await execSsh(
                conn,
                buildClearDeployRootCommand(realRoot, candidateNames, deployUseSudo),
                {
                  allowFailure: true,
                  label: '清理新增条目',
                }
              ).catch((err) => ({ code: 1, stderr: err?.message || String(err) }));
              if (clearRes.code !== 0) {
                clearSuccess = false;
                log('warn', `清理本次新增条目失败（${candidateNames.join('、')}），退回备份恢复流程：${clearRes.stderr || '未知错误'}`, 'cleanup');
              }
            }
            if (clearSuccess) {
              deployRootRestored = true;
              log('warn', '发布失败，已从暂存区还原旧版本并移除本次新增条目', 'cleanup');
            }
          } else {
            const stagingPath = path.posix.join(realRoot, `.yuyan-retiring-${releaseName}`);
            log('warn', `发布失败，暂存区还原失败，目录已保留以供排查：${stagingPath}（${restoreStagingRes.stderr || '未知错误'}）`, 'cleanup');
          }
        }

        if (backupCreated && !deployRootRestored) {
          deployRootRestored = await restoreDeployRootFromBackup(
            conn,
            { ...target, deployRoot: realRoot || target.deployRoot },
            backupPath,
            '恢复失败发布前目录',
            protectedSubDirs,
            deployUseSudo,
            { extraRemoveNames: filteredArtifactTopNames, realRoot, log }
          ).catch(() => false);
          if (deployRootRestored) {
            log('warn', `发布失败，已恢复部署目录到失败前状态：${backupPath}`, 'cleanup');
          } else {
            log('error', `发布失败，部署目录自动恢复失败，请人工检查备份目录：${backupPath}`, 'cleanup');
          }
        }
        throw deployError;
      } finally {
        await releaseFrontendDeployLock(conn, lockRoot, lockToken, deployUseSudo, log).catch(() => {});
      }
    });

    stage('finish', 100, '发布完成', `${target.projectName} 发布成功`);
    let successRecord = await updateRecord(record.id, {
      status: 'success',
      commitSha,
      commitMessage,
      commitAuthor,
      releasePath,
      backupPath,
      restoredRecordId: record.id,
      backupRecordId: previousSuccessRecord?.id || 0,
      logs,
      finishedAt: new Date().toISOString(),
    });
    let shouldSyncLogs = false;
    if (backupRetentionSynced) {
      const backupReferenceResult = await pruneLocalBackupReferences(target.id, log, target);
      shouldSyncLogs = shouldSyncLogs || backupReferenceResult.clearedRecords > 0;
    }
    const pruneResult = await pruneLocalRecords(target.projectId, log);
    shouldSyncLogs = shouldSyncLogs || pruneResult.deletedRecords > 0;
    if (shouldSyncLogs) {
      successRecord = await updateRecord(record.id, { logs });
    }
    emit?.result(successRecord);
    return successRecord;
  } catch (error) {
    if (isDeployStoppedError(error) && !uploadStarted) {
      log('warn', error.message || '发布任务已停止', 'cancel');
      stage(currentStage, currentPercent, '已停止', '发布任务已停止，未进入上传产物阶段');
      const stoppedRecord = await updateRecord(record.id, {
        status: 'stopped',
        commitSha,
        commitMessage,
        commitAuthor,
        releasePath,
        backupPath: '',
        logs,
        finishedAt: new Date().toISOString(),
      });
      emit?.result(stoppedRecord);
      return stoppedRecord;
    }

    logOperationFailure(log, error, 'error');
    if (backupCreated && !deployRootRestored && !recoveryAttempted) {
      deployRootRestored = await effectiveWithSsh(server, async (conn) =>
        restoreDeployRootFromBackup(conn, { ...target, deployRoot: realRoot || target.deployRoot }, backupPath, '恢复失败发布前目录', protectedSubDirs, deployUseSudo, { extraRemoveNames: filteredArtifactTopNames, realRoot, log })
      ).catch(() => false);
      if (deployRootRestored) {
        log('warn', `发布失败，已恢复部署目录到失败前状态：${backupPath}`, 'cleanup');
      } else {
        log('error', `发布失败，部署目录自动恢复失败，请人工检查备份目录：${backupPath}`, 'cleanup');
      }
    }
    if (backupPath) {
      if (!backupCreated || deployRootRestored) {
        await effectiveWithSsh(server, async (conn) => {
          await removeRemotePath(conn, server, backupPath, '清理失败发布备份目录', deployUseSudo);
        }).catch(() => {});
        log('warn', `发布失败，已触发失败备份清理：${backupPath}`, 'cleanup');
      } else {
        log('warn', `发布失败备份暂未清理，便于人工恢复：${backupPath}`, 'cleanup');
      }
    }
    let failedRecord = await updateRecord(record.id, {
      status: 'failed',
      commitSha,
      commitMessage,
      commitAuthor,
      releasePath,
      backupPath: '',
      logs,
      finishedAt: new Date().toISOString(),
    });
    const pruneResult = await pruneLocalRecords(target.projectId, log);
    if (pruneResult.deletedRecords > 0) {
      failedRecord = await updateRecord(record.id, { logs });
    }
    emit?.error(error instanceof Error ? error.message : String(error), currentStage, getSshFailureEventExtra(error));
    throw error;
  } finally {
    await fs.rm(path.join(repoDir, '.yuyan.npmrc'), { force: true }).catch(() => {});
  }
}

/**
 * 构建恢复操作元信息。
 * @param {'rollback'|'undoRollback'} action - 恢复操作类型
 * @returns {Object} 恢复操作配置
 */
function getRestoreActionMeta(action) {
  if (action === 'undoRollback') {
    return {
      action,
      operationText: '撤销回滚',
      branchPrefix: 'undo-rollback',
      progressTitle: '执行撤销回滚',
      finishTitle: '撤销回滚完成',
      successDetail: '已恢复回滚前版本',
      unavailableMessage: '该记录当前不可撤销回滚',
    };
  }
  return {
    action: 'rollback',
    operationText: '回滚',
    branchPrefix: 'rollback',
    progressTitle: '执行回滚',
    finishTitle: '回滚完成',
    successDetail: '已恢复上一版本',
    unavailableMessage: '该记录当前不可回滚',
  };
}

/**
 * 从可恢复记录中复制生效版本提交信息。
 * @param {Object} record - 发布记录
 * @returns {Object} 提交字段快照
 */
function pickRecordCommitSnapshot(record) {
  return {
    commitSha: record?.commitSha || '',
    commitMessage: record?.commitMessage || '',
    commitAuthor: record?.commitAuthor || '',
  };
}

/**
 * 恢复指定发布记录备份目录，并创建审计记录。
 * @param {number} recordId - 来源发布记录 ID
 * @param {Object} payload - 恢复参数
 * @param {Object} emit - 进度输出器
 * @param {'rollback'|'undoRollback'} action - 恢复操作类型
 * @returns {Promise<Object>} 恢复审计记录
 */
async function restoreRecordVersion(recordId, payload, emit, action) {
  const meta = getRestoreActionMeta(action);
  const sourceRecord = await getRecord(recordId);
  if (!sourceRecord) throw new Error('发布记录不存在');
  if (meta.action === 'rollback' && !sourceRecord.canRollback) throw new Error(meta.unavailableMessage);
  if (meta.action === 'undoRollback' && !sourceRecord.canUndoRollback) throw new Error(meta.unavailableMessage);
  if (!sourceRecord.backupPath) throw new Error('该记录没有可恢复的上一版本');
  const restoredRecord = await getRecord(sourceRecord.backupRecordId);
  if (!restoredRecord) throw new Error('可恢复版本记录不存在，无法确认恢复目标');
  const restoredCommit = pickRecordCommitSnapshot(restoredRecord);

  const { target, server, nginxInstance } = await getTargetContext(sourceRecord.targetId);
  const protectedSubDirs = await resolveProtectedSubDirs(target);
  const uploadStrategy = normalizeUploadStrategy(target.uploadStrategy);
  const isOverlayUpload = uploadStrategy === DEPLOY_UPLOAD_STRATEGIES.overlayKeepAssets;
  const deployUseSudo = resolveEffectiveDeploySudo(server, nginxInstance);
  const operator = String(payload.operator || '').trim() || '未知操作人';
  let realRoot = target.deployRoot;
  let currentBackup = '';
  let currentBackupCreated = false;
  let targetRestoreNames = [];
  let backupRetentionSynced = false;
  let rollbackRootRestored = false;
  let rollbackRecoveryAttempted = false;
  let currentStage = 'rollback';
  const logs = [];
  const log = (level, message, stage = '', source = '', extra = {}) => {
    logs.push({ level, message, stage, ...(source ? { source } : {}), ...(extra?.code ? { code: extra.code } : {}), timestamp: new Date().toISOString() });
    emit?.log(level, message, stage, source, extra);
  };
  log('info', `操作人 ${operator} 发起${meta.operationText}，来源发布记录 #${sourceRecord.id}`, 'rollback');
  log('info', `本次恢复目标：#${restoredRecord.id}${restoredRecord.commitSha ? ` ${restoredRecord.commitSha.slice(0, 8)}` : ''}${restoredRecord.commitMessage ? ` ${restoredRecord.commitMessage}` : ''}`, 'validate');
  log('info', `保留子目录：${protectedSubDirs.length ? protectedSubDirs.join('、') : '无'}`, 'validate');

  // 存量部署目标配置安全性校验
  await assertDeployTargetSafety(target, {
    mode: meta.action,
    isCleanReplace: false,
    log,
    nginxInstance,
  });

  const restoreRecord = await createRecord({
    targetId: target.id,
    projectId: target.projectId,
    projectName: target.projectName,
    envName: target.envName || '测试',
    branch: `${meta.branchPrefix}-${sourceRecord.id}`,
    action: meta.action,
    sourceRecordId: sourceRecord.id,
    restoredRecordId: restoredRecord.id,
    ...restoredCommit,
    status: 'running',
    operator,
    releasePath: target.deployRoot,
    backupPath: '',
    logs,
  });

  try {
    currentStage = 'rollback';
    emit?.stage('rollback', 40, meta.progressTitle, `恢复目录备份 ${sourceRecord.backupPath}`);
    await effectiveWithSsh(server, async (conn) => {
      await ensureDeployRootOperable(conn, server, target, deployUseSudo);
      const probe = await detectDeployRoot(conn, target.deployRoot, deployUseSudo);
      realRoot = probe.realRoot || target.deployRoot;
      if (realRoot !== target.deployRoot) {
        log('info', `检测到部署目录为软链接或存在重定向，真实路径为 ${realRoot}（配置路径为 ${target.deployRoot}），后续操作将在真实路径下执行`, 'validate');
      }

      // 计算 lockRoot 并加锁（需求 6）
      let allHostTargets = [];
      try {
        allHostTargets = await listPhysicalServerTargets({ serverId: target.serverId });
      } catch (err) {
        log('warn', `查询物理服务器同宿主目标失败，降级使用逻辑服务器目标：${err.message || err}`, 'rollback');
        allHostTargets = await listTargets({ serverId: target.serverId }).catch(() => [target]);
      }
      const otherTargets = allHostTargets.filter((t) => Number(t.id) !== Number(target.id));
      const candidateRoots = [realRoot];
      if (otherTargets.length > 0) {
        const otherPaths = otherTargets.map((t) => t.deployRoot);
        try {
          const detectedOthers = await batchDetectRealRoots(conn, otherPaths, deployUseSudo);
          otherTargets.forEach((t, i) => {
            const rPath = detectedOthers[i] || otherPaths[i];
            candidateRoots.push(rPath);
          });
        } catch (err) {
          otherTargets.forEach((t) => candidateRoots.push(t.deployRoot));
        }
      }
      const lockRoot = resolveTopmostLockRoot(realRoot, candidateRoots);
      const lockToken = await acquireFrontendDeployLock(conn, lockRoot, deployUseSudo, { recordId: restoreRecord.id, log });

      try {
        // 拿到锁之后、探测之前，清理过期暂存与垃圾箱
        await cleanupExpiredStagingAndTrash(conn, realRoot, deployUseSudo, log);

        // 回滚/撤销回滚对探测到的真实路径做风险分级校验，block 即中止
        const nginxPaths = resolveNginxPaths(nginxInstance, target);
        const realRootRisk = classifyDeployRootRisk(realRoot, { nginxPaths });
        if (realRootRisk.level === 'block') {
          throw new Error(`探测到的真实部署根目录 ${realRoot} 存在高危风险（${realRootRisk.reason}），操作已中止`);
        }

        await preflightCheckRollback(conn, { ...target, deployRoot: realRoot }, sourceRecord.backupPath, log, deployUseSudo);

        // 先算 restorePlan，再备份待变更项，kind 与 restorePlan.kind 相同
        const restorePlan = await detectBackupRestorePlan(conn, { ...target, deployRoot: realRoot }, sourceRecord.backupPath, protectedSubDirs, deployUseSudo, { realRoot });
        targetRestoreNames = restorePlan.restoreNames || [];
        if (restorePlan.warningMessage) {
          log('warn', restorePlan.warningMessage, 'cleanup');
        }
        if (restorePlan.skippedOldBackupNames?.length) {
          log(
            'info',
            `旧备份里有未识别的项，没有自动恢复，如需要可手动从 ${sourceRecord.backupPath}/${restorePlan.skippedOldBackupNames.join('、')} 拷回`,
            'cleanup'
          );
        }
        log('info', `待恢复条目名单：${restorePlan.restoreNames.join('、') || '无'}`, 'rollback');
        log('info', `待清理旧条目名单：${restorePlan.removeNames.join('、') || '无'}`, 'rollback');

        const existingSet = new Set(probe.existingNames);
        const namesToBackupSet = new Set(restorePlan.removeNames);
        for (const rName of restorePlan.restoreNames) {
          if (existingSet.has(rName)) {
            namesToBackupSet.add(rName);
          }
        }
        const namesToBackup = [...namesToBackupSet].sort();

        currentBackup = path.posix.join(realRoot, '.yuyan-backups', `${meta.branchPrefix}-${createReleaseName()}`);
        await execSsh(conn, buildRemoteMkdirCommand(currentBackup, deployUseSudo), {
          label: '创建操作前备份目录',
        });
        await execSsh(conn, buildBackupDeployRootCommand(realRoot, currentBackup, protectedSubDirs, deployUseSudo, {
          kind: restorePlan.kind,
          namesToBackup,
          isOverlayUpload: restorePlan.kind === BACKUP_KINDS.entryOnly,
        }), {
          label: '备份当前目录',
        });
        currentBackupCreated = true;

        const restoreCmd = buildRestoreDeployRootCommand(realRoot, sourceRecord.backupPath, protectedSubDirs, deployUseSudo, {
          restoreNames: restorePlan.restoreNames,
          removeNames: restorePlan.removeNames,
          isEntryOnly: restorePlan.kind === BACKUP_KINDS.entryOnly,
        });
        await execSsh(conn, restoreCmd, {
          label: '恢复目录备份',
        });

        const testResult = await runNginxTest(conn, server, nginxInstance);
        log('success', `${testResult.stderr || testResult.stdout}`.trim() || 'nginx -t 校验通过', 'nginx');
        await reloadNginx(conn, server, nginxInstance);
        log('success', 'Nginx 重载完成', 'reload');
        backupRetentionSynced = await pruneRemoteBackups(conn, { ...target, deployRoot: realRoot }, log, deployUseSudo);
      } catch (rollbackError) {
        rollbackRecoveryAttempted = true;
        if (currentBackupCreated && currentBackup && !rollbackRootRestored) {
          rollbackRootRestored = await restoreDeployRootFromBackup(conn, { ...target, deployRoot: realRoot }, currentBackup, '恢复操作前目录', protectedSubDirs, deployUseSudo, {
            realRoot,
            log,
            extraRemoveNames: targetRestoreNames,
          }).catch(() => false);
          if (rollbackRootRestored) {
            log('warn', `${meta.operationText}失败，已恢复部署目录到操作前状态：${currentBackup}`, 'cleanup');
            await removeRemotePath(conn, server, currentBackup, `清理失败${meta.operationText}备份目录`, deployUseSudo).catch(() => {});
            log('warn', `${meta.operationText}失败，已触发失败备份清理：${currentBackup}`, 'cleanup');
          } else {
            log('error', `${meta.operationText}失败，部署目录自动恢复失败，请人工检查备份目录：${currentBackup}`, 'cleanup');
          }
        }
        throw rollbackError;
      } finally {
        await releaseFrontendDeployLock(conn, lockRoot, lockToken, deployUseSudo, log).catch(() => {});
      }
    });

    currentStage = 'finish';
    emit?.stage('finish', 100, meta.finishTitle, meta.successDetail);
    let successRecord = await updateRecord(restoreRecord.id, {
      status: 'success',
      ...restoredCommit,
      releasePath: target.deployRoot,
      backupPath: currentBackup,
      restoredRecordId: restoredRecord.id,
      backupRecordId: sourceRecord.id,
      logs,
      finishedAt: new Date().toISOString(),
    });
    let shouldSyncLogs = false;
    if (backupRetentionSynced) {
      const backupReferenceResult = await pruneLocalBackupReferences(target.id, log, target);
      shouldSyncLogs = shouldSyncLogs || backupReferenceResult.clearedRecords > 0;
    }
    const pruneResult = await pruneLocalRecords(target.projectId, log);
    shouldSyncLogs = shouldSyncLogs || pruneResult.deletedRecords > 0;
    if (shouldSyncLogs) {
      successRecord = await updateRecord(restoreRecord.id, { logs });
    }
    emit?.result(successRecord);
    return successRecord;
  } catch (error) {
    logOperationFailure(log, error, 'error');
    if (rollbackRecoveryAttempted && currentBackupCreated && currentBackup) {
      // 持锁期间内层已执行过恢复（成功时已清理备份，失败时保留备份），锁释放后不再重复恢复
    } else if (currentBackupCreated && currentBackup) {
      rollbackRootRestored = await withSsh(server, async (conn) =>
        restoreDeployRootFromBackup(conn, { ...target, deployRoot: realRoot }, currentBackup, '恢复操作前目录', protectedSubDirs, deployUseSudo, {
          realRoot,
          log,
          extraRemoveNames: targetRestoreNames,
        })
      ).catch(() => false);
      if (rollbackRootRestored) {
        log('warn', `${meta.operationText}失败，已恢复部署目录到操作前状态：${currentBackup}`, 'cleanup');
        await effectiveWithSsh(server, async (conn) => {
          await removeRemotePath(conn, server, currentBackup, `清理失败${meta.operationText}备份目录`, deployUseSudo);
        }).catch(() => {});
        log('warn', `${meta.operationText}失败，已触发失败备份清理：${currentBackup}`, 'cleanup');
      } else {
        log('error', `${meta.operationText}失败，部署目录自动恢复失败，请人工检查备份目录：${currentBackup}`, 'cleanup');
      }
    } else {
      if (currentBackup) {
        await effectiveWithSsh(server, async (conn) => {
          await removeRemotePath(conn, server, currentBackup, `清理未创建完成的${meta.operationText}备份目录`, deployUseSudo);
        }).catch(() => {});
      }
      log('info', `${meta.operationText === '撤销回滚' ? '撤销回滚' : '回滚'}前备份失败，部署目录没有改动`, 'cleanup');
    }
    let failedRecord = await updateRecord(restoreRecord.id, {
      status: 'failed',
      backupPath: '',
      logs,
      finishedAt: new Date().toISOString(),
    });
    const pruneResult = await pruneLocalRecords(target.projectId, log);
    if (pruneResult.deletedRecords > 0) {
      failedRecord = await updateRecord(restoreRecord.id, { logs });
    }
    emit?.error(error instanceof Error ? error.message : String(error), currentStage, getSshFailureEventExtra(error));
    throw error;
  }
}

/**
 * 回滚发布记录
 * @param {number} recordId - 发布记录 ID
 * @param {Object} payload - 回滚参数
 * @param {Object} emit - 进度输出器
 * @returns {Promise<Object>} 回滚记录
 */
export async function rollbackRecord(recordId, payload, emit) {
  const sourceRecord = await getRecord(recordId);
  const target = sourceRecord ? await getTarget(sourceRecord.targetId) : null;
  if (target?.projectType === 'backend') return restoreBackendRecord(recordId, payload, emit, 'rollback');
  return restoreRecordVersion(recordId, payload, emit, 'rollback');
}

/**
 * 撤销回滚发布记录
 * @param {number} recordId - 回滚记录 ID
 * @param {Object} payload - 撤销参数
 * @param {Object} emit - 进度输出器
 * @returns {Promise<Object>} 撤销回滚记录
 */
export async function undoRollbackRecord(recordId, payload, emit) {
  const sourceRecord = await getRecord(recordId);
  const target = sourceRecord ? await getTarget(sourceRecord.targetId) : null;
  if (target?.projectType === 'backend') return restoreBackendRecord(recordId, payload, emit, 'undoRollback');
  return restoreRecordVersion(recordId, payload, emit, 'undoRollback');
}
