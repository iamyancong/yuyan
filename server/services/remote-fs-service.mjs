/**
 * 远程文件系统服务
 * @description 为独立服务器提供受控、只读的作用域远程目录浏览、文本预览及单次命令执行
 */

import path from 'node:path';
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

      const tarCommand = `${sudo}tar -czf - -C ${shellQuote(parentDir)} ${shellQuote(baseName)}`;
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

