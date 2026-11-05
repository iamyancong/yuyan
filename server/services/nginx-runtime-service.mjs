/**
 * 托管 Nginx 运行时服务
 * @description 负责内置运行时包校验、远程初始化、启停控制和托管站点配置同步。
 * 支持多变体运行时包，根据目标服务器 glibc 版本自动选择最优变体。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { NGINX_RUNTIME_ASSET_DIR, NGINX_RUNTIME_REGISTRY_PATH } from '../config/constants.mjs';
import {
  DEFAULT_NGINX_RUNTIME_BASE_ROOT,
  getDefaultNginxInstanceByServerId,
  getManagedNginxInstanceByServerId,
  getNginxInstanceContext,
  getNginxRuntimeByServerId,
  getServerWithCredential,
  getTarget,
  listTargets,
  resolveNextManagedListenPortByInstance,
  resolveNextManagedListenPort,
  updateNginxInstance,
  updateNginxInstanceState,
  updateNginxRuntimeState,
  upsertNginxRuntime,
} from './deploy-store.mjs';
export { getNginxInstanceContext } from './deploy-store.mjs';
export {
  YUYAN_NGINX_SCRIPT_VERSION,
  formatNginxVersionDisplay,
  parseNginxPidDirective,
  parseRemoteScriptVersion,
  parseRuntimeScriptStatusOutput,
  pathBelongsToBase,
  normalizePosixPath,
} from './nginx-runtime-detect.mjs';
import {
  execSsh,
  readRemoteText,
  shellQuote,
  streamSshCommand,
  uploadFile,
  withSsh,
  writeRemoteTextWithBackup,
} from './ssh-service.mjs';
import {
  minimizeArchiveRoots,
  parseNginxArchiveSites,
  resolveNginxArchiveSelection,
  resolveNginxArchiveWhitelist,
} from './nginx-archive-selection.mjs';
import {
  YUYAN_NGINX_SCRIPT_VERSION,
  YUYAN_NGINX_SCRIPT_VERSION_MARKER,
  formatNginxVersionDisplay,
  normalizePosixPath,
  parseNginxPidDirective,
  parseRemoteScriptVersion,
  parseRuntimeScriptStatusOutput,
  pathBelongsToBase,
} from './nginx-runtime-detect.mjs';
import {
  extractNginxBinaryFromCommand,
  parseNginxVersionOutput,
  splitShellWords,
} from './nginx-discovery-service.mjs';
import { getTestHooks } from './test-hooks.mjs';


/** 托管运行时支持的系统 */
const SUPPORTED_PLATFORM = 'Linux';

/** 托管运行时支持的架构 */
const SUPPORTED_ARCHES = new Set(['x86_64', 'amd64']);

/** Nginx 运行时操作 */
const RUNTIME_ACTIONS = new Set(['test', 'start', 'stop', 'reload', 'status', 'upgrade']);

/** 运行包导出时排除的 Nginx 运行态目录 */
const ARCHIVE_EXCLUDE_DIRS = ['logs', 'run', 'client_body_temp', 'proxy_temp'];

/** 运行包导出时排除的部署元数据目录 */
const ARCHIVE_EXCLUDE_METADATA_DIRS = ['.yuyan-backups', '.yuyan-manifests'];

/** 运行包导出时排除的全局匹配模式 */
const ARCHIVE_EXCLUDE_PATTERNS = [
  ...ARCHIVE_EXCLUDE_METADATA_DIRS,
  ...ARCHIVE_EXCLUDE_METADATA_DIRS.map((dir) => `*/${dir}`),
  ...ARCHIVE_EXCLUDE_METADATA_DIRS.map((dir) => `*/${dir}/*`),
  '*/yuyan-nginx.sh.bak.*',
];

/** 运行包导出无数据超时时间，避免远程 tar 或 SSH 通道无限挂起。 */
const ARCHIVE_STREAM_IDLE_TIMEOUT_MS = Number(process.env.NGINX_ARCHIVE_IDLE_TIMEOUT_MS || 120000);

/** 运行包导出无新增数据提示间隔。 */
const ARCHIVE_STREAM_HEARTBEAT_MS = 5000;

// ──────────────────────────────────────────────
// 路径派生
// ──────────────────────────────────────────────

/**
 * 按根目录派生托管运行时路径。
 * @param {string} baseRoot - 根目录
 * @returns {Object} 默认路径
 */
function deriveRuntimePaths(baseRoot = DEFAULT_NGINX_RUNTIME_BASE_ROOT) {
  const root = path.posix.normalize(String(baseRoot || DEFAULT_NGINX_RUNTIME_BASE_ROOT).trim().replace(/\\/g, '/')).replace(/\/+$/, '');
  const installRoot = path.posix.join(root || DEFAULT_NGINX_RUNTIME_BASE_ROOT, 'nginx');
  return {
    baseRoot: root || DEFAULT_NGINX_RUNTIME_BASE_ROOT,
    installRoot,
    webRoot: path.posix.join(root || DEFAULT_NGINX_RUNTIME_BASE_ROOT, 'html'),
    sitesDir: path.posix.join(installRoot, 'conf', 'conf.d'),
    logsDir: path.posix.join(installRoot, 'logs'),
    scriptPath: path.posix.join(installRoot, 'yuyan-nginx.sh'),
    portStart: 8080,
  };
}

/**
 * 解析服务器托管运行时路径配置。
 * @param {Object} runtime - 运行时 DB 记录
 * @returns {Object} 运行时配置
 */
function resolveRuntimeConfig(runtime) {
  const defaults = deriveRuntimePaths(runtime?.baseRoot);
  const installRoot = String(runtime?.nginxRoot || defaults.installRoot).replace(/\/+$/, '');
  const sitesDir = String(runtime?.sitesDir || defaults.sitesDir).replace(/\/+$/, '');
  const webRoot = String(runtime?.htmlRoot || defaults.webRoot).replace(/\/+$/, '');
  return {
    id: runtime?.id || 0,
    baseRoot: runtime?.baseRoot || defaults.baseRoot,
    installRoot,
    sitesDir,
    webRoot,
    logsDir: runtime?.logsDir || defaults.logsDir,
    useSudo: Boolean(runtime?.useSudo),
    portStart: Number(runtime?.portStart || defaults.portStart),
    mainConfPath: `${installRoot}/conf/nginx.conf`,
    scriptPath: runtime?.scriptPath || defaults.scriptPath,
    nginxPath: `${installRoot}/sbin/nginx`,
    pidPath: `${installRoot}/run/nginx.pid`,
  };
}

/**
 * 生成归档文件名时间戳。
 * @param {Date} date - 当前时间
 * @returns {string} 文件名时间戳
 */
function formatArchiveTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/**
 * 清洗归档文件名片段。
 * @param {string} value - 原始片段
 * @param {string} fallback - 兜底片段
 * @returns {string} 安全文件名片段
 */
function sanitizeArchiveFilePart(value, fallback) {
  return (
    String(value || '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || fallback
  );
}

/**
 * 生成 Nginx 实例运行包文件名。
 * @param {Object} server - 服务器配置
 * @param {Object} instance - Nginx 实例
 * @returns {string} 运行包文件名
 */
function buildArchiveFileName(server, instance, type = 'all', sites = []) {
  const serverName = sanitizeArchiveFilePart(server?.name || server?.host, `server-${server?.id || 'unknown'}`);
  const instanceName = sanitizeArchiveFilePart(instance?.name, `nginx-${instance?.id || 'instance'}`);
  const portPart = [...new Set(sites.flatMap((site) => site.listenPorts || []))].sort((left, right) => left - right).join('-');
  const selectionSuffix = portPart ? `-${portPart}` : '';
  if (type === 'conf') {
    return `${serverName}-${instanceName}${selectionSuffix}-nginx-${formatArchiveTimestamp()}.conf`;
  }
  const suffix = type === 'html' ? '-html' : '';
  return `${serverName}-${instanceName}${selectionSuffix}${suffix}-${formatArchiveTimestamp()}.tar.gz`;
}

/**
 * 把绝对根目录转换为 tar 内相对路径。
 * @param {string} baseRoot - 运行时根目录
 * @returns {string} tar 内路径
 */
function resolveArchiveRoot(baseRoot) {
  const normalized = path.posix.normalize(String(baseRoot || '').trim().replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!normalized || normalized === '/' || !normalized.startsWith('/')) {
    throw new Error('Nginx 导出路径无效，无法导出运行包');
  }
  const archiveRoot = normalized.replace(/^\/+/, '');
  if (!archiveRoot || archiveRoot === '.' || archiveRoot.startsWith('../')) {
    throw new Error('Nginx 导出路径无效，无法导出运行包');
  }
  return archiveRoot;
}

/**
 * 构建运行包远程预检命令。
 * @param {Object} config - 运行时配置
 * @param {string} type - 下载类型 ('all' | 'html' | 'conf')
 * @returns {string} 预检命令
 */
function buildArchivePrecheckCommand(config, type = 'all') {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  const checks = [];

  if (type === 'all' || type === 'html') {
    checks.push(`command -v tar >/dev/null 2>&1 || { echo ${shellQuote('远程服务器未安装 tar，无法生成运行包')} >&2; exit 10; }`);
  }
  if (config.useSudo) {
    checks.push(`sudo -n true || { echo ${shellQuote('当前账号无法免密 sudo，无法读取托管 Nginx 目录')} >&2; exit 11; }`);
  }
  if (type === 'all') {
    checks.push(`${sudo}test -d ${shellQuote(config.baseRoot)} || { echo ${shellQuote(`托管根目录不存在：${config.baseRoot}`)} >&2; exit 12; }`);
    checks.push(`${sudo}test -d ${shellQuote(config.webRoot)} || { echo ${shellQuote(`HTML 根目录不存在：${config.webRoot}`)} >&2; exit 13; }`);
    checks.push(`${sudo}test -f ${shellQuote(config.mainConfPath)} || { echo ${shellQuote(`Nginx 主配置不存在：${config.mainConfPath}`)} >&2; exit 14; }`);
    checks.push(`${sudo}test -x ${shellQuote(config.scriptPath)} || { echo ${shellQuote(`管理脚本不存在或不可执行：${config.scriptPath}`)} >&2; exit 15; }`);
  } else if (type === 'html') {
    checks.push(`${sudo}test -d ${shellQuote(config.webRoot)} || { echo ${shellQuote(`HTML 根目录不存在：${config.webRoot}`)} >&2; exit 13; }`);
  } else if (type === 'conf') {
    checks.push(`${sudo}test -f ${shellQuote(config.mainConfPath)} || { echo ${shellQuote(`Nginx 主配置不存在：${config.mainConfPath}`)} >&2; exit 14; }`);
  }

  return checks.filter(Boolean).join(' && ');
}

/**
 * 构建 tar 排除参数。
 * @param {string[]} patterns - 排除匹配模式
 * @returns {string} tar 排除参数
 */
function buildArchiveExcludeArgs(patterns) {
  return patterns.map((pattern) => `--exclude=${shellQuote(pattern)}`).join(' ');
}

/**
 * 构建带点文件排除机制与白名单放行的归档脚本。
 *
 * @param {Object} params
 * @param {Object} params.config - 运行时配置
 * @param {string[]} params.roots - 需要执行 find 扫描的绝对根目录列表
 * @param {string[]} params.archivePaths - 传递给 tar 的相对路径列表
 * @param {string[]} params.excludePatterns - 现有的静态排除模式列表
 * @param {string[]} [params.whitelist] - 白名单绝对路径列表
 * @param {boolean} [params.includeHidden] - 是否包含隐藏文件（默认 false）
 * @param {Object} [params.tempConf] - 临时配置文件信息
 * @returns {string} 远程可执行命令字符串
 */
export function buildArchiveExcludeTarScript({
  config,
  roots = [],
  archivePaths = [],
  excludePatterns = [],
  whitelist = [],
  includeHidden = false,
  tempConf = null,
}) {
  const sudo = config?.useSudo ? 'sudo -n ' : '';
  const tarPaths = archivePaths.map(shellQuote).join(' ');
  const excludeArgs = buildArchiveExcludeArgs(excludePatterns);
  const transformArg = tempConf ? ` --transform=${shellQuote(tempConf.transform)}` : '';
  const extraTargets = tempConf ? ` ${shellQuote(tempConf.tempArchivePath)}` : '';

  // 1. 如果显式开启包含隐藏文件，回到原有行为，仅排除部署元数据
  if (includeHidden) {
    if (tempConf) {
      return [
        `YUYAN_SELECTED_CONF=${shellQuote(tempConf.tempFilePath)}`,
        'trap \'rm -f "$YUYAN_SELECTED_CONF"\' EXIT',
        `printf %s ${shellQuote(tempConf.encodedConfig)} | base64 -d > "$YUYAN_SELECTED_CONF"`,
        `${sudo}tar -czf - -C / ${excludeArgs}${transformArg} ${tarPaths}${extraTargets}`,
      ].join(' && ');
    }
    return `${sudo}tar -czf - -C / ${excludeArgs} ${tarPaths}`;
  }

  // 2. 默认模式：按根目录查找点文件，剔除白名单与 .well-known，并通过 tar -X 精准排除
  const searchRoots = minimizeArchiveRoots(roots);
  const quotedRoots = searchRoots.map(shellQuote).join(' ');

  const cleanWhitelist = [...new Set((whitelist || []).map((p) => String(p || '').trim()).filter(Boolean))];
  const encodedKeep = Buffer.from(cleanWhitelist.join('\n'), 'utf8').toString('base64');

  const cleanupTargets = ['"$YUYAN_KEEP"', '"$YUYAN_EXCLUDE"'];
  if (tempConf) {
    cleanupTargets.push('"$YUYAN_SELECTED_CONF"');
  }

  const scriptParts = [
    'YUYAN_KEEP=$(mktemp)',
    'YUYAN_EXCLUDE=$(mktemp)',
    `trap 'rm -f ${cleanupTargets.join(' ')}' EXIT`,
  ];

  if (tempConf) {
    scriptParts.push(
      `YUYAN_SELECTED_CONF=${shellQuote(tempConf.tempFilePath)}`,
      `printf %s ${shellQuote(tempConf.encodedConfig)} | base64 -d > "$YUYAN_SELECTED_CONF"`
    );
  }

  if (cleanWhitelist.length > 0) {
    scriptParts.push(`printf %s ${shellQuote(encodedKeep)} | base64 -d > "$YUYAN_KEEP"`);
  } else {
    scriptParts.push(': > "$YUYAN_KEEP"');
  }

  if (quotedRoots) {
    scriptParts.push(
      `find ${quotedRoots} -mindepth 1 -name '.*' ! -name '.well-known' -prune -print \\` +
      '\n  | { grep -Fvx -f "$YUYAN_KEEP" || true; } \\' +
      '\n  | sed -e "s#^/##" -e "s#[\\*?\\[]#\\\\&#g" > "$YUYAN_EXCLUDE"'
    );
  } else {
    scriptParts.push(': > "$YUYAN_EXCLUDE"');
  }

  scriptParts.push(
    `tar -czf - -C / --anchored -X "$YUYAN_EXCLUDE" --no-anchored ${excludeArgs}${transformArg} ${tarPaths}${extraTargets}`
  );

  const innerScript = scriptParts.join(' && \\\n');
  if (config?.useSudo) {
    return `sudo -n sh -c ${shellQuote(innerScript)}`;
  }
  return innerScript;
}

/**
 * 构建运行包 tar 流式导出命令。
 * @param {Object} config - 运行时配置
 * @param {string} archiveRoot - tar 内相对根路径
 * @param {string} type - 下载类型 ('all' | 'html')
 * @param {Object} [options] - 排除与白名单选项
 * @returns {string} tar 命令
 */
export function buildArchiveTarCommand(config, archiveRoot, type = 'all', options = {}) {
  const excludePatterns = [...ARCHIVE_EXCLUDE_PATTERNS];
  if (type === 'all') {
    excludePatterns.push(
      ...ARCHIVE_EXCLUDE_DIRS.flatMap((dir) => [`${archiveRoot}/nginx/${dir}`, `${archiveRoot}/nginx/${dir}/*`])
    );
  }
  const rootDir = type === 'html'
    ? (config.webRoot || path.posix.join('/', archiveRoot))
    : (config.baseRoot || config.installRoot || path.posix.join('/', archiveRoot));

  return buildArchiveExcludeTarScript({
    config,
    roots: [rootDir],
    archivePaths: [archiveRoot],
    excludePatterns,
    whitelist: options.whitelist || [],
    includeHidden: Boolean(options.includeHidden),
  });
}

/**
 * 构建所选站点运行包的远程预检命令。
 * @param {Object} config - 运行时配置
 * @param {string} type - 下载类型
 * @param {string[]} roots - 所选站点根目录
 * @returns {string} 预检命令
 */
function buildSelectedArchivePrecheckCommand(config, type, roots) {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  const checks = [];
  if (type !== 'conf') {
    checks.push(`command -v tar >/dev/null 2>&1 || { echo ${shellQuote('远程服务器未安装 tar，无法生成运行包')} >&2; exit 10; }`);
  }
  if (type === 'all') {
    checks.push(`command -v base64 >/dev/null 2>&1 || { echo ${shellQuote('远程服务器未安装 base64，无法生成所选运行包')} >&2; exit 16; }`);
  }
  if (config.useSudo) {
    checks.push(`sudo -n true || { echo ${shellQuote('当前账号无法免密 sudo，无法读取托管 Nginx 目录')} >&2; exit 11; }`);
  }
  if (type === 'all') {
    checks.push(`${sudo}test -d ${shellQuote(config.installRoot)} || { echo ${shellQuote(`Nginx 目录不存在：${config.installRoot}`)} >&2; exit 12; }`);
    checks.push(`${sudo}test -x ${shellQuote(config.scriptPath)} || { echo ${shellQuote(`管理脚本不存在或不可执行：${config.scriptPath}`)} >&2; exit 15; }`);
  }
  if (type !== 'conf') {
    roots.forEach((root) => {
      checks.push(`${sudo}test -d ${shellQuote(root)} || { echo ${shellQuote(`站点根目录不存在：${root}`)} >&2; exit 13; }`);
    });
  }
  return checks.join(' && ');
}

/**
 * 构建只包含所选站点的 tar 流命令。
 * @param {Object} config - 运行时配置
 * @param {string[]} roots - 所选站点根目录
 * @param {'all'|'html'} type - 下载类型
 * @param {string} filteredConfig - 裁剪后的 nginx.conf
 * @param {Object} [options] - 排除与白名单选项
 * @returns {string} tar 流命令
 */
export function buildSelectedArchiveTarCommand(config, roots, type, filteredConfig = '', options = {}) {
  const selectedRoots = minimizeArchiveRoots(roots);
  const archiveRoots = type === 'all'
    ? minimizeArchiveRoots([config.installRoot, ...selectedRoots])
    : selectedRoots;
  const archivePaths = archiveRoots.map(resolveArchiveRoot);
  const excludePatterns = [...ARCHIVE_EXCLUDE_PATTERNS];
  if (type === 'all') {
    const installArchiveRoot = resolveArchiveRoot(config.installRoot);
    excludePatterns.push(
      ...ARCHIVE_EXCLUDE_DIRS.flatMap((dir) => [`${installArchiveRoot}/${dir}`, `${installArchiveRoot}/${dir}/*`]),
      resolveArchiveRoot(config.mainConfPath)
    );
  }

  if (type === 'html') {
    return buildArchiveExcludeTarScript({
      config,
      roots: selectedRoots,
      archivePaths,
      excludePatterns,
      whitelist: options.whitelist || [],
      includeHidden: Boolean(options.includeHidden),
    });
  }

  const configHash = crypto.createHash('sha256').update(filteredConfig).digest('hex').slice(0, 12);
  const tempFileName = `yuyan-nginx-selected-${configHash}.conf`;
  const tempFilePath = `/tmp/${tempFileName}`;
  const tempArchivePath = resolveArchiveRoot(tempFilePath);
  const destinationArchivePath = resolveArchiveRoot(config.mainConfPath);
  const encodedConfig = Buffer.from(filteredConfig, 'utf8').toString('base64');
  const transform = `s|^${tempArchivePath}$|${destinationArchivePath}|`;

  return buildArchiveExcludeTarScript({
    config,
    roots: archiveRoots,
    archivePaths,
    excludePatterns,
    whitelist: options.whitelist || [],
    includeHidden: Boolean(options.includeHidden),
    tempConf: { tempFilePath, tempArchivePath, encodedConfig, transform },
  });
}

/**
 * 构建接入已有 Nginx 实例的运行包远程预检命令。
 * @param {Object} config - 运行时配置
 * @param {string} type - 下载类型 ('all' | 'html' | 'conf')
 * @param {string[]} roots - 所选站点根目录
 * @returns {string} 预检命令
 */
export function buildExternalArchivePrecheckCommand(config, type = 'all', roots = []) {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  const checks = [];

  if (type !== 'conf') {
    checks.push(`command -v tar >/dev/null 2>&1 || { echo ${shellQuote('远程服务器未安装 tar，无法导出站点')} >&2; exit 10; }`);
  }
  if (type === 'all' && roots.length > 0) {
    checks.push(`command -v base64 >/dev/null 2>&1 || { echo ${shellQuote('远程服务器未安装 base64，无法导出所选配置')} >&2; exit 16; }`);
  }
  if (config.useSudo) {
    checks.push(`sudo -n true || { echo ${shellQuote('当前账号无法免密 sudo，无法读取 Nginx 文件或目录')} >&2; exit 11; }`);
  }
  if (type === 'all' || type === 'conf') {
    checks.push(`${sudo}test -f ${shellQuote(config.mainConfPath)} || { echo ${shellQuote(`Nginx 主配置不存在：${config.mainConfPath}`)} >&2; exit 14; }`);
  }
  if (type !== 'conf') {
    roots.forEach((root) => {
      checks.push(`${sudo}test -d ${shellQuote(root)} || { echo ${shellQuote(`站点根目录不存在：${root}`)} >&2; exit 13; }`);
    });
  }

  return checks.filter(Boolean).join(' && ');
}

/**
 * 构建接入已有 Nginx 实例的 tar 流命令。
 * @param {Object} config - 运行时配置
 * @param {string[]} roots - 所选站点根目录
 * @param {'all'|'html'} type - 下载类型
 * @param {string} filteredConfig - 裁剪后的 nginx 配置
 * @param {Object} [options] - 排除与白名单选项
 * @returns {string} tar 命令
 */
export function buildExternalArchiveTarCommand(config, roots = [], type = 'all', filteredConfig = '', options = {}) {
  const selectedRoots = minimizeArchiveRoots(roots);
  const excludePatterns = [...ARCHIVE_EXCLUDE_PATTERNS];

  if (type === 'html') {
    if (!selectedRoots.length) {
      throw new Error('所选 server 未配置 root，无法导出静态产物');
    }
    const archivePaths = selectedRoots.map(resolveArchiveRoot);
    return buildArchiveExcludeTarScript({
      config,
      roots: selectedRoots,
      archivePaths,
      excludePatterns,
      whitelist: options.whitelist || [],
      includeHidden: Boolean(options.includeHidden),
    });
  }

  // type === 'all'
  const archiveRoots = selectedRoots.map(resolveArchiveRoot);

  if (filteredConfig) {
    const configHash = crypto.createHash('sha256').update(filteredConfig).digest('hex').slice(0, 12);
    const tempFileName = `yuyan-nginx-selected-${configHash}.conf`;
    const tempFilePath = `/tmp/${tempFileName}`;
    const tempArchivePath = resolveArchiveRoot(tempFilePath);
    const destinationArchivePath = resolveArchiveRoot(config.mainConfPath);
    const encodedConfig = Buffer.from(filteredConfig, 'utf8').toString('base64');
    const transform = `s|^${tempArchivePath}$|${destinationArchivePath}|`;

    return buildArchiveExcludeTarScript({
      config,
      roots: selectedRoots,
      archivePaths: archiveRoots,
      excludePatterns,
      whitelist: options.whitelist || [],
      includeHidden: Boolean(options.includeHidden),
      tempConf: { tempFilePath, tempArchivePath, encodedConfig, transform },
    });
  }

  const allPaths = [resolveArchiveRoot(config.mainConfPath), ...archiveRoots];
  return buildArchiveExcludeTarScript({
    config,
    roots: selectedRoots,
    archivePaths: allPaths,
    excludePatterns,
    whitelist: options.whitelist || [],
    includeHidden: Boolean(options.includeHidden),
  });
}

/**
 * 解析已有 Nginx 实例的归档配置。
 * @param {Object} instance - Nginx 实例
 * @returns {Object} 归档配置
 */
export function resolveExternalArchiveConfig(instance) {
  const mainConfPath = String(instance?.defaultNginxConfPath || '').trim();
  if (!mainConfPath) {
    throw new Error('当前已有 Nginx 实例未配置主配置文件路径');
  }
  return {
    id: instance?.id || 0,
    instanceType: 'external',
    baseRoot: '',
    installRoot: '',
    sitesDir: '',
    webRoot: String(instance?.htmlRoot || instance?.defaultDeployRoot || '').trim(),
    logsDir: String(instance?.logsDir || '').trim(),
    useSudo: Boolean(instance?.useSudo),
    portStart: Number(instance?.portStart || 80),
    mainConfPath,
    scriptPath: '',
    nginxPath: '',
    pidPath: '',
  };
}

/**
 * 解析实例归档所需的运行时配置（兼容托管与已有实例）。
 * @param {Object} instance - Nginx 实例
 * @returns {Object} 运行时配置
 */
export function resolveArchiveRuntimeConfig(instance) {
  if (instance?.instanceType === 'managed') {
    return resolveRuntimeConfig(instance);
  }
  return resolveExternalArchiveConfig(instance);
}

// ──────────────────────────────────────────────
// 多变体运行时注册表
// ──────────────────────────────────────────────

/** 注册表缓存 */
let registryCache = null;

/**
 * 读取运行时变体注册表。
 * @returns {Promise<Object>} registry 内容
 */
async function readRuntimeRegistry() {
  if (registryCache) return registryCache;
  const content = await fs.readFile(NGINX_RUNTIME_REGISTRY_PATH, 'utf8');
  registryCache = JSON.parse(content);
  return registryCache;
}

/**
 * 解析指定变体的文件路径。
 * @param {Object} variant - 变体配置
 * @returns {{ manifestPath: string, packagePath: string }} 变体文件路径
 */
function resolveVariantPaths(variant) {
  const variantDir = path.join(NGINX_RUNTIME_ASSET_DIR, variant.dir);
  return {
    manifestPath: path.join(variantDir, 'manifest.json'),
    packagePath: path.join(variantDir, 'nginx-runtime.tar.gz'),
  };
}

/**
 * 读取指定变体的 manifest。
 * @param {Object} variant - 变体配置
 * @returns {Promise<Object>} manifest 内容
 */
async function readVariantManifest(variant) {
  const { manifestPath } = resolveVariantPaths(variant);
  const content = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(content);
}

/**
 * 计算文件 SHA-256。
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} hash
 */
async function sha256File(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 校验指定变体的运行时包。
 * @param {Object} variant - 变体配置
 * @returns {Promise<Object>} manifest 内容
 */
async function validateVariantPackage(variant) {
  const manifest = await readVariantManifest(variant);
  const { packagePath } = resolveVariantPaths(variant);
  const hash = await sha256File(packagePath);
  if (hash !== manifest.sha256) {
    throw new Error(`Nginx 运行时包校验失败（${variant.id}）：manifest=${manifest.sha256}，actual=${hash}`);
  }
  return manifest;
}

/**
 * 比较版本号。
 * @param {string} actual - 当前版本
 * @param {string} required - 要求版本
 * @returns {number} actual 大于等于 required 时返回非负数
 */
function compareVersion(actual, required) {
  const left = String(actual || '0').split('.').map((item) => Number(item || 0));
  const right = String(required || '0').split('.').map((item) => Number(item || 0));
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 根据远程服务器环境选择最优的运行时变体。
 * 选择策略：在满足 glibc 和 xcrypt 约束的变体中，选 priority 最高的。
 * @param {Object} registry - 变体注册表
 * @param {string} glibcVersion - 远程 glibc 版本
 * @param {boolean} hasXcrypt - 是否具备 XCRYPT_2.0
 * @returns {Object} 选中的变体
 */
function selectRuntimeVariant(registry, glibcVersion, hasXcrypt) {
  const candidates = registry.variants
    .filter((v) => compareVersion(glibcVersion || '0', v.minGlibc) >= 0)
    .filter((v) => !v.requireXcrypt || hasXcrypt);

  if (candidates.length === 0) {
    throw new Error(
      `当前服务器（glibc ${glibcVersion || 'unknown'}）没有兼容的 Nginx 运行时包。` +
      `可改用已安装 Nginx：在服务器配置中填写 Nginx 工作目录、校验命令和重载命令后，直接创建部署目标并发布。`
    );
  }

  candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return candidates[0];
}

/**
 * 获取所有可用变体的 manifest 列表（用于状态展示）。
 * @returns {Promise<Object[]>} manifest 列表
 */
async function listAvailableManifests() {
  try {
    const registry = await readRuntimeRegistry();
    const results = [];
    for (const variant of registry.variants) {
      try {
        const manifest = await readVariantManifest(variant);
        results.push({ ...manifest, variantId: variant.id, variantLabel: variant.label });
      } catch {
        /* 变体包不存在则跳过 */
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────
// 远程服务器环境探测
// ──────────────────────────────────────────────

/**
 * 校验远程服务器平台。
 * @param {Object} conn - SSH 连接
 * @returns {Promise<string>} 平台描述
 */
async function assertRemotePlatform(conn) {
  const result = await execSsh(conn, 'uname -s && uname -m', { label: '检查服务器系统架构' });
  const [platform, arch] = result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (platform !== SUPPORTED_PLATFORM || !SUPPORTED_ARCHES.has(String(arch || '').toLowerCase())) {
    throw new Error(`托管 Nginx v1 仅支持 Linux x86_64，当前服务器为 ${platform || 'unknown'} ${arch || 'unknown'}`);
  }
  return `${platform} ${arch}`;
}

/**
 * 探测远程服务器运行时环境（glibc 版本和 xcrypt 支持）。
 * 与旧版 assertRemoteRuntimeDependencies 不同，本函数不会抛出错误，
 * 而是返回探测结果，由调用方决定如何处理。
 * @param {Object} conn - SSH 连接
 * @returns {Promise<{ glibcVersion: string, hasXcrypt: boolean, summary: string }>} 探测结果
 */
async function detectRemoteEnvironment(conn) {
  const command = [
    'GLIBC_VERSION="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk \'{print $2}\' || true)"',
    'if [ -z "$GLIBC_VERSION" ]; then GLIBC_VERSION="$(ldd --version 2>&1 | head -n 1 | grep -oE \'[0-9]+\\.[0-9]+\' | tail -n 1 || true)"; fi',
    'echo "glibc=${GLIBC_VERSION:-unknown}"',
    'LIBCRYPT_PATH="$(ldconfig -p 2>/dev/null | awk \'/libcrypt\\.so\\.1/{print $NF; exit}\' || true)"',
    'if [ -z "$LIBCRYPT_PATH" ]; then for p in /lib64/libcrypt.so.1 /usr/lib64/libcrypt.so.1 /lib/x86_64-linux-gnu/libcrypt.so.1 /usr/lib/x86_64-linux-gnu/libcrypt.so.1; do [ -e "$p" ] && LIBCRYPT_PATH="$p" && break; done; fi',
    'if [ -n "$LIBCRYPT_PATH" ] && strings "$LIBCRYPT_PATH" 2>/dev/null | grep -q XCRYPT_2.0; then echo "xcrypt=2.0"; else echo "xcrypt=missing"; fi',
  ].join('; ');
  const result = await execSsh(conn, command, { label: '探测服务器运行时环境', allowFailure: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const glibcVersion = output.match(/glibc=([^\s]+)/)?.[1] || 'unknown';
  const hasXcrypt = output.includes('xcrypt=2.0');

  const parts = [`glibc ${glibcVersion}`];
  if (hasXcrypt) parts.push('libcrypt XCRYPT_2.0');
  return { glibcVersion, hasXcrypt, summary: parts.join('，') };
}

// ──────────────────────────────────────────────
// Nginx 配置生成
// ──────────────────────────────────────────────

/**
 * 渲染托管 Nginx 主配置正文（不含托管 Header）。
 * @param {Object} config - 运行时配置
 * @returns {string} nginx.conf 正文内容
 */
export function renderMainNginxConfigBody(config) {
  return [
    'worker_processes  1;',
    '',
    'error_log  logs/error.log warn;',
    'pid        run/nginx.pid;',
    '',
    'events {',
    '    worker_connections  1024;',
    '}',
    '',
    'http {',
    '    include       mime.types;',
    '    default_type  application/octet-stream;',
    '',
    '    client_max_body_size 200M;',
    '    sendfile        on;',
    '    keepalive_timeout  65;',
    '',
    '    gzip on;',
    '    gzip_min_length 1k;',
    '    gzip_comp_level 5;',
    '    gzip_types text/plain text/css text/javascript application/json application/javascript application/x-javascript application/xml;',
    '    gzip_vary on;',
    '    gzip_disable "MSIE [1-6]\\.";',
    '',
    '    access_log logs/access.log;',
    '    client_body_temp_path client_body_temp;',
    '    proxy_temp_path proxy_temp;',
    '',
    '    server {',
    `        listen ${config.portStart};`,
    '        server_name _;',
    '',
    `        root ${config.webRoot};`,
    '        index index.html index.htm;',
    '',
    '        location ~* \\.html$ {',
    '            expires -1;',
    '            add_header Cache-Control "no-cache";',
    '            try_files $uri =404;',
    '        }',
    '',
    '        location ~* \\.(js|mjs|css|map|wasm|png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|eot|json|txt)$ {',
    '            expires 1y;',
    '            add_header Cache-Control "public, max-age=31536000, immutable";',
    '            access_log off;',
    '            try_files $uri =404;',
    '        }',
    '',
    '        location / {',
    '            add_header Cache-Control "no-cache";',
    '            try_files $uri $uri/ /index.html;',
    '        }',
    '    }',
    '',
    '    include conf.d/*.conf;',
    '}',
    '',
  ].join('\n');
}

/**
 * 渲染托管 Nginx 主配置。
 * @param {Object} config - 运行时配置
 * @param {number=} explicitInstanceId - 显式 Nginx 实例 ID
 * @returns {string} nginx.conf 内容
 */
export function renderMainNginxConfig(config, explicitInstanceId = null) {
  const body = renderMainNginxConfigBody(config);
  const instanceId = explicitInstanceId ?? config?.id ?? config?.instanceId;
  if (Number(instanceId) > 0) {
    return attachManagedInstanceHeader(body, Number(instanceId));
  }
  return body;
}

/**
 * 渲染用户级 Nginx 管理脚本（协议版本见 YUYAN_NGINX_SCRIPT_VERSION）。
 * @returns {string} 脚本内容
 */
export function renderRuntimeScript() {
  return [
    '#!/usr/bin/env bash',
    '# yuyan-nginx-script-version: 2',
    'set -euo pipefail',
    '',
    'ACTION="${1:-help}"',
    'BASE_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'BASE_DIR="${BASE_DIR%/}"',
    'NGINX="$BASE_DIR/sbin/nginx"',
    'CONF="$BASE_DIR/conf/nginx.conf"',
    'BASE_SLASH="${BASE_DIR}/"',
    'KILL_BIN="/bin/kill"',
    'if [ ! -x "$KILL_BIN" ]; then KILL_BIN="kill"; fi',
    'PID_REPAIRED=0',
    'NEEDS_SUDO=0',
    'PRIMARY_PID_FILE=""',
    'PID_CANDIDATES=""',
    '',
    'normalize_path() {',
    '  local p="${1:-}"',
    '  p="${p%/}"',
    '  [ -n "$p" ] || { echo ""; return; }',
    '  echo "$p"',
    '}',
    '',
    '# 判断文本是否归属本实例根（禁止 /opt/yuyan/nginx 误匹配 /opt/yuyan/nginx2）',
    'belongs_to_base() {',
    '  local text="${1:-}"',
    '  case "$text" in',
    '    "$BASE_DIR"|"$BASE_SLASH"*|"$BASE_DIR "*) return 0 ;;',
    '  esac',
    '  # cmdline 中 -p /base/ 或 -c /base/conf',
    '  case "$text" in',
    '    *"$BASE_SLASH"*) ',
    '      # 排除 base 后紧跟字母数字（nginx2）',
    '      local rest="${text#*"$BASE_DIR"}"',
    '      case "$rest" in',
    '        ""|/*|[[:space:]]*) return 0 ;;',
    '        *) return 1 ;;',
    '      esac',
    '      ;;',
    '  esac',
    '  return 1',
    '}',
    '',
    'read_pid_candidates() {',
    '  PID_CANDIDATES=""',
    '  local directive=""',
    '  if [ -f "$CONF" ]; then',
    '    while IFS= read -r line || [ -n "$line" ]; do',
    '      line="${line%%#*}"',
    '      line="$(echo "$line" | sed \'s/^[[:space:]]*//;s/[[:space:]]*$//\')"',
    '      case "$line" in',
    '        [Pp][Ii][Dd][[:space:]]*)',
    '          directive="${line#*[Pp][Ii][Dd]}"',
    '          directive="$(echo "$directive" | sed \'s/^[[:space:]]*//;s/[[:space:]]*;[[:space:]]*$//;s/^["\'\\\'\']//;s/["\'\\\'\']$//\')"',
    '          break',
    '          ;;',
    '      esac',
    '    done < "$CONF"',
    '  fi',
    '  add_cand() {',
    '    local rel="$1" abs=""',
    '    [ -n "$rel" ] || return 0',
    '    case "$rel" in',
    '      /*) abs="$(normalize_path "$rel")" ;;',
    '      *) abs="$(normalize_path "$BASE_DIR/$rel")" ;;',
    '    esac',
    '    case " $PID_CANDIDATES " in',
    '      *" $abs "*) ;;',
    '      *) PID_CANDIDATES="$PID_CANDIDATES $abs" ;;',
    '    esac',
    '  }',
    '  add_cand "$directive"',
    '  add_cand "run/nginx.pid"',
    '  add_cand "logs/nginx.pid"',
    '  PID_CANDIDATES="$(echo "$PID_CANDIDATES" | sed \'s/^[[:space:]]*//\')"',
    '  PRIMARY_PID_FILE=""',
    '  if [ -n "$directive" ]; then',
    '    case "$directive" in',
    '      /*) PRIMARY_PID_FILE="$(normalize_path "$directive")" ;;',
    '      *) PRIMARY_PID_FILE="$(normalize_path "$BASE_DIR/$directive")" ;;',
    '    esac',
    '  else',
    '    PRIMARY_PID_FILE="$BASE_DIR/run/nginx.pid"',
    '  fi',
    '}',
    '',
    'proc_cmdline() {',
    '  local pid="$1"',
    '  if [ -r "/proc/$pid/cmdline" ]; then',
    '    tr \'\\0\' \' \' < "/proc/$pid/cmdline" 2>/dev/null || true',
    '  fi',
    '}',
    '',
    'proc_belongs() {',
    '  local pid="$1"',
    '  local cmd exe',
    '  cmd="$(proc_cmdline "$pid")"',
    '  if belongs_to_base "$cmd"; then return 0; fi',
    '  if [ -L "/proc/$pid/exe" ] || [ -e "/proc/$pid/exe" ]; then',
    '    exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || readlink "/proc/$pid/exe" 2>/dev/null || true)"',
    '    # (deleted) 后缀',
    '    exe="${exe% (deleted)}"',
    '    if belongs_to_base "$exe"; then return 0; fi',
    '  fi',
    '  return 1',
    '}',
    '',
    'pid_signal_check() {',
    '  # 0=存活可信号；1=不存在；2=EPERM/需要更高权限',
    '  local pid="$1"',
    '  if [ ! -d "/proc/$pid" ]; then return 1; fi',
    '  if "$KILL_BIN" -0 "$pid" 2>/dev/null; then return 0; fi',
    '  # 进程目录在但 kill -0 失败 → 多半 EPERM',
    '  return 2',
    '}',
    '',
    'validate_pid_file() {',
    '  local file="$1"',
    '  [ -f "$file" ] || return 1',
    '  local pid',
    '  pid="$(tr -d \'[:space:]\' < "$file" 2>/dev/null || true)"',
    '  case "$pid" in',
    "    ''|*[!0-9]*) return 1 ;;",
    '  esac',
    '  local rc=0',
    '  pid_signal_check "$pid" || rc=$?',
    '  if [ "$rc" -eq 1 ]; then return 1; fi',
    '  if [ "$rc" -eq 2 ]; then',
    '    echo "needs_sudo: 1"',
    '    echo "running: $pid"',
    '    echo "permission_denied: 1"',
    '    return 2',
    '  fi',
    '  if proc_belongs "$pid"; then',
    '    # 只向 stdout 输出纯数字 pid；路径写入全局，避免命令替换吞多行',
    '    PRIMARY_PID_FILE="$file"',
    '    echo "$pid"',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    '',
    'find_master_by_proc() {',
    '  local pid cmd',
    '  for pid_dir in /proc/[0-9]*; do',
    '    pid="${pid_dir#/proc/}"',
    '    cmd="$(proc_cmdline "$pid")"',
    '    case "$cmd" in',
    "      *'nginx: master process'*)",
    '        if belongs_to_base "$cmd"; then',
    '          echo "$pid"',
    '          return 0',
    '        fi',
    '        # 有些构建 cmdline 只是二进制路径，再看 args 中的 -p/-c',
    '        if belongs_to_base "$cmd" || { case "$cmd" in *"-p ${BASE_DIR}"*|*" -p ${BASE_SLASH}"*|*" -c ${BASE_SLASH}"*|*" -c ${CONF}"*) true ;; *) false ;; esac; }; then',
    '          echo "$pid"',
    '          return 0',
    '        fi',
    '        ;;',
    '      *"$NGINX"*|*"${BASE_SLASH}sbin/nginx"*)',
    '        # worker 通常含 "worker process"；master 含 master 或启动参数 -p',
    '        case "$cmd" in',
    "          *'worker process'*|*'cache manager'*|*'cache loader'*) continue ;;",
    '        esac',
    '        if belongs_to_base "$cmd"; then',
    '          case "$cmd" in',
    '            *\'master process\'*|*-p[[:space:]]*|*-c[[:space:]]*) echo "$pid"; return 0 ;;',
    '          esac',
    '        fi',
    '        ;;',
    '    esac',
    '  done',
    '  return 1',
    '}',
    '',
    'repair_pid_file() {',
    '  local pid="$1"',
    '  local target="${PRIMARY_PID_FILE:-$BASE_DIR/run/nginx.pid}"',
    '  mkdir -p "$(dirname "$target")" 2>/dev/null || true',
    '  if printf \'%s\\n\' "$pid" > "$target" 2>/dev/null; then',
    '    echo "pid_repaired: 1"',
    '    echo "pid_path: $target"',
    '    return 0',
    '  fi',
    '  # 写失败不致命',
    '  echo "pid_path: $target"',
    '  return 0',
    '}',
    '',
    '# 输出 master pid 到 stdout 最后一行数字；副作用打印元数据到 stdout',
    'resolve_master_pid() {',
    '  NEEDS_SUDO=0',
    '  PID_REPAIRED=0',
    '  read_pid_candidates',
    '  local cand pid found="" rc',
    '  for cand in $PID_CANDIDATES; do',
    '    set +e',
    '    pid="$(validate_pid_file "$cand")"',
    '    rc=$?',
    '    set -e',
    '    if [ "$rc" -eq 2 ]; then',
    '      NEEDS_SUDO=1',
    '      # validate 已在 stdout 打出 needs_sudo/running/permission_denied；原样透传数字外的元数据',
    '      echo "$pid" | grep -E \'^(needs_sudo|running|permission_denied|pid_path):\' || true',
    '      echo "needs_sudo: 1"',
    '      return 2',
    '    fi',
    '    if [ "$rc" -eq 0 ] && [ -n "$pid" ]; then',
    '      found="$pid"',
    '      PRIMARY_PID_FILE="$cand"',
    '      break',
    '    fi',
    '  done',
    '  if [ -z "$found" ]; then',
    '    set +e',
    '    found="$(find_master_by_proc)"',
    '    set -e',
    '    if [ -n "$found" ]; then',
    '      PID_REPAIRED=1',
    '      repair_pid_file "$found"',
    '    fi',
    '  fi',
    '  if [ -n "$found" ]; then',
    '    set +e',
    '    pid_signal_check "$found"',
    '    sig_rc=$?',
    '    set -e',
    '    if [ "$sig_rc" -eq 2 ]; then',
    '      echo "needs_sudo: 1"',
    '      echo "running: $found"',
    '      echo "permission_denied: 1"',
    '      return 2',
    '    fi',
    '    if [ "$sig_rc" -eq 1 ]; then',
    '      # 刚找到却瞬间退出',
    '      return 1',
    '    fi',
    '    echo "$found"',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    '',
    'is_running() {',
    '  local pid',
    '  set +e',
    '  pid="$(resolve_master_pid 2>/dev/null | awk \'/^[0-9]+$/{print; exit}\')"',
    '  local rc=$?',
    '  set -e',
    '  [ -n "$pid" ]',
    '}',
    '',
    'read_version_from_bin() {',
    '  local bin="$1"',
    '  case "$bin" in',
    "    *'(deleted)'*) echo \"\"; return 0 ;;",
    '  esac',
    '  if [ ! -e "$bin" ] && [ ! -L "$bin" ]; then',
    '    echo ""',
    '    return 0',
    '  fi',
    '  # nginx -v 写在 stderr；/proc/pid/exe 在 (deleted) 时仍可执行',
    '  local out',
    '  out="$("$bin" -v 2>&1 || true)"',
    '  echo "$out" | sed -n -e "s/.*[Nn]ginx version:[[:space:]]*\\([^[:space:]]*\\).*/\\1/p" -e "s/.*[Tt]engine version:[[:space:]]*\\([^[:space:]]*\\).*/\\1/p" | head -n 1',
    '}',
    '',
    'emit_status_details() {',
    '  local pid="$1"',
    '  local running_exe="" disk_exe="$NGINX" running_ver="" disk_ver="" pending=0 ver_bin=""',
    '  if [ -e "/proc/$pid/exe" ] || [ -L "/proc/$pid/exe" ]; then',
    '    running_exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"',
    '    if [ -z "$running_exe" ]; then',
    '      running_exe="/proc/$pid/exe"',
    '    fi',
    '  fi',
    '  # 原地替换后 readlink 带 " (deleted)"，路径不可直接执行；改走 /proc/pid/exe',
    '  ver_bin="${running_exe:-/proc/$pid/exe}"',
    "  case \"$ver_bin\" in",
    "    *'(deleted)'*) ver_bin=\"/proc/$pid/exe\" ;;",
    '  esac',
    '  running_ver="$(read_version_from_bin "$ver_bin")"',
    '  disk_ver="$(read_version_from_bin "$disk_exe")"',
    '  if [ -n "$running_ver" ] && [ -n "$disk_ver" ] && [ "$running_ver" != "$disk_ver" ]; then',
    '    pending=1',
    '  fi',
    '  case "$running_exe" in',
    "    *'(deleted)'*) pending=1 ;;",
    '  esac',
    '  echo "running: $pid"',
    '  echo "pid_path: ${PRIMARY_PID_FILE:-$BASE_DIR/run/nginx.pid}"',
    '  if [ "${PID_REPAIRED:-0}" = "1" ]; then echo "pid_repaired: 1"; fi',
    '  echo "running_exe: ${running_exe:-}"',
    '  echo "disk_exe: $disk_exe"',
    '  echo "running_version: ${running_ver:-}"',
    '  echo "disk_version: ${disk_ver:-}"',
    '  echo "upgrade_pending: $pending"',
    '  return 0',
    '}',
    '',
    'do_test() {',
    '  "$NGINX" -p "$BASE_DIR/" -c "$CONF" -t',
    '}',
    '',
    'case "$ACTION" in',
    '  start)',
    '    set +e',
    '    MASTER="$(resolve_master_pid 2>/dev/null | awk \'/^[0-9]+$/{print; exit}\')"',
    '    rc=$?',
    '    set -e',
    '    if [ "$rc" -eq 2 ]; then',
    '      echo "needs_sudo: 1" >&2',
    '      echo "实例进程可能在跑但当前账号无信号权限，请开启免密 sudo 后重试" >&2',
    '      exit 4',
    '    fi',
    '    if [ -n "${MASTER:-}" ]; then',
    '      echo "yuyan nginx already running: $MASTER"',
    '      exit 0',
    '    fi',
    '    do_test',
    '    "$NGINX" -p "$BASE_DIR/" -c "$CONF"',
    '    echo "yuyan nginx started"',
    '    ;;',
    '  stop)',
    '    set +e',
    '    MASTER="$(resolve_master_pid 2>/dev/null | awk \'/^[0-9]+$/{print; exit}\')"',
    '    rc=$?',
    '    set -e',
    '    if [ "$rc" -eq 2 ]; then',
    '      echo "needs_sudo: 1" >&2',
    '      exit 4',
    '    fi',
    '    if [ -n "${MASTER:-}" ]; then',
    '      "$KILL_BIN" -QUIT "$MASTER" 2>/dev/null || "$NGINX" -p "$BASE_DIR/" -c "$CONF" -s quit',
    '      echo "yuyan nginx stopped"',
    '    else',
    '      echo "yuyan nginx not running"',
    '    fi',
    '    ;;',
    '  reload)',
    '    set +e',
    '    MASTER="$(resolve_master_pid 2>/dev/null | awk \'/^[0-9]+$/{print; exit}\')"',
    '    rc=$?',
    '    set -e',
    '    if [ "$rc" -eq 2 ]; then',
    '      echo "needs_sudo: 1" >&2',
    '      echo "实例进程可能在跑但当前账号无信号权限，请开启免密 sudo 后重试" >&2',
    '      exit 4',
    '    fi',
    '    do_test',
    '    if [ -n "${MASTER:-}" ]; then',
    '      "$KILL_BIN" -HUP "$MASTER" 2>/dev/null || "$NGINX" -p "$BASE_DIR/" -c "$CONF" -s reload',
    '      echo "yuyan nginx reloaded"',
    '      if [ "${PID_REPAIRED:-0}" = "1" ]; then echo "pid_repaired: 1"; fi',
    '    else',
    '      # 确认无本实例进程才允许 start；不再在「认不到」时盲目 start',
    '      echo "yuyan nginx not running; starting after confirmed absence" >&2',
    '      "$NGINX" -p "$BASE_DIR/" -c "$CONF"',
    '      echo "yuyan nginx started"',
    '    fi',
    '    ;;',
    '  test)',
    '    do_test',
    '    ;;',
    '  status)',
    '    PID_REPAIRED=0',
    '    set +e',
    '    # resolve_master_pid 会打印元数据行 + 最终 pid；因命令替换在子 shell，需从输出回填全局变量',
    '    STATUS_OUT="$(resolve_master_pid 2>&1)"',
    '    rc=$?',
    '    set -e',
    '    if [ "$rc" -eq 2 ] || echo "$STATUS_OUT" | grep -q \'needs_sudo: 1\'; then',
    '      echo "needs_sudo: 1"',
    '      echo "$STATUS_OUT" | grep -E \'^(running|pid_path|pid_repaired|permission_denied):\' || true',
    '      # 进程在跑但无信号权限：绝不能标 stopped，也不能 start',
    '      exit 4',
    '    fi',
    '    MASTER="$(echo "$STATUS_OUT" | awk \'/^[0-9]+$/{print; exit}\')"',
    '    PARSED_PID_PATH="$(echo "$STATUS_OUT" | awk -F\': \' \'/^pid_path:/{print $2; exit}\')"',
    '    if [ -n "$PARSED_PID_PATH" ]; then PRIMARY_PID_FILE="$PARSED_PID_PATH"; fi',
    '    if echo "$STATUS_OUT" | grep -q \'pid_repaired: 1\'; then PID_REPAIRED=1; fi',
    '    # 若未打印 pid_path（命中已有正确 pid 文件），从候选回填',
    '    if [ -z "${PRIMARY_PID_FILE:-}" ]; then',
    '      read_pid_candidates',
    '    fi',
    '    echo "$STATUS_OUT" | grep -E \'^(pid_repaired|pid_path|needs_sudo):\' || true',
    '    if [ -n "${MASTER:-}" ]; then',
    '      emit_status_details "$MASTER"',
    '      exit 0',
    '    fi',
    '    echo "stopped"',
    '    disk_ver="$(read_version_from_bin "$NGINX")"',
    '    echo "disk_version: ${disk_ver:-}"',
    '    echo "disk_exe: $NGINX"',
    '    exit 3',
    '    ;;',
    '  upgrade)',
    '    # 平滑热升级：USR2 拉起新 master，再 QUIT 旧 master',
    '    set +e',
    '    OLD_MASTER="$(resolve_master_pid 2>/dev/null | awk \'/^[0-9]+$/{print; exit}\')"',
    '    rc=$?',
    '    set -e',
    '    if [ "$rc" -eq 2 ]; then',
    '      echo "needs_sudo: 1" >&2',
    '      echo "实例进程可能在跑但当前账号无信号权限，请开启免密 sudo 后重试" >&2',
    '      exit 4',
    '    fi',
    '    do_test',
    '    if [ -z "${OLD_MASTER:-}" ]; then',
    '      echo "yuyan nginx not running; nothing to upgrade" >&2',
    '      exit 1',
    '    fi',
    '    read_pid_candidates',
    '    OLD_PID_FILE="${PRIMARY_PID_FILE:-$BASE_DIR/run/nginx.pid}"',
    '    OLDBIN_FILE="${OLD_PID_FILE}.oldbin"',
    '    "$KILL_BIN" -USR2 "$OLD_MASTER"',
    '    # 等待新 master',
    '    NEW_MASTER=""',
    '    i=0',
    '    while [ "$i" -lt 50 ]; do',
    '      sleep 0.2',
    '      if [ -f "$OLD_PID_FILE" ]; then',
    '        cand="$(tr -d \'[:space:]\' < "$OLD_PID_FILE" 2>/dev/null || true)"',
    '        if [ -n "$cand" ] && [ "$cand" != "$OLD_MASTER" ] && [ -d "/proc/$cand" ]; then',
    '          NEW_MASTER="$cand"',
    '          break',
    '        fi',
    '      fi',
    '      i=$((i + 1))',
    '    done',
    '    if [ -z "$NEW_MASTER" ]; then',
    '      echo "hot upgrade failed: new master not ready" >&2',
    '      exit 1',
    '    fi',
    '    # QUIT 旧 master（oldbin）',
    '    if [ -f "$OLDBIN_FILE" ]; then',
    '      OLD_FROM_FILE="$(tr -d \'[:space:]\' < "$OLDBIN_FILE" 2>/dev/null || true)"',
    '      [ -n "$OLD_FROM_FILE" ] && OLD_MASTER="$OLD_FROM_FILE"',
    '    fi',
    '    if [ -d "/proc/$OLD_MASTER" ]; then',
    '      "$KILL_BIN" -QUIT "$OLD_MASTER" 2>/dev/null || true',
    '    fi',
    '    # 确认旧进程退出',
    '    j=0',
    '    while [ "$j" -lt 50 ]; do',
    '      if [ ! -d "/proc/$OLD_MASTER" ]; then break; fi',
    '      sleep 0.2',
    '      j=$((j + 1))',
    '    done',
    '    if [ -d "/proc/$OLD_MASTER" ]; then',
    '      echo "hot upgrade warning: old master $OLD_MASTER still alive" >&2',
    '      # 失败回滚：QUIT 新进程',
    '      "$KILL_BIN" -QUIT "$NEW_MASTER" 2>/dev/null || true',
    '      exit 1',
    '    fi',
    '    echo "yuyan nginx upgraded"',
    '    echo "running: $NEW_MASTER"',
    '    emit_status_details "$NEW_MASTER"',
    '    ;;',
    '  rotate-logs)',
    '    KEEP_DAYS="${2:-14}"',
    '    if ! [[ "$KEEP_DAYS" =~ ^[1-9][0-9]*$ ]]; then',
    '      KEEP_DAYS=14',
    '    fi',
    '    LOGS_DIR="$BASE_DIR/logs"',
    '    if [ ! -d "$LOGS_DIR" ]; then',
    '      exit 0',
    '    fi',
    '    set +e',
    '    MASTER="$(resolve_master_pid 2>/dev/null | awk \'/^[0-9]+$/{print; exit}\')"',
    '    rc=$?',
    '    set -e',
    '    if [ "$rc" -eq 2 ]; then',
    '      echo "nginx 进程由其他账号运行，当前账号无法发送 reopen 信号，已跳过本次日志轮转" >&2',
    '      exit 1',
    '    fi',
    '    TIMESTAMP="$(date +%Y%m%d%H%M%S)"',
    '    ROTATED_COUNT=0',
    '    for log_file in "$LOGS_DIR"/*.log; do',
    '      [ -f "$log_file" ] || continue',
    '      [ -s "$log_file" ] || continue',
    '      target_file="${log_file}.${TIMESTAMP}"',
    '      if [ -e "$target_file" ]; then',
    '        target_file="${target_file}.$$"',
    '        suffix=1',
    '        while [ -e "$target_file" ]; do',
    '          target_file="${log_file}.${TIMESTAMP}.${suffix}"',
    '          suffix=$((suffix + 1))',
    '        done',
    '      fi',
    '      mv "$log_file" "$target_file"',
    '      ROTATED_COUNT=$((ROTATED_COUNT + 1))',
    '    done',
    '',
    '    if [ "$ROTATED_COUNT" -gt 0 ] && [ -n "${MASTER:-}" ]; then',
    '      if ! "$NGINX" -p "$BASE_DIR/" -c "$CONF" -s reopen; then',
    '        echo "nginx 日志 reopen 信号发送失败，已终止本次轮转，保留未压缩日志以防数据丢失" >&2',
    '        exit 1',
    '      fi',
    '      sleep 1',
    '    fi',
    '',
    '    if command -v gzip >/dev/null 2>&1; then',
    '      for uncompressed in "$LOGS_DIR"/*.log.*; do',
    '        [ -f "$uncompressed" ] || continue',
    '        case "$uncompressed" in',
    '          *.gz) continue ;;',
    '        esac',
    '        gzip -f "$uncompressed" 2>/dev/null || true',
    '      done',
    '    fi',
    '',
    '    find "$LOGS_DIR" -maxdepth 1 -type f -name \'*.log.*\' -mtime "+$KEEP_DAYS" -exec rm -f {} + 2>/dev/null || true',
    '    ;;',
    '  help|*)',
    '    echo "用法: $0 {start|stop|reload|test|status|upgrade|rotate-logs [keep_days]}"',
    '    ;;',
    'esac',
    '',
  ].join('\n');
}

/** 进程内按 Nginx 实例 ID 的互斥锁映射 */
const nginxInstanceLocks = new Map();

/**
 * 获取 Nginx 实例操作锁。
 * @param {number|string} instanceId - 实例 ID
 * @param {string} opName - 操作名称
 */
export function acquireNginxInstanceLock(instanceId, opName) {
  const numericId = Number(instanceId);
  const currentOp = nginxInstanceLocks.get(numericId);
  if (currentOp) {
    const error = new Error(`该 Nginx 实例正在执行其他操作（${currentOp}），请稍后再试`);
    error.statusCode = 409;
    error.code = 'NGINX_INSTANCE_BUSY';
    throw error;
  }
  nginxInstanceLocks.set(numericId, opName);
}

/**
 * 释放 Nginx 实例操作锁。
 * @param {number|string} instanceId - 实例 ID
 */
export function releaseNginxInstanceLock(instanceId) {
  nginxInstanceLocks.delete(Number(instanceId));
}

/**
 * 解析托管 Nginx 日志保留天数。
 * 优先级：显式参数 > 环境变量 NGINX_LOG_KEEP_DAYS > 14
 * @param {number|string} [customKeepDays] - 显式传入的保留天数
 * @returns {number} 保留天数（默认 14）
 */
export function resolveNginxLogKeepDays(customKeepDays) {
  if (customKeepDays !== undefined && customKeepDays !== null) {
    const parsedCustom = Number(customKeepDays);
    if (Number.isInteger(parsedCustom) && parsedCustom >= 1) return parsedCustom;
  }
  const envRaw = Number(process.env.NGINX_LOG_KEEP_DAYS);
  if (Number.isInteger(envRaw) && envRaw >= 1) return envRaw;
  return 14;
}

/**
 * 解析日志轮转 crontab 安装结果。
 * @param {Object} result - SSH 执行结果对象 { code, stdout, stderr }
 * @param {string} cronLine - 待安装的定时任务行
 * @param {{ useSudo?: boolean }} [options] - 选项
 * @returns {{ status: 'installed'|'unchanged'|'no_crontab'|'read_failed'|'write_failed', cronLine: string, message: string }}
 */
export function parseLogRotateCronResult(result, cronLine, options = {}) {
  const useSudo = Boolean(options?.useSudo);
  const editCmd = useSudo ? 'sudo crontab -e' : 'crontab -e';
  const stdout = String(result?.stdout || '');
  const stderr = String(result?.stderr || '');
  const code = result?.code ?? 1;

  if (code === 0) {
    if (stdout.includes('yuyan-cron:unchanged')) {
      return {
        status: 'unchanged',
        cronLine,
        message: '定时任务已存在且无需更新',
      };
    }
    return {
      status: 'installed',
      cronLine,
      message: '定时任务已成功安装',
    };
  }

  if (code === 45) {
    return {
      status: 'no_crontab',
      cronLine,
      message: `服务器未安装 crontab（cron），平台不提供 SSH 兜底轮转，请安装 cron 后重新点击「更新管理脚本与定时任务」，或手动执行 ${editCmd} 添加以下一行：\n${cronLine}`,
    };
  }

  if (code === 46) {
    const detail = stderr.trim() || stdout.trim() || '权限不足或读取失败';
    return {
      status: 'read_failed',
      cronLine,
      message: `读取服务器定时任务失败（${detail}），未修改现有 crontab。可手动执行 ${editCmd} 添加以下一行：\n${cronLine}`,
    };
  }

  // 47 或其他非 0 退出码
  const detail = stderr.trim() || stdout.trim() || `退出码 ${code}`;
  return {
    status: 'write_failed',
    cronLine,
    message: `写入服务器定时任务失败（${detail}）。可手动执行 ${editCmd} 添加以下一行：\n${cronLine}`,
  };
}

/**
 * 构建将托管 Nginx 日志轮转任务安装到 crontab 的 Shell 命令。
 * @param {Object} config - 运行时配置
 * @param {number} [keepDays] - 保留天数
 * @returns {{command: string, cronLine: string, marker: string}} 命令及 cron 信息
 */
export function buildLogRotateCronInstallCommand(config, keepDays) {
  const effectiveKeepDays = resolveNginxLogKeepDays(keepDays);
  const scriptPath = String(config?.scriptPath || '').trim();
  const scriptSha = crypto.createHash('sha256').update(scriptPath).digest('hex');
  const markerTag = scriptSha.slice(0, 12);
  const marker = `# yuyan-nginx-rotate-logs:${markerTag}`;
  const minute = parseInt(scriptSha.slice(0, 4), 16) % 60;
  // cron 中 % 会被当作换行符，将命令部分的 % 转义为 \%
  const commandPart = `${shellQuote(scriptPath)} rotate-logs ${effectiveKeepDays} >/dev/null 2>&1`.replace(/%/g, '\\%');
  const cronLine = `${minute} 3 * * * ${commandPart} ${marker}`;

  const crontabCmd = config?.useSudo ? 'sudo -n crontab' : 'crontab';
  const script = [
    'command -v crontab >/dev/null 2>&1 || exit 45;',
    'ERR_FILE=$(mktemp 2>/dev/null || echo "/tmp/yuyan-cron-err-$$.tmp");',
    `EXISTING=$(${crontabCmd} -l 2>"$ERR_FILE");`,
    'CRON_EXIT=$?;',
    'CRON_ERR=$(cat "$ERR_FILE" 2>/dev/null || true);',
    'rm -f "$ERR_FILE";',
    'if [ "$CRON_EXIT" -eq 0 ]; then',
    '  :;',
    'else',
    // 读取 crontab 失败处理：收紧空 crontab 判定，
    // 仅匹配 vixie/cronie 的 "no crontab for <user>" 以及 busybox 1.3x 的 "crontab: can't open 'root': No such file or directory"；
    // 绝不能单独匹配 "No such file"，避免类似 "sudo: crontab: No such file or directory"（命令缺失或环境错误）被误当作空 crontab。
    '  case "$CRON_ERR" in',
    '    *"no crontab for "*|*"can\'t open \'"*"No such file or directory"*)',
    '      EXISTING="";;',
    '    *)',
    '      printf "%s\\n" "$CRON_ERR" >&2;',
    '      exit 46;;',
    '  esac;',
    'fi;',
    `MATCHED=$(printf '%s\\n' "$EXISTING" | grep -F ${shellQuote(marker)} || true);`,
    `if [ "$MATCHED" = ${shellQuote(cronLine)} ]; then`,
    '  printf "yuyan-cron:unchanged\\n";',
    '  exit 0;',
    'fi;',
    `FILTERED=$(printf '%s\\n' "$EXISTING" | grep -F -v ${shellQuote(marker)} || true);`,
    'WRITE_OK=0;',
    'if [ -n "$FILTERED" ]; then',
    `  printf '%s\\n%s\\n' "$FILTERED" ${shellQuote(cronLine)} | ${crontabCmd} - && WRITE_OK=1;`,
    'else',
    `  printf '%s\\n' ${shellQuote(cronLine)} | ${crontabCmd} - && WRITE_OK=1;`,
    'fi;',
    'if [ "$WRITE_OK" -eq 1 ]; then',
    '  printf "yuyan-cron:installed\\n";',
    '  exit 0;',
    'else',
    '  exit 47;',
    'fi',
  ].join(' ');

  const command = `sh -c ${shellQuote(script)}`;
  return { command, cronLine, marker };
}

/**
 * 校验 Nginx 配置文本片段。
 * @param {string|number} value - 原始值
 * @param {string} label - 字段名
 * @returns {string} 清洗后的值
 */
function normalizeNginxConfigValue(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (/[\r\n;]/.test(text)) throw new Error(`${label}不能包含换行或分号`);
  return text;
}

/**
 * 渲染项目托管站点配置。
 * @param {Object} target - 部署目标
 * @returns {string} 站点配置
 */
export const MANAGED_HEADER_PREFIX = '# managed-by: yuyan';
export const MANAGED_HEADER_REGEX = /^#\s*managed-by:\s*yuyan\s+target=(\d+)\s+sha256=([a-f0-9]{64})(?:\r?\n|$)/i;
export const MANAGED_INSTANCE_HEADER_REGEX = /^#\s*managed-by:\s*yuyan\s+instance=(\d+)\s+sha256=([a-f0-9]{64})(?:\r?\n|$)/i;
export const MANAGED_ANY_HEADER_REGEX = /^#\s*managed-by:\s*yuyan\s+(?:target|instance)=(\d+)\s+sha256=([a-f0-9]{64})(?:\r?\n|$)/i;

/**
 * 规范化并计算配置主体内容的 SHA-256 哈希值
 * @param {string} body - 配置主体内容
 * @returns {string} sha256 16进制字符串
 */
export function computeConfigBodySha256(body) {
  const normalized = String(body || '')
    .replace(MANAGED_ANY_HEADER_REGEX, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * 渲染项目托管站点配置正文（不含托管 Header）。
 * @param {Object} target - 部署目标
 * @returns {string} 站点配置正文
 */
export function renderSiteConfigBody(target) {
  const listenPort = Number(target.listenPort || 0);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('托管站点监听端口必须在 1-65535 之间');
  }
  const serverName = normalizeNginxConfigValue(target.nginxServerName || '_', 'server_name');
  const deployRoot = normalizeNginxConfigValue(target.deployRoot, '部署根目录');
  return [
    `server {`,
    `    listen ${listenPort};`,
    `    server_name ${serverName};`,
    '',
    '    gzip on;',
    '    gzip_min_length 1k;',
    '    gzip_comp_level 5;',
    '    gzip_types text/plain text/css text/javascript application/json application/javascript application/x-javascript application/xml;',
    '    gzip_vary on;',
    '    gzip_disable "MSIE [1-6]\\.";',
    '',
    `    root ${deployRoot};`,
    '    index index.html index.htm;',
    '',
    '    location ~* \\.html$ {',
    '        expires -1;',
    '        add_header Cache-Control "no-cache";',
    '        try_files $uri =404;',
    '    }',
    '',
    '    location ~* \\.(js|mjs|css|map|wasm|png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|eot|json|txt)$ {',
    '        expires 1y;',
    '        add_header Cache-Control "public, max-age=31536000, immutable";',
    '        access_log off;',
    '        try_files $uri =404;',
    '    }',
    '',
    '    location / {',
    '        add_header Cache-Control "no-cache";',
    '        try_files $uri $uri/ /index.html;',
    '    }',
    '}',
  ].join('\n');
}

/**
 * 为配置正文追加平台托管标记头
 * @param {string} body - 配置正文
 * @param {number} targetId - 部署目标 ID
 * @returns {string} 包含标记头的完整配置文本
 */
export function attachManagedHeader(body, targetId) {
  const cleanBody = String(body || '').replace(MANAGED_ANY_HEADER_REGEX, '').trim();
  const hash = computeConfigBodySha256(cleanBody);
  const header = `# managed-by: yuyan target=${targetId} sha256=${hash}`;
  return `${header}\n\n${cleanBody}\n`;
}

/**
 * 为主配置正文追加平台托管标记头
 * @param {string} body - 主配置正文
 * @param {number} instanceId - Nginx 实例 ID
 * @returns {string} 包含标记头的完整主配置文本
 */
export function attachManagedInstanceHeader(body, instanceId) {
  const cleanBody = String(body || '').replace(MANAGED_ANY_HEADER_REGEX, '').trim();
  const hash = computeConfigBodySha256(cleanBody);
  const header = `# managed-by: yuyan instance=${instanceId} sha256=${hash}`;
  return `${header}\n\n${cleanBody}\n`;
}

/**
 * 解析配置文件的平台托管标记头
 * @param {string} content - 配置文件内容
 * @returns {{ isManaged: boolean, targetId: number | null, expectedSha256: string | null, body: string }}
 */
export function parseManagedHeader(content) {
  const text = String(content || '');
  const match = text.match(MANAGED_HEADER_REGEX);
  if (!match) {
    return {
      isManaged: false,
      targetId: null,
      expectedSha256: null,
      body: text.trim(),
    };
  }
  const firstLineEnd = text.indexOf('\n');
  const body = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1).trim() : '';
  return {
    isManaged: true,
    targetId: Number(match[1]),
    expectedSha256: match[2].toLowerCase(),
    body,
  };
}

/**
 * 解析主配置文件的平台托管标记头
 * @param {string} content - 配置文件内容
 * @returns {{ isManaged: boolean, instanceId: number | null, expectedSha256: string | null, body: string }}
 */
export function parseManagedInstanceHeader(content) {
  const text = String(content || '');
  const match = text.match(MANAGED_INSTANCE_HEADER_REGEX);
  if (!match) {
    return {
      isManaged: false,
      instanceId: null,
      expectedSha256: null,
      body: text.trim(),
    };
  }
  const firstLineEnd = text.indexOf('\n');
  const body = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1).trim() : '';
  return {
    isManaged: true,
    instanceId: Number(match[1]),
    expectedSha256: match[2].toLowerCase(),
    body,
  };
}

/**
 * 渲染项目托管站点配置（含托管 Header 标记）。
 * @param {Object} target - 部署目标
 * @returns {string} 站点完整配置
 */
export function renderSiteConfig(target) {
  const body = renderSiteConfigBody(target);
  return attachManagedHeader(body, target.id);
}

/**
 * 检查现有配置的托管归属与覆写安全性。
 * @param {string} existingContent - 远程服务器已有配置
 * @param {Object} target - 部署目标
 * @param {string} generatedBody - 平台生成的主体配置
 * @returns {{ canAutoOverwrite: boolean, status: string, reason?: string, currentSha256: string }}
 */
export function inspectNginxConfigManagedState(existingContent, target, generatedBody) {
  const trimmed = String(existingContent || '').trim();
  if (!trimmed) {
    return { canAutoOverwrite: true, status: 'not_found', currentSha256: '' };
  }

  const parsed = parseManagedHeader(existingContent);
  if (parsed.isManaged) {
    const actualHash = computeConfigBodySha256(parsed.body);
    if (parsed.targetId === Number(target.id) && actualHash === parsed.expectedSha256) {
      return { canAutoOverwrite: true, status: 'clean_managed', currentSha256: actualHash };
    }
    const reason = parsed.targetId === Number(target.id)
      ? '配置文件曾由平台生成，但已被手工修改过（内容哈希不匹配）'
      : `配置文件属于其他部署目标（#${parsed.targetId}）`;
    return { canAutoOverwrite: false, status: 'drifted_managed', reason, currentSha256: actualHash };
  }

  // 没有 header 标记的老文件：若内容和平台模板生成的完全一致，视为平台名下的历史文件，允许更新并补上标记
  const legacyHash = computeConfigBodySha256(trimmed);
  const targetHash = computeConfigBodySha256(generatedBody);
  if (legacyHash === targetHash) {
    return { canAutoOverwrite: true, status: 'legacy_clean_match', currentSha256: legacyHash };
  }

  return {
    canAutoOverwrite: false,
    status: 'unmanaged_external',
    reason: '配置文件为手工维护或已有实例文件，未包含当前目标的平台托管标记',
    currentSha256: legacyHash,
  };
}

/**
 * 检查现有主配置的托管归属与覆写安全性。
 * @param {string} existingContent - 远程服务器已有主配置
 * @param {Object} instance - Nginx 实例
 * @param {string} generatedBody - 平台生成的主配置主体
 * @returns {{ canAutoOverwrite: boolean, status: string, reason?: string, currentSha256: string }}
 */
export function inspectMainNginxConfigManagedState(existingContent, instance, generatedBody) {
  const trimmed = String(existingContent || '').trim();
  if (!trimmed) {
    return { canAutoOverwrite: true, status: 'not_found', currentSha256: '' };
  }

  const parsed = parseManagedInstanceHeader(existingContent);
  if (parsed.isManaged) {
    const actualHash = computeConfigBodySha256(parsed.body);
    if (parsed.instanceId === Number(instance.id) && actualHash === parsed.expectedSha256) {
      return { canAutoOverwrite: true, status: 'clean_managed', currentSha256: actualHash };
    }
    const reason = parsed.instanceId === Number(instance.id)
      ? '主配置文件曾由平台生成，但已被手工修改过（内容哈希不匹配）'
      : `主配置文件属于其他 Nginx 实例（#${parsed.instanceId}）`;
    return { canAutoOverwrite: false, status: 'drifted_managed', reason, currentSha256: actualHash };
  }

  // 没有 header 标记的老文件：若内容和平台模板生成的完全一致，视为平台名下的历史文件，允许更新并补上标记
  const legacyHash = computeConfigBodySha256(trimmed);
  const targetHash = computeConfigBodySha256(generatedBody);
  if (legacyHash === targetHash) {
    return { canAutoOverwrite: true, status: 'legacy_clean_match', currentSha256: legacyHash };
  }

  return {
    canAutoOverwrite: false,
    status: 'unmanaged_external',
    reason: '主配置文件为手工维护或已有实例文件，未包含当前托管实例的平台归属标记',
    currentSha256: legacyHash,
  };
}

/**
 * 兼容旧版的配置覆写安全校验函数。
 * @param {string} existingContent - 现有内容
 * @param {string} newContent - 新内容
 * @param {Object=} target - 部署目标
 * @returns {{ safe: boolean, reason?: string }}
 */
export function checkNginxOverwriteSafety(existingContent, newContent, target = { id: 0 }) {
  const inspection = inspectNginxConfigManagedState(existingContent, target, newContent);
  return {
    safe: inspection.canAutoOverwrite,
    reason: inspection.reason,
  };
}

/**
 * 解析部署目标托管站点配置文件路径。
 * @param {Object} target - 部署目标
 * @param {Object} config - 托管运行时配置
 * @returns {string} 站点配置文件路径
 */
function resolveTargetSitePath(target, config) {
  const rawPath = String(target.nginxConfPath || '').trim();
  if (rawPath) return rawPath;
  return config.mainConfPath;
}

/**
 * 判断目标是否使用托管 Nginx 主配置作为入口。
 * @param {string} sitePath - 配置文件路径
 * @param {Object} config - 托管运行时配置
 * @returns {boolean} 是否主配置
 */
function isManagedMainConfPath(sitePath, config) {
  return path.posix.normalize(sitePath) === path.posix.normalize(config.mainConfPath);
}

// ──────────────────────────────────────────────
// 运行时操作
// ──────────────────────────────────────────────

/**
 * 构建远程脚本命令。
 * @param {Object} config - 运行时配置
 * @param {string} action - 操作
 * @returns {string} 命令
 */
function buildRuntimeScriptCommand(config, action) {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  return `${sudo}${shellQuote(config.scriptPath)} ${action}`;
}

/**
 * 执行托管运行时脚本。
 * @param {Object} conn - SSH 连接
 * @param {Object} runtime - 运行时 DB 记录
 * @param {string} action - 操作
 * @returns {Promise<Object>} 执行结果
 */
async function execRuntimeScript(conn, runtime, action) {
  if (!RUNTIME_ACTIONS.has(action)) throw new Error('不支持的 Nginx 运行时操作');
  const config = resolveRuntimeConfig(runtime);
  return execSsh(conn, buildRuntimeScriptCommand(config, action), {
    label: `托管 Nginx ${action}`,
    allowFailure: action === 'status',
  });
}

/**
 * 生成外部 Nginx 实例操作命令。
 * @param {Object} instance - Nginx 实例
 * @param {string} action - 操作
 * @returns {string} 远程命令
 */
function buildExternalInstanceCommand(instance, action) {
  if (!['test', 'reload'].includes(action)) throw new Error('已有 Nginx 实例仅支持校验和重载');
  const command = action === 'reload' ? instance.nginxReloadCommand || 'nginx -s reload' : instance.nginxTestCommand || 'nginx -t';
  const sudo = instance.useSudo ? 'sudo -n ' : '';
  const workDir = String(instance.nginxWorkDir || '').trim();
  const cdPrefix = workDir ? `cd ${shellQuote(workDir)} && ` : '';
  return `${cdPrefix}${sudo}${command}`;
}

/**
 * 执行外部 Nginx 实例操作。
 * @param {Object} conn - SSH 连接
 * @param {Object} instance - Nginx 实例
 * @param {string} action - 操作
 * @returns {Promise<Object>} 执行结果
 */
async function execExternalInstanceAction(conn, instance, action) {
  return execSsh(conn, buildExternalInstanceCommand(instance, action), {
    label: `Nginx 实例 ${instance.name || instance.id} ${action}`,
    allowFailure: false,
  });
}

/**
 * 组装运行时状态返回体。
 * @param {Object} params - 状态参数
 * @returns {Object} 状态响应
 */
function createRuntimeStatusResponse(params) {
  const {
    instance,
    initialized,
    running,
    status,
    statusOutput,
    platform,
    manifest,
    manifests,
    config,
    runningVersion = '',
    diskVersion = '',
    upgradePending = false,
    pidRepaired = false,
    masterPid = 0,
    versionDetectError = '',
    scriptRefreshed = false,
  } = params;
  const version = runningVersion || diskVersion || instance?.runtimeVersion || '';
  return {
    runtime: instance || null,
    initialized,
    running,
    status,
    statusOutput,
    platform: platform || '',
    manifest,
    manifests,
    version,
    runningVersion: runningVersion || '',
    diskVersion: diskVersion || version,
    upgradePending: Boolean(upgradePending),
    pidRepaired: Boolean(pidRepaired),
    masterPid: Number(masterPid) || 0,
    versionDetectError: versionDetectError || '',
    scriptRefreshed: Boolean(scriptRefreshed),
    packageVariant: instance?.packageVariant || '',
    baseRoot: config.baseRoot,
    installRoot: config.installRoot,
    sitesDir: config.sitesDir,
    webRoot: config.webRoot,
    scriptPath: config.scriptPath,
    mainConfPath: config.mainConfPath,
    portStart: config.portStart,
  };
}

/**
 * 按 Nginx 实例读取运行时状态。
 * @param {number} instanceId - Nginx 实例 ID
 * @returns {Promise<Object>} 状态
 */
/**
 * 若远端 yuyan-nginx.sh 协议版本低于当前，则自动刷新管理脚本与定时任务。
 * @param {Object} conn - SSH 连接
 * @param {Object} server - 服务器
 * @param {Object} config - 运行时配置
 * @returns {Promise<{ refreshed: boolean, remoteVersion: number }>}
 */
async function ensureManagedScriptCurrent(conn, server, config) {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  const quotedPath = shellQuote(config.scriptPath);
  // 脚本尚不存在时不要在 status/reload 路径里偷偷安装（留给初始化），避免干扰站点保存的 skipped 备份语义。
  const existsResult = await execSsh(conn, `${sudo}test -f ${quotedPath}`, {
    label: '检查管理脚本是否存在',
    allowFailure: true,
  });
  if (existsResult.code !== 0) {
    return { refreshed: false, remoteVersion: 0 };
  }
  const headResult = await execSsh(conn, `${sudo}sed -n '1,40p' ${quotedPath}`, {
    label: '检查管理脚本协议版本',
    allowFailure: true,
  });
  const head = String(headResult.stdout || '');
  // 读不到内容时不自动安装，避免 SSH 桩/空文件场景误触发 write backup（污染站点保存的 skipped 语义）。
  if (!head.trim()) {
    return { refreshed: false, remoteVersion: 0 };
  }
  const remoteVersion = parseRemoteScriptVersion(head);
  if (remoteVersion >= YUYAN_NGINX_SCRIPT_VERSION) {
    return { refreshed: false, remoteVersion };
  }
  await installManagedScriptAndLogRotateCron(conn, server, config, {});
  return { refreshed: true, remoteVersion };
}

/**
 * 对指定二进制执行 nginx -v 并解析版本（合并 stderr/stdout）。
 * @param {Object} conn - SSH 连接
 * @param {string} binary - 绝对路径
 * @param {boolean} useSudo - 是否 sudo
 * @returns {Promise<{ version: string, output: string }>}
 */
async function probeNginxBinaryVersion(conn, binary, useSudo) {
  if (!binary) return { version: '', output: '' };
  const sudo = useSudo ? 'sudo -n ' : '';
  const result = await execSsh(conn, `${sudo}${shellQuote(binary)} -v`, {
    label: '探测 Nginx 版本',
    allowFailure: true,
  });
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  return { version: parseNginxVersionOutput(output).version || '', output };
}

/**
 * 探测接入已有 Nginx 的运行/磁盘版本。
 * @param {Object} conn - SSH 连接
 * @param {Object} instance - 实例
 * @param {boolean} useSudo - 是否 sudo
 * @returns {Promise<{ version: string, runningVersion: string, diskVersion: string, versionDetectError: string, upgradePending: boolean }>}
 */
async function probeExternalInstanceVersion(conn, instance, useSudo) {
  const sudo = useSudo ? 'sudo -n ' : '';
  const binary = extractNginxBinaryFromCommand(instance?.nginxTestCommand || instance?.nginxReloadCommand || '');
  const workDir = String(instance?.nginxWorkDir || '').replace(/\/+$/, '');
  let runningVersion = '';
  let diskVersion = '';
  let versionDetectError = '';
  const baseHint = workDir || (binary ? binary.replace(/\/sbin\/nginx$/, '').replace(/\/nginx$/, '') : '');
  if (baseHint) {
    const safeBase = String(baseHint).replace(/"/g, '');
    const findScript = [
      'for d in /proc/[0-9]*; do',
      '  pid=${d#/proc/};',
      '  cmd=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null || true);',
      '  case "$cmd" in',
      '    *"nginx: master process"*)',
      `      case "$cmd" in *"${safeBase}"*|*"${safeBase}/"*) echo "$pid"; exit 0;; esac;;`,
      '  esac;',
      'done;',
      'exit 1',
    ].join(' ');
    const found = await execSsh(conn, `${sudo}sh -c ${shellQuote(findScript)}`, {
      label: '查找已有 Nginx master',
      allowFailure: true,
    });
    const pid = String(found.stdout || '').trim().split(/\s+/)[0] || '';
    if (found.code === 0 && /^\d+$/.test(pid)) {
      const exeScript = `exe=$(readlink /proc/${pid}/exe 2>/dev/null || echo /proc/${pid}/exe); "$exe" -v`;
      const exeProbe = await execSsh(conn, `${sudo}sh -c ${shellQuote(exeScript)}`, {
        label: '读取运行中 Nginx 版本',
        allowFailure: true,
      });
      runningVersion = parseNginxVersionOutput(`${exeProbe.stderr || ''}\n${exeProbe.stdout || ''}`).version || '';
    }
  }
  if (binary) {
    diskVersion = (await probeNginxBinaryVersion(conn, binary, useSudo)).version;
  } else if (!runningVersion) {
    versionDetectError = '无法从校验命令安全提取 Nginx 二进制路径';
  }
  if (!runningVersion && !diskVersion && !versionDetectError) {
    versionDetectError = '执行 nginx -v 失败或无输出';
  }
  const version = runningVersion || diskVersion;
  const upgradePending = Boolean(runningVersion && diskVersion && runningVersion !== diskVersion);
  return { version, runningVersion, diskVersion, versionDetectError, upgradePending };
}

/**
 * 追加托管 Nginx 中央审计（无 central 上下文时静默跳过）。
 * @param {string} action - 审计动作
 * @param {Object} body - 审计正文
 */
async function appendNginxRuntimeCentralAudit(action, body = {}) {
  const hooks = getTestHooks();
  if (hooks?.onNginxAudit) {
    try {
      await hooks.onNginxAudit(action, body);
    } catch {
      // 测试钩子失败不阻断主流程
    }
  }
  try {
    const { getRequestContext } = await import('./request-context.mjs');
    const context = getRequestContext();
    if (!context || context.legacy) return;
    const { appendCentralAudit } = await import('./central-identity-service.mjs');
    await appendCentralAudit(context, { action, ...body });
  } catch {
    // 桌面端/无身份上下文时忽略
  }
}

export async function getNginxInstanceStatus(instanceId) {
  const { instance, server } = await getNginxInstanceContext(instanceId);
  const manifests = await listAvailableManifests();
  const manifest = manifests[0] || null;
  const effectiveUseSudo = Boolean(instance.useSudo || server.useSudo);
  const effectiveInstance = { ...instance, useSudo: effectiveUseSudo };
  const config = resolveRuntimeConfig(effectiveInstance);

  if (instance.instanceType !== 'managed') {
    return withSsh(server, async (conn) => {
      const probed = await probeExternalInstanceVersion(conn, effectiveInstance, effectiveUseSudo);
      if (probed.version) {
        await updateNginxInstanceState(instance.id, { runtimeVersion: probed.version });
      }
      const running = Boolean(probed.runningVersion) || instance.status === 'running';
      return createRuntimeStatusResponse({
        instance: { ...instance, runtimeVersion: probed.version || instance.runtimeVersion || '' },
        initialized: true,
        running,
        status: running ? 'running' : (instance.status || 'unknown'),
        statusOutput: instance.statusOutput || '',
        platform: '',
        manifest,
        manifests,
        config,
        runningVersion: probed.runningVersion,
        diskVersion: probed.diskVersion,
        upgradePending: probed.upgradePending,
        versionDetectError: probed.versionDetectError,
      });
    });
  }

  return withSsh(server, async (conn) => {
    const platformResult = await execSsh(conn, 'uname -s && uname -m', {
      label: '检查服务器系统架构',
      allowFailure: true,
    });
    const fileResult = await execSsh(
      conn,
      [
        `[ -x ${shellQuote(config.nginxPath)} ] && echo nginx=1 || echo nginx=0`,
        `[ -x ${shellQuote(config.scriptPath)} ] && echo script=1 || echo script=0`,
        `[ -f ${shellQuote(config.mainConfPath)} ] && echo conf=1 || echo conf=0`,
      ].join(' && '),
      { label: '检查托管 Nginx 文件', allowFailure: true }
    );
    const fileText = fileResult.stdout || '';
    const initialized = fileText.includes('nginx=1') && fileText.includes('script=1') && fileText.includes('conf=1');
    let scriptRefreshed = false;
    if (initialized) {
      const ensured = await ensureManagedScriptCurrent(conn, server, config);
      scriptRefreshed = ensured.refreshed;
    }
    const statusResult = await execRuntimeScript(conn, effectiveInstance, 'status').catch((error) => ({
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
    }));
    const combined = `${statusResult.stdout || ''}${statusResult.stderr || ''}`;
    const parsed = parseRuntimeScriptStatusOutput(combined);
    const needsSudo = parsed.needsSudo || statusResult.code === 4;
    // 新脚本成功时会输出 running: <pid>；兼容旧脚本/测试桩仅返回 exit 0 的情况。
    // needs_sudo 时若已解析到 pid，仍视为「在跑但缺权限」，绝不能标 stopped。
    const running =
      parsed.running ||
      (statusResult.code === 0 && !parsed.stopped && !needsSudo && !/\bstopped\b/.test(combined));
    let status = 'stopped';
    if (!initialized) status = 'uninitialized';
    else if (needsSudo) status = running ? 'error' : 'error';
    else status = running ? 'running' : 'stopped';
    if (parsed.pidRepaired) {
      await appendNginxRuntimeCentralAudit('nginx_pid_auto_repaired', {
        resourceType: 'nginx_instance',
        resourceId: Number(instance.id),
        result: 'repaired',
        pid: parsed.pid,
        pidPath: parsed.pidPath,
      });
    }
    const runtimeVersion = parsed.runningVersion || parsed.diskVersion || instance.runtimeVersion || '';
    await updateNginxInstanceState(instance.id, {
      status: needsSudo ? 'error' : status,
      statusOutput: combined.trim(),
      runtimeVersion: runtimeVersion || null,
    });
    return createRuntimeStatusResponse({
      instance: {
        ...instance,
        status,
        statusOutput: combined.trim(),
        runtimeVersion,
      },
      initialized,
      running,
      status: needsSudo ? 'error' : status,
      statusOutput: `${combined.trim()}${needsSudo ? '\n需要免密 sudo 才能识别/信号 root 进程' : ''}`,
      platform: platformResult.stdout.trim().replace(/\s+/g, ' '),
      manifest,
      manifests,
      config,
      runningVersion: parsed.runningVersion,
      diskVersion: parsed.diskVersion || runtimeVersion,
      upgradePending: parsed.upgradePending,
      pidRepaired: parsed.pidRepaired,
      masterPid: parsed.pid,
      versionDetectError: parsed.running || parsed.diskVersion ? '' : '未能从运行进程或磁盘二进制探测到版本',
      scriptRefreshed,
    });
  });
}

export async function getNginxRuntimeStatus(serverId) {
  const instance = (await getManagedNginxInstanceByServerId(serverId)) || (await getDefaultNginxInstanceByServerId(serverId));
  if (!instance || instance.instanceType !== 'managed') {
    const manifests = await listAvailableManifests();
    const manifest = manifests[0] || null;
    const config = resolveRuntimeConfig(null);
    return {
      runtime: null,
      initialized: false,
      running: false,
      status: 'uninitialized',
      statusOutput: '',
      platform: '',
      manifest,
      manifests,
      version: '',
      packageVariant: '',
      baseRoot: config.baseRoot,
      installRoot: config.installRoot,
      sitesDir: config.sitesDir,
      webRoot: config.webRoot,
      scriptPath: config.scriptPath,
      mainConfPath: config.mainConfPath,
      portStart: config.portStart,
    };
  }
  return getNginxInstanceStatus(instance.id);
}

// ──────────────────────────────────────────────
// 导出：初始化
// ──────────────────────────────────────────────

/**
 * 初始化服务器托管 Nginx 运行时。
 * 自动探测目标服务器的 glibc 版本，并从 registry 中选择最优的运行时变体。
 * @param {number} serverId - 服务器 ID
 * @param {Object} payload - 初始化参数
 * @param {Object} emit - 进度输出器
 * @returns {Promise<Object>} 初始化结果
 */
export async function initializeNginxRuntime(serverId, payload = {}, emit = {}) {
  const runtime = await upsertNginxRuntime(serverId, payload);
  if (!runtime?.id) throw new Error('无法创建托管 Nginx 实例');
  return initializeNginxInstanceRuntime(runtime.id, payload, emit);
}

/**
 * 安装托管 Nginx 管理脚本 yuyan-nginx.sh 与配置日志轮转定时任务。
 * @param {Object} conn - SSH 连接
 * @param {Object} sshServer - SSH 服务器配置
 * @param {Object} config - 运行时配置
 * @param {Object} [emit] - 进度回调对象
 * @returns {Promise<{ script: { backupPath: string, skipped: boolean }, cron: { status: string, cronLine: string, message: string } }>}
 */
export async function installManagedScriptAndLogRotateCron(conn, sshServer, config, emit = {}) {
  // 1. 写入管理脚本并设置可执行权限
  const scriptContent = renderRuntimeScript();
  const scriptBackup = await writeRemoteTextWithBackup(
    conn,
    { ...sshServer, useSudo: config.useSudo },
    config.scriptPath,
    scriptContent
  );
  await execSsh(conn, `${config.useSudo ? 'sudo -n ' : ''}chmod +x ${shellQuote(config.scriptPath)}`, {
    label: '设置管理脚本权限',
  });

  const script = {
    backupPath: scriptBackup?.backupPath || '',
    skipped: Boolean(scriptBackup?.skipped),
  };

  // 2. 安装日志轮转定时任务
  const { command: cronCommand, cronLine } = buildLogRotateCronInstallCommand(config);
  let cron;
  try {
    const cronResult = await execSsh(conn, cronCommand, {
      label: '配置日志轮转定时任务',
      allowFailure: true,
    });
    cron = parseLogRotateCronResult(cronResult, cronLine, { useSudo: config.useSudo });
    if (cron.status === 'installed') {
      emit.log?.('success', '已配置托管 Nginx 每天自动日志轮转定时任务', 'configure');
    } else if (cron.status === 'unchanged') {
      emit.log?.('info', '托管 Nginx 每天自动日志轮转定时任务已存在，保持不变', 'configure');
    } else {
      emit.log?.('warn', `配置日志轮转定时任务未完成：${cron.message}`, 'configure');
    }
  } catch (cronError) {
    cron = parseLogRotateCronResult({ code: 1, stderr: cronError.message }, cronLine, { useSudo: config.useSudo });
    emit.log?.('warn', `配置日志轮转定时任务异常（${cronError.message}）`, 'configure');
  }

  return { script, cron };
}

/**
 * 初始化指定托管 Nginx 实例。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} payload - 初始化参数
 * @param {Object} emit - 进度输出器
 * @returns {Promise<Object>} 初始化结果
 */
export async function initializeNginxInstanceRuntime(instanceId, payload = {}, emit = {}) {
  const force = Boolean(payload.force);
  const expectedSha256 = payload.expectedSha256 ? String(payload.expectedSha256).toLowerCase() : null;
  if (force && !expectedSha256) {
    const badRequestError = new Error('强制覆盖主配置必须提供 expectedSha256 哈希校验值');
    badRequestError.statusCode = 400;
    badRequestError.code = 'INVALID_ARGUMENT';
    throw badRequestError;
  }

  const { instance, server } = await getNginxInstanceContext(instanceId);
  if (!instance) {
    const notFoundError = new Error('Nginx 实例不存在');
    notFoundError.statusCode = 404;
    throw notFoundError;
  }
  if (instance.instanceType !== 'managed') {
    const notManagedError = new Error('只有托管 Nginx 实例支持初始化；已接入实例不可初始化');
    notManagedError.statusCode = 409;
    notManagedError.code = 'NGINX_INSTANCE_NOT_MANAGED';
    throw notManagedError;
  }

  acquireNginxInstanceLock(instanceId, '初始化运行时');
  try {
    const { instanceType: _ignored, force: _f, expectedSha256: _e, ...safePayload } = payload;
    const effectiveBaseRoot = safePayload.baseRoot || instance.baseRoot;
    const derivedPaths = deriveRuntimePaths(effectiveBaseRoot);
    const effectiveInstance = {
      ...instance,
      ...safePayload,
      baseRoot: effectiveBaseRoot,
      nginxRoot: safePayload.nginxRoot || (safePayload.baseRoot ? derivedPaths.installRoot : instance.nginxRoot),
      htmlRoot: safePayload.htmlRoot || (safePayload.baseRoot ? derivedPaths.webRoot : instance.htmlRoot),
      sitesDir: safePayload.sitesDir || (safePayload.baseRoot ? derivedPaths.sitesDir : instance.sitesDir),
      logsDir: safePayload.logsDir || (safePayload.baseRoot ? derivedPaths.logsDir : instance.logsDir),
      scriptPath: safePayload.scriptPath || (safePayload.baseRoot ? derivedPaths.scriptPath : instance.scriptPath),
    };
    const activeServer = server;
    const config = resolveRuntimeConfig(effectiveInstance);
    let activeInstance = effectiveInstance;

    await withSsh(activeServer, async (conn) => {
      // ── 阶段 1：校验平台 ──
      emit.stage?.('validate', 5, '校验服务器平台', '');
      const platform = await assertRemotePlatform(conn);
      emit.log?.('success', `服务器架构校验通过：${platform}`, 'validate');

      // ── 阶段 2：探测运行时环境 ──
      emit.stage?.('detect', 10, '探测服务器运行时环境', '');
      const { glibcVersion, hasXcrypt, summary } = await detectRemoteEnvironment(conn);
      emit.log?.('info', `服务器环境：${summary}`, 'detect');

      // ── 前置主配置安全性与防篡改检查（在上传解压前预检）──
      emit.stage?.('precheck', 12, '检查主配置安全性', config.mainConfPath);
      const sudo = config.useSudo ? 'sudo -n ' : '';
      const generatedBody = renderMainNginxConfigBody(config);
      const mainConfigContent = attachManagedInstanceHeader(generatedBody, effectiveInstance.id);
      const existingResult = await execSsh(conn, `${sudo}test -f ${shellQuote(config.mainConfPath)}`, {
        label: '检查主配置是否存在',
        allowFailure: true,
      });
      let fileExists = false;
      if (existingResult.code === 0) {
        fileExists = true;
      } else if (existingResult.code === 1) {
        fileExists = false;
      } else {
        const errorMsg = (existingResult.stderr || existingResult.stdout || '').trim() || '未知命令执行错误';
        throw new Error(`检查主配置文件是否存在失败（退出码 ${existingResult.code}）：${errorMsg}`);
      }

      if (fileExists) {
        const existingContent = await readRemoteText(conn, { ...activeServer, useSudo: config.useSudo }, config.mainConfPath);
        const inspection = inspectMainNginxConfigManagedState(existingContent, effectiveInstance, generatedBody);
        if (!inspection.canAutoOverwrite && !force) {
          const conflictError = new Error(inspection.reason || '主配置文件存在手工修改或未被平台接管，需确认覆盖接管');
          conflictError.statusCode = 409;
          conflictError.code = 'NGINX_CONFIG_CONFLICT';
          conflictError.details = {
            instanceId: effectiveInstance.id,
            path: config.mainConfPath,
            currentContent: existingContent,
            generatedContent: mainConfigContent,
            currentSha256: inspection.currentSha256 || computeConfigBodySha256(existingContent),
            reason: inspection.reason,
          };
          throw conflictError;
        }
        if (force) {
          const actualSha = computeConfigBodySha256(existingContent);
          if (actualSha !== expectedSha256) {
            const raceError = new Error('远程主配置文件在预览后已被修改，请重新对比差异后再接管覆盖');
            raceError.statusCode = 409;
            raceError.code = 'NGINX_CONFIG_CONFLICT';
            raceError.details = {
              instanceId: effectiveInstance.id,
              path: config.mainConfPath,
              currentContent: existingContent,
              generatedContent: mainConfigContent,
              currentSha256: actualSha,
              reason: '远程主配置文件已发生并发改动',
            };
            throw raceError;
          }
        }
      }

      // 预检全部通过，即将开始上传解压与覆盖写入，此时持久化更新数据库实例配置
      if (Object.keys(safePayload).length > 0) {
        activeInstance = await updateNginxInstance(instanceId, safePayload);
      }

      // ── 阶段 3：选择运行时变体 ──
      emit.stage?.('select', 15, '选择运行时变体', '');
      const registry = await readRuntimeRegistry();
      const variant = selectRuntimeVariant(registry, glibcVersion, hasXcrypt);
      emit.log?.('success', `选中运行时变体：${variant.label}（${variant.id}）`, 'select');

      // ── 阶段 4：校验运行时包 ──
      emit.stage?.('validate', 20, '校验运行时包', `${variant.id}`);
      const manifest = await validateVariantPackage(variant);
      const { packagePath } = resolveVariantPaths(variant);
      const remotePackagePath = `/tmp/yuyan-nginx-runtime-${manifest.sha256.slice(0, 12)}.tar.gz`;
      emit.log?.('success', `运行时包校验通过：nginx ${manifest.version} ${variant.id}`, 'validate');

      try {
        // ── 阶段 5：上传 ──
        emit.stage?.('upload', 30, '上传运行时包', remotePackagePath);
        await uploadFile(conn, packagePath, remotePackagePath);

        // ── 阶段 6：解压 ──
        emit.stage?.('unpack', 50, '解压运行时包', config.installRoot);
        await execSsh(
          conn,
          [
            `${config.useSudo ? 'sudo -n ' : ''}mkdir -p ${shellQuote(config.installRoot)} ${shellQuote(config.sitesDir)} ${shellQuote(config.webRoot)}`,
            `${config.useSudo ? 'sudo -n ' : ''}tar -xzf ${shellQuote(remotePackagePath)} -C ${shellQuote(config.installRoot)}`,
            `${config.useSudo ? 'sudo -n ' : ''}mkdir -p ${shellQuote(config.installRoot)}/logs ${shellQuote(config.installRoot)}/run ${shellQuote(config.installRoot)}/client_body_temp ${shellQuote(config.installRoot)}/proxy_temp`,
            `${config.useSudo ? 'sudo -n ' : ''}chmod +x ${shellQuote(config.nginxPath)}`,
          ].join(' && '),
          { label: '解压托管 Nginx 运行时' }
        );
      } finally {
        await execSsh(conn, `rm -f ${shellQuote(remotePackagePath)}`, {
          label: '清理托管 Nginx 运行时包',
          allowFailure: true,
        }).catch(() => {});
      }

      // ── 阶段 7：配置 ──
      emit.stage?.('configure', 70, '生成 Nginx 主配置和管理脚本', config.mainConfPath);
      await execSsh(conn, `${config.useSudo ? 'sudo -n ' : ''}mkdir -p ${shellQuote(config.sitesDir)} ${shellQuote(config.webRoot)}`, {
        label: '创建托管 Nginx 目录',
      });
      await writeRemoteTextWithBackup(conn, { ...activeServer, useSudo: config.useSudo }, config.mainConfPath, mainConfigContent);
      await installManagedScriptAndLogRotateCron(conn, activeServer, config, emit);

      // ── 阶段 8：校验配置 ──
      emit.stage?.('test', 85, '校验 Nginx 配置', config.scriptPath);
      const testResult = await execRuntimeScript(conn, activeInstance, 'test');
      emit.log?.('success', `${testResult.stderr || testResult.stdout}`.trim() || 'nginx -t 校验通过', 'test');

      // ── 阶段 9：启动 ──
      emit.stage?.('start', 95, '启动托管 Nginx', config.scriptPath);
      const statusResult = await execRuntimeScript(conn, activeInstance, 'status');
      const action = statusResult.code === 0 ? 'reload' : 'start';
      const startResult = await execRuntimeScript(conn, activeInstance, action);
      emit.log?.('success', `${startResult.stdout || startResult.stderr}`.trim() || `托管 Nginx 已${action === 'reload' ? '重载' : '启动'}`, 'start');

      // ── 更新 DB 状态（包含变体信息）──
      await updateNginxInstanceState(activeInstance.id, {
        runtimeVersion: manifest.version,
        packageSha256: manifest.sha256,
        packageVariant: variant.id,
        status: 'running',
        initializedAt: new Date().toISOString(),
      });
    });

    emit.stage?.('finish', 100, '初始化完成', config.installRoot);
    return getNginxInstanceStatus(activeInstance.id);
  } finally {
    releaseNginxInstanceLock(instanceId);
  }
}

/**
 * 更新托管 Nginx 实例的管理脚本与定时任务。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} [emit] - 进度回调
 * @returns {Promise<{ script: { backupPath: string, skipped: boolean }, cron: { status: string, cronLine: string, message: string }, status: Object }>}
 */
export async function refreshNginxInstanceScript(instanceId, emit = {}) {
  const { instance, server } = await getNginxInstanceContext(instanceId);
  if (!instance) {
    const notFoundError = new Error('Nginx 实例不存在');
    notFoundError.statusCode = 404;
    throw notFoundError;
  }
  if (instance.instanceType !== 'managed') {
    const notManagedError = new Error('只有托管 Nginx 实例支持更新管理脚本与定时任务');
    notManagedError.statusCode = 409;
    notManagedError.code = 'NGINX_INSTANCE_NOT_MANAGED';
    throw notManagedError;
  }

  acquireNginxInstanceLock(instanceId, '更新管理脚本与定时任务');
  try {
    const effectiveUseSudo = Boolean(instance.useSudo || server.useSudo);
    const effectiveInstance = { ...instance, useSudo: effectiveUseSudo };
    const config = resolveRuntimeConfig(effectiveInstance);
    const result = await withSsh(server, async (conn) => {
      const sudo = config.useSudo ? 'sudo -n ' : '';
      const checkCmd = `${sudo}test -d ${shellQuote(config.installRoot)} && ${sudo}test -x ${shellQuote(config.nginxPath)}`;
      const checkResult = await execSsh(conn, checkCmd, {
        label: '检查托管 Nginx 实例是否已初始化',
        allowFailure: true,
      });
      if (checkResult.code !== 0) {
        const notInitError = new Error('实例尚未初始化，请先初始化');
        notInitError.statusCode = 400;
        throw notInitError;
      }

      return installManagedScriptAndLogRotateCron(conn, server, config, emit);
    });

    return {
      script: result.script,
      cron: result.cron,
      status: await getNginxInstanceStatus(instanceId),
    };
  } finally {
    releaseNginxInstanceLock(instanceId);
  }
}

// ──────────────────────────────────────────────
// 导出：运行时操作
// ──────────────────────────────────────────────

/**
 * 执行托管 Nginx 运行时操作。
 * @param {number} serverId - 服务器 ID
 * @param {'test'|'start'|'stop'|'reload'|'status'} action - 操作
 * @returns {Promise<Object>} 操作结果
 */
export async function runNginxRuntimeAction(serverId, action) {
  const server = await getServerWithCredential(serverId);
  if (!server) throw new Error('服务器不存在');
  const runtime = await getNginxRuntimeByServerId(serverId);
  if (!runtime) throw new Error('当前服务器尚未初始化托管 Nginx');
  return withSsh(server, async (conn) => {
    const result = await execRuntimeScript(conn, runtime, action);
    const status = action === 'stop' && result.code === 0 ? 'stopped' : action === 'start' || action === 'reload' ? 'running' : result.code === 0 ? 'running' : 'error';
    await updateNginxRuntimeState(serverId, {
      status,
      statusOutput: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    });
    return {
      success: result.code === 0,
      action,
      output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
      status: await getNginxRuntimeStatus(serverId),
    };
  });
}

/**
 * 执行指定 Nginx 实例操作。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {'test'|'start'|'stop'|'reload'|'status'} action - 操作
 * @returns {Promise<Object>} 操作结果
 */
export async function runNginxInstanceAction(instanceId, action) {
  const shouldLock = ['start', 'stop', 'reload', 'upgrade'].includes(action);
  const actionLabels = {
    start: '启动',
    stop: '停止',
    reload: '重载',
    upgrade: '平滑升级',
  };
  if (shouldLock) {
    acquireNginxInstanceLock(instanceId, actionLabels[action] || action);
  }
  try {
    const { instance, server } = await getNginxInstanceContext(instanceId);
    const effectiveUseSudo = Boolean(instance.useSudo || server.useSudo);
    const effectiveInstance = { ...instance, useSudo: effectiveUseSudo };
    return await withSsh(server, async (conn) => {
      if (instance.instanceType === 'managed' && ['reload', 'start', 'stop', 'status', 'upgrade', 'test'].includes(action)) {
        const config = resolveRuntimeConfig(effectiveInstance);
        await ensureManagedScriptCurrent(conn, server, config);
      }
      const result = instance.instanceType === 'managed'
        ? await execRuntimeScript(conn, effectiveInstance, action)
        : await execExternalInstanceAction(conn, effectiveInstance, action);
      const status =
        action === 'stop' && result.code === 0
          ? 'stopped'
          : action === 'start' || action === 'reload'
            ? 'running'
            : result.code === 0
              ? 'running'
              : 'error';
      if (action === 'upgrade') {
        await appendNginxRuntimeCentralAudit('nginx_binary_hot_upgrade', {
          resourceType: 'nginx_instance',
          resourceId: Number(instance.id),
          result: result.code === 0 ? 'success' : 'failed',
          output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(0, 2000),
        });
      }
      await updateNginxInstanceState(instance.id, {
        status,
        statusOutput: `${result.stdout || ''}${result.stderr || ''}`.trim(),
      });
      return {
        success: result.code === 0,
        action,
        output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
        status: await getNginxInstanceStatus(instance.id),
      };
    });
  } finally {
    if (shouldLock) {
      releaseNginxInstanceLock(instanceId);
    }
  }
}

/**
 * 读取托管实例主配置。
 * @param {Object} conn - SSH 连接
 * @param {Object} config - 运行时配置
 * @returns {Promise<string>} nginx.conf 内容
 */
async function readManagedMainConfig(conn, config) {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  const result = await execSsh(conn, `${sudo}cat ${shellQuote(config.mainConfPath)}`, {
    label: '读取 Nginx 主配置',
  });
  return result.stdout || '';
}

/**
 * 构建用于展开全部 include 配置的 nginx -T 远程命令。
 * @param {Object} instance - Nginx 实例
 * @param {Object} config - 运行时配置
 * @returns {string} 远程命令
 */
export function buildNginxDumpConfigCommand(instance, config) {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  if (instance?.instanceType === 'managed') {
    const nginxBin = config.nginxPath || (config.installRoot ? `${config.installRoot}/sbin/nginx` : 'nginx');
    const prefixArg = config.installRoot ? `-p ${shellQuote(config.installRoot.replace(/\/+$/, '') + '/')} ` : '';
    return `${sudo}${shellQuote(nginxBin)} ${prefixArg}-c ${shellQuote(config.mainConfPath)} -T`;
  }

  // 已有外部 Nginx 实例
  const workDir = String(instance?.nginxWorkDir || '').trim();
  const cdPrefix = workDir ? `cd ${shellQuote(workDir)} && ` : '';
  const baseTestCmd = String(instance?.nginxTestCommand || '').trim();
  let dumpCmd = '';
  if (baseTestCmd) {
    dumpCmd = /(^|\s)-t(\s|$)/.test(baseTestCmd)
      ? baseTestCmd.replace(/(^|\s)-t(\s|$)/, '$1-T$2')
      : `${baseTestCmd} -T`;
    if (!/(^|\s)-c(\s|$)/.test(dumpCmd) && config.mainConfPath) {
      dumpCmd = `${dumpCmd} -c ${shellQuote(config.mainConfPath)}`;
    }
  } else {
    dumpCmd = `nginx -T -c ${shellQuote(config.mainConfPath)}`;
  }
  return `${cdPrefix}${sudo}${dumpCmd}`;
}

/**
 * 读取完整的 Nginx 配置（优先使用 nginx -T 展开 include，失败时降级读取主配置）。
 * @param {Object} conn - SSH 连接
 * @param {Object} instance - Nginx 实例
 * @param {Object} config - 运行时配置
 * @param {(msg: string) => void} [onWarning] - 降级警告回调
 * @returns {Promise<{ content: string, expanded: boolean }>} 配置内容与是否成功展开
 */
export async function readEffectiveNginxConfig(conn, instance, config, onWarning) {
  const dumpCmd = buildNginxDumpConfigCommand(instance, config);
  try {
    const result = await execSsh(conn, dumpCmd, {
      label: '展开 Nginx 完整配置(nginx -T)',
      allowFailure: true,
    });
    if (result.code === 0 && result.stdout && result.stdout.trim()) {
      return { content: result.stdout, expanded: true };
    }
  } catch {
    // 忽略异常，降级处理
  }

  const fallbackWarning = 'include 未展开，点文件白名单可能不全';
  onWarning?.(fallbackWarning);
  console.warn(`[nginx-archive] ${fallbackWarning}`);
  const fallbackContent = await readManagedMainConfig(conn, config).catch(() => '');
  return { content: fallbackContent, expanded: false };
}

/**
 * 获取 Nginx 实例可选的 server 块（支持托管与已有实例）。
 * @param {number} instanceId - Nginx 实例 ID
 * @returns {Promise<Object>} 配置版本与站点列表
 */
export async function getNginxInstanceArchiveSites(instanceId) {
  const { instance, server } = await getNginxInstanceContext(instanceId);
  const config = resolveArchiveRuntimeConfig(instance);
  const content = await withSsh(server, (conn) => readManagedMainConfig(conn, config));
  const parsed = parseNginxArchiveSites(content);
  const targets = await listTargets({ serverId: instance.serverId });
  const sites = parsed.sites.map((site) => {
    const matchedTargets = targets.filter((target) => {
      const deployRoot = path.posix.normalize(String(target.deployRoot || '').trim().replace(/\\/g, '/')).replace(/\/+$/, '');
      return (deployRoot && site.roots.includes(deployRoot))
        || (Number(target.listenPort || 0) > 0 && site.listenPorts.includes(Number(target.listenPort)));
    });
    return {
      ...site,
      targetIds: matchedTargets.map((target) => Number(target.id)),
      projectNames: [...new Set(matchedTargets.map((target) => String(target.projectName || '').trim()).filter(Boolean))],
      canDownloadFiles: site.roots.length > 0,
    };
  });
  return {
    configPath: config.mainConfPath,
    revision: parsed.revision,
    sites,
  };
}

/**
 * 流式导出 Nginx 实例运行包或配置/站点（支持托管与已有实例）。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {string} type - 下载类型 ('all' | 'html' | 'conf')
 * @param {import('node:stream').Writable} output - 输出流
 * @param {(meta: Object) => void} onReady - 响应头准备回调
 * @param {{siteIds?: string[], revision?: string}} selection - 可选 server 选择
 * @returns {Promise<Object>} 导出元信息
 */
export async function streamNginxInstanceArchive(instanceId, type = 'all', output, onReady, selection = {}) {
  const { instance, server } = await getNginxInstanceContext(instanceId);
  const isManaged = instance.instanceType === 'managed';
  const config = resolveArchiveRuntimeConfig(instance);
  const siteIds = (selection.siteIds || []).filter(Boolean);
  const hasSelection = siteIds.length > 0;

  const archiveStream = new PassThrough();
  archiveStream.pipe(output);

  // 监听 output 的结束事件，用于等待网络传输完成
  const outputFinished = new Promise((resolve) => {
    output.once('finish', resolve);
    output.once('close', resolve);
  });

  const meta = await withSsh(server, async (conn) => {
    let selected = null;
    let archiveRoot = '';
    if (hasSelection) {
      const content = await readManagedMainConfig(conn, config);
      selected = resolveNginxArchiveSelection(content, { ...selection, siteIds, type });
      const precheckCommand = isManaged
        ? buildSelectedArchivePrecheckCommand(config, type, selected.roots)
        : buildExternalArchivePrecheckCommand(config, type, selected.roots);
      if (precheckCommand) {
        await execSsh(conn, precheckCommand, {
          label: isManaged ? `预检所选 Nginx 运行包(${type})` : `预检所选 Nginx 导出(${type})`,
        });
      }
    } else {
      if (isManaged) {
        if (type === 'html') {
          archiveRoot = resolveArchiveRoot(config.webRoot);
        } else if (type !== 'conf') {
          archiveRoot = resolveArchiveRoot(config.baseRoot);
        }
        await execSsh(conn, buildArchivePrecheckCommand(config, type), { label: `预检托管 Nginx 运行包(${type})` });
      } else {
        const roots = type === 'html' && config.webRoot ? [config.webRoot] : [];
        const precheckCommand = buildExternalArchivePrecheckCommand(config, type, roots);
        if (precheckCommand) {
          await execSsh(conn, precheckCommand, { label: `预检已有 Nginx 导出(${type})` });
        }
      }
    }

    let whitelist = [];
    const includeHidden = Boolean(selection.includeHidden);
    if (type !== 'conf' && !includeHidden) {
      const { content: effectiveContent, expanded } = await readEffectiveNginxConfig(
        conn,
        instance,
        config,
        (warning) => {
          selection.onEvent?.({ stage: 'packing', message: warning });
        }
      );
      const confToParse = expanded ? effectiveContent : (selected?.filteredConfig || effectiveContent);
      if (confToParse) {
        whitelist = resolveNginxArchiveWhitelist(confToParse, {
          prefix: config.installRoot || path.dirname(config.mainConfPath),
          confDir: path.dirname(config.mainConfPath),
        });
      }
      const whitelistMsg = whitelist.length > 0
        ? `已放行 ${whitelist.length} 个点文件与配置引用`
        : '已排除隐藏文件（无点文件引用）';
      selection.onEvent?.({ stage: 'packing', message: whitelistMsg });
      console.log(`[nginx-archive] 导出白名单 (${whitelist.length} 项): ${whitelist.join(', ') || '(无点文件引用)'}`);
    }

    const currentMeta = {
      fileName: buildArchiveFileName(server, instance, type, selected?.sites || []),
      baseRoot: config.baseRoot,
      scriptPath: config.scriptPath,
      revision: selected?.revision || '',
      whitelistCount: whitelist.length,
    };
    onReady?.(currentMeta);

    if (selected && type === 'conf') {
      archiveStream.end(Buffer.from(selected.filteredConfig, 'utf8'));
      await outputFinished;
      return currentMeta;
    }

    if (!selected && type === 'conf') {
      const sudo = config.useSudo ? 'sudo -n ' : '';
      await streamSshCommand(conn, `${sudo}cat ${shellQuote(config.mainConfPath)}`, archiveStream, {
        label: '导出 Nginx 配置文件',
      });
    } else {
      const archiveOptions = { whitelist, includeHidden };

      let command = '';
      if (isManaged) {
        command = selected
          ? buildSelectedArchiveTarCommand(config, selected.roots, type, selected.filteredConfig, archiveOptions)
          : buildArchiveTarCommand(config, archiveRoot, type, archiveOptions);
      } else {
        const roots = selected ? selected.roots : (config.webRoot ? [config.webRoot] : []);
        command = buildExternalArchiveTarCommand(config, roots, type, selected?.filteredConfig || '', archiveOptions);
      }
      await streamSshCommand(conn, command, archiveStream, {
        label: isManaged ? `导出托管 Nginx 运行包(${type})` : `导出已有 Nginx 配置/站点(${type})`,
      });
    }
    
    // 数据推送完毕，发送结束符并等待管道数据全数写入网络
    archiveStream.end();
    await outputFinished;
    return currentMeta;
  });

  return meta;
}

/**
 * 本地直写：流式导出托管 Nginx 实例运行包并保存到指定磁盘路径。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {string} type - 下载类型 ('all' | 'html' | 'conf')
 * @param {string} filePath - 本地保存路径
 * @param {(event: Object) => void} onEvent - 下载阶段与进度事件回调
 * @param {() => boolean} isAbortedFn - 外部传递的是否 Abort 判断函数
 * @returns {Promise<Object>} 导出元信息
 */
export async function saveNginxInstanceArchiveToPath(instanceId, type = 'all', filePath, onEvent, isAbortedFn, options = {}) {
  const emit = (event) => {
    if (!isAbortedFn?.()) onEvent?.(event);
  };

  emit({ stage: 'preparing', message: '正在准备下载任务' });
  const { instance, server } = await getNginxInstanceContext(instanceId);
  const isManaged = instance.instanceType === 'managed';
  const config = resolveArchiveRuntimeConfig(instance);
  
  let archiveRoot = '';
  if (isManaged) {
    if (type === 'html') {
      archiveRoot = resolveArchiveRoot(config.webRoot);
    } else if (type !== 'conf') {
      archiveRoot = resolveArchiveRoot(config.baseRoot);
    }
  }

  const fileName = buildArchiveFileName(server, instance, type);
  const meta = {
    fileName,
    baseRoot: config.baseRoot,
    scriptPath: config.scriptPath,
  };

  await withSsh(server, async (conn) => {
    emit({ stage: 'prechecking', message: '正在校验远程运行包依赖与路径' });
    const precheckCommand = isManaged
      ? buildArchivePrecheckCommand(config, type)
      : buildExternalArchivePrecheckCommand(config, type, config.webRoot ? [config.webRoot] : []);
    if (precheckCommand) {
      await execSsh(conn, precheckCommand, {
        label: isManaged ? `预检托管 Nginx 运行包(${type})` : `预检已有 Nginx 导出(${type})`,
      });
    }
    
    if (isAbortedFn?.()) return;

    // 通过标准 PassThrough 管道写入本地文件，同时在 data 事件中统计进度。
    const fileStream = createWriteStream(filePath);
    let loaded = 0;
    let lastProgressAt = Date.now();
    const progressStream = new PassThrough();
    const fileWritePromise = finished(fileStream);

    progressStream.on('data', (chunk) => {
      loaded += chunk.length;
      lastProgressAt = Date.now();
      emit({ stage: 'writing', message: '正在写入本地磁盘', loaded });
    });
    progressStream.on('error', (error) => {
      fileStream.destroy(error);
    });
    progressStream.pipe(fileStream);

    /**
     * 流式执行远程导出命令并发送空闲心跳。
     * @param {string} command - 远程命令
     * @param {string} label - 命令标签
     * @param {string} idleMessage - 无数据提示文案
     * @returns {Promise<void>}
     */
    const runArchiveStream = async (command, label, idleMessage) => {
      const heartbeat = setInterval(() => {
        if (isAbortedFn?.()) return;
        const idleSeconds = Math.floor((Date.now() - lastProgressAt) / 1000);
        if (idleSeconds < 10) return;
        emit({
          stage: loaded > 0 ? 'writing' : 'packing',
          message: `${idleMessage}，已 ${idleSeconds} 秒无新增数据`,
          loaded,
          idleSeconds,
        });
      }, ARCHIVE_STREAM_HEARTBEAT_MS);

      try {
        await streamSshCommand(conn, command, progressStream, {
          label,
          isAborted: isAbortedFn,
          abortMessage: `${label} 已取消`,
          idleTimeoutMs: ARCHIVE_STREAM_IDLE_TIMEOUT_MS,
          idleTimeoutMessage: `${label} 超过 ${Math.ceil(ARCHIVE_STREAM_IDLE_TIMEOUT_MS / 1000)} 秒没有输出，已中断。请检查远程目录是否存在超大文件、网络是否稳定，或改用“仅前端静态产物/仅配置文件”分包下载。`,
        });
      } finally {
        clearInterval(heartbeat);
      }
    };

    try {
      if (type === 'conf') {
        const sudo = config.useSudo ? 'sudo -n ' : '';
        emit({ stage: 'packing', message: '正在读取远程 Nginx 配置文件' });
        await runArchiveStream(`${sudo}cat ${shellQuote(config.mainConfPath)}`, '导出 Nginx 配置文件', '正在等待远程配置文件输出');
      } else {
        emit({ stage: 'packing', message: '正在远程打包运行目录并开始传输' });
        let whitelist = [];
        const includeHidden = Boolean(options.includeHidden);
        if (!includeHidden) {
          emit({ stage: 'packing', message: '正在分析 Nginx 引用文件并构建白名单' });
          const { content: effectiveContent } = await readEffectiveNginxConfig(
            conn,
            instance,
            config,
            (warning) => emit({ stage: 'packing', message: warning })
          );
          if (effectiveContent) {
            whitelist = resolveNginxArchiveWhitelist(effectiveContent, {
              prefix: config.installRoot || path.dirname(config.mainConfPath),
              confDir: path.dirname(config.mainConfPath),
            });
          }
          const whitelistMsg = whitelist.length > 0
            ? `已放行 ${whitelist.length} 个点文件与配置引用`
            : '已排除隐藏文件（无点文件引用）';
          emit({ stage: 'packing', message: whitelistMsg });
          console.log(`[nginx-archive] 直存本地白名单 (${whitelist.length} 项): ${whitelist.join(', ') || '(无点文件引用)'}`);
        }
        const archiveOptions = { whitelist, includeHidden };

        const command = isManaged
          ? buildArchiveTarCommand(config, archiveRoot, type, archiveOptions)
          : buildExternalArchiveTarCommand(config, config.webRoot ? [config.webRoot] : [], type, '', archiveOptions);
        await runArchiveStream(
          command,
          isManaged ? `导出托管 Nginx 运行包(${type})` : `导出已有 Nginx 配置/站点(${type})`,
          '远程打包仍在运行'
        );
      }
      
      progressStream.end();
      await fileWritePromise;
      emit({ stage: 'finished', message: '运行包已保存到本地磁盘', loaded });
    } catch (err) {
      progressStream.destroy(err);
      fileStream.destroy();
      throw err;
    }
  });

  return meta;
}

// ──────────────────────────────────────────────
// 导出：端口管理
// ──────────────────────────────────────────────

/**
 * 获取服务器下一个可用托管站点端口。
 * @param {number} serverId - 服务器 ID
 * @param {number} excludeTargetId - 排除目标 ID
 * @returns {Promise<Object>} 端口信息
 */
export async function getNextNginxRuntimePort(serverId, excludeTargetId = 0) {
  const port = await resolveNextManagedListenPort(serverId, excludeTargetId);
  return { port };
}

/**
 * 获取 Nginx 实例下一个可用托管站点端口。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {number} excludeTargetId - 排除目标 ID
 * @returns {Promise<Object>} 端口信息
 */
export async function getNextNginxInstancePort(instanceId, excludeTargetId = 0) {
  const port = await resolveNextManagedListenPortByInstance(instanceId, excludeTargetId);
  return { port };
}

// ──────────────────────────────────────────────
// 导出：站点配置同步
// ──────────────────────────────────────────────

/**
 * 同步部署目标托管站点配置。
 * @param {number} targetId - 部署目标 ID
 * @returns {Promise<Object>} 同步结果
 */
export async function syncTargetNginxSite(targetId, options = {}) {
  const force = Boolean(options.force);
  const expectedSha256 = options.expectedSha256 ? String(options.expectedSha256).toLowerCase() : null;
  if (force && !expectedSha256) {
    const badRequestError = new Error('强制覆盖站点配置必须提供 expectedSha256 哈希校验值');
    badRequestError.statusCode = 400;
    badRequestError.code = 'INVALID_ARGUMENT';
    throw badRequestError;
  }
  const target = await getTarget(targetId);
  if (!target) throw new Error('部署目标不存在');
  if (!target.nginxSiteManaged) throw new Error('当前部署目标未启用托管 Nginx 站点');
  const server = await getServerWithCredential(target.serverId);
  if (!server) throw new Error('部署服务器不存在');
  const { instance } = await getNginxInstanceContext(target.nginxInstanceId);
  if (!instance) throw new Error('未关联有效的 Nginx 实例');
  if (instance.instanceType !== 'managed') {
    throw new Error('只有托管 Nginx 实例支持同步站点配置；已有实例请直接通过“Nginx 配置”在线编辑');
  }

  const effectiveUseSudo = Boolean(instance?.useSudo || server?.useSudo);
  const effectiveInstance = { ...instance, useSudo: effectiveUseSudo };
  const effectiveServer = { ...server, useSudo: effectiveUseSudo };
  const sudo = effectiveUseSudo ? 'sudo -n ' : '';

  const config = resolveRuntimeConfig(instance);
  const sitePath = resolveTargetSitePath(target, config);

  if (!isManagedMainConfPath(sitePath, config)) {
    const normalizedSiteDir = path.posix.normalize(path.posix.dirname(sitePath));
    const normalizedSitesDir = path.posix.normalize(config.sitesDir || '');
    if (!normalizedSitesDir || (normalizedSiteDir !== normalizedSitesDir && !normalizedSiteDir.startsWith(`${normalizedSitesDir}/`))) {
      throw new Error(`安全拦截：托管站点配置文件路径（${sitePath}）超出托管实例 sitesDir（${config.sitesDir}）目录范围`);
    }
  }

  return withSsh(effectiveServer, async (conn) => {
    if (isManagedMainConfPath(sitePath, config)) {
      await execSsh(conn, `${sudo}mkdir -p ${shellQuote(target.deployRoot)}`, {
        label: '创建主应用部署目录',
      });
      if (instance.instanceType === 'managed') {
        await ensureManagedScriptCurrent(conn, server, resolveRuntimeConfig(effectiveInstance));
      }
      const testResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, effectiveInstance, 'test') : await execExternalInstanceAction(conn, effectiveInstance, 'test');
      const reloadResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, effectiveInstance, 'reload') : await execExternalInstanceAction(conn, effectiveInstance, 'reload');
      return {
        success: true,
        requireDiffConfirm: false,
        path: sitePath,
        backupPath: '',
        skipped: false,
        testOutput: `${testResult.stdout || ''}${testResult.stderr || ''}`.trim(),
        reloadOutput: `${reloadResult.stdout || ''}${reloadResult.stderr || ''}`.trim(),
      };
    }
    const generatedBody = renderSiteConfigBody(target);
    const siteConfig = attachManagedHeader(generatedBody, target.id);
    const existingResult = await execSsh(conn, `${sudo}test -f ${shellQuote(sitePath)}`, {
      label: '检查站点配置是否存在',
      allowFailure: true,
    });
    let fileExists = false;
    if (existingResult.code === 0) {
      fileExists = true;
    } else if (existingResult.code === 1) {
      fileExists = false;
    } else {
      const errorMsg = (existingResult.stderr || existingResult.stdout || '').trim() || '未知命令执行错误';
      throw new Error(`检查配置文件是否存在失败（退出码 ${existingResult.code}）：${errorMsg}`);
    }

    let existingContent = '';
    if (fileExists) {
      existingContent = await readRemoteText(conn, effectiveServer, sitePath);
      const inspection = inspectNginxConfigManagedState(existingContent, target, generatedBody);
      if (!inspection.canAutoOverwrite && !force) {
        const conflictError = new Error(inspection.reason || '配置文件存在手工修改或未被平台接管，需确认覆盖接管');
        conflictError.statusCode = 409;
        conflictError.code = 'NGINX_SITE_CONFLICT';
        conflictError.details = {
          path: sitePath,
          currentContent: existingContent,
          generatedContent: siteConfig,
          currentSha256: inspection.currentSha256 || computeConfigBodySha256(existingContent),
          reason: inspection.reason,
        };
        throw conflictError;
      }
      if (force) {
        const actualSha = computeConfigBodySha256(existingContent);
        if (actualSha !== expectedSha256) {
          const raceError = new Error('远程配置文件在预览后已被修改，请重新对比差异后再接管覆盖');
          raceError.statusCode = 409;
          raceError.code = 'NGINX_SITE_CONFLICT';
          raceError.details = {
            path: sitePath,
            currentContent: existingContent,
            generatedContent: siteConfig,
            currentSha256: actualSha,
            reason: '远程配置文件已发生并发改动',
          };
          throw raceError;
        }
      }
    }
    await execSsh(conn, `${sudo}mkdir -p ${shellQuote(path.posix.dirname(sitePath))} ${shellQuote(target.deployRoot)}`, {
      label: '创建站点目录',
    });
    const { backupPath = '', skipped = false } = await writeRemoteTextWithBackup(conn, effectiveServer, sitePath, siteConfig);
    try {
      if (instance.instanceType === 'managed') {
        await ensureManagedScriptCurrent(conn, server, resolveRuntimeConfig(effectiveInstance));
      }
      const testResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, effectiveInstance, 'test') : await execExternalInstanceAction(conn, effectiveInstance, 'test');
      const reloadResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, effectiveInstance, 'reload') : await execExternalInstanceAction(conn, effectiveInstance, 'reload');
      return {
        success: true,
        requireDiffConfirm: false,
        path: sitePath,
        backupPath: fileExists ? backupPath : '',
        skipped,
        testOutput: `${testResult.stdout || ''}${testResult.stderr || ''}`.trim(),
        reloadOutput: `${reloadResult.stdout || ''}${reloadResult.stderr || ''}`.trim(),
      };
    } catch (error) {
      if (fileExists && backupPath) {
        await execSsh(conn, `${sudo}cp ${shellQuote(backupPath)} ${shellQuote(sitePath)}`, {
          label: '恢复站点配置备份',
          allowFailure: true,
        });
      } else if (!fileExists) {
        await execSsh(conn, `${sudo}rm -f ${shellQuote(sitePath)}`, {
          label: '清理失败站点配置',
          allowFailure: true,
        });
      } else {
        console.warn('[syncTargetNginxSite] 站点配置回滚跳过：原文件存在但备份路径为空，不执行覆盖恢复或删除');
      }
      throw error;
    }
  });
}
