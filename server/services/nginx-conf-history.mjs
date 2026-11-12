/**
 * Nginx 配置文件历史备份：列出、读取、校验与 sudo 感知的远程文本读取。
 *
 * 安全约束：
 * - 备份目录与文件名前缀一律由服务端根据部署目标解析出的配置路径推导，不接受客户端传入路径；
 * - 读取单个备份时只接受文件名，并按严格正则校验（不含 `/`、`..`、控制字符，必须是本文件前缀）；
 * - 只读取普通文件，拒绝软链、目录、设备文件；读取上限 512KB；含 NUL 字节视为二进制拒绝。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { execSsh, shellQuote } from './ssh-service.mjs';

/** 平台生成的备份时间戳后缀：14 位数字（UTC 的 YYYYMMDDHHmmss） */
export const NGINX_BACKUP_TIMESTAMP_RE = /^\d{14}$/;

/** 外部备份后缀允许的字符集（如 old、before-upgrade、20240101.1） */
const EXTERNAL_SUFFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 单个历史版本读取上限（字节） */
export const NGINX_HISTORY_MAX_BYTES = 512 * 1024;

/** 当前配置文件读取上限（字节），避免误配超大文件拖垮 SSH 通道 */
export const NGINX_CONF_MAX_BYTES = 2 * 1024 * 1024;

/** 历史列表最多返回条数（外部备份可能很多，防止响应过大） */
export const NGINX_HISTORY_LIST_LIMIT = 200;

/** 远程读取脚本退出码约定 */
const READ_EXIT = Object.freeze({
  notFound: 44,
  symlink: 45,
  notRegular: 46,
  unreadable: 47,
  tooLarge: 48,
});

/**
 * 计算文本内容 sha256（按 UTF-8 编码）。
 * @param {string} content - 文本内容
 * @returns {string} 十六进制摘要
 */
export function computeContentSha256(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

/**
 * 把 UTC 的 14 位时间戳解析为 ISO 字符串；非法日期（如 13 月、2 月 30 日）返回空串。
 * @param {string} stamp - YYYYMMDDHHmmss
 * @returns {string} ISO 时间或空串
 */
export function parseBackupTimestampUtc(stamp) {
  const text = String(stamp || '');
  if (!NGINX_BACKUP_TIMESTAMP_RE.test(text)) return '';
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const hour = Number(text.slice(8, 10));
  const minute = Number(text.slice(10, 12));
  const second = Number(text.slice(12, 14));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return '';
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return '';
  }
  return date.toISOString();
}

/**
 * 根据配置文件路径推导备份目录与文件名前缀。
 * @param {string} confPath - 服务端解析出的配置文件绝对路径
 * @returns {{ dir: string, base: string, prefix: string }} 目录、文件名与备份前缀
 */
export function resolveBackupLocation(confPath) {
  const raw = String(confPath || '').trim();
  if (!raw || !raw.startsWith('/') || raw.includes('\0')) {
    throw Object.assign(new Error('Nginx 配置文件路径无效，无法读取历史版本'), { statusCode: 400, code: 'NGINX_CONF_PATH_INVALID' });
  }
  const normalized = path.posix.normalize(raw);
  const base = path.posix.basename(normalized);
  if (!base || base === '/' || base === '.' || base === '..') {
    throw Object.assign(new Error('Nginx 配置文件路径无效，无法读取历史版本'), { statusCode: 400, code: 'NGINX_CONF_PATH_INVALID' });
  }
  return { dir: path.posix.dirname(normalized), base, prefix: `${base}.bak.` };
}

/**
 * 对备份文件名分类：平台备份（.bak.<14 位 UTC 时间戳>）或外部备份；不合法返回 null。
 * @param {string} base - 配置文件名
 * @param {string} name - 备份文件名
 * @returns {{ name: string, suffix: string, source: 'yuyan'|'external', createdAt: string } | null} 分类结果
 */
export function classifyBackupName(base, name) {
  const fileName = String(name ?? '');
  const prefix = `${base}.bak.`;
  if (!base || !fileName.startsWith(prefix) || fileName.length > 255) return null;
  if (fileName.includes('/') || fileName.includes('\\') || /[\u0000-\u001f\u007f]/.test(fileName)) return null;
  const suffix = fileName.slice(prefix.length);
  if (!suffix || suffix.includes('..')) return null;
  if (NGINX_BACKUP_TIMESTAMP_RE.test(suffix)) {
    const createdAt = parseBackupTimestampUtc(suffix);
    if (createdAt) return { name: fileName, suffix, source: 'yuyan', createdAt };
  }
  if (!EXTERNAL_SUFFIX_RE.test(suffix)) return null;
  return { name: fileName, suffix, source: 'external', createdAt: '' };
}

/**
 * 校验客户端传入的备份文件名，不合法时抛出 400。
 * @param {string} base - 配置文件名
 * @param {string} name - 客户端传入的文件名
 * @returns {{ name: string, suffix: string, source: 'yuyan'|'external', createdAt: string }} 分类结果
 */
export function assertSafeBackupName(base, name) {
  const classified = classifyBackupName(base, name);
  if (!classified) {
    throw Object.assign(new Error('历史版本文件名不合法'), { statusCode: 400, code: 'NGINX_HISTORY_NAME_INVALID' });
  }
  return classified;
}

/**
 * 构建列出备份文件的远程命令：GNU find 优先（一次拿到大小与 mtime），BusyBox 等不支持 -printf 时逐个文件回退。
 * 输出每行：`<size>\t<mtimeEpoch>\t<name>`；文件名过滤用 case + 引号前缀，避免配置文件名中的 glob 字符被解释。
 * @param {Object} options - 参数
 * @param {string} options.dir - 备份目录
 * @param {string} options.prefix - 备份前缀（<base>.bak.）
 * @param {boolean} [options.useSudo=false] - 是否 sudo -n
 * @returns {string} 远程命令
 */
export function buildListBackupsCommand({ dir, prefix, useSudo = false }) {
  const script = [
    'dir="$1"; prefix="$2";',
    '[ -d "$dir" ] || exit 0;',
    'if find "$dir" -maxdepth 0 -printf "" >/dev/null 2>&1; then',
    'find "$dir" -maxdepth 1 -type f -printf "%s\\t%T@\\t%f\\n" 2>/dev/null | while IFS= read -r line || [ -n "$line" ]; do',
    // JS 字符串里的 \t 是真实 tab：去掉「大小<TAB>mtime<TAB>」前缀得到文件名
    'name="${line#*\t*\t}"; case "$name" in ("$prefix"*) printf "%s\\n" "$line";; esac; done;',
    'else',
    'for f in "$dir"/* "$dir"/.[!.]*; do',
    'name="${f##*/}"; case "$name" in ("$prefix"*) ;; (*) continue;; esac;',
    '[ -f "$f" ] && [ ! -L "$f" ] || continue;',
    'size=$(wc -c < "$f" 2>/dev/null | tr -d " ");',
    'mtime=$(stat -c %Y "$f" 2>/dev/null || date -r "$f" +%s 2>/dev/null || echo 0);',
    'printf "%s\\t%s\\t%s\\n" "${size:-0}" "${mtime:-0}" "$name"; done;',
    'fi',
  ].join(' ');
  const sudo = useSudo ? 'sudo -n ' : '';
  return `${sudo}sh -c ${shellQuote(script)} sh ${shellQuote(dir)} ${shellQuote(prefix)}`;
}

/**
 * 解析列表命令输出，过滤非法文件名并按时间倒序排列。
 * 平台备份按文件名里的 UTC 时间排序，外部备份按 mtime 排序。
 * @param {string} stdout - 命令输出
 * @param {string} base - 配置文件名
 * @param {number} [limit] - 最多返回条数
 * @returns {{ items: Array<Object>, truncated: boolean }} 解析结果
 */
export function parseListBackupsOutput(stdout, base, limit = NGINX_HISTORY_LIST_LIMIT) {
  const seen = new Set();
  const items = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    const firstTab = line.indexOf('\t');
    const secondTab = firstTab >= 0 ? line.indexOf('\t', firstTab + 1) : -1;
    if (firstTab <= 0 || secondTab <= firstTab) continue;
    const size = Number(line.slice(0, firstTab));
    const mtimeEpoch = Number(line.slice(firstTab + 1, secondTab));
    const name = line.slice(secondTab + 1);
    if (seen.has(name)) continue;
    const classified = classifyBackupName(base, name);
    if (!classified) continue;
    seen.add(name);
    const mtime = Number.isFinite(mtimeEpoch) && mtimeEpoch > 0 ? new Date(Math.floor(mtimeEpoch * 1000)).toISOString() : '';
    items.push({
      ...classified,
      size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0,
      mtime,
      sortKey: classified.createdAt || mtime || '',
    });
  }
  items.sort((a, b) => (a.sortKey === b.sortKey ? b.name.localeCompare(a.name) : a.sortKey < b.sortKey ? 1 : -1));
  const truncated = items.length > limit;
  return { items: items.slice(0, limit).map(({ sortKey, ...item }) => item), truncated };
}

/**
 * 构建远程文本读取命令：以 base64 传输原始字节，避免 SSH 分块把多字节 UTF-8 字符截断成乱码。
 * @param {Object} options - 参数
 * @param {string} options.filePath - 文件路径
 * @param {number} options.maxBytes - 读取上限
 * @param {boolean} [options.rejectSymlink=false] - 是否拒绝软链
 * @param {boolean} [options.useSudo=false] - 是否 sudo -n
 * @returns {string} 远程命令
 */
export function buildReadTextCommand({ filePath, maxBytes, rejectSymlink = false, useSudo = false }) {
  const script = [
    'f="$1"; max="$2"; nolink="$3";',
    `if [ "$nolink" = 1 ] && [ -L "$f" ]; then exit ${READ_EXIT.symlink}; fi;`,
    `[ -e "$f" ] || [ -L "$f" ] || exit ${READ_EXIT.notFound};`,
    `[ -f "$f" ] || exit ${READ_EXIT.notRegular};`,
    `size=$(wc -c < "$f" 2>/dev/null | tr -d " ") || exit ${READ_EXIT.unreadable};`,
    `[ -n "$size" ] || exit ${READ_EXIT.unreadable};`,
    `if [ "$size" -gt "$max" ]; then printf "%s" "$size" >&2; exit ${READ_EXIT.tooLarge}; fi;`,
    'if command -v base64 >/dev/null 2>&1; then printf "B64\\n"; base64 < "$f"; else printf "RAW\\n"; cat -- "$f"; fi',
  ].join(' ');
  const sudo = useSudo ? 'sudo -n ' : '';
  return `${sudo}sh -c ${shellQuote(script)} sh ${shellQuote(filePath)} ${shellQuote(Math.max(1, Math.floor(Number(maxBytes) || 1)))} ${shellQuote(rejectSymlink ? 1 : 0)}`;
}

/**
 * 判断 sudo 本身不可用（需要密码、未安装、无 sudoers 授权），用于回退普通读取。
 * @param {{ code: number, stderr: string }} result - 执行结果
 * @returns {boolean} 是否 sudo 不可用
 */
export function isSudoUnavailable(result) {
  if (!result || result.code === 0) return false;
  if (result.code === 127 && /sudo/i.test(result.stderr || '')) return true;
  return /sudo:|a password is required|is not in the sudoers|not allowed to execute/i.test(result.stderr || '');
}

/**
 * 解析读取命令输出为文本，并做二进制检测。
 * @param {string} stdout - 命令输出
 * @returns {{ content: string, size: number, encodingWarning: boolean }} 文本内容
 */
export function decodeReadTextOutput(stdout) {
  const text = String(stdout || '');
  const newlineIndex = text.indexOf('\n');
  const marker = newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
  const body = newlineIndex >= 0 ? text.slice(newlineIndex + 1) : '';
  let buffer;
  if (marker === 'B64') {
    buffer = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  } else if (marker === 'RAW') {
    buffer = Buffer.from(body, 'utf8');
  } else {
    throw Object.assign(new Error('读取远程文件失败：输出格式无法识别'), { statusCode: 502, code: 'NGINX_READ_FAILED' });
  }
  if (buffer.includes(0)) {
    throw Object.assign(new Error('目标文件似乎是二进制内容，无法作为 Nginx 配置查看'), { statusCode: 415, code: 'ERR_BINARY_NOT_SUPPORTED' });
  }
  let encodingWarning = false;
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    encodingWarning = true;
    content = new TextDecoder('utf-8').decode(buffer);
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return { content, size: buffer.length, encodingWarning };
}

/**
 * 把读取命令的退出码转换为业务错误。
 * @param {{ code: number, stderr: string }} result - 执行结果
 * @param {string} filePath - 文件路径
 * @param {number} maxBytes - 上限
 * @returns {Error} 错误
 */
function toReadError(result, filePath, maxBytes) {
  switch (result.code) {
    case READ_EXIT.notFound:
      return Object.assign(new Error(`文件 ${filePath} 不存在，可能已被清理`), { statusCode: 404, code: 'ENOENT' });
    case READ_EXIT.symlink:
      return Object.assign(new Error('出于安全考虑，不读取软链接形式的历史版本'), { statusCode: 400, code: 'NGINX_HISTORY_SYMLINK' });
    case READ_EXIT.notRegular:
      return Object.assign(new Error(`${filePath} 不是普通文件`), { statusCode: 400, code: 'NGINX_HISTORY_NOT_FILE' });
    case READ_EXIT.tooLarge: {
      const size = Number(String(result.stderr || '').trim()) || 0;
      return Object.assign(
        new Error(`文件大小（${(size / 1024).toFixed(1)}KB）超过上限 ${(maxBytes / 1024).toFixed(0)}KB`),
        { statusCode: 413, code: 'ERR_FILE_TOO_LARGE' }
      );
    }
    default:
      return Object.assign(
        new Error(`读取 ${filePath} 失败（退出码 ${result.code}）：${String(result.stderr || '').trim() || '没有读取权限'}`),
        { statusCode: 403, code: 'NGINX_READ_FAILED' }
      );
  }
}

/**
 * sudo 感知地读取远程文本：配置了 sudo 时先 sudo -n 读取，sudo 不可用则回退普通读取。
 * @param {Object} conn - SSH 连接
 * @param {Object} options - 参数
 * @param {string} options.filePath - 文件路径
 * @param {boolean} [options.useSudo=false] - 是否优先 sudo
 * @param {number} [options.maxBytes] - 上限
 * @param {boolean} [options.rejectSymlink=false] - 是否拒绝软链
 * @param {boolean} [options.allowMissing=false] - 文件不存在时返回空内容而不是报错
 * @returns {Promise<{ exists: boolean, content: string, size: number, sha256: string, encodingWarning: boolean, usedSudo: boolean }>} 读取结果
 */
export async function readRemoteTextSafe(conn, options) {
  const { filePath, useSudo = false, rejectSymlink = false, allowMissing = false } = options;
  const maxBytes = Math.max(1024, Number(options.maxBytes || NGINX_HISTORY_MAX_BYTES));
  const maxOutputBytes = Math.ceil(maxBytes * 1.4) + 64 * 1024;
  const run = (sudo) => execSsh(conn, buildReadTextCommand({ filePath, maxBytes, rejectSymlink, useSudo: sudo }), {
    label: `读取 ${filePath}`,
    allowFailure: true,
    maxOutputBytes,
    timeoutMs: 30_000,
  });
  let result = await run(Boolean(useSudo));
  let usedSudo = Boolean(useSudo);
  if (useSudo && isSudoUnavailable(result)) {
    result = await run(false);
    usedSudo = false;
  }
  if (result.code === READ_EXIT.notFound && allowMissing) {
    return { exists: false, content: '', size: 0, sha256: computeContentSha256(''), encodingWarning: false, usedSudo };
  }
  if (result.code !== 0) throw toReadError(result, filePath, maxBytes);
  const decoded = decodeReadTextOutput(result.stdout);
  return { exists: true, ...decoded, sha256: computeContentSha256(decoded.content), usedSudo };
}

/**
 * 列出某个配置文件的历史备份。
 * @param {Object} conn - SSH 连接
 * @param {Object} options - 参数
 * @param {string} options.confPath - 服务端解析的配置文件路径
 * @param {boolean} [options.useSudo=false] - 是否优先 sudo
 * @returns {Promise<{ dir: string, base: string, items: Array<Object>, truncated: boolean }>} 历史列表
 */
export async function listRemoteBackups(conn, { confPath, useSudo = false }) {
  const { dir, base, prefix } = resolveBackupLocation(confPath);
  const run = (sudo) => execSsh(conn, buildListBackupsCommand({ dir, prefix, useSudo: sudo }), {
    label: `列出 ${base} 历史备份`,
    allowFailure: true,
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 30_000,
  });
  let result = await run(Boolean(useSudo));
  if (useSudo && isSudoUnavailable(result)) result = await run(false);
  if (result.code !== 0) {
    throw Object.assign(
      new Error(`列出历史备份失败（退出码 ${result.code}）：${String(result.stderr || '').trim() || '没有目录读取权限'}`),
      { statusCode: 403, code: 'NGINX_HISTORY_LIST_FAILED' }
    );
  }
  return { dir, base, ...parseListBackupsOutput(result.stdout, base) };
}

/**
 * 读取单个历史备份内容。
 * @param {Object} conn - SSH 连接
 * @param {Object} options - 参数
 * @param {string} options.confPath - 服务端解析的配置文件路径
 * @param {string} options.name - 客户端传入的备份文件名（会严格校验）
 * @param {boolean} [options.useSudo=false] - 是否优先 sudo
 * @returns {Promise<Object>} 历史版本内容
 */
export async function readRemoteBackup(conn, { confPath, name, useSudo = false }) {
  const { dir, base } = resolveBackupLocation(confPath);
  const classified = assertSafeBackupName(base, name);
  const filePath = path.posix.join(dir, classified.name);
  // 拼接后再做一次边界校验，确保仍在同一目录下
  if (path.posix.dirname(filePath) !== dir || path.posix.basename(filePath) !== classified.name) {
    throw Object.assign(new Error('历史版本文件名不合法'), { statusCode: 400, code: 'NGINX_HISTORY_NAME_INVALID' });
  }
  const read = await readRemoteTextSafe(conn, { filePath, useSudo, rejectSymlink: true, maxBytes: NGINX_HISTORY_MAX_BYTES });
  return { ...classified, path: filePath, content: read.content, size: read.size, sha256: read.sha256, encodingWarning: read.encodingWarning };
}
