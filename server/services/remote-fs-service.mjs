/**
 * 远程文件系统服务
 * @description 为独立服务器提供受控、只读的作用域远程目录浏览、文本预览及单次命令执行
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { getServerWithCredential, listTargets } from './deploy-store.mjs';
import { execSsh, getSftp, shellQuote, streamSshCommand, withSsh } from './ssh-service.mjs';

/** 单目录最多返回条目数。 */
export const MAX_FS_DIRECTORY_ENTRIES = 500;

/** 文本文件预览大小上限 (512KB)。 */
export const MAX_PREVIEW_FILE_BYTES = 512 * 1024;

/** 单次命令执行默认超时 (15s)。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 15_000;

/** 单次命令执行最大超时 (30s)。 */
export const MAX_EXEC_TIMEOUT_MS = 30_000;

/** 单次命令最大输出限制 (256KB)。 */
export const MAX_EXEC_OUTPUT_BYTES = 256 * 1024;

/** 禁止执行的交互式或阻塞式命令正则。 */
const BLOCKED_COMMANDS_REGEX = /(?:^|[;&|`$()\s])(?:vim?|nano|less|more|top|htop|watch|tail\s+-f|gdb|tmux|screen)(?:$|[;&|`$()\s])/i;

/**
 * 规范化 POSIX 绝对路径。
 * @param {string} inputPath - 原始路径
 * @returns {string} 规范化后的绝对路径
 */
export function normalizePosixPath(inputPath) {
  const trimmed = String(inputPath || '').trim().replace(/\\/g, '/');
  if (!trimmed) return '/';
  const resolved = path.posix.normalize(trimmed);
  const withLeadingSlash = resolved.startsWith('/') ? resolved : `/${resolved}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')) {
    return withLeadingSlash.slice(0, -1);
  }
  return withLeadingSlash;
}

/**
 * 格式化文件权限。
 * @param {number} mode - 文件 mode 掩码
 * @returns {string} 权限字符表示（如 'rwxr-xr-x'）
 */
export function formatPosixPermissions(mode) {
  if (typeof mode !== 'number') return '---------';
  const flags = [
    mode & 0o400 ? 'r' : '-',
    mode & 0o200 ? 'w' : '-',
    mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-',
    mode & 0o020 ? 'w' : '-',
    mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-',
    mode & 0o002 ? 'w' : '-',
    mode & 0o001 ? 'x' : '-',
  ].join('');
  return flags;
}

/**
 * 检查 Buffer 是否包含空字节从而判定为二进制。
 * @param {Buffer} buffer - 字节流
 * @returns {boolean} 是否为二进制
 */
export function isBinaryBuffer(buffer) {
  const checkLen = Math.min(buffer.length, 4096);
  for (let i = 0; i < checkLen; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * 推导服务器的有效作用域允许根列表。
 * @param {Object} server - 服务器配置
 * @param {Object[]} [targets=[]] - 服务器关联的部署目标
 * @returns {Array<{id: string, label: string, path: string, isDefault?: boolean}>} 允许根集合
 */
export function resolveServerAllowedRoots(server, targets = []) {
  const roots = [];
  const seenPaths = new Set();

  /**
   * 添加并去重允许根。
   * @param {string} id - 标识
   * @param {string} label - 标签
   * @param {string} rawPath - 原始路径
   * @param {boolean} [isDefault=false] - 是否默认
   */
  const addRoot = (id, label, rawPath, isDefault = false) => {
    const normalized = normalizePosixPath(rawPath);
    if (!normalized || normalized === '/') return;
    const segments = normalized.split('/').filter(Boolean);
    // 强制要求允许根至少有两级目录，严防根目录 '/' 或 '/etc' 等范围过宽
    if (segments.length < 2) return;
    if (seenPaths.has(normalized)) return;
    seenPaths.add(normalized);
    roots.push({ id, label, path: normalized, isDefault });
  };

  // 1. 服务器默认部署根
  if (server?.defaultDeployRoot) {
    addRoot('server-deploy-root', '站点根目录', server.defaultDeployRoot, true);
    const parentDir = path.posix.dirname(normalizePosixPath(server.defaultDeployRoot));
    addRoot('server-deploy-parent', '站点根上级', parentDir);
  }

  // 2. Nginx 实例静态站点与配置目录
  const nginxInstances = Array.isArray(server?.nginxInstances) ? server.nginxInstances : [];
  nginxInstances.forEach((instance) => {
    const name = instance.name || `实例 ${instance.id}`;
    if (instance.htmlRoot) {
      addRoot(`nginx-html-${instance.id}`, `站点目录 (${name})`, instance.htmlRoot);
      const parentDir = path.posix.dirname(normalizePosixPath(instance.htmlRoot));
      addRoot(`nginx-parent-${instance.id}`, `部署根 (${name})`, parentDir);
    }
    if (instance.defaultDeployRoot) {
      addRoot(`nginx-deploy-${instance.id}`, `部署根 (${name})`, instance.defaultDeployRoot);
      const parentDir = path.posix.dirname(normalizePosixPath(instance.defaultDeployRoot));
      addRoot(`nginx-deploy-parent-${instance.id}`, `部署根上级 (${name})`, parentDir);
    }
    if (instance.configPath) {
      const confDir = path.posix.dirname(normalizePosixPath(instance.configPath));
      addRoot(`nginx-conf-${instance.id}`, `Nginx 配置 (${name})`, confDir);
    }
  });

  // 3. 服务器默认后端目录（如有）
  if (server?.defaultBackendRoot) {
    addRoot('server-backend-root', '后端服务根', server.defaultBackendRoot);
  }

  // 4. 当前服务器已配置的部署目标（Deploy Targets）
  const serverId = Number(server?.id || 0);
  const matchedTargets = targets.filter((target) => Number(target?.serverId || 0) === serverId);
  matchedTargets.forEach((target) => {
    if (target?.deployRoot) {
      const projectName = target.projectName || target.projectPath || `项目 ${target.id}`;
      addRoot(`target-${target.id}`, `部署目标 (${projectName})`, target.deployRoot);
    }
  });

  if (roots.length === 0) {
    throw new Error('当前服务器未配置任何前端或 Nginx 作用域根目录，请先完善服务器默认部署路径');
  }

  // 若没有被标记为默认的，将第一个根设为默认
  if (!roots.some((r) => r.isDefault)) {
    roots[0].isDefault = true;
  }

  return roots;
}

/**
 * 校验目标路径是否落在允许根范围内（字符串层词法校验）。
 * @param {string} targetPath - 待检查路径
 * @param {Array<{path: string}>} allowedRoots - 允许根集合
 * @returns {string} 匹配的允许根路径
 */
export function assertPathWithinRoots(targetPath, allowedRoots) {
  const normalized = normalizePosixPath(targetPath);
  const matchedRoot = allowedRoots.find((root) => {
    const rootPath = root.path;
    return normalized === rootPath || normalized.startsWith(`${rootPath}/`);
  });

  if (!matchedRoot) {
    const error = new Error(`访问被拒绝：路径 "${normalized}" 超出服务器允许的访问范围`);
    error.code = 'ERR_FS_OUT_OF_BOUNDS';
    error.status = 403;
    throw error;
  }

  return matchedRoot.path;
}

/**
 * 利用 SFTP realpath 检查软链接或真实路径是否穿出允许根。
 * @param {Object} sftp - SFTP 实例
 * @param {string} targetPath - 待检查路径
 * @param {Array<{path: string}>} allowedRoots - 允许根集合
 * @returns {Promise<string>} 解析后的真实绝对路径
 */
export async function assertSafeRealpath(sftp, targetPath, allowedRoots) {
  return new Promise((resolve, reject) => {
    sftp.realpath(targetPath, (error, resolvedRealpath) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const normalizedReal = normalizePosixPath(resolvedRealpath);
        assertPathWithinRoots(normalizedReal, allowedRoots);
        resolve(normalizedReal);
      } catch (checkError) {
        reject(checkError);
      }
    });
  });
}

/**
 * 获取服务器的文件浏览根列表。
 * @param {number} serverId - 服务器 ID
 * @returns {Promise<{roots: Array<{id: string, label: string, path: string, isDefault?: boolean}>}>} 允许根
 */
export async function getServerFsRoots(serverId) {
  const server = await getServerWithCredential(Number(serverId));
  if (!server) {
    throw new Error(`服务器 ID ${serverId} 不存在`);
  }
  const targets = await listTargets();
  const roots = resolveServerAllowedRoots(server, targets);
  return { roots };
}

/**
 * 异步读取远程目录条目并按桌面文件规范整理。
 * @param {number} serverId - 服务器 ID
 * @param {string} [requestedPath] - 请求的目录路径
 * @param {Object} [options] - 选项
 * @returns {Promise<{currentPath: string, rootPath: string, isAtRoot: boolean, truncated: boolean, entries: Object[]}>} 目录内容
 */
export async function listRemoteFsDirectory(serverId, requestedPath, options = {}) {
  const server = await getServerWithCredential(Number(serverId));
  if (!server) throw new Error(`服务器 ID ${serverId} 不存在`);

  const targets = await listTargets();
  const allowedRoots = resolveServerAllowedRoots(server, targets);

  // 若未传 requestedPath 或为空，默认落到首个（默认）允许根
  const defaultRoot = allowedRoots.find((r) => r.isDefault) || allowedRoots[0];
  const targetPath = requestedPath ? normalizePosixPath(requestedPath) : defaultRoot.path;

  // 1. 词法边界校验
  const matchedRootPath = assertPathWithinRoots(targetPath, allowedRoots);

  return withSsh(server, async (conn) => {
    const sftp = await getSftp(conn);

    // 2. 真实路径防逃逸校验
    await assertSafeRealpath(sftp, targetPath, allowedRoots);

    // 3. 读取 SFTP 目录内容
    const rawEntries = await new Promise((resolve, reject) => {
      sftp.readdir(targetPath, (error, list) => {
        if (error) {
          if (error.code === 2 || error.message?.includes('No such file')) {
            const notFoundError = new Error(`远程目录 "${targetPath}" 不存在`);
            notFoundError.code = 'ENOENT';
            notFoundError.status = 404;
            reject(notFoundError);
            return;
          }
          if (error.code === 3 || error.message?.includes('Permission denied')) {
            const permError = new Error(`无权限访问远程目录 "${targetPath}"`);
            permError.code = 'EACCES';
            permError.status = 403;
            reject(permError);
            return;
          }
          reject(error);
          return;
        }
        resolve(Array.isArray(list) ? list : []);
      });
    });

    const limit = Math.max(1, Number(options.limit || MAX_FS_DIRECTORY_ENTRIES));
    const processedEntries = [];

    for (const item of rawEntries) {
      const name = String(item.filename || '').trim();
      if (!name || name === '.' || name === '..') continue;

      const attrs = item.attrs || {};
      const isDir = Boolean(attrs.isDirectory?.());
      const isSymlink = Boolean(attrs.isSymbolicLink?.());
      const isRegularFile = Boolean(attrs.isFile?.());

      // 仅展示目录、符号链接和普通文件，过滤管道、块设备、套接字等
      if (!isDir && !isSymlink && !isRegularFile) continue;

      const type = isDir ? 'directory' : isSymlink ? 'symlink' : 'file';
      const ext = !isDir && name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';

      processedEntries.push({
        name,
        path: path.posix.join(targetPath, name),
        type,
        extension: ext,
        size: isDir ? null : Number(attrs.size || 0),
        mtime: attrs.mtime ? Number(attrs.mtime) * 1000 : null,
        permissions: formatPosixPermissions(attrs.mode),
        readable: true,
      });
    }

    // 排序规则：目录在前，文件在后；名称按字典升序排
    processedEntries.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });

    const truncated = processedEntries.length > limit;
    const entries = truncated ? processedEntries.slice(0, limit) : processedEntries;
    const isAtRoot = targetPath === matchedRootPath;

    return {
      currentPath: targetPath,
      rootPath: matchedRootPath,
      isAtRoot,
      truncated,
      entries,
    };
  });
}

/**
 * 读取远程文本文件进行只读预览。
 * @param {number} serverId - 服务器 ID
 * @param {string} filePath - 文件路径
 * @param {Object} [options] - 选项
 * @returns {Promise<{path: string, size: number, content: string, encoding: string, mimeType: string}>} 预览内容
 */
export async function readRemoteFsFile(serverId, filePath, options = {}) {
  const server = await getServerWithCredential(Number(serverId));
  if (!server) throw new Error(`服务器 ID ${serverId} 不存在`);

  const targets = await listTargets();
  const allowedRoots = resolveServerAllowedRoots(server, targets);
  const normalizedPath = normalizePosixPath(filePath);

  // 1. 词法边界校验
  assertPathWithinRoots(normalizedPath, allowedRoots);

  const maxBytes = Math.max(1024, Number(options.maxBytes || MAX_PREVIEW_FILE_BYTES));

  return withSsh(server, async (conn) => {
    const sftp = await getSftp(conn);

    // 2. 真实路径防逃逸校验
    await assertSafeRealpath(sftp, normalizedPath, allowedRoots);

    // 3. 文件 stat 检查
    const attrs = await new Promise((resolve, reject) => {
      sftp.stat(normalizedPath, (error, stat) => {
        if (error) {
          if (error.code === 2) {
            const err = new Error(`文件 "${normalizedPath}" 不存在`);
            err.code = 'ENOENT';
            err.status = 404;
            reject(err);
            return;
          }
          reject(error);
          return;
        }
        resolve(stat);
      });
    });

    if (attrs.isDirectory?.()) {
      const dirError = new Error(`"${normalizedPath}" 是一个目录，无法作为文本预览`);
      dirError.status = 400;
      throw dirError;
    }

    const fileSize = Number(attrs.size || 0);
    if (fileSize > maxBytes) {
      const sizeError = new Error(`文件大小（${(fileSize / 1024).toFixed(1)}KB）超过预览上限 ${(maxBytes / 1024).toFixed(0)}KB`);
      sizeError.code = 'ERR_FILE_TOO_LARGE';
      sizeError.status = 413;
      throw sizeError;
    }

    // 4. 读取文件 Buffer
    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      let totalLength = 0;
      const readStream = sftp.createReadStream(normalizedPath);

      readStream.on('data', (chunk) => {
        chunks.push(chunk);
        totalLength += chunk.length;
        if (totalLength > maxBytes) {
          readStream.destroy();
          const limitError = new Error(`文件大小超出限制`);
          limitError.code = 'ERR_FILE_TOO_LARGE';
          limitError.status = 413;
          reject(limitError);
        }
      });

      readStream.on('error', (err) => reject(err));
      readStream.on('end', () => resolve(Buffer.concat(chunks)));
    });

    if (isBinaryBuffer(buffer)) {
      const binError = new Error(`目标文件似乎是二进制内容，暂不支持在线预览`);
      binError.code = 'ERR_BINARY_NOT_SUPPORTED';
      binError.status = 415;
      throw binError;
    }

    const content = buffer.toString('utf8');
    const ext = normalizedPath.split('.').pop()?.toLowerCase() || '';

    return {
      path: normalizedPath,
      size: fileSize,
      content,
      encoding: 'utf-8',
      extension: ext,
    };
  });
}

/**
 * 执行受控单次远程命令（P2）。
 * @param {number} serverId - 服务器 ID
 * @param {string} command - 待执行命令
 * @param {string} [cwd] - 远程执行目录
 * @param {Object} [options] - 选项
 * @returns {Promise<{command: string, cwd: string, code: number, stdout: string, stderr: string, durationMs: number}>} 执行结果
 */
export async function execRemoteFsCommand(serverId, command, cwd, options = {}) {
  const server = await getServerWithCredential(Number(serverId));
  if (!server) throw new Error(`服务器 ID ${serverId} 不存在`);

  const trimmedCommand = String(command || '').trim();
  if (!trimmedCommand) {
    throw new Error('执行命令不能为空');
  }

  if (trimmedCommand.length > 500) {
    throw new Error('单次执行命令长度不能超过 500 个字符');
  }

  if (BLOCKED_COMMANDS_REGEX.test(trimmedCommand)) {
    throw new Error('为保障系统稳定性，禁止在非交互式面板执行交互式终端命令（如 vim, top, tail -f 等）');
  }

  const targets = await listTargets();
  const allowedRoots = resolveServerAllowedRoots(server, targets);

  let targetCwd = '';
  if (cwd) {
    const normalizedCwd = normalizePosixPath(cwd);
    assertPathWithinRoots(normalizedCwd, allowedRoots);
    targetCwd = normalizedCwd;
  } else {
    targetCwd = (allowedRoots.find((r) => r.isDefault) || allowedRoots[0]).path;
  }

  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || DEFAULT_EXEC_TIMEOUT_MS), 1000), MAX_EXEC_TIMEOUT_MS);
  const maxOutputBytes = Math.min(Math.max(Number(options.maxOutputBytes || MAX_EXEC_OUTPUT_BYTES), 1024), 1024 * 1024);

  const fullCommand = targetCwd ? `cd ${shellQuote(targetCwd)} && ${trimmedCommand}` : trimmedCommand;
  const startTime = Date.now();

  return withSsh(server, async (conn) => {
    // 检查 cwd realpath
    const sftp = await getSftp(conn);
    await assertSafeRealpath(sftp, targetCwd, allowedRoots);

    const result = await execSsh(conn, fullCommand, {
      timeoutMs,
      maxOutputBytes,
      allowFailure: true,
      label: `单次命令 [${trimmedCommand.slice(0, 30)}]`,
    });

    const durationMs = Date.now() - startTime;

    // 审计日志
    console.info(
      `[REMOTE_EXEC_AUDIT] ServerId: ${serverId}, Host: ${server.host}, Cwd: "${targetCwd}", Command: "${trimmedCommand}", Code: ${result.code}, Duration: ${durationMs}ms`
    );

    return {
      command: trimmedCommand,
      cwd: targetCwd,
      code: Number(result.code || 0),
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      durationMs,
    };
  });
}

/**
 * 格式化下载时间戳 (YYYYMMDDHHmmss)。
 * @param {Date} [date=new Date()] - 日期对象
 * @returns {string} 紧凑时间戳字符串
 */
export function formatFsDownloadTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${m}${d}${h}${min}${s}`;
}

/**
 * 清理文件名，去除非法字符。
 * @param {string} value - 原始文件名部分
 * @param {string} fallback - 兜底默认值
 * @returns {string} 安全的文件名部分
 */
export function sanitizeFsFileNamePart(value, fallback) {
  const sanitized = String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

/**
 * 流式下载服务器指定远程路径（目录打包为 tar.gz，单文件直接流式传输）。
 * @param {number} serverId - 服务器 ID
 * @param {string} requestedPath - 请求的远程绝对路径
 * @param {import('node:stream').Writable} outputStream - 输出流
 * @param {Function} [onReady] - 就绪回调，提供文件名、MIME 类型等响应元信息
 * @param {Object} [options] - 选项
 * @param {Function} [options.isAborted] - 外部判断中断函数
 * @returns {Promise<{fileName: string, isDirectory: boolean}>} 下载完成元数据
 */
export async function streamRemoteFsEntry(serverId, requestedPath, outputStream, onReady, options = {}) {
  const server = await getServerWithCredential(Number(serverId));
  if (!server) throw new Error(`服务器 ID ${serverId} 不存在`);

  const trimmedPath = String(requestedPath || '').trim();
  if (!trimmedPath) {
    throw new Error('下载目标路径不能为空');
  }

  const targets = await listTargets();
  const allowedRoots = resolveServerAllowedRoots(server, targets);
  const normalizedRequested = normalizePosixPath(trimmedPath);

  // 1. 词法级别校验作用域白名单
  assertPathWithinRoots(normalizedRequested, allowedRoots);

  return withSsh(server, async (conn) => {
    const sftp = await getSftp(conn);

    // 2. 利用 SFTP realpath 防软链接逃逸
    const safeRealPath = await assertSafeRealpath(sftp, normalizedRequested, allowedRoots);

    // 3. 读取条目属性获取类型
    const stats = await new Promise((resolve, reject) => {
      sftp.stat(safeRealPath, (error, resStats) => {
        if (error) {
          reject(new Error(`无法读取目标路径属性: ${error.message}`));
          return;
        }
        resolve(resStats);
      });
    });

    const isDirectory = stats.isDirectory();
    const sudo = server.useSudo ? 'sudo -n ' : '';
    const baseName = path.posix.basename(safeRealPath);
    const serverPart = sanitizeFsFileNamePart(server.name || server.host, 'server');
    const targetPart = sanitizeFsFileNamePart(baseName, isDirectory ? 'dir' : 'file');

    if (isDirectory) {
      // 目录：预检读权限与目录存在性
      await execSsh(conn, `${sudo}test -d ${shellQuote(safeRealPath)} && ${sudo}test -r ${shellQuote(safeRealPath)}`, {
        label: `预检下载目录 [${baseName}]`,
      });

      const parentDir = path.posix.dirname(safeRealPath);
      const timestamp = formatFsDownloadTimestamp();
      const fileName = `${serverPart}-${targetPart}-${timestamp}.tar.gz`;

      const meta = {
        fileName,
        isDirectory: true,
        mimeType: 'application/gzip',
        path: safeRealPath,
      };

      onReady?.(meta);

      const excludeArgs = buildHiddenExcludeArgs();
      const tarCommand = `${sudo}tar -czf - ${excludeArgs} -C ${shellQuote(parentDir)} -- ${shellQuote(baseName)}`;
      await streamSshCommand(conn, tarCommand, outputStream, {
        label: `流式打包目录 [${baseName}]`,
        isAborted: options.isAborted,
        idleTimeoutMs: 120_000,
      });

      return meta;
    }

    // 单文件：预检读权限与文件存在性
    await execSsh(conn, `${sudo}test -f ${shellQuote(safeRealPath)} && ${sudo}test -r ${shellQuote(safeRealPath)}`, {
      label: `预检下载文件 [${baseName}]`,
    });

    const fileName = baseName;
    const meta = {
      fileName,
      isDirectory: false,
      mimeType: 'application/octet-stream',
      fileSize: stats.size,
      path: safeRealPath,
    };

    onReady?.(meta);

    const catCommand = `${sudo}cat ${shellQuote(safeRealPath)}`;
    await streamSshCommand(conn, catCommand, outputStream, {
      label: `流式读取文件 [${baseName}]`,
      isAborted: options.isAborted,
      idleTimeoutMs: 120_000,
    });

    return meta;
  });
}

/**
 * 下载票据内存缓存映射 (ticketId -> { serverId, paths, createdAt })。
 * @note 架构设计说明：当前雨燕平台后端为轻量化单进程 Node.js 服务，
 *       采用内存 Map 结合 120s TTL 与惰性自动清理机制，可完全满足短时间内防 GET URL 超长的安全凭据中转需求。
 *       若后续演进为多进程集群部署，可将票据存储平滑迁移至 Redis 共享缓存或使用 HMAC 签名的有状态 Token。
 */
const downloadTickets = new Map();

/** 票据默认有效时间：120 秒 */
export const DOWNLOAD_TICKET_TTL_MS = 120_000;

/**
 * 清理过期下载票据
 */
function cleanupExpiredTickets() {
  const now = Date.now();
  for (const [ticket, record] of downloadTickets.entries()) {
    if (now - record.createdAt > DOWNLOAD_TICKET_TTL_MS) {
      downloadTickets.delete(ticket);
    }
  }
}

/**
 * 创建单次或多次批量下载票据。
 * @param {number} serverId - 服务器 ID
 * @param {string[]} paths - 目标路径列表
 * @param {Object} [creator] - 创建者身份上下文（供审计使用）
 * @returns {string} 随机票据 ID
 */
export function createDownloadTicket(serverId, paths, creator = {}) {
  cleanupExpiredTickets();
  const rawList = Array.isArray(paths) ? paths : [paths];
  const normalized = Array.from(
    new Set(
      rawList
        .map((p) => String(p || '').trim())
        .filter(Boolean)
        .map((p) => normalizePosixPath(p))
    )
  );

  if (normalized.length === 0) {
    throw new Error('下载票据路径不能为空');
  }

  if (normalized.length > MAX_FS_DIRECTORY_ENTRIES) {
    const error = new Error(`单次批量下载条目数不能超过 ${MAX_FS_DIRECTORY_ENTRIES} 项`);
    error.status = 400;
    throw error;
  }

  const ticket = crypto.randomBytes(24).toString('hex');
  downloadTickets.set(ticket, {
    serverId: Number(serverId),
    paths: normalized,
    creator: creator && typeof creator === 'object' ? { ...creator } : {},
    createdAt: Date.now(),
  });
  return ticket;
}

/**
 * 消费并校验下载票据（单次有效）。
 * @param {string} ticket - 票据 ID
 * @param {number} [expectedServerId] - 期望匹配的服务器 ID
 * @returns {{ serverId: number, paths: string[], creator: Object }} 关联的下载信息与创建者审计元数据
 */
export function consumeDownloadTicket(ticket, expectedServerId) {
  cleanupExpiredTickets();
  const trimmed = String(ticket || '').trim();
  if (!trimmed) {
    throw new Error('缺少下载票据');
  }

  const record = downloadTickets.get(trimmed);
  if (!record) {
    const error = new Error('下载票据无效或已过期，请重新发起下载');
    error.status = 404;
    throw error;
  }

  downloadTickets.delete(trimmed);

  if (expectedServerId && Number(record.serverId) !== Number(expectedServerId)) {
    const error = new Error('下载票据与当前服务器不匹配');
    error.status = 403;
    throw error;
  }

  return { serverId: record.serverId, paths: record.paths, creator: record.creator || {} };
}

/**
 * 判断是否为持有一次性票据的远程文件系统下载请求。
 * 仅放行 GET /servers/:id/fs/download 且带 ticket 的请求至控制器严格核销，其余请求一律严格鉴权。
 * @param {Object} req - Express 请求对象
 * @returns {boolean} 是否命中带票据的下载请求
 */
export function isTicketedFsDownloadRequest(req) {
  return (
    req?.method === 'GET' &&
    /^\/servers\/\d+\/fs\/download$/.test(req?.path || '') &&
    typeof req?.query?.ticket === 'string' &&
    req.query.ticket.trim().length > 0
  );
}

/**
 * 解析下载目标路径参数（严格去重，绝不以逗号暴力切分支持文件名自带逗号）。
 * @param {Object} params
 * @param {string|string[]} [params.paths] - 批量路径输入
 * @param {string} [params.path] - 单路径输入
 * @returns {string[]} 解析并去重后的路径数组
 */
export function parseDownloadPaths(params = {}) {
  const { paths, path: singlePath } = params;
  let list = [];

  if (paths !== undefined && paths !== null) {
    if (Array.isArray(paths)) {
      list = paths;
    } else {
      const raw = String(paths).trim();
      if (raw) {
        list = [raw];
      }
    }
  } else if (singlePath) {
    const raw = String(singlePath).trim();
    if (raw) {
      list = [raw];
    }
  }

  const set = new Set();
  const result = [];
  for (const item of list) {
    const str = String(item || '').trim();
    if (str && !set.has(str)) {
      set.add(str);
      result.push(str);
    }
  }

  return result;
}

/**
 * 构建排除隐藏文件的参数（GNU tar 与 GNU du 共用）。
 *
 * 规则：
 * 1. 递归排除所有子层级以 `.` 开头的文件和目录（如 .yuyan-backups, .git, .DS_Store）。
 * 2. 配合在条目父目录下以相对 basename 执行，确保直接选中的隐藏项自身（如 .yuyan-backups）不会被排除。
 *
 * 注：目标机器环境均为 GNU tar / GNU coreutils du。
 *
 * @returns {string} 排除参数，格式为排除子路径以点号开头的参数
 */
export function buildHiddenExcludeArgs() {
  return "--exclude='*/.*'";
}

/**
 * 拼装批量归档 tar 命令（防注入，带有 -- 参数终止符，无静默跳过参数）。
 * @param {Object} params
 * @param {string[]} params.safeRealPaths - 已安全校验的绝对路径列表
 * @param {string} [params.sudo=''] - sudo 前缀
 * @returns {string} 完整的 Shell 执行命令
 */
export function buildBatchTarCommand({ safeRealPaths, sudo = '' }) {
  if (!safeRealPaths || safeRealPaths.length === 0) {
    throw new Error('归档路径列表不能为空');
  }

  const excludeArgs = buildHiddenExcludeArgs();
  const firstParent = path.posix.dirname(safeRealPaths[0]);
  const allSameParent = safeRealPaths.every((p) => path.posix.dirname(p) === firstParent);

  if (allSameParent) {
    const entryNames = safeRealPaths.map((p) => path.posix.basename(p));
    const quotedEntries = entryNames.map((n) => shellQuote(n)).join(' ');
    // 关键点：在条目列表前显式加上 -- 终止参数解析，严防以 - 开头的文件名触发 tar 选项注入
    // --exclude 必须位于 -- 参数终止符之前
    return `${sudo}tar -czf - ${excludeArgs} -C ${shellQuote(firstParent)} -- ${quotedEntries}`;
  }

  // 跨目录场景：在根目录以相对路径打包，同样加上 --
  const relPaths = safeRealPaths.map((p) => shellQuote(p.replace(/^\//, '')));
  return `${sudo}tar -czf - ${excludeArgs} -C / -- ${relPaths.join(' ')}`;
}

/**
 * 流式批量打包下载服务器多个远程路径（使用 tar.gz 流式归档输出）。
 * @param {number} serverId - 服务器 ID
 * @param {string[]} requestedPaths - 请求的远程绝对路径列表
 * @param {import('node:stream').Writable} outputStream - 输出流
 * @param {Function} [onReady] - 就绪回调
 * @param {Object} [options] - 选项
 * @param {Function} [options.isAborted] - 中断判定函数
 * @returns {Promise<{fileName: string, isDirectory: boolean, count: number}>} 下载完成元数据
 */
export async function streamRemoteFsBatch(serverId, requestedPaths, outputStream, onReady, options = {}) {
  const server = await getServerWithCredential(Number(serverId));
  if (!server) throw new Error(`服务器 ID ${serverId} 不存在`);

  const rawList = Array.isArray(requestedPaths) ? requestedPaths : [requestedPaths];
  // 严格去重与路径格式化
  const paths = Array.from(
    new Set(
      rawList
        .map((p) => String(p || '').trim())
        .filter(Boolean)
        .map((p) => normalizePosixPath(p))
    )
  );

  if (paths.length === 0) {
    throw new Error('批量下载目标路径不能为空');
  }

  if (paths.length > MAX_FS_DIRECTORY_ENTRIES) {
    throw new Error(`单次批量下载条目数不能超过 ${MAX_FS_DIRECTORY_ENTRIES} 项`);
  }

  const targets = await listTargets();
  const allowedRoots = resolveServerAllowedRoots(server, targets);

  // 1. 词法级别校验所有路径的作用域白名单
  for (const itemPath of paths) {
    assertPathWithinRoots(itemPath, allowedRoots);
  }

  return withSsh(server, async (conn) => {
    const sftp = await getSftp(conn);

    // 2. 利用 SFTP realpath 防软链接逃逸并再次去重
    const safeRealPaths = [];
    const seenSafe = new Set();
    for (const itemPath of paths) {
      const safe = await assertSafeRealpath(sftp, itemPath, allowedRoots);
      if (!seenSafe.has(safe)) {
        seenSafe.add(safe);
        safeRealPaths.push(safe);
      }
    }

    const sudo = server.useSudo ? 'sudo -n ' : '';
    const serverPart = sanitizeFsFileNamePart(server.name || server.host, 'server');
    const timestamp = formatFsDownloadTimestamp();
    const fileName = `${serverPart}-batch-${timestamp}.tar.gz`;

    const meta = {
      fileName,
      isDirectory: true,
      mimeType: 'application/gzip',
      count: safeRealPaths.length,
    };

    onReady?.(meta);

    // 3. 构建带有 -- 参数防注入标记的纯净 tar 命令（不包含 --ignore-failed-read）
    const tarCommand = buildBatchTarCommand({ safeRealPaths, sudo });

    await streamSshCommand(conn, tarCommand, outputStream, {
      label: `流式批量打包 [${safeRealPaths.length}项]`,
      isAborted: options.isAborted,
      idleTimeoutMs: 180_000,
    });

    return meta;
  });
}

/** 远程文件系统大小查询超时时间 (10 秒)。 */
export const FS_SIZE_TIMEOUT_MS = 10_000;

/**
 * 查询远程文件系统指定路径的磁盘占用预估大小（排除隐藏文件，与 tar 打包排除规则完全一致）。
 *
 * @param {number} serverId - 服务器 ID
 * @param {string|string[]} requestedPaths - 请求查询的远程路径列表
 * @returns {Promise<{ totalBytes: number, items: Array<{ path: string, bytes: number }>, truncated: boolean }>}
 */
export async function calculateRemoteFsSize(serverId, requestedPaths) {
  // 1. 前置参数校验（不碰数据库，避免无效请求查库或测试环境失败）
  const rawList = Array.isArray(requestedPaths) ? requestedPaths : [requestedPaths];
  const paths = Array.from(
    new Set(
      rawList
        .map((p) => String(p || '').trim())
        .filter(Boolean)
        .map((p) => normalizePosixPath(p))
    )
  );

  if (paths.length === 0) {
    throw new Error('目标路径列表不能为空');
  }

  if (paths.length > MAX_FS_DIRECTORY_ENTRIES) {
    throw new Error(`单次大小查询条目数不能超过 ${MAX_FS_DIRECTORY_ENTRIES} 项`);
  }

  const numericServerId = Number(serverId);
  if (!numericServerId) {
    throw new Error('无效的服务器 ID');
  }

  const server = await getServerWithCredential(numericServerId);
  if (!server) throw new Error(`服务器 ID ${serverId} 不存在`);

  const targets = await listTargets();
  const allowedRoots = resolveServerAllowedRoots(server, targets);

  // 2. 词法级别校验所有路径的作用域白名单
  for (const itemPath of paths) {
    assertPathWithinRoots(itemPath, allowedRoots);
  }

  return withSsh(server, async (conn) => {
    const sftp = await getSftp(conn);

    // 3. 利用 SFTP realpath 防软链接逃逸并再次去重
    const safeRealPaths = [];
    const seenSafe = new Set();
    for (const itemPath of paths) {
      const safe = await assertSafeRealpath(sftp, itemPath, allowedRoots);
      if (!seenSafe.has(safe)) {
        seenSafe.add(safe);
        safeRealPaths.push(safe);
      }
    }

    const sudo = server.useSudo ? 'sudo -n ' : '';
    const excludeArgs = buildHiddenExcludeArgs();
    // 关键：在远端命令中加入 timeout，防止 SSH 通道中断后远端 du 进程继续常驻后台扫盘
    const timeoutSec = Math.ceil(FS_SIZE_TIMEOUT_MS / 1000);
    const timeoutCmd = `timeout ${timeoutSec} `;

    // 注：当前远程文件浏览器多选均在同一目录下操作（allSameParent 恒为 true）；
    // 跨目录 (-C /) 模式下，若选中的相对路径自身带有隐藏目录（如 opt/.hid），会被 */.* 排除。
    const firstParent = path.posix.dirname(safeRealPaths[0]);
    const allSameParent = safeRealPaths.every((p) => path.posix.dirname(p) === firstParent);

    let duCommand = '';
    if (allSameParent) {
      const entryNames = safeRealPaths.map((p) => path.posix.basename(p));
      const quotedEntries = entryNames.map((n) => shellQuote(n)).join(' ');
      duCommand = `cd ${shellQuote(firstParent)} && ${sudo}${timeoutCmd}du -sb ${excludeArgs} -- ${quotedEntries}`;
    } else {
      const quotedPaths = safeRealPaths.map((p) => shellQuote(p)).join(' ');
      duCommand = `${sudo}${timeoutCmd}du -sb ${excludeArgs} -- ${quotedPaths}`;
    }

    let truncated = false;
    let stdout = '';
    let warning = '';
    let isTimeout = false;

    try {
      const result = await execSsh(conn, duCommand, {
        label: `查询路径大小 [${safeRealPaths.length}项]`,
        timeoutMs: FS_SIZE_TIMEOUT_MS + 2_000,
        allowFailure: true,
      });

      stdout = result.stdout || '';
      // GNU timeout 超时退出码为 124（或 137）
      if (result.code === 124 || result.code === 137) {
        isTimeout = true;
        truncated = true;
        warning = '查询超时，大小未知';
      } else if (result.code !== 0) {
        // 目录中有无权限读取的文件，du 退出码非 0 但依然输出了已统计大小
        warning = '部分文件无法读取，大小可能偏小';
      }
    } catch {
      // SSH 通道层超时或严重网络异常
      truncated = true;
      isTimeout = true;
      warning = '查询超时，大小未知';
    }

    const items = [];
    let totalBytes = 0;

    if (!isTimeout && stdout) {
      const lines = stdout.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d+)\s+(.+)$/);
        if (match) {
          const bytes = Number(match[1]);
          const rawName = match[2].trim();
          const fullPath = allSameParent ? path.posix.join(firstParent, rawName) : rawName;
          items.push({ path: fullPath, bytes });
          totalBytes += bytes;
        }
      }
    }

    if (!isTimeout && items.length === 0 && warning) {
      // 完全未能获取任何条目且有错误
      truncated = true;
    }

    return { totalBytes, items, truncated, warning };
  });
}


