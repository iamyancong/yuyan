/**
 * 独立服务器部署核心服务
 * @description 负责本地构建、远程发布、Nginx 配置文件管理和回滚
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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
  pruneProjectRecords,
  pruneTargetBackupReferences,
  updateRecord,
  getManagedNginxInstanceByServerId,
  getJdk,
} from './deploy-store.mjs';
import { DEPLOY_BACKUP_KEEP_PER_TARGET, DEPLOY_DATA_DIR, DEPLOY_RECORD_KEEP_PER_PROJECT } from '../config/constants.mjs';
import { withHiddenWindow } from '../utils/child-process.mjs';
import {
  execSsh,
  shellQuote,
  uploadDirectory,
  uploadFile,
  withSsh,
  writeRemoteTextWithBackup,
} from './ssh-service.mjs';
import { deployBackendTarget, restoreBackendRecord } from './backend-runtime-service.mjs';

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
 * 拆分输出行
 * @param {string} text - 原始输出
 * @returns {string[]} 非空行列表
 */
function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
 * 为本次发布准备临时 npm 认证配置。
 * @param {string} repoDir - 本次发布 clone 出来的仓库目录
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @returns {Promise<Object>} 需要注入命令执行环境的变量
 */
async function prepareRuntimeNpmConfig(repoDir, log) {
  const content = createRuntimeNpmrcContent();
  if (!content) return {};

  const npmrcPath = path.join(repoDir, '.yuyan.npmrc');
  await fs.writeFile(npmrcPath, `${content}\n`, { mode: 0o600 });
  log('info', '已注入运行时 npm 私服配置，用于本次依赖安装', 'install');
  return { NPM_CONFIG_USERCONFIG: npmrcPath };
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
function parsePreserveSubDirs(value) {
  const dirs = String(value || '')
    .split(/[,，]/)
    .map((item) => item.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .map((item) => item.split('/')[0])
    .filter((item) => item && item !== '.' && item !== '..' && !['.yuyan-backups', DEPLOY_MANIFEST_DIR_NAME].includes(item));
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
  const parent = normalizeDeployRoot(parentRoot);
  const child = normalizeDeployRoot(childRoot);
  const prefix = parent === '/' ? '/' : `${parent}/`;
  if (!child.startsWith(prefix) || child === parent) return '';
  return child.slice(prefix.length).split('/')[0] || '';
}

/**
 * 获取当前部署目标需要保护的顶层子目录。
 * @param {Object} target - 当前部署目标
 * @returns {Promise<string[]>} 保留子目录列表
 */
async function resolveProtectedSubDirs(target) {
  const manualDirs = parsePreserveSubDirs(target.preserveSubDirs);
  const targets = await listTargets({ serverId: target.serverId });
  const autoDirs = targets
    .filter((item) => Number(item.id) !== Number(target.id))
    .map((item) => getNestedDeploySubDir(target.deployRoot, item.deployRoot))
    .filter(Boolean);
  return [...new Set([...autoDirs, ...manualDirs])];
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
 * @param {string} workspaceRoot - 发布工作区
 * @param {string} releaseName - 发布版本号
 * @param {string[]} relativeFiles - 本次上传文件相对路径
 * @returns {Promise<string>} 本地清单路径
 */
async function createArtifactManifestFile(workspaceRoot, releaseName, relativeFiles) {
  const manifestPath = path.join(workspaceRoot, `artifact-manifest-${releaseName}.txt`);
  const content = `${relativeFiles.filter(Boolean).join('\n')}\n`;
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
  if (!useSudo) {
    await uploadFile(conn, manifestPath, remoteManifestPath);
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
 * 按最近发布清单清理旧静态资源。
 * @param {Object} conn - SSH 连接
 * @param {Object} target - 部署目标
 * @param {(level: string, message: string, stage?: string) => void} log - 日志函数
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {Promise<boolean>} 是否清理成功
 */
async function pruneRemoteArtifactManifests(conn, target, log, useSudo = false) {
  const keepCount = Math.max(1, Number(DEPLOY_BACKUP_KEEP_PER_TARGET || 8));
  const script = [
    'set -eu',
    'root="$1"',
    'keep="$2"',
    `manifest_dir="$root/${DEPLOY_MANIFEST_DIR_NAME}"`,
    'if [ ! -d "$manifest_dir" ]; then echo "deleted_files=0 deleted_manifests=0"; exit 0; fi',
    'tmp_all=$(mktemp)',
    'tmp_recent=$(mktemp)',
    'tmp_stale_files=$(mktemp)',
    'tmp_stale_manifests=$(mktemp)',
    'tmp_delete=$(mktemp)',
    'cleanup() { rm -f "$tmp_all" "$tmp_recent" "$tmp_stale_files" "$tmp_stale_manifests" "$tmp_delete"; }',
    'trap cleanup EXIT',
    'find "$manifest_dir" -maxdepth 1 -type f -name "*.txt" | sort > "$tmp_all"',
    'total=$(wc -l < "$tmp_all" | tr -d " ")',
    'if [ "$total" -le "$keep" ]; then echo "deleted_files=0 deleted_manifests=0"; exit 0; fi',
    'stale_count=$((total - keep))',
    'tail -n "$keep" "$tmp_all" | while IFS= read -r manifest; do [ -f "$manifest" ] && cat "$manifest"; done | sed "/^$/d" | sort -u > "$tmp_recent"',
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
  const result = await execSsh(conn, buildRemoteShellCommand(script, [target.deployRoot, String(keepCount)], useSudo), {
    allowFailure: true,
    label: `保留最近 ${keepCount} 次发布静态资源`,
  });
  if (result.code !== 0) {
    log('warn', `旧静态资源清理失败：${result.stderr || result.stdout || `退出码 ${result.code}`}`, 'cleanup');
    return false;
  }
  const output = String(result.stdout || '').trim();
  log('info', `已执行静态资源保留策略：最近 ${keepCount} 次发布；${output || 'deleted_files=0 deleted_manifests=0'}`, 'cleanup');
  return true;
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

    const child = spawn(command, withHiddenWindow({
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== 'win32',
    }));

    let stdout = '';
    let stderr = '';
    let stopped = false;
    let killTimer = null;

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
      const text = chunk.toString();
      stdout += text;
      for (const line of splitLines(text)) options.onLog?.('info', line);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of splitLines(text)) options.onLog?.('warn', line);
    });

    child.on('error', (error) => {
      cleanupAbortListener();
      reject(stopped || options.signal?.aborted ? createDeployStoppedError(options.signal) : error);
    });
    child.on('close', (code) => {
      cleanupAbortListener();
      if (stopped || options.signal?.aborted) {
        reject(createDeployStoppedError(options.signal));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${options.label || command} 执行失败，退出码 ${code}\n${stderr || stdout}`));
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
      onLog: (level, message) => log(level, message, 'clone'),
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
      onLog: (level, message) => log(level, message, 'clone'),
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
 * @param {string} command - 安装命令
 * @returns {boolean} 是否标准安装命令
 */
function isStandardInstallCommand(command) {
  if (splitCommandList(command).length !== 1) return false;
  const normalized = normalizeInstallCommand(command);
  if (!normalized || hasShellControlOperator(normalized)) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const managerIndex = tokens[0] === 'corepack' ? 1 : 0;
  const manager = tokens[managerIndex];
  const action = tokens[managerIndex + 1];
  const trailingTokens = tokens.slice(managerIndex + 2);
  const hasOnlyFlags = trailingTokens.every((token) => token.startsWith('-'));
  if (!hasOnlyFlags) return false;
  if (manager === 'pnpm') return ['install', 'i'].includes(action);
  if (manager === 'npm') return ['install', 'i', 'ci'].includes(action);
  if (manager === 'yarn') return action === 'install';
  if (manager === 'bun') return action === 'install';
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
async function getTargetContext(targetId) {
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
function buildNginxCommand(server, nginxInstance, type) {
  if (nginxInstance?.instanceType === 'managed') {
    const sudo = nginxInstance.useSudo ? 'sudo -n ' : '';
    const scriptPath = nginxInstance.scriptPath || '/opt/yuyan/nginx/yuyan-nginx.sh';
    return `${sudo}${shellQuote(scriptPath)} ${type}`;
  }
  const command =
    type === 'reload'
      ? nginxInstance?.nginxReloadCommand || server.nginxReloadCommand || 'nginx -s reload'
      : nginxInstance?.nginxTestCommand || server.nginxTestCommand || 'nginx -t';
  const sudo = (nginxInstance ? nginxInstance.useSudo : server.useSudo) ? 'sudo -n ' : '';
  const workDir = String(nginxInstance?.nginxWorkDir || server.nginxWorkDir || '').trim();
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
function getNginxCommandLabel(server, nginxInstance, type) {
  if (nginxInstance?.instanceType === 'managed') {
    const scriptPath = nginxInstance.scriptPath || '/opt/yuyan/nginx/yuyan-nginx.sh';
    return `${scriptPath} ${type}`;
  }
  const command =
    type === 'reload'
      ? nginxInstance?.nginxReloadCommand || server.nginxReloadCommand || 'nginx -s reload'
      : nginxInstance?.nginxTestCommand || server.nginxTestCommand || 'nginx -t';
  const workDir = String(nginxInstance?.nginxWorkDir || server.nginxWorkDir || '').trim();
  return workDir ? `cd ${workDir} && ${command}` : command;
}

/**
 * 解析发布目录操作是否使用 sudo。
 * @param {Object} server - 服务器配置
 * @param {Object} nginxInstance - Nginx 实例配置
 * @returns {boolean} 是否使用 sudo
 */
function resolveEffectiveDeploySudo(server, nginxInstance) {
  return Boolean(nginxInstance ? nginxInstance.useSudo : server.useSudo);
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
 * 生成 find 排除条件。
 * @param {string[]} protectedSubDirs - 保留的顶层子目录
 * @returns {string} find 排除参数
 */
function buildFindExcludeArgs(protectedSubDirs = []) {
  return ['.yuyan-backups', DEPLOY_MANIFEST_DIR_NAME, ...protectedSubDirs].map((name) => `! -name ${shellQuote(name)}`).join(' ');
}

/**
 * 生成备份部署目录命令，保留受保护子目录在原位。
 * @param {Object} target - 部署目标
 * @param {string} backupPath - 备份目录
 * @param {string[]} protectedSubDirs - 保留的顶层子目录
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} 远程命令
 */
function buildBackupDeployRootCommand(target, backupPath, protectedSubDirs, useSudo = false) {
  return `${buildSudoPrefix(useSudo)}find ${shellQuote(target.deployRoot)} -mindepth 1 -maxdepth 1 ${buildFindExcludeArgs(protectedSubDirs)} -exec cp -a {} ${shellQuote(`${backupPath}/`)} \\;`;
}

/**
 * 生成清理部署目录命令，跳过受保护子目录。
 * @param {Object} target - 部署目标
 * @param {string[]} protectedSubDirs - 保留的顶层子目录
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} 远程命令
 */
function buildClearDeployRootCommand(target, protectedSubDirs, useSudo = false) {
  return `${buildSudoPrefix(useSudo)}find ${shellQuote(target.deployRoot)} -mindepth 1 -maxdepth 1 ${buildFindExcludeArgs(protectedSubDirs)} -exec rm -rf {} +`;
}

/**
 * 生成从备份恢复部署目录命令，避免旧备份覆盖受保护子目录。
 * @param {Object} target - 部署目标
 * @param {string} backupPath - 备份目录
 * @param {string[]} protectedSubDirs - 保留的顶层子目录
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} 远程命令
 */
function buildRestoreDeployRootCommand(target, backupPath, protectedSubDirs, useSudo = false) {
  return [
    buildClearDeployRootCommand(target, protectedSubDirs, useSudo),
    `${buildSudoPrefix(useSudo)}find ${shellQuote(backupPath)} -mindepth 1 -maxdepth 1 ${buildFindExcludeArgs(protectedSubDirs)} -exec cp -a {} ${shellQuote(`${target.deployRoot}/`)} \\;`,
  ].join(' && ');
}

/**
 * 从远程备份恢复部署根目录
 * @param {Object} conn - SSH 连接
 * @param {Object} target - 部署目标
 * @param {string} backupPath - 备份目录
 * @param {string} label - 操作标签
 * @param {string[]} protectedSubDirs - 保留的顶层子目录
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {Promise<boolean>} 是否恢复成功
 */
async function restoreDeployRootFromBackup(conn, target, backupPath, label, protectedSubDirs = [], useSudo = false) {
  if (!backupPath) return false;
  const result = await execSsh(
    conn,
    buildRestoreDeployRootCommand(target, backupPath, protectedSubDirs, useSudo),
    {
      allowFailure: true,
      label,
    }
  );
  return result.code === 0;
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
  const keepCount = Math.max(1, Number(DEPLOY_BACKUP_KEEP_PER_TARGET || 8));
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
 */
async function pruneLocalBackupReferences(targetId, log) {
  const keepCount = Math.max(1, Number(DEPLOY_BACKUP_KEEP_PER_TARGET || 8));
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
    const effectiveServer = { ...server, useSudo: nginxInstance.useSudo };
    const { backupPath } = await writeRemoteTextWithBackup(conn, effectiveServer, confPath, payload.content || '');
    let testResult;
    try {
      testResult = await runNginxTest(conn, server, nginxInstance);
    } catch (error) {
      const sudo = nginxInstance.useSudo ? 'sudo -n ' : '';
      await execSsh(conn, `${sudo}cp ${shellQuote(backupPath)} ${shellQuote(confPath)}`, {
        allowFailure: true,
        label: '恢复 Nginx 配置文件备份',
      });
      throw error;
    }
    if (payload.reload !== false) {
      await reloadNginx(conn, server, nginxInstance);
    }
    return {
      success: true,
      backupPath,
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
  const branch = payload.branch || target.defaultBranch || 'dev';
  const operator = String(payload.operator || '').trim() || '未知操作人';
  const signal = payload.signal;
  const logs = [];
  const log = (level, message, stage = '') => {
    logs.push({ level, message, stage, timestamp: new Date().toISOString() });
    emit?.log(level, message, stage);
  };
  log('info', `操作人 ${operator} 发起发布`, 'audit');
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
  const releasePath = target.deployRoot;
  let backupPath = '';
  let commitSha = '';
  let commitMessage = '';
  let commitAuthor = '';
  let backupRetentionSynced = false;
  let backupCreated = false;
  let deployRootRestored = false;
  let uploadStarted = false;
  let artifactManifestPath = '';
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
    await fs.mkdir(workspaceRoot, { recursive: true });
    deployAccess = await withSsh(server, async (conn) => resolveDeployRootAccess(conn, server, target, deployUseSudo, log));

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
    if (!isBackend) {
      npmConfigEnv = await prepareRuntimeNpmConfig(repoDir, log);

      throwIfDeployStopped(signal);
      const installPlan = await resolveDependencyInstallPlan({
        repoDir,
        metaPath,
        target,
        branch,
        commitSha,
        forceInstallDependencies: Boolean(payload.forceInstallDependencies),
        signal,
      });
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
        await runLocalCommandList(target.installCommand, {
          cwd: repoDir,
          env: npmConfigEnv,
          label: '安装依赖',
          onLog: (level, message) => log(level, message, 'install'),
          signal,
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
        onLog: (level, message) => log(level, message, 'install'),
        signal,
      });
    } else {
      stage('install', 30, '跳过依赖安装', '未配置依赖安装命令，依赖将通过打包命令自动下载');
    }

    throwIfDeployStopped(signal);
    stage('build', 48, '构建产物', target.buildCommand);
    await runLocalCommandList(target.buildCommand, {
      cwd: repoDir,
      env: isBackend ? { ...process.env, ...jdkEnv } : npmConfigEnv,
      label: '构建产物',
      onLog: (level, message) => log(level, message, 'build'),
      signal,
    });

    let localJarPath = '';
    let jarFileName = '';
    let artifactPath = '';
    let artifactDir = '';

    if (isBackend) {
      const configured = String(target.artifactDir || '').trim();
      if (!configured) {
        throw new Error('未配置 Jar 产物路径，请检查部署目标的“产物目录”配置项（如： valuation-outsourced-starter/target/valuation-outsourced-starter-3.0.0-SNAPSHOT.jar）');
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
      const uploadableFiles = await collectUploadableArtifactFiles(artifactPath, protectedSubDirs);
      artifactManifestPath = await createArtifactManifestFile(workspaceRoot, releaseName, uploadableFiles);
      log('info', `本次发布产物清单：${uploadableFiles.length} 个文件`, 'build');
    }

    throwIfDeployStopped(signal);
    uploadStarted = true;
    stage('upload', 66, '上传产物', isBackend ? `上传 Jar 包到 ${server.name}:${target.deployRoot}` : `上传到 ${server.name}:${target.deployRoot}`);
    await withSsh(server, async (conn) => {
      await execSsh(conn, buildRemoteMkdirCommand(target.deployRoot, deployUseSudo), {
        label: '创建部署目录',
      });

      if (isBackend) {
        throw new Error('后端目标必须使用版本化后端发布流程');
      } else {
        backupPath = path.posix.join(target.deployRoot, '.yuyan-backups', releaseName);
        const backupCommands = [buildRemoteMkdirCommand(backupPath, deployUseSudo), buildBackupDeployRootCommand(target, backupPath, protectedSubDirs, deployUseSudo)];
        if (!isOverlayUpload) backupCommands.push(buildClearDeployRootCommand(target, protectedSubDirs, deployUseSudo));
        await execSsh(conn, backupCommands.join(' && '), {
          label: isOverlayUpload ? '备份部署目录' : '备份并清空部署目录',
        });
        backupCreated = true;
        if (isOverlayUpload) {
          log('info', '覆盖上传模式已跳过清空部署目录，旧 hash 静态资源将暂时保留', 'upload');
        }

        let uploaded = 0;
        if (deployAccess.uploadMode === 'sudoTar') {
          uploaded = await uploadDirectoryWithSudoTar(conn, artifactPath, target.deployRoot, {
            archivePath: path.join(workspaceRoot, `artifact-${releaseName}.tar.gz`),
            releaseName,
            protectedSubDirs,
            signal,
            log,
            deferRootFileNames: ['index.html'],
          });
        } else {
          await uploadDirectory(conn, artifactPath, target.deployRoot, ({ remotePath }) => {
            uploaded += 1;
            if (uploaded <= 5 || uploaded % 30 === 0) {
              log('info', `已上传：${remotePath}`, 'upload');
            }
          }, { excludeTopLevelNames: protectedSubDirs, deferRootFileNames: ['index.html'] });
        }
        log('success', `产物上传完成，共 ${uploaded} 个文件`, 'upload');

        if (target.enableNginxTest) {
          stage('nginx', 82, '校验 Nginx', `执行 ${getNginxCommandLabel(server, nginxInstance, 'test')}`);
          try {
            const testResult = await runNginxTest(conn, server, nginxInstance);
            log('success', `${testResult.stderr || testResult.stdout}`.trim() || 'nginx -t 校验通过', 'nginx');
          } catch (error) {
            deployRootRestored = await restoreDeployRootFromBackup(conn, target, backupPath, '恢复部署目录备份', protectedSubDirs, deployUseSudo);
            throw error;
          }
        }

        if (target.enableNginxReload) {
          stage('reload', 92, '重载 Nginx', `执行 ${getNginxCommandLabel(server, nginxInstance, 'reload')}`);
          await reloadNginx(conn, server, nginxInstance);
          log('success', 'Nginx 重载完成', 'reload');
        }

        if (artifactManifestPath) {
          try {
            const remoteManifestPath = await uploadArtifactManifest(conn, artifactManifestPath, target, releaseName, deployUseSudo);
            log('info', `已写入发布产物清单：${remoteManifestPath}`, 'cleanup');
            await pruneRemoteArtifactManifests(conn, target, log, deployUseSudo);
          } catch (manifestError) {
            log('warn', `发布产物清单写入或旧资源清理失败，本次发布不回滚：${manifestError.message || manifestError}`, 'cleanup');
          }
        }
      }

      backupRetentionSynced = await pruneRemoteBackups(conn, target, log, deployUseSudo);
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
      const backupReferenceResult = await pruneLocalBackupReferences(target.id, log);
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

    log('error', error instanceof Error ? error.message : String(error), 'error');
    if (backupCreated && !deployRootRestored) {
      deployRootRestored = await withSsh(server, async (conn) => restoreDeployRootFromBackup(conn, target, backupPath, '恢复失败发布前目录', protectedSubDirs, deployUseSudo)).catch(() => false);
      if (deployRootRestored) {
        log('warn', `发布失败，已恢复部署目录到失败前状态：${backupPath}`, 'cleanup');
      } else {
        log('error', `发布失败，部署目录自动恢复失败，请人工检查备份目录：${backupPath}`, 'cleanup');
      }
    }
    if (backupPath) {
      if (!backupCreated || deployRootRestored) {
        await withSsh(server, async (conn) => {
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
    emit?.error(error instanceof Error ? error.message : String(error), currentStage);
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
  const deployUseSudo = resolveEffectiveDeploySudo(server, nginxInstance);
  const operator = String(payload.operator || '').trim() || '未知操作人';
  let currentBackup = '';
  let backupRetentionSynced = false;
  let rollbackRootRestored = false;
  let currentStage = 'rollback';
  const logs = [];
  const log = (level, message, stage = '') => {
    logs.push({ level, message, stage, timestamp: new Date().toISOString() });
    emit?.log(level, message, stage);
  };
  log('info', `操作人 ${operator} 发起${meta.operationText}，来源发布记录 #${sourceRecord.id}`, 'audit');
  log('info', `本次恢复目标：#${restoredRecord.id}${restoredRecord.commitSha ? ` ${restoredRecord.commitSha.slice(0, 8)}` : ''}${restoredRecord.commitMessage ? ` ${restoredRecord.commitMessage}` : ''}`, 'validate');
  log('info', `保留子目录：${protectedSubDirs.length ? protectedSubDirs.join('、') : '无'}`, 'validate');

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
    await withSsh(server, async (conn) => {
      await ensureDeployRootOperable(conn, server, target, deployUseSudo);
      currentBackup = path.posix.join(target.deployRoot, '.yuyan-backups', `${meta.branchPrefix}-${createReleaseName()}`);
      await execSsh(conn, `${buildRemoteMkdirCommand(currentBackup, deployUseSudo)} && ${buildBackupDeployRootCommand(target, currentBackup, protectedSubDirs, deployUseSudo)}`, {
        label: '备份当前目录',
      });
      await execSsh(conn, buildRestoreDeployRootCommand(target, sourceRecord.backupPath, protectedSubDirs, deployUseSudo), {
        label: '恢复目录备份',
      });
      const testResult = await runNginxTest(conn, server, nginxInstance);
      log('success', `${testResult.stderr || testResult.stdout}`.trim() || 'nginx -t 校验通过', 'nginx');
      await reloadNginx(conn, server, nginxInstance);
      log('success', 'Nginx 重载完成', 'reload');
      backupRetentionSynced = await pruneRemoteBackups(conn, target, log, deployUseSudo);
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
      const backupReferenceResult = await pruneLocalBackupReferences(target.id, log);
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
    log('error', error instanceof Error ? error.message : String(error), 'error');
    if (currentBackup) {
      rollbackRootRestored = await withSsh(server, async (conn) => restoreDeployRootFromBackup(conn, target, currentBackup, '恢复操作前目录', protectedSubDirs, deployUseSudo)).catch(() => false);
      if (rollbackRootRestored) {
        log('warn', `${meta.operationText}失败，已恢复部署目录到操作前状态：${currentBackup}`, 'cleanup');
        await withSsh(server, async (conn) => {
          await removeRemotePath(conn, server, currentBackup, `清理失败${meta.operationText}备份目录`, deployUseSudo);
        }).catch(() => {});
        log('warn', `${meta.operationText}失败，已触发失败备份清理：${currentBackup}`, 'cleanup');
      } else {
        log('error', `${meta.operationText}失败，部署目录自动恢复失败，请人工检查备份目录：${currentBackup}`, 'cleanup');
      }
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
    emit?.error(error instanceof Error ? error.message : String(error), currentStage);
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
