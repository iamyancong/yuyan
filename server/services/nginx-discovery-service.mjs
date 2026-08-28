/**
 * 宿主机已有 Nginx 智能发现服务。
 * @description 仅执行进程读取、配置测试展开和目录存在性检查，不修改配置、不发送 reload 信号。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { getServerWithCredential } from './deploy-store.mjs';
import { execSsh, shellQuote, withSsh } from './ssh-service.mjs';
import {
  normalizeNginxArchivePath,
  tokenizeNginxConfig,
} from './nginx-archive-selection.mjs';

/** 最多检查的 Nginx 运行实例数量。 */
const MAX_RUNTIME_CANDIDATES = 12;

/** 最多返回的 server 站点数量。 */
const MAX_DISCOVERED_SITES = 200;

/** 同时检查的 Nginx 运行实例数量。 */
const RUNTIME_INSPECTION_CONCURRENCY = 3;

/** 单次扫描总预算。 */
const SCAN_BUDGET_MS = 60_000;

/** 单次 Nginx 配置展开的最大输出。 */
const MAX_NGINX_DUMP_BYTES = 4 * 1024 * 1024;

/** 诊断原始详情最大长度。 */
const MAX_DIAGNOSTIC_DETAIL_LENGTH = 1_200;

/** 常见宿主机 Nginx 二进制路径。 */
const COMMON_NGINX_BINARIES = [
  '/usr/sbin/nginx',
  '/usr/local/nginx/sbin/nginx',
  '/usr/local/openresty/nginx/sbin/nginx',
  '/opt/nginx/sbin/nginx',
  '/opt/openresty/nginx/sbin/nginx',
  '/home/nginx/sbin/nginx',
];

/**
 * 将 shell 命令文本拆成不执行插值的参数列表。
 * @param {string} commandText - 进程命令文本
 * @returns {string[]} 参数列表
 */
export function splitShellWords(commandText) {
  const words = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of String(commandText || '')) {
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
      if (current) words.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (current) words.push(current);
  return words;
}

/**
 * 读取命令行短参数值。
 * @param {string[]} args - 命令参数
 * @param {string} option - 参数名
 * @returns {string} 参数值
 */
function readShortOption(args, option) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '');
    if (value === option) return String(args[index + 1] || '');
    if (value.startsWith(option) && value.length > option.length) return value.slice(option.length);
  }
  return '';
}

/**
 * 解析 Nginx master 进程列表。
 * @param {string} output - ps 输出
 * @returns {Array<{pid: number, user: string, binary: string, prefix: string, configPath: string, command: string}>} 运行实例线索
 */
export function parseNginxMasterProcesses(output) {
  const processes = [];
  String(output || '').split(/\r?\n/).forEach((line) => {
    const marker = 'nginx: master process';
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) return;
    const fields = line.slice(0, markerIndex).trim().split(/\s+/).filter(Boolean);
    const pidFirst = /^\d+$/.test(fields[0] || '');
    const userFirst = /^\d+$/.test(fields[1] || '');
    const pid = Number(pidFirst ? fields[0] : userFirst ? fields[1] : 0);
    const user = pidFirst ? fields[1] : userFirst ? fields[0] : '';
    if (!pid || !user) return;
    const command = line.slice(markerIndex + marker.length).trim();
    const args = splitShellWords(command);
    processes.push({
      pid,
      user,
      binary: args[0] || 'nginx',
      prefix: readShortOption(args.slice(1), '-p'),
      configPath: readShortOption(args.slice(1), '-c'),
      command,
    });
  });
  return processes;
}

/**
 * 解析 Nginx -V 的版本和编译路径。
 * @param {string} output - nginx -V 输出
 * @returns {{version: string, prefix: string, configPath: string}} 编译信息
 */
export function parseNginxVersionOutput(output) {
  const text = String(output || '');
  const version = text.match(/nginx version:\s*([^\s]+)/i)?.[1] || '';
  const configureArgs = text.match(/configure arguments:\s*(.+)$/im)?.[1] || '';
  const args = splitShellWords(configureArgs);
  const readConfigureOption = (name) => {
    const prefix = `${name}=`;
    return args.find((item) => item.startsWith(prefix))?.slice(prefix.length) || '';
  };
  return {
    version,
    prefix: readConfigureOption('--prefix'),
    configPath: readConfigureOption('--conf-path'),
  };
}

/**
 * 将 nginx -T 输出拆成带来源路径的配置片段。
 * @param {string} output - nginx -T 标准输出与错误输出
 * @param {string} fallbackPath - 未包含 marker 时的配置路径
 * @returns {Array<{path: string, content: string}>} 配置片段
 */
export function parseNginxDumpSections(output, fallbackPath = '') {
  const sections = [];
  let current = null;
  String(output || '').split(/\r?\n/).forEach((line) => {
    const marker = line.match(/^# configuration file (.+):\s*$/);
    if (marker) {
      if (current) sections.push({ ...current, content: current.lines.join('\n') });
      current = { path: String(marker[1] || '').trim(), lines: [] };
      return;
    }
    if (current) current.lines.push(line);
  });
  if (current) sections.push({ ...current, content: current.lines.join('\n') });
  if (sections.length) return sections.map(({ path: configPath, content }) => ({ path: configPath, content }));
  const content = String(output || '').trim();
  return content && fallbackPath ? [{ path: fallbackPath, content }] : [];
}

/**
 * 将 token 列表转换为轻量配置树。
 * @param {Array<Object>} tokens - Nginx token
 * @param {number} startIndex - 起始 token 下标
 * @param {string} name - 当前块名称
 * @param {string[]} args - 当前块参数
 * @returns {{node: Object, nextIndex: number}} 配置树与下一个 token 下标
 */
function parseConfigNode(tokens, startIndex = 0, name = 'root', args = []) {
  const node = { name, args, directives: [], children: [], start: tokens[startIndex]?.start || 0 };
  let statement = [];
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type === 'word') {
      statement.push(token.value);
      index += 1;
      continue;
    }
    if (token.type === 'semicolon') {
      if (statement.length) node.directives.push({ name: String(statement[0]).toLowerCase(), args: statement.slice(1) });
      statement = [];
      index += 1;
      continue;
    }
    if (token.type === 'brace-open') {
      const childName = String(statement[0] || '').toLowerCase();
      const childArgs = statement.slice(1);
      const child = parseConfigNode(tokens, index + 1, childName, childArgs);
      node.children.push(child.node);
      statement = [];
      index = child.nextIndex;
      continue;
    }
    if (token.type === 'brace-close') return { node, nextIndex: index + 1 };
    index += 1;
  }
  return { node, nextIndex: index };
}

/**
 * 递归查询指定名称的配置块。
 * @param {Object} node - 配置树节点
 * @param {string} name - 块名称
 * @returns {Object[]} 匹配节点
 */
function findConfigNodes(node, name) {
  const matches = node.name === name ? [node] : [];
  node.children.forEach((child) => matches.push(...findConfigNodes(child, name)));
  return matches;
}

/**
 * 提取静态绝对路径和动态路径。
 * @param {Array<Object>} directives - 指令列表
 * @param {string} directiveName - 指令名
 * @returns {{staticPaths: string[], dynamicPaths: string[]}} 路径集合
 */
function extractDirectivePaths(directives, directiveName) {
  const staticPaths = new Set();
  const dynamicPaths = new Set();
  directives.filter((item) => item.name === directiveName).forEach((item) => {
    const value = String(item.args[0] || '').trim();
    if (!value) return;
    if (value.includes('$')) {
      dynamicPaths.add(value);
      return;
    }
    const normalized = normalizeNginxArchivePath(value);
    if (normalized) staticPaths.add(normalized);
  });
  return { staticPaths: [...staticPaths], dynamicPaths: [...dynamicPaths] };
}

/**
 * 解析 listen 指令为稳定结构。
 * @param {string[]} args - listen 指令参数
 * @returns {{raw: string, address: string, port: number|null, transport: 'tcp'|'unix', ssl: boolean, defaultServer: boolean, wildcard: boolean, loopback: boolean}}
 */
export function parseNginxDiscoveryListen(args) {
  const values = (Array.isArray(args) ? args : []).map((item) => String(item || '').trim()).filter(Boolean);
  const raw = values.join(' ') || '80';
  const target = values[0] && !['ssl', 'default_server', 'default'].includes(values[0]) ? values[0] : '80';
  const ssl = values.includes('ssl');
  const defaultServer = values.includes('default_server') || values.includes('default');
  if (target.startsWith('unix:')) {
    return { raw, address: target.slice(5), port: null, transport: 'unix', ssl, defaultServer, wildcard: false, loopback: true };
  }

  let address = '*';
  let port = 80;
  const bracketMatch = target.match(/^\[([^\]]+)](?::(\d+))?$/);
  const addressPortMatch = target.match(/^(.+):(\d+)$/);
  if (/^\d+$/.test(target)) {
    port = Number(target);
  } else if (bracketMatch) {
    address = bracketMatch[1];
    port = Number(bracketMatch[2] || 80);
  } else if (addressPortMatch) {
    address = addressPortMatch[1] || '*';
    port = Number(addressPortMatch[2]);
  } else if (target) {
    address = target;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = 80;
  const normalizedAddress = address.toLowerCase();
  const wildcard = ['*', '0.0.0.0', '::'].includes(normalizedAddress);
  const loopback = normalizedAddress === 'localhost' || normalizedAddress === '::1' || /^127(?:\.\d{1,3}){0,3}$/.test(normalizedAddress);
  return { raw, address, port, transport: 'tcp', ssl, defaultServer, wildcard, loopback };
}

/**
 * 判断 server_name 是否可作为用户访问地址。
 * @param {string} value - server_name 原值
 * @returns {boolean} 是否为明确域名或 IP
 */
export function isUsableNginxServerName(value) {
  const name = String(value || '').trim();
  if (!name || name === '_' || /[$~*]/.test(name) || name.includes('_')) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || name.includes(':')) return true;
  return /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)(?:\.(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?))*$/i.test(name);
}

/**
 * 生成 TCP 访问候选。
 * @param {Object[]} listens - 结构化 listen 列表
 * @param {string[]} serverNames - server_name 原值
 * @param {string} serverHost - 雨燕中配置的 SSH host/IP
 * @returns {Object[]} 访问地址候选
 */
export function buildNginxAccessEndpoints(listens, serverNames, serverHost) {
  const usableServerName = serverNames.find(isUsableNginxServerName) || '';
  const endpoints = [];
  const seen = new Set();
  listens.filter((item) => item.transport === 'tcp' && item.port).forEach((listen) => {
    const host = usableServerName || (listen.loopback ? listen.address : String(serverHost || '').trim());
    if (!host) return;
    const protocol = listen.ssl || listen.port === 443 ? 'https' : 'http';
    const renderedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const defaultPort = protocol === 'https' ? 443 : 80;
    const url = `${protocol}://${renderedHost}${listen.port === defaultPort ? '' : `:${listen.port}`}`;
    const key = `${url}|${listen.loopback ? 'local' : 'remote'}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({
      url,
      host,
      port: listen.port,
      protocol,
      source: usableServerName ? 'serverName' : listen.loopback ? 'listen' : 'serverHost',
      scope: listen.loopback ? 'local' : 'remote',
    });
  });
  return endpoints;
}

/**
 * 解析展开后的 Nginx 配置站点。
 * @param {Array<{path: string, content: string}>} sections - 配置片段
 * @param {string} runtimeKey - 运行实例稳定标识
 * @param {{serverHost?: string}} options - 解析选项
 * @returns {Object[]} server 站点摘要
 */
export function parseNginxDiscoverySites(sections, runtimeKey = '', options = {}) {
  const parsedSections = sections.map((section) => ({
    ...section,
    tree: parseConfigNode(tokenizeNginxConfig(section.content)).node,
  }));
  const inheritedRoots = new Set();
  parsedSections.forEach((section) => {
    findConfigNodes(section.tree, 'http').forEach((httpNode) => {
      extractDirectivePaths(httpNode.directives, 'root').staticPaths.forEach((root) => inheritedRoots.add(root));
    });
  });

  const sites = [];
  parsedSections.forEach((section) => {
    findConfigNodes(section.tree, 'server').forEach((serverNode, order) => {
      const listenDirectives = serverNode.directives.filter((item) => item.name === 'listen');
      const listens = listenDirectives.length
        ? listenDirectives.map((item) => parseNginxDiscoveryListen(item.args))
        : [parseNginxDiscoveryListen([])];
      const listenValues = [...new Set(listens.map((item) => item.raw))];
      const listenPorts = [...new Set(listens.filter((item) => item.transport === 'tcp').map((item) => item.port).filter(Boolean))];
      const serverNames = [...new Set(serverNode.directives.filter((item) => item.name === 'server_name').flatMap((item) => item.args).filter(Boolean))];
      const nestedDirectives = serverNode.children.flatMap((child) => [child.directives, ...findConfigNodes(child, 'location').map((item) => item.directives)]).flat();
      const directRoots = extractDirectivePaths(serverNode.directives, 'root');
      const locationRoots = extractDirectivePaths(nestedDirectives, 'root');
      const aliases = extractDirectivePaths(nestedDirectives, 'alias');
      const roots = [...new Set([...directRoots.staticPaths, ...locationRoots.staticPaths])];
      if (!roots.length && !directRoots.dynamicPaths.length && !locationRoots.dynamicPaths.length) {
        inheritedRoots.forEach((root) => roots.push(root));
      }
      const dynamicRoots = [...new Set([...directRoots.dynamicPaths, ...locationRoots.dynamicPaths])];
      const hasProxyPass = [...serverNode.directives, ...nestedDirectives].some((item) => item.name === 'proxy_pass');
      const type = roots.length ? (hasProxyPass ? 'mixed' : 'static') : hasProxyPass ? 'proxy' : 'unknown';
      const idSource = `${runtimeKey}\0${section.path}\0${serverNode.start}\0${order}`;
      sites.push({
        id: `site-${crypto.createHash('sha256').update(idSource).digest('hex').slice(0, 16)}`,
        order: sites.length,
        configPath: section.path,
        listens,
        accessEndpoints: buildNginxAccessEndpoints(listens, serverNames, options.serverHost || ''),
        listenPorts,
        listenValues,
        serverNames,
        roots,
        dynamicRoots,
        aliases: aliases.staticPaths,
        dynamicAliases: aliases.dynamicPaths,
        type,
        hasProxyPass,
        warnings: [],
      });
    });
  });
  return sites.slice(0, MAX_DISCOVERED_SITES + 1);
}

/**
 * 构造带 sudo 的只读命令。
 * @param {string} command - 原始命令
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} 远程命令
 */
function buildReadOnlyCommand(command, useSudo) {
  return `${useSudo ? 'sudo -n ' : ''}${command}`;
}

/**
 * 生成 Nginx 配置操作命令。
 * @param {string} binary - Nginx 二进制
 * @param {string} action - Nginx 参数
 * @param {string} prefix - 工作目录
 * @param {string} configPath - 主配置路径
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {string} 命令文本
 */
function buildNginxCommand(binary, action, prefix, configPath, useSudo) {
  const args = [shellQuote(binary), action];
  if (prefix) args.push('-p', shellQuote(prefix));
  if (configPath) args.push('-c', shellQuote(configPath));
  return buildReadOnlyCommand(args.join(' '), useSudo);
}

/**
 * 将相对配置路径解析到 prefix 下。
 * @param {string} configPath - 配置路径
 * @param {string} prefix - Nginx prefix
 * @returns {string} 绝对或原始配置路径
 */
function resolveConfigPath(configPath, prefix) {
  const configured = String(configPath || '').trim();
  if (!configured) return '';
  if (configured.startsWith('/')) return path.posix.normalize(configured);
  return prefix ? path.posix.join(prefix, configured) : configured;
}

/**
 * 生成服务器内稳定的 Nginx 运行时指纹。
 * @param {string} binary - 规范化二进制路径
 * @param {string} prefix - Nginx prefix
 * @param {string} mainConfigPath - 主配置路径
 * @returns {string} SHA-256 指纹
 */
export function createNginxRuntimeFingerprint(binary, prefix, mainConfigPath) {
  const normalized = [binary, prefix, mainConfigPath].map((item) => {
    const value = String(item || '').trim();
    return value.startsWith('/') ? path.posix.normalize(value) : value;
  });
  if (!normalized[0] || !normalized[0].startsWith('/')) return '';
  return crypto.createHash('sha256').update(normalized.join('\0')).digest('hex');
}

/**
 * 创建结构化诊断。
 * @param {string} code - 稳定错误码
 * @param {'info'|'warning'|'error'} severity - 严重度
 * @param {'scan'|'runtime'} scope - 诊断范围
 * @param {string} summary - 用户可读摘要
 * @param {string} detail - 原始详情
 * @param {string} action - 建议操作
 * @returns {Object} 诊断对象
 */
function createDiagnostic(code, severity, scope, summary, detail = '', action = '') {
  return {
    code,
    severity,
    scope,
    summary,
    detail: String(detail || '').trim().slice(0, MAX_DIAGNOSTIC_DETAIL_LENGTH),
    action,
  };
}

/**
 * 按编码、范围和摘要对诊断去重。
 * @param {Object[]} diagnostics - 原始诊断
 * @returns {Object[]} 去重结果
 */
export function dedupeNginxDiagnostics(diagnostics) {
  const seen = new Set();
  return diagnostics.filter((item) => {
    const key = `${item.code}|${item.scope}|${item.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 提取适合展示的命令失败摘要。
 * @param {Object} result - 远程命令结果
 * @returns {string} 失败摘要
 */
function summarizeCommandFailure(result) {
  return `${result?.stderr || ''}\n${result?.stdout || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join('；')
    .slice(0, 600);
}

/**
 * 将命令失败归类为稳定诊断。
 * @param {string} detail - 命令错误详情
 * @param {boolean} useSudo - 是否使用 sudo
 * @returns {Object} 结构化诊断
 */
function classifyCommandFailure(detail, useSudo) {
  if (/password is required|a terminal is required|no tty/i.test(detail)) {
    return createDiagnostic('sudo_password_required', 'error', 'runtime', 'sudo 需要交互密码，自动扫描已降级', detail, '配置免密 sudo 读取权限，或使用手动接入');
  }
  if (/permission denied|权限不足|operation not permitted/i.test(detail)) {
    return createDiagnostic('permission_denied', 'warning', 'runtime', useSudo ? 'sudo 读取权限不足' : '当前账号读取 Nginx 配置的权限不足', detail, useSudo ? '配置免密 sudo 读取权限，或使用手动接入' : '使用 sudo 重新扫描，或手动填写');
  }
  if (/command not found|no such file or directory|not found/i.test(detail)) {
    return createDiagnostic('command_not_found', 'error', 'runtime', 'Nginx 可执行文件不可用', detail, '检查进程启动目录或使用手动接入');
  }
  if (/timeout|超时|aborted/i.test(detail)) {
    return createDiagnostic('timeout', 'warning', 'runtime', 'Nginx 检查超时', detail, '可重新扫描或手动填写');
  }
  return createDiagnostic('config_invalid', 'warning', 'runtime', 'Nginx 配置读取或校验失败', detail, '展开详情检查配置，或手动填写');
}

/**
 * 批量检查前端根目录和 index.html。
 * @param {Object} conn - SSH 连接
 * @param {string[]} roots - 根目录
 * @param {{useSudo: boolean, execute: Function, signal?: AbortSignal}} context - 扫描上下文
 * @returns {Promise<Map<string, {exists: boolean, readable: boolean, hasIndexHtml: boolean}>>} 路径状态
 */
async function inspectRemoteRoots(conn, roots, context) {
  const uniqueRoots = [...new Set(roots)].slice(0, MAX_DISCOVERED_SITES);
  if (!uniqueRoots.length) return new Map();
  const commands = uniqueRoots.map((root) => {
    const key = Buffer.from(root, 'utf8').toString('base64');
    const indexPath = path.posix.join(root, 'index.html');
    return `printf '%s\\t' ${shellQuote(key)}; ${buildReadOnlyCommand(`test -d ${shellQuote(root)}`, context.useSudo)} && printf '1\\t' || printf '0\\t'; ${buildReadOnlyCommand(`test -r ${shellQuote(root)}`, context.useSudo)} && printf '1\\t' || printf '0\\t'; ${buildReadOnlyCommand(`test -f ${shellQuote(indexPath)}`, context.useSudo)} && printf '1\\n' || printf '0\\n'`;
  });
  const result = await context.execute(conn, commands.join('; '), {
    allowFailure: true,
    label: '检查 Nginx 前端目录',
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
    signal: context.signal,
  });
  const statuses = new Map();
  String(result.stdout || '').split(/\r?\n/).forEach((line) => {
    const [encoded, exists, readable, hasIndexHtml] = line.split('\t');
    if (!encoded) return;
    try {
      statuses.set(Buffer.from(encoded, 'base64').toString('utf8'), {
        exists: exists === '1',
        readable: readable === '1',
        hasIndexHtml: hasIndexHtml === '1',
      });
    } catch {
      /** 忽略单条无法解码的远程结果。 */
    }
  });
  return statuses;
}

/**
 * 检查单个 Nginx 运行实例。
 * @param {Object} conn - SSH 连接
 * @param {Object} candidate - 运行实例候选
 * @param {Object} context - 扫描上下文
 * @returns {Promise<Object>} 运行实例摘要
 */
async function inspectNginxRuntime(conn, candidate, context) {
  const versionResult = await context.execute(conn, buildReadOnlyCommand(`${shellQuote(candidate.binary)} -V`, context.useSudo), {
    allowFailure: true,
    label: `读取 ${candidate.binary} 版本`,
    timeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
    signal: context.signal,
  });
  const versionInfo = parseNginxVersionOutput(`${versionResult.stderr || ''}\n${versionResult.stdout || ''}`);
  const prefix = String(candidate.prefix || versionInfo.prefix || '').replace(/\/+$/, '');
  const mainConfigPath = resolveConfigPath(candidate.configPath || versionInfo.configPath, prefix);
  const runtimeKey = `${candidate.binary}|${prefix}|${mainConfigPath}`;
  const runtimeFingerprint = createNginxRuntimeFingerprint(candidate.binary, prefix, mainConfigPath);
  const testCommand = buildNginxCommand(candidate.binary, '-t', prefix, mainConfigPath, false);
  const reloadCommand = buildNginxCommand(candidate.binary, '-s reload', prefix, mainConfigPath, false);
  const dumpResult = await context.execute(conn, buildNginxCommand(candidate.binary, '-T', prefix, mainConfigPath, context.useSudo), {
    allowFailure: true,
    label: `扫描 ${candidate.binary} 配置`,
    timeoutMs: 25_000,
    maxOutputBytes: MAX_NGINX_DUMP_BYTES,
    signal: context.signal,
  });
  const combinedOutput = `${dumpResult.stdout || ''}\n${dumpResult.stderr || ''}`;
  const sections = parseNginxDumpSections(combinedOutput, mainConfigPath);
  const sites = dumpResult.code === 0
    ? parseNginxDiscoverySites(sections, runtimeKey, { serverHost: context.serverHost })
    : [];
  const rootStatuses = await inspectRemoteRoots(conn, sites.flatMap((site) => site.roots), context);
  const decoratedSites = sites.map((site) => ({
    ...site,
    roots: site.roots.map((root) => ({
      path: root,
      ...(rootStatuses.get(root) || { exists: false, readable: false, hasIndexHtml: false }),
    })),
  }));
  const sourcePaths = new Set([mainConfigPath, ...decoratedSites.map((site) => site.configPath)].filter(Boolean));
  const fingerprintMatch = runtimeFingerprint && context.instances.find((instance) => instance.runtimeFingerprint === runtimeFingerprint);
  const connectedInstance = fingerprintMatch || context.instances.find((instance) => {
    const configPath = String(instance.defaultNginxConfPath || '').trim();
    if (configPath && sourcePaths.has(configPath)) return true;
    const workDir = String(instance.nginxWorkDir || '').replace(/\/+$/, '');
    if (workDir && prefix && workDir === prefix) return true;
    return [instance.nginxTestCommand, instance.nginxReloadCommand].some((command) => String(command || '').includes(candidate.binary));
  });
  const diagnostics = [];
  if (versionResult.code !== 0) diagnostics.push(classifyCommandFailure(summarizeCommandFailure(versionResult), context.useSudo));
  if (dumpResult.code !== 0) diagnostics.push(classifyCommandFailure(summarizeCommandFailure(dumpResult) || 'Nginx 配置读取失败', context.useSudo));
  const unreadableRootCount = decoratedSites
    .flatMap((site) => site.roots)
    .filter((root) => root.exists && !root.readable).length;
  if (unreadableRootCount) {
    diagnostics.push(createDiagnostic(
      'permission_denied',
      'warning',
      'runtime',
      `${unreadableRootCount} 个站点根目录当前账号不可读`,
      '',
      context.useSudo ? '配置免密 sudo 读取权限，或手动填写' : '使用 sudo 重新扫描，或手动填写',
    ));
  }
  if (!decoratedSites.length && dumpResult.code === 0) {
    diagnostics.push(createDiagnostic('no_sites', 'info', 'runtime', '配置已读取，但没有发现 server 站点'));
  }
  const uniqueDiagnostics = dedupeNginxDiagnostics(diagnostics);
  return {
    id: `runtime-${crypto.createHash('sha256').update(runtimeKey).digest('hex').slice(0, 16)}`,
    binaryPath: candidate.binary,
    binaryResolution: 'resolved',
    inspectionState: dumpResult.code === 0 ? 'ready' : versionInfo.version ? 'partial' : 'unavailable',
    runtimeFingerprint,
    version: versionInfo.version,
    masterPids: candidate.pids || [],
    running: Boolean(candidate.pids?.length),
    prefix,
    mainConfigPath,
    nginxWorkDir: prefix,
    nginxTestCommand: testCommand,
    nginxReloadCommand: reloadCommand,
    useSudo: context.useSudo,
    connectedInstanceId: connectedInstance?.id || null,
    connectedInstance: connectedInstance ? { id: connectedInstance.id, name: connectedInstance.name } : null,
    diagnostics: uniqueDiagnostics,
    warnings: uniqueDiagnostics.map((item) => item.summary),
    sites: decoratedSites,
  };
}

/**
 * 解析 `/proc` 路径查询输出。
 * @param {string} output - 查询输出
 * @returns {Map<number, {exe: string, cwd: string}>} 进程路径表
 */
export function parseNginxProcPaths(output) {
  const result = new Map();
  String(output || '').split(/\r?\n/).forEach((line) => {
    const [pidText, exe = '', cwd = ''] = line.split('\t');
    const pid = Number(pidText);
    if (pid) result.set(pid, { exe: exe.trim(), cwd: cwd.trim() });
  });
  return result;
}

/**
 * 根据进程参数、`/proc` 和 PATH 结果解析可安全执行的绝对路径。
 * @param {Object} process - 进程线索
 * @param {{exe?: string, cwd?: string}} proc - `/proc` 路径
 * @param {string[]} binaries - 已确认可执行的绝对路径
 * @returns {{binary: string, status: 'resolved'|'unresolved'}} 路径结果
 */
export function resolveNginxProcessBinary(process, proc = {}, binaries = []) {
  if (String(proc.exe || '').startsWith('/')) return { binary: path.posix.normalize(proc.exe), status: 'resolved' };
  const raw = String(process.binary || '').trim();
  if (raw.startsWith('/')) return { binary: path.posix.normalize(raw), status: 'resolved' };
  if (raw.includes('/') && String(proc.cwd || '').startsWith('/')) {
    return { binary: path.posix.resolve(proc.cwd, raw), status: 'resolved' };
  }
  if (!raw.includes('/')) {
    const match = binaries.find((item) => item.startsWith('/') && path.posix.basename(item) === path.posix.basename(raw));
    if (match) return { binary: path.posix.normalize(match), status: 'resolved' };
  }
  return { binary: raw || 'nginx', status: 'unresolved' };
}

/**
 * 查询 master 进程的真实可执行文件与工作目录。
 * @param {Object} conn - SSH 连接
 * @param {Object[]} processes - master 进程列表
 * @param {Object} context - 扫描上下文
 * @returns {Promise<Map<number, {exe: string, cwd: string}>>} 进程路径表
 */
async function readProcessPaths(conn, processes, context) {
  if (!processes.length) return new Map();
  const commands = processes.map(({ pid }) => {
    const exeCommand = buildReadOnlyCommand(`readlink -f /proc/${pid}/exe`, context.useSudo);
    const cwdCommand = buildReadOnlyCommand(`readlink -f /proc/${pid}/cwd`, context.useSudo);
    return `exe=$(${exeCommand} 2>/dev/null || true); cwd=$(${cwdCommand} 2>/dev/null || true); printf '%s\\t%s\\t%s\\n' '${pid}' "$exe" "$cwd"`;
  });
  try {
    const result = await context.execute(conn, commands.join('; '), {
      allowFailure: true,
      label: '解析 Nginx 进程路径',
      timeoutMs: 10_000,
      maxOutputBytes: 128 * 1024,
      signal: context.signal,
    });
    return parseNginxProcPaths(result.stdout);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return new Map();
  }
}

/**
 * 发现服务器中的 Nginx 二进制与运行进程。
 * @param {Object} conn - SSH 连接
 * @param {{execute: Function, useSudo: boolean, signal?: AbortSignal}} context - 扫描上下文
 * @returns {Promise<{candidates: Object[], truncated: boolean}>} 运行实例候选
 */
async function discoverRuntimeCandidates(conn, context) {
  const findCommand = `${context.useSudo ? 'sudo -n ' : ''}find /home /opt -maxdepth 6 -type f -path '*/sbin/nginx' -perm -u+x -print 2>/dev/null || true`;
  const [processResult, binaryResult] = await Promise.all([
    context.execute(conn, "{ ps -eo pid=,user=,args=ww 2>/dev/null || true; ps -ef 2>/dev/null || true; } | grep 'nginx: master process' | grep -v grep || true", {
      allowFailure: true,
      label: '扫描 Nginx master 进程',
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024,
      signal: context.signal,
    }),
    context.execute(conn, `{ command -v nginx 2>/dev/null || true; command -v openresty 2>/dev/null || true; for p in ${COMMON_NGINX_BINARIES.map(shellQuote).join(' ')}; do [ -x "$p" ] && printf '%s\\n' "$p"; done; ${findCommand}; } | awk 'NF && !seen[$0]++' | head -n ${MAX_RUNTIME_CANDIDATES + 1}`, {
      allowFailure: true,
      label: '扫描常见 Nginx 安装路径',
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
      signal: context.signal,
    }),
  ]);
  const binaries = String(binaryResult.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith('/'));
  const processes = parseNginxMasterProcesses(processResult.stdout);
  const procPaths = await readProcessPaths(conn, processes, context);
  const byKey = new Map();
  processes.forEach((process) => {
    const resolution = resolveNginxProcessBinary(process, procPaths.get(process.pid), binaries);
    const key = `${resolution.binary}|${process.prefix}|${process.configPath}`;
    const current = byKey.get(key) || {
      binary: resolution.binary,
      originalBinary: process.binary,
      binaryResolution: resolution.status,
      prefix: process.prefix,
      configPath: process.configPath,
      pids: [],
    };
    if (!current.pids.includes(process.pid)) current.pids.push(process.pid);
    byKey.set(key, current);
  });
  binaries.forEach((binary) => {
    if ([...byKey.values()].some((item) => item.binary === binary)) return;
    byKey.set(`${binary}||`, { binary, originalBinary: binary, binaryResolution: 'resolved', prefix: '', configPath: '', pids: [] });
  });
  const allCandidates = [...byKey.values()].sort((left, right) => Number(Boolean(right.pids.length)) - Number(Boolean(left.pids.length)));
  return {
    candidates: allCandidates.slice(0, MAX_RUNTIME_CANDIDATES),
    truncated: allCandidates.length > MAX_RUNTIME_CANDIDATES || binaries.length > MAX_RUNTIME_CANDIDATES,
  };
}

/**
 * 将无法安全解析的进程转换为诊断运行项。
 * @param {Object} candidate - 运行实例候选
 * @param {boolean} useSudo - sudo 状态
 * @returns {Object} 不可检查运行项
 */
function createUnresolvedRuntime(candidate, useSudo) {
  const diagnostic = createDiagnostic('binary_unresolved', 'error', 'runtime', `无法解析 Nginx 可执行文件：${candidate.originalBinary || candidate.binary}`, '', '请确认进程工作目录，或使用手动接入');
  const runtimeKey = `${candidate.binary}|${candidate.prefix}|${candidate.configPath}`;
  return {
    id: `runtime-${crypto.createHash('sha256').update(runtimeKey).digest('hex').slice(0, 16)}`,
    binaryPath: candidate.originalBinary || candidate.binary,
    binaryResolution: 'unresolved',
    inspectionState: 'unavailable',
    runtimeFingerprint: '',
    version: '',
    masterPids: candidate.pids || [],
    running: Boolean(candidate.pids?.length),
    prefix: candidate.prefix || '',
    mainConfigPath: candidate.configPath || '',
    nginxWorkDir: '',
    nginxTestCommand: '',
    nginxReloadCommand: '',
    useSudo,
    connectedInstanceId: null,
    connectedInstance: null,
    diagnostics: [diagnostic],
    warnings: [diagnostic.summary],
    sites: [],
  };
}

/**
 * 使用固定并发数检查运行实例，并保留成功的部分结果。
 * @param {Object[]} candidates - 运行实例候选
 * @param {(candidate: Object) => Promise<Object>} inspect - 单项检查器
 * @param {AbortSignal} signal - 扫描取消信号
 * @returns {Promise<{runtimes: Object[], diagnostics: Object[]}>} 部分结果与诊断
 */
async function inspectRuntimePool(candidates, inspect, signal) {
  const runtimes = [];
  const diagnostics = [];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < candidates.length && !signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      try {
        runtimes[index] = await inspect(candidate);
      } catch (error) {
        if (error?.name === 'AbortError') break;
        diagnostics.push(createDiagnostic('config_invalid', 'warning', 'scan', `${candidate.binary} 检查失败`, error instanceof Error ? error.message : String(error), '可重新扫描或手动填写'));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RUNTIME_INSPECTION_CONCURRENCY, candidates.length) }, () => worker()));
  return { runtimes: runtimes.filter(Boolean), diagnostics };
}

/**
 * 计算运行实例排序分值。
 * @param {Object} runtime - 运行实例
 * @returns {number} 排序分值
 */
function getRuntimeScore(runtime) {
  const roots = runtime.sites.flatMap((site) => site.roots || []);
  return Number(runtime.running) * 16
    + Number(runtime.inspectionState === 'ready') * 8
    + Number(!runtime.connectedInstanceId) * 4
    + Number(roots.some((root) => root.exists)) * 2
    + Number(roots.some((root) => root.hasIndexHtml));
}

/**
 * 扫描服务器上的宿主机 Nginx 和前端站点。
 * @param {number} serverId - 服务器 ID
 * @param {{useSudo?: boolean, signal?: AbortSignal}} options - 扫描选项
 * @param {{getServer?: Function, withConnection?: Function, execute?: Function}} dependencies - 可替换测试依赖
 * @returns {Promise<{useSudo: boolean, runtimes: Object[], warnings: string[], truncated: boolean}>} 扫描结果
 */
export async function discoverServerNginx(serverId, options = {}, dependencies = {}) {
  const startedAt = Date.now();
  const getServer = dependencies.getServer || getServerWithCredential;
  const withConnection = dependencies.withConnection || withSsh;
  const execute = dependencies.execute || execSsh;
  const server = await getServer(serverId);
  if (!server) throw new Error('部署服务器不存在');
  const useSudo = options.useSudo === undefined ? Boolean(server.useSudo) : Boolean(options.useSudo);
  const scanController = new AbortController();
  let budgetExceeded = false;
  const handleExternalAbort = () => scanController.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', handleExternalAbort, { once: true });
  if (options.signal?.aborted) handleExternalAbort();
  const budgetTimer = setTimeout(() => {
    budgetExceeded = true;
    scanController.abort(new Error('Nginx 扫描超过 60 秒预算'));
  }, SCAN_BUDGET_MS);
  const serverSummary = {
    id: server.id,
    name: server.name || '',
    host: server.host || '',
    sshPort: Number(server.port || 22),
  };

  try {
    return await withConnection(server, async (conn) => {
      const context = { execute, useSudo, signal: scanController.signal };
      let discovery = { candidates: [], truncated: false };
      const diagnostics = [];
      try {
        discovery = await discoverRuntimeCandidates(conn, context);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        diagnostics.push(createDiagnostic(
          budgetExceeded ? 'timeout' : 'config_invalid',
          'error',
          'scan',
          budgetExceeded ? '扫描已达到 60 秒预算' : '无法扫描 Nginx 运行环境',
          error instanceof Error ? error.message : String(error),
          '可重试或使用手动接入',
        ));
      }

      const inspected = await inspectRuntimePool(discovery.candidates, (candidate) => {
        if (candidate.binaryResolution !== 'resolved') return Promise.resolve(createUnresolvedRuntime(candidate, useSudo));
        return inspectNginxRuntime(conn, candidate, {
          execute,
          instances: Array.isArray(server.nginxInstances) ? server.nginxInstances : [],
          useSudo,
          signal: scanController.signal,
          serverHost: server.host || '',
        });
      }, scanController.signal);
      if (options.signal?.aborted) {
        const abortError = options.signal.reason instanceof Error ? options.signal.reason : new Error('Nginx 扫描已取消');
        abortError.name = 'AbortError';
        throw abortError;
      }
      diagnostics.push(...inspected.diagnostics);
      if (!discovery.candidates.length && !diagnostics.length) {
        diagnostics.push(createDiagnostic('no_sites', 'info', 'scan', '没有在运行进程、系统 PATH、/home 或 /opt 常见目录中发现 Nginx'));
      }
      if (budgetExceeded) diagnostics.push(createDiagnostic('timeout', 'warning', 'scan', '扫描达到 60 秒预算，已返回部分结果', '', '可重新扫描或手动填写'));

      const siteCountBeforeTrim = inspected.runtimes.reduce((total, runtime) => total + runtime.sites.length, 0);
      let remainingSites = MAX_DISCOVERED_SITES;
      const runtimes = inspected.runtimes
        .sort((left, right) => getRuntimeScore(right) - getRuntimeScore(left))
        .map((runtime) => {
          const sites = runtime.sites.slice(0, Math.max(0, remainingSites));
          remainingSites -= sites.length;
          return { ...runtime, sites };
        });
      const truncated = discovery.truncated || siteCountBeforeTrim > MAX_DISCOVERED_SITES;
      if (truncated) diagnostics.push(createDiagnostic('truncated', 'warning', 'scan', '扫描结果已按运行实例 12 个、站点 200 个的上限截断', '', '可手动填写未展示的实例'));
      const allDiagnostics = dedupeNginxDiagnostics([
        ...diagnostics,
        ...runtimes.flatMap((runtime) => runtime.diagnostics || []),
      ]);
      return {
        server: serverSummary,
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        useSudo,
        runtimes,
        diagnostics: allDiagnostics,
        warnings: allDiagnostics.map((item) => item.summary),
        truncated,
      };
    });
  } finally {
    clearTimeout(budgetTimer);
    options.signal?.removeEventListener('abort', handleExternalAbort);
  }
}
