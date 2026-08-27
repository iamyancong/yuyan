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
  parseNginxListenPort,
  tokenizeNginxConfig,
} from './nginx-archive-selection.mjs';

/** 最多检查的 Nginx 运行实例数量。 */
const MAX_RUNTIME_CANDIDATES = 12;

/** 最多返回的 server 站点数量。 */
const MAX_DISCOVERED_SITES = 200;

/** 单次 Nginx 配置展开的最大输出。 */
const MAX_NGINX_DUMP_BYTES = 4 * 1024 * 1024;

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
 * 解析展开后的 Nginx 配置站点。
 * @param {Array<{path: string, content: string}>} sections - 配置片段
 * @param {string} runtimeKey - 运行实例稳定标识
 * @returns {Object[]} server 站点摘要
 */
export function parseNginxDiscoverySites(sections, runtimeKey = '') {
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
      const listenValues = [...new Set(listenDirectives.map((item) => item.args.join(' ').trim()).filter(Boolean))];
      const listenPorts = [...new Set(listenDirectives.map((item) => parseNginxListenPort(item.args)).filter((port) => port && port <= 65535))];
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
        listenPorts: listenPorts.length ? listenPorts : [80],
        listenValues: listenValues.length ? listenValues : ['80'],
        serverNames,
        roots,
        dynamicRoots,
        aliases: aliases.staticPaths,
        dynamicAliases: aliases.dynamicPaths,
        type,
        hasProxyPass,
      });
    });
  });
  return sites.slice(0, MAX_DISCOVERED_SITES);
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
 * 批量检查前端根目录和 index.html。
 * @param {Object} conn - SSH 连接
 * @param {string[]} roots - 根目录
 * @param {boolean} useSudo - 是否使用 sudo
 * @param {Function} execute - SSH 命令执行器
 * @returns {Promise<Map<string, {exists: boolean, hasIndexHtml: boolean}>>} 路径状态
 */
async function inspectRemoteRoots(conn, roots, useSudo, execute) {
  const uniqueRoots = [...new Set(roots)].slice(0, MAX_DISCOVERED_SITES);
  if (!uniqueRoots.length) return new Map();
  const commands = uniqueRoots.map((root) => {
    const key = Buffer.from(root, 'utf8').toString('base64');
    const indexPath = path.posix.join(root, 'index.html');
    return `printf '%s\\t' ${shellQuote(key)}; ${buildReadOnlyCommand(`test -d ${shellQuote(root)}`, useSudo)} && printf '1\\t' || printf '0\\t'; ${buildReadOnlyCommand(`test -f ${shellQuote(indexPath)}`, useSudo)} && printf '1\\n' || printf '0\\n'`;
  });
  const result = await execute(conn, commands.join('; '), {
    allowFailure: true,
    label: '检查 Nginx 前端目录',
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
  });
  const statuses = new Map();
  String(result.stdout || '').split(/\r?\n/).forEach((line) => {
    const [encoded, exists, hasIndexHtml] = line.split('\t');
    if (!encoded) return;
    try {
      statuses.set(Buffer.from(encoded, 'base64').toString('utf8'), { exists: exists === '1', hasIndexHtml: hasIndexHtml === '1' });
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
  });
  const versionInfo = parseNginxVersionOutput(`${versionResult.stderr || ''}\n${versionResult.stdout || ''}`);
  const prefix = String(candidate.prefix || versionInfo.prefix || '').replace(/\/+$/, '');
  const mainConfigPath = resolveConfigPath(candidate.configPath || versionInfo.configPath, prefix);
  const runtimeKey = `${candidate.binary}|${prefix}|${mainConfigPath}`;
  const testCommand = buildNginxCommand(candidate.binary, '-t', prefix, mainConfigPath, false);
  const reloadCommand = buildNginxCommand(candidate.binary, '-s reload', prefix, mainConfigPath, false);
  const dumpResult = await context.execute(conn, buildNginxCommand(candidate.binary, '-T', prefix, mainConfigPath, context.useSudo), {
    allowFailure: true,
    label: `扫描 ${candidate.binary} 配置`,
    timeoutMs: 25_000,
    maxOutputBytes: MAX_NGINX_DUMP_BYTES,
  });
  const combinedOutput = `${dumpResult.stdout || ''}\n${dumpResult.stderr || ''}`;
  const sections = parseNginxDumpSections(combinedOutput, mainConfigPath);
  const sites = dumpResult.code === 0 ? parseNginxDiscoverySites(sections, runtimeKey) : [];
  const rootStatuses = await inspectRemoteRoots(conn, sites.flatMap((site) => site.roots), context.useSudo, context.execute);
  const decoratedSites = sites.map((site) => ({
    ...site,
    roots: site.roots.map((root) => ({ path: root, ...(rootStatuses.get(root) || { exists: false, hasIndexHtml: false }) })),
  }));
  const sourcePaths = new Set([mainConfigPath, ...decoratedSites.map((site) => site.configPath)].filter(Boolean));
  const connectedInstance = context.instances.find((instance) => sourcePaths.has(String(instance.defaultNginxConfPath || '').trim()));
  const warnings = [];
  if (dumpResult.code !== 0) {
    const failure = summarizeCommandFailure(dumpResult) || 'Nginx 配置读取失败';
    warnings.push(failure);
    if (!context.useSudo && /权限|permission denied/i.test(failure)) {
      warnings.push('当前账号权限不足，请开启“使用 sudo”后重新扫描，或继续手动填写');
    }
    if (context.useSudo && /password|sudo|权限|permission/i.test(failure)) {
      warnings.push('当前扫描只支持非交互 sudo -n；请配置免密 sudo 读取权限，或使用手动接入');
    }
  }
  if (!decoratedSites.length && dumpResult.code === 0) warnings.push('配置已读取，但没有发现可选择的 server 站点');
  return {
    id: `runtime-${crypto.createHash('sha256').update(runtimeKey).digest('hex').slice(0, 16)}`,
    binaryPath: candidate.binary,
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
    warnings: warnings.filter(Boolean),
    sites: decoratedSites,
  };
}

/**
 * 发现服务器中的 Nginx 二进制与运行进程。
 * @param {Object} conn - SSH 连接
 * @param {Function} execute - SSH 命令执行器
 * @param {boolean} useSudo - 是否使用非交互 sudo 扫描受限目录
 * @returns {Promise<Object[]>} 运行实例候选
 */
async function discoverRuntimeCandidates(conn, execute, useSudo) {
  const findCommand = `${useSudo ? 'sudo -n ' : ''}find /home /opt -maxdepth 6 -type f -path '*/sbin/nginx' -perm -u+x -print 2>/dev/null || true`;
  const [processResult, binaryResult] = await Promise.all([
    execute(conn, "{ ps -eo pid=,user=,args=ww 2>/dev/null || true; ps -ef 2>/dev/null || true; } | grep 'nginx: master process' | grep -v grep || true", {
      allowFailure: true,
      label: '扫描 Nginx master 进程',
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024,
    }),
    execute(conn, `{ command -v nginx 2>/dev/null || true; command -v openresty 2>/dev/null || true; for p in ${COMMON_NGINX_BINARIES.map(shellQuote).join(' ')}; do [ -x "$p" ] && printf '%s\\n' "$p"; done; ${findCommand}; } | awk 'NF && !seen[$0]++' | head -n ${MAX_RUNTIME_CANDIDATES}`, {
      allowFailure: true,
      label: '扫描常见 Nginx 安装路径',
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    }),
  ]);
  const binaries = String(binaryResult.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const processes = parseNginxMasterProcesses(processResult.stdout);
  const byKey = new Map();
  processes.forEach((process) => {
    const resolvedBinary = process.binary.includes('/')
      ? process.binary
      : binaries.find((item) => path.posix.basename(item) === path.posix.basename(process.binary)) || process.binary;
    const key = `${resolvedBinary}|${process.prefix}|${process.configPath}`;
    const current = byKey.get(key) || { binary: resolvedBinary, prefix: process.prefix, configPath: process.configPath, pids: [] };
    if (!current.pids.includes(process.pid)) current.pids.push(process.pid);
    byKey.set(key, current);
  });
  binaries.forEach((binary) => {
    if ([...byKey.values()].some((item) => item.binary === binary)) return;
    byKey.set(`${binary}||`, { binary, prefix: '', configPath: '', pids: [] });
  });
  return [...byKey.values()].slice(0, MAX_RUNTIME_CANDIDATES);
}

/**
 * 扫描服务器上的宿主机 Nginx 和前端站点。
 * @param {number} serverId - 服务器 ID
 * @param {{useSudo?: boolean}} options - 扫描选项
 * @param {{getServer?: Function, withConnection?: Function, execute?: Function}} dependencies - 可替换测试依赖
 * @returns {Promise<{useSudo: boolean, runtimes: Object[], warnings: string[], truncated: boolean}>} 扫描结果
 */
export async function discoverServerNginx(serverId, options = {}, dependencies = {}) {
  const getServer = dependencies.getServer || getServerWithCredential;
  const withConnection = dependencies.withConnection || withSsh;
  const execute = dependencies.execute || execSsh;
  const server = await getServer(serverId);
  if (!server) throw new Error('部署服务器不存在');
  const useSudo = options.useSudo === undefined ? Boolean(server.useSudo) : Boolean(options.useSudo);
  return withConnection(server, async (conn) => {
    const candidates = await discoverRuntimeCandidates(conn, execute, useSudo);
    const runtimes = [];
    const warnings = [];
    for (const candidate of candidates) {
      try {
        runtimes.push(await inspectNginxRuntime(conn, candidate, {
          execute,
          instances: Array.isArray(server.nginxInstances) ? server.nginxInstances : [],
          useSudo,
        }));
      } catch (error) {
        warnings.push(`${candidate.binary}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!candidates.length) warnings.push('没有在运行进程、系统 PATH、/home 或 /opt 常见目录中发现 Nginx');
    if (useSudo && warnings.some((item) => /password|sudo|权限|permission/i.test(item))) {
      warnings.push('当前扫描只支持非交互 sudo -n；请为 Nginx 读取命令配置免密 sudo，或使用手动接入');
    }
    return {
      useSudo,
      runtimes,
      warnings,
      truncated: candidates.length >= MAX_RUNTIME_CANDIDATES || runtimes.reduce((total, item) => total + item.sites.length, 0) >= MAX_DISCOVERED_SITES,
    };
  });
}
