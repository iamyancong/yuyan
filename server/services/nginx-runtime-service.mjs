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
  resolveNextManagedListenPortByInstance,
  resolveNextManagedListenPort,
  updateNginxInstance,
  updateNginxInstanceState,
  updateNginxRuntimeState,
  upsertNginxRuntime,
} from './deploy-store.mjs';
import {
  execSsh,
  shellQuote,
  streamSshCommand,
  uploadFile,
  withSsh,
  writeRemoteTextWithBackup,
} from './ssh-service.mjs';

/** 托管运行时支持的系统 */
const SUPPORTED_PLATFORM = 'Linux';

/** 托管运行时支持的架构 */
const SUPPORTED_ARCHES = new Set(['x86_64', 'amd64']);

/** Nginx 运行时操作 */
const RUNTIME_ACTIONS = new Set(['test', 'start', 'stop', 'reload', 'status']);

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
function buildArchiveFileName(server, instance, type = 'all') {
  if (type === 'conf') {
    return 'nginx.conf';
  }
  const serverName = sanitizeArchiveFilePart(server?.name || server?.host, `server-${server?.id || 'unknown'}`);
  const instanceName = sanitizeArchiveFilePart(instance?.name, `nginx-${instance?.id || 'instance'}`);
  const suffix = type === 'html' ? '-html' : '';
  return `${serverName}-${instanceName}${suffix}-${formatArchiveTimestamp()}.tar.gz`;
}

/**
 * 把绝对根目录转换为 tar 内相对路径。
 * @param {string} baseRoot - 运行时根目录
 * @returns {string} tar 内路径
 */
function resolveArchiveRoot(baseRoot) {
  const normalized = path.posix.normalize(String(baseRoot || '').trim().replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!normalized || normalized === '/' || !normalized.startsWith('/')) {
    throw new Error('托管 Nginx 根目录无效，无法导出运行包');
  }
  const archiveRoot = normalized.replace(/^\/+/, '');
  if (!archiveRoot || archiveRoot === '.' || archiveRoot.startsWith('../')) {
    throw new Error('托管 Nginx 根目录无效，无法导出运行包');
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
 * 构建运行包 tar 流式导出命令。
 * @param {Object} config - 运行时配置
 * @param {string} archiveRoot - tar 内相对根路径
 * @param {string} type - 下载类型 ('all' | 'html')
 * @returns {string} tar 命令
 */
export function buildArchiveTarCommand(config, archiveRoot, type = 'all') {
  const sudo = config.useSudo ? 'sudo -n ' : '';
  const excludePatterns = [...ARCHIVE_EXCLUDE_PATTERNS];
  if (type === 'all') {
    excludePatterns.push(
      ...ARCHIVE_EXCLUDE_DIRS.flatMap((dir) => [`${archiveRoot}/nginx/${dir}`, `${archiveRoot}/nginx/${dir}/*`])
    );
  }
  return `${sudo}tar -czf - -C / ${buildArchiveExcludeArgs(excludePatterns)} ${shellQuote(archiveRoot)}`;
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
 * 渲染托管 Nginx 主配置。
 * @param {Object} config - 运行时配置
 * @returns {string} nginx.conf 内容
 */
function renderMainNginxConfig(config) {
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
 * 渲染用户级 Nginx 管理脚本。
 * @returns {string} 脚本内容
 */
function renderRuntimeScript() {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'ACTION="${1:-help}"',
    'BASE_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'NGINX="$BASE_DIR/sbin/nginx"',
    'CONF="$BASE_DIR/conf/nginx.conf"',
    'PID="$BASE_DIR/run/nginx.pid"',
    '',
    'is_running() {',
    '  [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null',
    '}',
    '',
    'case "$ACTION" in',
    '  start)',
    '    if is_running; then',
    '      echo "yuyan nginx already running: $(cat "$PID")"',
    '      exit 0',
    '    fi',
    '    "$NGINX" -p "$BASE_DIR/" -c "$CONF"',
    '    echo "yuyan nginx started"',
    '    ;;',
    '  stop)',
    '    if is_running; then',
    '      "$NGINX" -p "$BASE_DIR/" -c "$CONF" -s quit',
    '      echo "yuyan nginx stopped"',
    '    else',
    '      echo "yuyan nginx not running"',
    '    fi',
    '    ;;',
    '  reload)',
    '    "$NGINX" -p "$BASE_DIR/" -c "$CONF" -t',
    '    if is_running; then',
    '      "$NGINX" -p "$BASE_DIR/" -c "$CONF" -s reload',
    '      echo "yuyan nginx reloaded"',
    '    else',
    '      "$NGINX" -p "$BASE_DIR/" -c "$CONF"',
    '      echo "yuyan nginx started"',
    '    fi',
    '    ;;',
    '  test)',
    '    "$NGINX" -p "$BASE_DIR/" -c "$CONF" -t',
    '    ;;',
    '  status)',
    '    if is_running; then',
    '      echo "running: $(cat "$PID")"',
    '    else',
    '      echo "stopped"',
    '      exit 3',
    '    fi',
    '    ;;',
    '  help|*)',
    '    echo "用法: $0 {start|stop|reload|test|status}"',
    '    ;;',
    'esac',
    '',
  ].join('\n');
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
function renderSiteConfig(target) {
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
    '    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|eot|json|txt)$ {',
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
    '',
  ].join('\n');
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
  const { instance, initialized, running, status, statusOutput, platform, manifest, manifests, config } = params;
  return {
    runtime: instance || null,
    initialized,
    running,
    status,
    statusOutput,
    platform: platform || '',
    manifest,
    manifests,
    version: instance?.runtimeVersion || '',
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
export async function getNginxInstanceStatus(instanceId) {
  const { instance, server } = await getNginxInstanceContext(instanceId);
  const manifests = await listAvailableManifests();
  const manifest = manifests[0] || null;
  const config = resolveRuntimeConfig(instance);
  if (instance.instanceType !== 'managed') {
    return createRuntimeStatusResponse({
      instance,
      initialized: true,
      running: instance.status === 'running',
      status: instance.status || 'unknown',
      statusOutput: instance.statusOutput || '',
      platform: '',
      manifest,
      manifests,
      config,
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
    const statusResult = await execRuntimeScript(conn, instance, 'status').catch((error) => ({
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
    }));
    const fileText = fileResult.stdout || '';
    const initialized = fileText.includes('nginx=1') && fileText.includes('script=1') && fileText.includes('conf=1');
    const status = initialized ? (statusResult.code === 0 ? 'running' : 'stopped') : 'uninitialized';
    await updateNginxInstanceState(instance.id, {
      status,
      statusOutput: `${statusResult.stdout || ''}${statusResult.stderr || ''}`.trim(),
    });
    return createRuntimeStatusResponse({
      instance: { ...instance, status, statusOutput: `${statusResult.stdout || ''}${statusResult.stderr || ''}`.trim() },
      initialized,
      running: statusResult.code === 0,
      status,
      statusOutput: `${statusResult.stdout || ''}${statusResult.stderr || ''}`.trim(),
      platform: platformResult.stdout.trim().replace(/\s+/g, ' '),
      manifest,
      manifests,
      config,
    });
  });
}

// ──────────────────────────────────────────────
// 导出：状态查询
// ──────────────────────────────────────────────

/**
 * 获取服务器托管 Nginx 运行时状态。
 * @param {number} serverId - 服务器 ID
 * @returns {Promise<Object>} 状态
 */
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
 * 初始化指定托管 Nginx 实例。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} payload - 初始化参数
 * @param {Object} emit - 进度输出器
 * @returns {Promise<Object>} 初始化结果
 */
export async function initializeNginxInstanceRuntime(instanceId, payload = {}, emit = {}) {
  await updateNginxInstance(instanceId, {
    ...payload,
    instanceType: 'managed',
  });
  const { instance, server } = await getNginxInstanceContext(instanceId);
  if (instance.instanceType !== 'managed') throw new Error('只有托管 Nginx 实例支持初始化');
  const config = resolveRuntimeConfig(instance);

  await withSsh(server, async (conn) => {
    // ── 阶段 1：校验平台 ──
    emit.stage?.('validate', 5, '校验服务器平台', '');
    const platform = await assertRemotePlatform(conn);
    emit.log?.('success', `服务器架构校验通过：${platform}`, 'validate');

    // ── 阶段 2：探测运行时环境 ──
    emit.stage?.('detect', 10, '探测服务器运行时环境', '');
    const { glibcVersion, hasXcrypt, summary } = await detectRemoteEnvironment(conn);
    emit.log?.('info', `服务器环境：${summary}`, 'detect');

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
        `rm -f ${shellQuote(remotePackagePath)}`,
      ].join(' && '),
      { label: '解压托管 Nginx 运行时' }
    );

    // ── 阶段 7：配置 ──
    emit.stage?.('configure', 70, '生成 Nginx 主配置和管理脚本', config.mainConfPath);
    await execSsh(conn, `${config.useSudo ? 'sudo -n ' : ''}mkdir -p ${shellQuote(config.sitesDir)} ${shellQuote(config.webRoot)}`, {
      label: '创建托管 Nginx 目录',
    });
    await writeRemoteTextWithBackup(conn, { ...server, useSudo: config.useSudo }, config.mainConfPath, renderMainNginxConfig(config));
    await writeRemoteTextWithBackup(conn, { ...server, useSudo: config.useSudo }, config.scriptPath, renderRuntimeScript());
    await execSsh(conn, `${config.useSudo ? 'sudo -n ' : ''}chmod +x ${shellQuote(config.scriptPath)}`, { label: '设置管理脚本权限' });

    // ── 阶段 8：校验配置 ──
    emit.stage?.('test', 85, '校验 Nginx 配置', config.scriptPath);
    const testResult = await execRuntimeScript(conn, instance, 'test');
    emit.log?.('success', `${testResult.stderr || testResult.stdout}`.trim() || 'nginx -t 校验通过', 'test');

    // ── 阶段 9：启动 ──
    emit.stage?.('start', 95, '启动托管 Nginx', config.scriptPath);
    const statusResult = await execRuntimeScript(conn, instance, 'status');
    const action = statusResult.code === 0 ? 'reload' : 'start';
    const startResult = await execRuntimeScript(conn, instance, action);
    emit.log?.('success', `${startResult.stdout || startResult.stderr}`.trim() || `托管 Nginx 已${action === 'reload' ? '重载' : '启动'}`, 'start');

    // ── 更新 DB 状态（包含变体信息）──
    await updateNginxInstanceState(instance.id, {
      runtimeVersion: manifest.version,
      packageSha256: manifest.sha256,
      packageVariant: variant.id,
      status: 'running',
      initializedAt: new Date().toISOString(),
    });
  });

  emit.stage?.('finish', 100, '初始化完成', config.installRoot);
  return getNginxInstanceStatus(instance.id);
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
  const { instance, server } = await getNginxInstanceContext(instanceId);
  return withSsh(server, async (conn) => {
    const result = instance.instanceType === 'managed'
      ? await execRuntimeScript(conn, instance, action)
      : await execExternalInstanceAction(conn, instance, action);
    const status =
      action === 'stop' && result.code === 0
        ? 'stopped'
        : action === 'start' || action === 'reload'
          ? 'running'
          : result.code === 0
            ? 'running'
            : 'error';
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
}

/**
 * 流式导出托管 Nginx 实例运行包。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {string} type - 下载类型 ('all' | 'html' | 'conf')
 * @param {import('node:stream').Writable} output - 输出流
 * @param {(meta: Object) => void} onReady - 响应头准备回调
 * @returns {Promise<Object>} 导出元信息
 */
export async function streamNginxInstanceArchive(instanceId, type = 'all', output, onReady) {
  const { instance, server } = await getNginxInstanceContext(instanceId);
  if (instance.instanceType !== 'managed') throw new Error('只有托管 Nginx 实例支持下载运行包');

  const config = resolveRuntimeConfig(instance);
  
  let archiveRoot = '';
  if (type === 'html') {
    archiveRoot = resolveArchiveRoot(config.webRoot);
  } else if (type !== 'conf') {
    archiveRoot = resolveArchiveRoot(config.baseRoot);
  }

  const fileName = buildArchiveFileName(server, instance, type);
  const meta = {
    fileName,
    baseRoot: config.baseRoot,
    scriptPath: config.scriptPath,
  };

  const archiveStream = new PassThrough();
  archiveStream.pipe(output);

  // 监听 output 的结束事件，用于等待网络传输完成
  const outputFinished = new Promise((resolve) => {
    output.once('finish', resolve);
    output.once('close', resolve);
  });

  await withSsh(server, async (conn) => {
    await execSsh(conn, buildArchivePrecheckCommand(config, type), { label: `预检托管 Nginx 运行包(${type})` });
    onReady?.(meta);
    if (type === 'conf') {
      const sudo = config.useSudo ? 'sudo -n ' : '';
      await streamSshCommand(conn, `${sudo}cat ${shellQuote(config.mainConfPath)}`, archiveStream, {
        label: '导出 Nginx 配置文件',
      });
    } else {
      await streamSshCommand(conn, buildArchiveTarCommand(config, archiveRoot, type), archiveStream, {
        label: `导出托管 Nginx 运行包(${type})`,
      });
    }
    
    // 数据推送完毕，发送结束符并等待管道数据全数写入网络
    archiveStream.end();
    await outputFinished;
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
export async function saveNginxInstanceArchiveToPath(instanceId, type = 'all', filePath, onEvent, isAbortedFn) {
  const emit = (event) => {
    if (!isAbortedFn?.()) onEvent?.(event);
  };

  emit({ stage: 'preparing', message: '正在准备下载任务' });
  const { instance, server } = await getNginxInstanceContext(instanceId);
  if (instance.instanceType !== 'managed') throw new Error('只有托管 Nginx 实例支持下载运行包');

  const config = resolveRuntimeConfig(instance);
  
  let archiveRoot = '';
  if (type === 'html') {
    archiveRoot = resolveArchiveRoot(config.webRoot);
  } else if (type !== 'conf') {
    archiveRoot = resolveArchiveRoot(config.baseRoot);
  }

  const fileName = buildArchiveFileName(server, instance, type);
  const meta = {
    fileName,
    baseRoot: config.baseRoot,
    scriptPath: config.scriptPath,
  };

  await withSsh(server, async (conn) => {
    emit({ stage: 'prechecking', message: '正在校验远程运行包依赖与路径' });
    await execSsh(conn, buildArchivePrecheckCommand(config, type), { label: `预检托管 Nginx 运行包(${type})` });
    
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
        await runArchiveStream(
          buildArchiveTarCommand(config, archiveRoot, type),
          `导出托管 Nginx 运行包(${type})`,
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
export async function syncTargetNginxSite(targetId) {
  const target = await getTarget(targetId);
  if (!target) throw new Error('部署目标不存在');
  if (!target.nginxSiteManaged) throw new Error('当前部署目标未启用托管 Nginx 站点');
  const server = await getServerWithCredential(target.serverId);
  if (!server) throw new Error('部署服务器不存在');
  const { instance } = await getNginxInstanceContext(target.nginxInstanceId);

  const config = resolveRuntimeConfig(instance);
  const sitePath = resolveTargetSitePath(target, config);
  return withSsh(server, async (conn) => {
    if (isManagedMainConfPath(sitePath, config)) {
      await execSsh(conn, `${instance.useSudo ? 'sudo -n ' : ''}mkdir -p ${shellQuote(target.deployRoot)}`, {
        label: '创建主应用部署目录',
      });
      const testResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, instance, 'test') : await execExternalInstanceAction(conn, instance, 'test');
      const reloadResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, instance, 'reload') : await execExternalInstanceAction(conn, instance, 'reload');
      return {
        success: true,
        path: sitePath,
        backupPath: '',
        testOutput: `${testResult.stdout || ''}${testResult.stderr || ''}`.trim(),
        reloadOutput: `${reloadResult.stdout || ''}${reloadResult.stderr || ''}`.trim(),
      };
    }
    const siteConfig = renderSiteConfig(target);
    const existingResult = await execSsh(conn, `[ -f ${shellQuote(sitePath)} ]`, {
      label: '检查站点配置是否存在',
      allowFailure: true,
    });
    await execSsh(conn, `${instance.useSudo ? 'sudo -n ' : ''}mkdir -p ${shellQuote(path.posix.dirname(sitePath))} ${shellQuote(target.deployRoot)}`, {
      label: '创建站点目录',
    });
    const { backupPath } = await writeRemoteTextWithBackup(conn, { ...server, useSudo: instance.useSudo }, sitePath, siteConfig);
    try {
      const testResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, instance, 'test') : await execExternalInstanceAction(conn, instance, 'test');
      const reloadResult = instance.instanceType === 'managed' ? await execRuntimeScript(conn, instance, 'reload') : await execExternalInstanceAction(conn, instance, 'reload');
      return {
        success: true,
        path: sitePath,
        backupPath: existingResult.code === 0 ? backupPath : '',
        testOutput: `${testResult.stdout || ''}${testResult.stderr || ''}`.trim(),
        reloadOutput: `${reloadResult.stdout || ''}${reloadResult.stderr || ''}`.trim(),
      };
    } catch (error) {
      const sudo = instance.useSudo ? 'sudo -n ' : '';
      if (existingResult.code === 0) {
        await execSsh(conn, `${sudo}cp ${shellQuote(backupPath)} ${shellQuote(sitePath)}`, {
          label: '恢复站点配置备份',
          allowFailure: true,
        });
      } else {
        await execSsh(conn, `${sudo}rm -f ${shellQuote(sitePath)}`, {
          label: '清理失败站点配置',
          allowFailure: true,
        });
      }
      throw error;
    }
  });
}
