/**
 * 后端部署领域规则
 * @description 提供 Java 版本、路径、服务名、日志脱敏和运行参数校验等无副作用能力。
 */

import path from 'node:path';

/** 后端服务角色 */
export const BACKEND_SERVICE_ROLES = new Set(['application', 'gateway']);

/** 后端进程管理模式 */
export const BACKEND_PROCESS_MODES = new Set(['systemd', 'pid', 'legacy']);

/** OpenAPI 文件最大字节数 */
export const OPENAPI_MAX_BYTES = 20 * 1024 * 1024;

/** 默认后端停止超时秒数 */
export const DEFAULT_BACKEND_STOP_TIMEOUT_SECONDS = 30;

/** 默认后端启动健康等待秒数 */
export const DEFAULT_BACKEND_STARTUP_TIMEOUT_SECONDS = 120;

/** 默认远程版本保留数量 */
export const DEFAULT_BACKEND_RELEASE_KEEP = 8;

/**
 * 解析 Java major 版本。
 * @param {string} text java -version 或版本字符串
 * @returns {number} major 版本，无法识别时返回 0
 */
export function parseJavaMajorVersion(text) {
  const value = String(text || '');
  const matched = value.match(/(?:java|openjdk)?\s*version\s*["']?([^"'\s]+)/i) || value.match(/\b(1\.\d+|\d+)(?:[._+-]\d+)?/);
  if (!matched) return 0;
  const version = matched[1] || matched[0];
  const parts = String(version).replace(/^[^\d]*/, '').split(/[._+-]/).filter(Boolean);
  if (!parts.length) return 0;
  if (parts[0] === '1' && parts[1]) return Number(parts[1]) || 0;
  return Number(parts[0]) || 0;
}

/**
 * 生成安全稳定的服务名。
 * @param {string} value 原始项目或服务名
 * @returns {string} 仅包含小写字母、数字和连字符的服务名
 */
export function normalizeBackendServiceName(value) {
  return String(value || 'backend-service')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'backend-service';
}

/**
 * 将 JVM/应用参数解析为参数数组，后续必须逐项 shellQuote 后执行。
 * @param {string} value 参数文本
 * @param {string} label 字段名称
 * @returns {string[]} 参数数组
 */
export function parseRuntimeArguments(value, label = '运行参数') {
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (/[\r\n\0]/.test(raw)) throw new Error(`${label}不能包含换行或空字节`);
  const result = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped || quote) throw new Error(`${label}存在未闭合的引号或转义符`);
  if (current) result.push(current);
  return result;
}

/** 校验只允许单行保存的后端配置值。 */
function normalizeSingleLine(value, label) {
  const normalized = String(value || '').trim();
  if (/[\r\n\0]/.test(normalized)) throw new Error(`${label}不能包含换行或空字节`);
  return normalized;
}

/** 校验并保留运行参数原始文本。 */
function normalizeRuntimeArgumentText(value, label) {
  const normalized = String(value || '').trim();
  parseRuntimeArguments(normalized, label);
  return normalized;
}

/**
 * 校验仓库内相对路径。
 * @param {string} value 路径或 glob
 * @param {string} label 字段名称
 * @param {{allowGlob?: boolean, required?: boolean}} options 校验选项
 * @returns {string} 标准化路径
 */
export function validateRepositoryRelativePath(value, label, options = {}) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) {
    if (options.required !== false) throw new Error(`${label}不能为空`);
    return '';
  }
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) throw new Error(`${label}必须使用仓库内相对路径`);
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`${label}不能跳出仓库目录`);
  if (!options.allowGlob && /[*?\[\]{}]/.test(normalized)) throw new Error(`${label}不能包含通配符`);
  return normalized.replace(/^\.\//, '');
}

/**
 * 校验远程部署根目录。
 * @param {string} value 部署根目录
 * @param {string} allowedRoot 服务器允许的后端根目录
 * @returns {string} 标准化绝对目录
 */
export function validateBackendDeployRoot(value, allowedRoot = '') {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || !path.posix.isAbsolute(raw)) throw new Error('后端部署根目录必须使用服务器绝对路径');
  const normalized = path.posix.normalize(raw).replace(/\/+$/, '');
  if (normalized === '/' || normalized === '/home' || normalized === '/opt') throw new Error('后端部署根目录范围过大，请使用独立项目目录');
  if (normalized.includes('\n') || normalized.includes('\r')) throw new Error('后端部署根目录不能包含换行');
  const root = String(allowedRoot || '').trim() ? path.posix.normalize(String(allowedRoot).trim()).replace(/\/+$/, '') : '';
  if (root && normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`后端部署根目录必须位于服务器后端根目录 ${root} 下`);
  }
  return normalized;
}

/**
 * 解析并校验服务端口。
 * @param {unknown} value 端口值
 * @param {{useSudo?: boolean, required?: boolean}} options 校验选项
 * @returns {number} 端口，未要求且为空时返回 0
 */
export function validateBackendServerPort(value, options = {}) {
  const port = Number(value || 0);
  if (!port && options.required === false) return 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('后端服务端口必须在 1-65535 之间');
  if (port < 1024 && !options.useSudo) throw new Error('1024 以下端口需要服务器开启授权模式');
  return port;
}

/**
 * 标准化健康检查路径。
 * @param {string} value 路径或历史 URL
 * @returns {string} 仅保留 path/query 的健康检查路径
 */
export function normalizeHealthCheckPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '/actuator/health';
  try {
    const url = new URL(raw);
    return `${url.pathname || '/'}${url.search || ''}`;
  } catch {
    const normalized = raw.startsWith('/') ? raw : `/${raw}`;
    if (/\s/.test(normalized) || normalized.includes('..')) throw new Error('健康检查路径不合法');
    return normalized;
  }
}

/**
 * 将敏感信息从日志中脱敏。
 * @param {string} value 原始日志
 * @returns {string} 脱敏日志
 */
export function redactDeployLog(value) {
  return String(value || '')
    .replace(/(authorization\s*[=:]\s*)([^\r\n]+)/gi, '$1***')
    .replace(/((?:password|passwd|token|secret|authorization|appToken|access[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi, '$1***')
    .replace(/(https?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/g, '$1***$3')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1***');
}

/**
 * 校验 OpenAPI JSON 内容。
 * @param {string|Buffer} content OpenAPI 内容
 * @returns {{json: Object, pretty: string, size: number}} 校验结果
 */
export function validateOpenApiContent(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
  if (!buffer.length) throw new Error('OpenAPI 输出文件为空');
  if (buffer.length > OPENAPI_MAX_BYTES) throw new Error('OpenAPI 文件超过 20MB，已拒绝预览和缓存');
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('OpenAPI 输出不是合法 JSON');
  }
  if (!json || typeof json !== 'object' || (!json.openapi && !json.swagger) || !json.paths || typeof json.paths !== 'object') {
    throw new Error('OpenAPI 文件缺少 openapi/swagger 版本或 paths 对象');
  }
  const pretty = `${JSON.stringify(json, null, 2)}\n`;
  return { json, pretty, size: Buffer.byteLength(pretty) };
}

/**
 * 规范化后端配置。
 * @param {Object} payload 部署目标参数
 * @param {Object} server 服务器配置
 * @returns {Object} 后端配置
 */
export function normalizeBackendConfig(payload, server = {}) {
  const processMode = BACKEND_PROCESS_MODES.has(payload.processMode) ? payload.processMode : 'pid';
  const serviceRole = BACKEND_SERVICE_ROLES.has(payload.serviceRole) ? payload.serviceRole : 'application';
  return {
    environmentId: Number(payload.environmentId || 0),
    serviceRole,
    serviceName: normalizeBackendServiceName(payload.serviceName || payload.projectName),
    buildJdkId: Number(payload.buildJdkId || payload.jdkId || 0),
    serverJavaRuntimeId: Number(payload.serverJavaRuntimeId || 0),
    runtimeJavaHome: normalizeSingleLine(payload.runtimeJavaHome, '服务器 JAVA_HOME'),
    runtimeJavaVersion: normalizeSingleLine(payload.runtimeJavaVersion, '服务器 Java 版本'),
    serverPort: validateBackendServerPort(payload.serverPort || 0, { useSudo: Boolean(server.useSudo), required: true }),
    springProfiles: normalizeSingleLine(payload.springProfiles, 'Spring Profiles'),
    externalConfigPath: normalizeSingleLine(payload.externalConfigPath, '外部配置路径'),
    jvmOptions: normalizeRuntimeArgumentText(payload.jvmOptions, 'JVM 参数'),
    appArgs: normalizeRuntimeArgumentText(payload.appArgs, '应用参数'),
    processMode,
    stopTimeoutSeconds: Math.min(300, Math.max(5, Number(payload.stopTimeoutSeconds || DEFAULT_BACKEND_STOP_TIMEOUT_SECONDS))),
    startupTimeoutSeconds: Math.min(900, Math.max(10, Number(payload.startupTimeoutSeconds || DEFAULT_BACKEND_STARTUP_TIMEOUT_SECONDS))),
    healthCheckPath: normalizeHealthCheckPath(payload.healthCheckPath || payload.healthCheckUrl),
    nacosServerAddr: normalizeSingleLine(payload.nacosServerAddr, 'Nacos 地址'),
    nacosConsoleUrl: normalizeSingleLine(payload.nacosConsoleUrl, 'Nacos 控制台'),
    nacosNamespace: normalizeSingleLine(payload.nacosNamespace, 'Nacos Namespace'),
    nacosGroup: normalizeSingleLine(payload.nacosGroup, 'Nacos Group'),
    requireNacosRegistration: Boolean(payload.requireNacosRegistration),
    gatewayUrl: normalizeSingleLine(payload.gatewayUrl, 'Gateway 地址'),
    gatewayProbePath: normalizeSingleLine(payload.gatewayProbePath, 'Gateway 探测路径'),
    artifactPattern: validateRepositoryRelativePath(payload.artifactPattern || payload.artifactDir, 'Jar 产物路径', { allowGlob: true }),
    openapiCommand: String(payload.openapiCommand || '').trim(),
    openapiOutputPath: validateRepositoryRelativePath(payload.openapiOutputPath || '', 'OpenAPI 输出路径', { required: false }),
    legacyStartCommand: String(payload.startCommand || payload.legacyStartCommand || '').trim(),
    legacyStopCommand: String(payload.stopCommand || payload.legacyStopCommand || '').trim(),
    needsReview: processMode === 'legacy' || Boolean(payload.needsReview),
  };
}
