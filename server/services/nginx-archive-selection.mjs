/**
 * Nginx 运行包站点选择工具。
 * @description 只解析主配置 http 上下文中的直接 server 块，并保留原始文本位置用于安全裁剪。
 */

import crypto from 'node:crypto';
import path from 'node:path';

/** 支持导出的运行包类型。 */
export const NGINX_ARCHIVE_TYPES = new Set(['all', 'html', 'conf']);

/** 系统高危根目录黑名单，禁止作为静态根目录打包。 */
const DANGEROUS_SYSTEM_ROOTS = new Set([
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/var',
  '/root',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/lib',
  '/lib64',
]);

/**
 * 规范化 Nginx 绝对路径。
 * @param {string} value - 原始路径
 * @returns {string} 规范化路径
 */
export function normalizeNginxArchivePath(value) {
  const normalized = path.posix.normalize(String(value || '').trim().replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '/' || !normalized.startsWith('/') || normalized.startsWith('/../')) {
    return '';
  }
  if (DANGEROUS_SYSTEM_ROOTS.has(normalized)) {
    return '';
  }
  return normalized;
}

/**
 * 读取一个带引号的 Nginx token。
 * @param {string} content - 配置文本
 * @param {number} start - 起始位置
 * @returns {{ value: string, end: number }} token 内容和结束位置
 */
function readQuotedToken(content, start) {
  const quote = content[start];
  let value = '';
  let index = start + 1;
  while (index < content.length) {
    const char = content[index];
    if (char === '\\' && index + 1 < content.length) {
      value += content[index + 1];
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  return { value, end: content.length };
}

/**
 * 将 Nginx 配置转换为保留位置的轻量 token。
 * @param {string} content - 配置文本
 * @returns {Array<{type: 'word'|'brace-open'|'brace-close'|'semicolon', value: string, start: number, end: number}>} token 列表
 */
export function tokenizeNginxConfig(content) {
  const tokens = [];
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '#') {
      const newlineIndex = content.indexOf('\n', index + 1);
      index = newlineIndex < 0 ? content.length : newlineIndex + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quoted = readQuotedToken(content, index);
      tokens.push({ type: 'word', value: quoted.value, start: index, end: quoted.end });
      index = quoted.end;
      continue;
    }
    if (char === '{' || char === '}' || char === ';') {
      tokens.push({
        type: char === '{' ? 'brace-open' : char === '}' ? 'brace-close' : 'semicolon',
        value: char,
        start: index,
        end: index + 1,
      });
      index += 1;
      continue;
    }
    const start = index;
    while (index < content.length && !/[\s{};'"#]/.test(content[index])) {
      index += 1;
    }
    if (index > start) {
      tokens.push({ type: 'word', value: content.slice(start, index), start, end: index });
      continue;
    }
    index += 1;
  }
  return tokens;
}

/**
 * 从 listen 指令参数中提取端口。
 * @param {string[]} args - listen 参数
 * @returns {number|null} 端口
 */
export function parseNginxListenPort(args) {
  const endpoint = String(args[0] || '').trim();
  if (/^\d{1,5}$/.test(endpoint)) return Number(endpoint);
  const colonPort = endpoint.match(/:(\d{1,5})$/);
  if (colonPort) return Number(colonPort[1]);
  return null;
}

/**
 * 解析单个 server 块的指令。
 * @param {Array<Object>} tokens - 全部 token
 * @param {number} openIndex - server 左花括号 token 下标
 * @param {number} closeIndex - server 右花括号 token 下标
 * @returns {{listenPorts: number[], listenValues: string[], roots: string[], serverNames: string[]}} 提取结果
 */
function parseServerDirectives(tokens, openIndex, closeIndex) {
  const listenPorts = new Set();
  const listenValues = new Set();
  const roots = new Set();
  const serverNames = new Set();
  let depth = 1;
  let statement = [];

  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const token = tokens[index];
    if (token.type === 'brace-open') {
      depth += 1;
      statement = [];
      continue;
    }
    if (token.type === 'brace-close') {
      depth = Math.max(1, depth - 1);
      statement = [];
      continue;
    }
    if (token.type !== 'semicolon') {
      if (token.type === 'word') statement.push(token.value);
      continue;
    }

    const directive = String(statement[0] || '').toLowerCase();
    const args = statement.slice(1);
    if (directive === 'root') {
      const root = normalizeNginxArchivePath(args[0]);
      if (root) roots.add(root);
    } else if (depth === 1 && directive === 'listen') {
      const rawValue = args.join(' ').trim();
      if (rawValue) listenValues.add(rawValue);
      const port = parseNginxListenPort(args);
      if (port && port <= 65535) listenPorts.add(port);
    } else if (depth === 1 && directive === 'server_name') {
      args.filter(Boolean).forEach((value) => serverNames.add(value));
    }
    statement = [];
  }

  return {
    listenPorts: [...listenPorts],
    listenValues: [...listenValues],
    roots: [...roots],
    serverNames: [...serverNames],
  };
}

/**
 * 解析主配置中的 http 直接 server 块。
 * @param {string} content - nginx.conf 内容
 * @returns {{revision: string, sites: Array<Object>, blocks: Array<Object>}} 解析结果
 */
export function parseNginxArchiveSites(content) {
  const source = String(content || '');
  const revision = crypto.createHash('sha256').update(source).digest('hex');
  const tokens = tokenizeNginxConfig(source);
  const contextStack = [];
  const blocks = [];
  let pendingContext = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'word') {
      pendingContext.push(token);
      continue;
    }
    if (token.type === 'semicolon') {
      pendingContext = [];
      continue;
    }
    if (token.type === 'brace-open') {
      const nameToken = pendingContext[0] || null;
      const context = {
        name: String(nameToken?.value || '').toLowerCase(),
        start: nameToken?.start ?? token.start,
        openIndex: index,
      };
      const parent = contextStack.at(-1);
      contextStack.push(context);
      pendingContext = [];

      if (context.name !== 'server' || (parent && parent.name !== 'http')) continue;
      let nestedDepth = 1;
      let closeIndex = index + 1;
      for (; closeIndex < tokens.length; closeIndex += 1) {
        if (tokens[closeIndex].type === 'brace-open') nestedDepth += 1;
        if (tokens[closeIndex].type === 'brace-close') nestedDepth -= 1;
        if (nestedDepth === 0) break;
      }
      const closeToken = tokens[closeIndex];
      if (!closeToken) continue;
      const raw = source.slice(context.start, closeToken.end);
      const occurrence = blocks.filter((item) => item.raw === raw).length;
      const id = `site-${crypto.createHash('sha256').update(`${raw}\0${occurrence}`).digest('hex').slice(0, 16)}`;
      blocks.push({
        id,
        start: context.start,
        end: closeToken.end,
        raw,
        ...parseServerDirectives(tokens, index, closeIndex),
      });
      continue;
    }
    if (token.type === 'brace-close') {
      contextStack.pop();
      pendingContext = [];
    }
  }

  const sites = blocks.map((block, order) => ({
    id: block.id,
    order,
    listenPorts: block.listenPorts,
    listenValues: block.listenValues,
    roots: block.roots,
    serverNames: block.serverNames,
  }));
  return { revision, sites, blocks };
}

/**
 * 只保留所选 server 块并保留全部公共配置。
 * @param {string} content - 原 nginx.conf
 * @param {Array<Object>} blocks - 已解析的 server 块
 * @param {string[]} selectedIds - 所选 server ID
 * @returns {string} 裁剪后的配置
 */
export function filterNginxConfigBySiteIds(content, blocks, selectedIds) {
  const selected = new Set(selectedIds);
  let cursor = 0;
  let output = '';
  for (const block of blocks) {
    output += content.slice(cursor, block.start);
    if (selected.has(block.id)) output += content.slice(block.start, block.end);
    cursor = block.end;
  }
  output += content.slice(cursor);
  return output;
}

/**
 * 去重并移除已被父目录覆盖的归档根目录。
 * @param {string[]} roots - 原始根目录
 * @returns {string[]} 最小根目录集合
 */
export function minimizeArchiveRoots(roots) {
  const normalized = [...new Set(roots.map(normalizeNginxArchivePath).filter(Boolean))]
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return normalized.filter((candidate, index) => !normalized.slice(0, index).some((parent) => candidate.startsWith(`${parent}/`)));
}

/**
 * 校验站点选择并生成归档上下文。
 * @param {string} content - 最新 nginx.conf
 * @param {{siteIds?: string[], revision?: string, type?: string}} selection - 客户端选择
 * @returns {{revision: string, sites: Object[], roots: string[], filteredConfig: string, blocks: Object[]}} 归档上下文
 */
export function resolveNginxArchiveSelection(content, selection = {}) {
  const type = String(selection.type || 'all');
  if (!NGINX_ARCHIVE_TYPES.has(type)) throw new Error('不支持的运行包下载类型');
  const parsed = parseNginxArchiveSites(content);
  if (selection.revision && selection.revision !== parsed.revision) {
    const error = new Error('Nginx 配置已发生变化，请刷新站点列表后重新选择');
    error.status = 409;
    error.code = 'nginx_config_changed';
    throw error;
  }
  const ids = [...new Set((selection.siteIds || []).map((value) => String(value || '').trim()).filter(Boolean))];
  if (!ids.length) throw new Error('请至少选择一个 Nginx server');
  const siteMap = new Map(parsed.sites.map((site) => [site.id, site]));
  const sites = ids.map((id) => siteMap.get(id));
  if (sites.some((site) => !site)) throw new Error('所选 Nginx server 已失效，请刷新后重试');
  if (type !== 'conf' && sites.some((site) => !site.roots.length)) {
    throw new Error('所选 Nginx server 中存在未配置 root 的反向代理，只能下载 Nginx 配置文件');
  }
  const roots = minimizeArchiveRoots(sites.flatMap((site) => site.roots));
  if (type !== 'conf' && !roots.length) {
    throw new Error('所选 Nginx server 未配置 root，只能下载 Nginx 配置文件');
  }
  return {
    revision: parsed.revision,
    sites,
    roots,
    blocks: parsed.blocks,
    filteredConfig: filterNginxConfigBySiteIds(content, parsed.blocks, ids),
  };
}

/** 需要提取文件路径参数的 Nginx 指令集合。 */
const DIRECTIVE_FILE_ARGS = new Set([
  'auth_basic_user_file',
  'ssl_certificate',
  'ssl_certificate_key',
  'ssl_trusted_certificate',
  'ssl_client_certificate',
  'ssl_dhparam',
  'ssl_password_file',
  'include',
  'root',
  'alias',
]);

/**
 * 收集路径中所有以点开头段对应的累计绝对路径。
 * 例如：'/data/.certs/keys/.auth/pass' ->
 * ['/data/.certs', '/data/.certs/keys', '/data/.certs/keys/.auth', '/data/.certs/keys/.auth/pass']
 *
 * @param {string} absPath - 规范化的绝对路径
 * @returns {string[]} 涉及的白名单路径列表
 */
export function collectDotPathWhitelists(absPath) {
  if (!absPath || !absPath.startsWith('/')) return [];
  const parts = absPath.split('/').filter(Boolean);
  const firstDotIndex = parts.findIndex((p) => p.startsWith('.') && p !== '.well-known');
  if (firstDotIndex === -1) return [];

  const results = [];
  let current = '';
  for (let i = 0; i < parts.length; i += 1) {
    current += `/${parts[i]}`;
    if (i >= firstDotIndex) {
      results.push(current);
    }
  }
  return results;
}

/**
 * 解析 Nginx 配置内容中引用的关键路径，并提取包含隐藏段（以 . 开头）的文件或目录白名单。
 *
 * @param {string} content - Nginx 配置内容
 * @param {Object} [options] - 路径解析上下文
 * @param {string} [options.prefix] - Nginx 安装根目录或工作前缀
 * @param {string} [options.confDir] - 配置文件所在目录
 * @returns {string[]} 需要放行的绝对路径白名单列表
 */
export function resolveNginxArchiveWhitelist(content, options = {}) {
  const source = String(content || '').trim();
  if (!source) return [];

  const prefix = options.prefix ? path.posix.normalize(String(options.prefix).trim().replace(/\\/g, '/')).replace(/\/+$/, '') : '';
  const confDir = options.confDir ? path.posix.normalize(String(options.confDir).trim().replace(/\\/g, '/')).replace(/\/+$/, '') : '';

  // 从 nginx -T 输出中提取所有包含的子配置文件路径与其所在目录
  const includeConfDirs = new Set();
  const fileHeaderRegex = /^#\s*configuration file\s+([^:]+):/gm;
  let fileMatch;
  while ((fileMatch = fileHeaderRegex.exec(source)) !== null) {
    const includedFile = fileMatch[1].trim();
    if (includedFile) {
      includeConfDirs.add(path.posix.dirname(path.posix.normalize(includedFile.replace(/\\/g, '/'))));
    }
  }

  const tokens = tokenizeNginxConfig(source);
  const rawPaths = [];
  let statement = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'brace-open' || token.type === 'brace-close') {
      statement = [];
      continue;
    }
    if (token.type !== 'semicolon') {
      if (token.type === 'word') statement.push(token.value);
      continue;
    }

    const directive = String(statement[0] || '').toLowerCase();
    const args = statement.slice(1);
    statement = [];

    if (!directive || args.length === 0) continue;

    if (DIRECTIVE_FILE_ARGS.has(directive)) {
      const candidate = String(args[0] || '').trim();
      if (candidate) rawPaths.push(candidate);
    } else if (directive === 'error_page') {
      // 格式：error_page 404 /404.html; 或 error_page 500 = /err.html;
      const candidate = String(args[args.length - 1] || '').trim();
      if (candidate && !/^\d+$/.test(candidate) && !candidate.startsWith('=')) {
        rawPaths.push(candidate);
      }
    } else if (directive === 'try_files') {
      // 格式：try_files $uri $uri/ /index.html =404;
      for (const arg of args) {
        const candidate = String(arg || '').trim();
        if (candidate.startsWith('/') && !candidate.startsWith('=')) {
          rawPaths.push(candidate);
        }
      }
    }
  }

  const whitelist = new Set();

  for (const raw of rawPaths) {
    // 忽略变量插值与网络协议地址
    if (!raw || raw.startsWith('$') || /^https?:\/\//i.test(raw)) continue;

    // 清洗首尾引号
    const cleaned = raw.replace(/^['"]|['"]$/g, '');

    // 解析绝对路径
    const candidates = [];
    if (cleaned.startsWith('/')) {
      candidates.push(cleaned);
    } else {
      if (confDir) candidates.push(path.posix.resolve(confDir, cleaned));
      if (prefix && prefix !== confDir) candidates.push(path.posix.resolve(prefix, cleaned));
      for (const incDir of includeConfDirs) {
        if (incDir !== confDir && incDir !== prefix) {
          candidates.push(path.posix.resolve(incDir, cleaned));
        }
      }
      if (!confDir && !prefix && includeConfDirs.size === 0) candidates.push(path.posix.resolve('/', cleaned));
    }

    for (const cand of candidates) {
      const normalized = path.posix.normalize(cand).replace(/\/+$/, '') || '/';
      const dotPaths = collectDotPathWhitelists(normalized);
      for (const item of dotPaths) {
        whitelist.add(item);
      }
    }
  }

  return [...whitelist].sort();
}

