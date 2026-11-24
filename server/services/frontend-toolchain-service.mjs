/**
 * 前端包管理器多版本工具链调度服务
 * @description 将雨燕平台自身的 pnpm 版本与被部署业务项目的 pnpm 版本彻底解耦：
 * 1. 按业务仓库 package.json 的 packageManager 字段声明（如 pnpm@10.15.0）自动解析所需版本；
 * 2. 按「L1 镜像预置只读池 -> L2 数据目录持久化缓存池 -> 宿主机版本匹配 -> L2 内网私服按需安装」顺序调度；
 * 3. 仅在本次部署子进程的环境变量中前置 PATH，并关闭 pnpm 10+ 内置 manage-package-manager-versions 自下载，
 *    避免绕过 .npmrc 直连公网 registry.npmjs.org 或污染宿主机全局环境。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DEPLOY_DATA_DIR } from '../config/constants.mjs';
import { withHiddenWindow } from '../utils/child-process.mjs';

/** 严格的 SemVer 版本白名单（防止路径穿越与命令注入） */
const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 支持解析的包管理器名称 */
const SUPPORTED_PACKAGE_MANAGERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);

/** 镜像预置只读工具链默认根目录 */
export const DEFAULT_PREINSTALLED_TOOLCHAINS_DIR = '/opt/yuyan-toolchains';

/** 仓库未声明 packageManager 时的默认 pnpm 版本（保障存量项目零回归） */
export const DEFAULT_FALLBACK_PNPM_VERSION = '9.15.9';

/** 按需安装单次超时时间（毫秒） */
const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;

/** 同版本并发安装单飞锁：key = `${cacheRoot}::pnpm@${version}` */
const inFlightInstallMap = new Map();

/**
 * 解析 package.json 中的 packageManager 字段。
 * 支持 `pnpm@10.15.0`、`pnpm@9.15.9+sha512.xxx`、`pnpm@10.15.0-rc.1` 等标准写法。
 * 拒绝非精确版本（如 `^10.0.0`、`latest`）及包含路径/特殊字符的非法输入。
 * @param {string} raw - 原始 packageManager 字符串
 * @returns {{ name: string, version: string, raw: string } | null} 解析结果，非法时返回 null
 */
export function parsePackageManagerSpec(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const atIndex = text.indexOf('@');
  if (atIndex <= 0) return null;

  const name = text.slice(0, atIndex).trim().toLowerCase();
  if (!SUPPORTED_PACKAGE_MANAGERS.has(name)) return null;

  // 剥离 corepack 附加的 +sha512... / +sha256... 构建元数据
  const versionPart = text.slice(atIndex + 1).split('+')[0].trim();
  if (!STRICT_SEMVER_RE.test(versionPart)) return null;

  return {
    name,
    version: versionPart,
    raw: text,
  };
}

/**
 * 读取业务仓库根目录 package.json 中的 packageManager 声明。
 * @param {string} repoDir - 仓库根目录
 * @returns {Promise<{ name: string, version: string, raw: string } | null>} 解析后的包管理器规格
 */
export async function readRepoPackageManagerSpec(repoDir) {
  if (!repoDir) return null;
  const pkgPath = path.join(repoDir, 'package.json');
  const content = await fs.readFile(pkgPath, 'utf8').catch(() => '');
  if (!content) return null;
  try {
    const pkg = JSON.parse(content);
    return parsePackageManagerSpec(pkg?.packageManager);
  } catch {
    return null;
  }
}

/**
 * 判断部署命令（安装或构建）是否调用了 pnpm。
 * @param {string} [installCommand=''] - 安装命令
 * @param {string} [buildCommand=''] - 构建命令
 * @returns {boolean} 是否使用了 pnpm
 */
export function commandsUsePnpm(installCommand = '', buildCommand = '') {
  const combined = `${String(installCommand || '')}\n${String(buildCommand || '')}`;
  return /(?:^|[\s;&|()])pnpm(?=$|[\s;&|()])/.test(combined);
}

/**
 * 根据运行平台返回 `npm install -g --prefix <prefixDir>` 产出的可执行文件目录与二进制名。
 * @param {string} prefixDir - npm --prefix 目录
 * @param {NodeJS.Platform} [platform=process.platform] - 目标平台
 * @returns {{ binDir: string, binPath: string }} bin 目录与 pnpm 可执行文件路径
 */
export function resolvePnpmPrefixLayout(prefixDir, platform = process.platform) {
  const isWin = platform === 'win32';
  const binDir = isWin ? prefixDir : path.join(prefixDir, 'bin');
  const binPath = path.join(binDir, isWin ? 'pnpm.cmd' : 'pnpm');
  return { binDir, binPath };
}

/**
 * 检查指定路径的文件是否存在且可读。
 * @param {string} filePath - 文件路径
 * @returns {Promise<boolean>} 是否存在
 */
async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 将工具链 binDir 前置到 PATH，并组装需要注入子进程的环境变量。
 * 统一注入 `npm_config_manage_package_manager_versions=false`，
 * 防止 pnpm 10+ 绕过雨燕及内网 .npmrc 自行连公网下载包管理器。
 * @param {string} binDir - 工具链 bin 目录（为空时不修改 PATH）
 * @param {Object} [options={}] - 组装选项
 * @param {string} [options.basePath] - 基础 PATH 值
 * @param {NodeJS.Platform} [options.platform=process.platform] - 平台
 * @returns {Record<string, string>} 子进程注入环境变量
 */
export function buildPnpmToolchainEnv(binDir, options = {}) {
  const platform = options.platform || process.platform;
  const env = {
    npm_config_manage_package_manager_versions: 'false',
  };
  if (binDir) {
    const delimiter = platform === 'win32' ? ';' : ':';
    const currentPath = String(options.basePath ?? process.env.PATH ?? process.env.Path ?? '').trim();
    env.PATH = currentPath ? `${binDir}${delimiter}${currentPath}` : binDir;
  }
  return env;
}

/**
 * 探测当前宿主机默认 pnpm 的实际版本（关闭 manage-package-manager-versions 以获取真实二进制版本）。
 * @param {Object} [options={}] - 探测选项
 * @param {string} [options.cwd] - 执行目录
 * @param {Record<string, string>} [options.env] - 附加环境变量
 * @param {AbortSignal} [options.signal] - 取消信号
 * @param {NodeJS.Platform} [options.platform=process.platform] - 平台
 * @returns {Promise<string>} 版本号，未安装或探测失败时返回空字符串
 */
export function probeHostPnpmVersion(options = {}) {
  const platform = options.platform || process.platform;
  const bin = platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return new Promise((resolve) => {
    execFile(
      bin,
      ['--version'],
      withHiddenWindow({
        cwd: options.cwd,
        timeout: 10_000,
        signal: options.signal,
        env: {
          ...process.env,
          ...(options.env || {}),
          npm_config_manage_package_manager_versions: 'false',
        },
      }),
      (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        const version = String(stdout || '').trim().split(/\s+/)[0] || '';
        resolve(STRICT_SEMVER_RE.test(version) ? version : '');
      }
    );
  });
}

/**
 * 通过 npm 复用内网 .npmrc 配置将指定版本 pnpm 安装到隔离 prefix 目录。
 * @param {Object} options - 安装参数
 * @param {string} options.version - 目标 pnpm 精确版本号
 * @param {string} options.prefixDir - 临时安装前缀目录
 * @param {string} [options.npmrcPath] - 优先使用的 .npmrc 文件路径
 * @param {AbortSignal} [options.signal] - 取消信号
 * @param {number} [options.timeoutMs] - 超时时间
 * @param {NodeJS.Platform} [options.platform=process.platform] - 平台
 * @returns {Promise<void>}
 */
function runNpmInstallPnpm({ version, prefixDir, npmrcPath, signal, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS, platform = process.platform }) {
  const npmBin = platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install', '-g', '--prefix', prefixDir, '--no-audit', '--no-fund', `pnpm@${version}`];
  const env = {
    ...process.env,
    npm_config_manage_package_manager_versions: 'false',
  };
  if (npmrcPath) {
    env.NPM_CONFIG_USERCONFIG = npmrcPath;
  }

  return new Promise((resolve, reject) => {
    execFile(
      npmBin,
      args,
      withHiddenWindow({
        timeout: timeoutMs,
        signal,
        env,
        maxBuffer: 4 * 1024 * 1024,
      }),
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message || '').trim().slice(0, 600);
          reject(new Error(`按需安装 pnpm@${version} 失败：${detail}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * 确定按需安装 pnpm 时应复用的 .npmrc 文件路径。
 * 优先级：雨燕运行时私服配置（NPM_CONFIG_USERCONFIG） > 仓库根目录 .npmrc > 系统默认 npm 配置。
 * @param {string} repoDir - 仓库根目录
 * @param {Record<string, string>} [runtimeEnv={}] - 运行时环境变量
 * @returns {Promise<{ npmrcPath: string, sourceLabel: string }>} npmrc 路径与日志描述
 */
async function resolveNpmrcForToolchainInstall(repoDir, runtimeEnv = {}) {
  const runtimeUserConfig = String(runtimeEnv?.NPM_CONFIG_USERCONFIG || '').trim();
  if (runtimeUserConfig && (await fileExists(runtimeUserConfig))) {
    return { npmrcPath: runtimeUserConfig, sourceLabel: '雨燕运行时私服 .npmrc' };
  }
  if (repoDir) {
    const repoNpmrc = path.join(repoDir, '.npmrc');
    if (await fileExists(repoNpmrc)) {
      return { npmrcPath: repoNpmrc, sourceLabel: '仓库根 .npmrc' };
    }
  }
  return { npmrcPath: '', sourceLabel: '系统默认 npm 源' };
}

/**
 * 在单版本互斥锁保护下，将指定版本的 pnpm 原子安装到 L2 持久化缓存池。
 * @param {Object} options - 安装选项
 * @param {string} options.version - 精确版本号
 * @param {string} options.cacheRoot - L2 工具链缓存根目录
 * @param {string} options.repoDir - 当前仓库目录
 * @param {Record<string, string>} [options.runtimeEnv] - 运行时环境变量
 * @param {(level: string, message: string, stage?: string) => void} [options.log] - 日志回调
 * @param {AbortSignal} [options.signal] - 停止信号
 * @param {NodeJS.Platform} [options.platform=process.platform] - 平台
 * @param {Function} [options.installPackageFn] - 可注入的安装函数（单测用）
 * @returns {Promise<{ binDir: string, binPath: string, reusedConcurrent: boolean }>} 安装结果
 */
async function ensureCachedPnpmVersion({
  version,
  cacheRoot,
  repoDir,
  runtimeEnv,
  log,
  signal,
  platform = process.platform,
  installPackageFn = runNpmInstallPnpm,
}) {
  const pnpmPoolDir = path.join(cacheRoot, 'pnpm');
  const targetDir = path.join(pnpmPoolDir, version);
  const targetLayout = resolvePnpmPrefixLayout(targetDir, platform);
  const lockKey = `${pnpmPoolDir}::${version}`;

  if (inFlightInstallMap.has(lockKey)) {
    log?.('info', `包管理器调度：pnpm@${version} 正在由其他并发任务安装，等待复用...`, 'install');
    await inFlightInstallMap.get(lockKey);
    if (await fileExists(targetLayout.binPath)) {
      return { ...targetLayout, reusedConcurrent: true };
    }
  }

  const installTask = (async () => {
    await fs.mkdir(pnpmPoolDir, { recursive: true });
    // 双重检查，避免并发竞态重复下载
    if (await fileExists(targetLayout.binPath)) {
      return;
    }

    const { npmrcPath, sourceLabel } = await resolveNpmrcForToolchainInstall(repoDir, runtimeEnv);
    const tmpDir = path.join(pnpmPoolDir, `.tmp-${version}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      log?.('info', `包管理器调度：未命中本地工具链，正在按需安装 pnpm@${version}（复用${sourceLabel}）...`, 'install');
      await installPackageFn({
        version,
        prefixDir: tmpDir,
        npmrcPath,
        signal,
        platform,
      });

      const tmpLayout = resolvePnpmPrefixLayout(tmpDir, platform);
      if (!(await fileExists(tmpLayout.binPath))) {
        throw new Error(`安装完成后未找到可执行文件：${tmpLayout.binPath}`);
      }

      try {
        await fs.rename(tmpDir, targetDir);
      } catch (renameErr) {
        // 并发或残留场景下若目标目录已就绪则直接复用，否则抛出原错误
        if (await fileExists(targetLayout.binPath)) {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          return;
        }
        throw renameErr;
      }
    } catch (error) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })();

  inFlightInstallMap.set(lockKey, installTask);
  try {
    await installTask;
  } finally {
    if (inFlightInstallMap.get(lockKey) === installTask) {
      inFlightInstallMap.delete(lockKey);
    }
  }

  return { ...targetLayout, reusedConcurrent: false };
}

/**
 * 为本次前端部署解析并准备包管理器工具链环境。
 * @param {Object} options - 调度选项
 * @param {string} options.repoDir - 本次发布仓库目录
 * @param {string} [options.installCommand=''] - 部署安装命令
 * @param {string} [options.buildCommand=''] - 部署构建命令
 * @param {Record<string, string>} [options.runtimeEnv={}] - 已准备好的运行时环境变量
 * @param {(level: string, message: string, stage?: string) => void} [options.log] - 日志回调
 * @param {AbortSignal} [options.signal] - 停止信号
 * @param {string} [options.preinstalledRoot] - L1 镜像预置根目录（可注入，便于单测）
 * @param {string} [options.cacheRoot] - L2 持久化缓存根目录（可注入，便于单测）
 * @param {string} [options.defaultPnpmVersion] - 未声明 packageManager 时的默认 pnpm 版本
 * @param {boolean} [options.allowAutoInstall] - 是否允许 L2 按需安装未预置版本
 * @param {NodeJS.Platform} [options.platform=process.platform] - 运行平台
 * @param {string} [options.basePath] - 基础 PATH（可注入，便于单测）
 * @param {Function} [options.probeHostVersionFn] - 宿主机版本探测函数（可注入，便于单测）
 * @param {Function} [options.installPackageFn] - 按需安装执行函数（可注入，便于单测）
 * @returns {Promise<{
 *   managed: boolean,
 *   packageManager: string,
 *   version: string,
 *   declaredByRepo: boolean,
 *   source: 'none' | 'preinstalled' | 'cached' | 'host' | 'installed' | 'fallback',
 *   binDir: string,
 *   env: Record<string, string>,
 * }>} 调度结果与需要注入构建子进程的环境变量
 */
export async function resolveFrontendToolchain(options) {
  const {
    repoDir,
    installCommand = '',
    buildCommand = '',
    runtimeEnv = {},
    log,
    signal,
    preinstalledRoot = process.env.YUYAN_PREINSTALLED_TOOLCHAINS_DIR || DEFAULT_PREINSTALLED_TOOLCHAINS_DIR,
    cacheRoot = path.join(DEPLOY_DATA_DIR, 'toolchains'),
    defaultPnpmVersion = process.env.YUYAN_DEFAULT_PNPM_VERSION || DEFAULT_FALLBACK_PNPM_VERSION,
    allowAutoInstall = process.env.YUYAN_ALLOW_AUTO_INSTALL_PNPM !== 'false',
    platform = process.platform,
    basePath = runtimeEnv.PATH ?? process.env.PATH ?? process.env.Path ?? '',
    probeHostVersionFn = probeHostPnpmVersion,
    installPackageFn = runNpmInstallPnpm,
  } = options || {};

  if (!commandsUsePnpm(installCommand, buildCommand)) {
    return {
      managed: false,
      packageManager: '',
      version: '',
      declaredByRepo: false,
      source: 'none',
      binDir: '',
      env: {},
    };
  }

  const repoSpec = await readRepoPackageManagerSpec(repoDir);
  const fallbackVersion = STRICT_SEMVER_RE.test(String(defaultPnpmVersion || '').trim())
    ? String(defaultPnpmVersion).trim()
    : DEFAULT_FALLBACK_PNPM_VERSION;

  const declaredByRepo = repoSpec?.name === 'pnpm';
  if (repoSpec && repoSpec.name !== 'pnpm') {
    log?.(
      'warn',
      `包管理器调度：仓库 packageManager 声明为 ${repoSpec.name}@${repoSpec.version}，但部署命令使用 pnpm，将按平台默认 pnpm@${fallbackVersion} 调度`,
      'install'
    );
  }

  const desiredVersion = declaredByRepo ? repoSpec.version : fallbackVersion;
  const reasonLabel = declaredByRepo
    ? `仓库声明 packageManager=pnpm@${desiredVersion}`
    : `仓库未声明 packageManager，默认使用 pnpm@${desiredVersion}`;

  // L1：命中镜像只读预置池（零网络、零延迟）
  const l1Layout = resolvePnpmPrefixLayout(path.join(preinstalledRoot, 'pnpm', desiredVersion), platform);
  if (await fileExists(l1Layout.binPath)) {
    log?.('info', `包管理器调度：${reasonLabel}，命中镜像预置工具链（${l1Layout.binDir}）`, 'install');
    return {
      managed: true,
      packageManager: 'pnpm',
      version: desiredVersion,
      declaredByRepo,
      source: 'preinstalled',
      binDir: l1Layout.binDir,
      env: buildPnpmToolchainEnv(l1Layout.binDir, { basePath, platform }),
    };
  }

  // L2：命中数据目录持久化缓存池（跨容器重启复用）
  const l2Layout = resolvePnpmPrefixLayout(path.join(cacheRoot, 'pnpm', desiredVersion), platform);
  if (await fileExists(l2Layout.binPath)) {
    log?.('info', `包管理器调度：${reasonLabel}，命中本地缓存工具链（${l2Layout.binDir}）`, 'install');
    return {
      managed: true,
      packageManager: 'pnpm',
      version: desiredVersion,
      declaredByRepo,
      source: 'cached',
      binDir: l2Layout.binDir,
      env: buildPnpmToolchainEnv(l2Layout.binDir, { basePath, platform }),
    };
  }

  // 宿主机/容器默认 pnpm 匹配检查（桌面端常见快速路径）
  const hostVersion = await probeHostVersionFn({ cwd: repoDir, env: runtimeEnv, signal, platform });
  if (hostVersion && hostVersion === desiredVersion) {
    log?.('info', `包管理器调度：${reasonLabel}，当前环境 pnpm@${hostVersion} 已匹配，直接复用`, 'install');
    return {
      managed: true,
      packageManager: 'pnpm',
      version: hostVersion,
      declaredByRepo,
      source: 'host',
      binDir: '',
      env: buildPnpmToolchainEnv('', { basePath, platform }),
    };
  }

  // 未声明 packageManager 且宿主机已安装可用 pnpm（如桌面端本机构建），不额外触发下载
  if (!declaredByRepo && hostVersion) {
    log?.(
      'info',
      `包管理器调度：仓库未声明 packageManager，未命中预置池，沿用当前环境 pnpm@${hostVersion}`,
      'install'
    );
    return {
      managed: true,
      packageManager: 'pnpm',
      version: hostVersion,
      declaredByRepo: false,
      source: 'host',
      binDir: '',
      env: buildPnpmToolchainEnv('', { basePath, platform }),
    };
  }

  // L2 按需安装（复用内网 .npmrc 私服）
  if (!allowAutoInstall) {
    log?.(
      'warn',
      `包管理器调度：${reasonLabel}，未命中预置/缓存且已禁用按需安装（YUYAN_ALLOW_AUTO_INSTALL_PNPM=false），回退当前环境${hostVersion ? ` pnpm@${hostVersion}` : ''}`,
      'install'
    );
    return {
      managed: true,
      packageManager: 'pnpm',
      version: hostVersion || '',
      declaredByRepo,
      source: 'fallback',
      binDir: '',
      env: buildPnpmToolchainEnv('', { basePath, platform }),
    };
  }

  try {
    const installed = await ensureCachedPnpmVersion({
      version: desiredVersion,
      cacheRoot,
      repoDir,
      runtimeEnv,
      log,
      signal,
      platform,
      installPackageFn,
    });
    log?.(
      'success',
      `包管理器调度：pnpm@${desiredVersion} ${installed.reusedConcurrent ? '已复用并发安装缓存' : '按需安装完成并落盘缓存'}（${installed.binDir}）`,
      'install'
    );
    return {
      managed: true,
      packageManager: 'pnpm',
      version: desiredVersion,
      declaredByRepo,
      source: installed.reusedConcurrent ? 'cached' : 'installed',
      binDir: installed.binDir,
      env: buildPnpmToolchainEnv(installed.binDir, { basePath, platform }),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    log?.(
      'warn',
      `包管理器调度：按需安装 pnpm@${desiredVersion} 失败（${errMsg}），将回退当前环境${hostVersion ? ` pnpm@${hostVersion}` : '默认 pnpm'} 继续尝试`,
      'install'
    );
    return {
      managed: true,
      packageManager: 'pnpm',
      version: hostVersion || '',
      declaredByRepo,
      source: 'fallback',
      binDir: '',
      env: buildPnpmToolchainEnv('', { basePath, platform }),
    };
  }
}
