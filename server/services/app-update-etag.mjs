/**
 * 桌面端安装包 sha256 摘要 → ETag 解析与失效缓存。
 * @description 断点续传会产生大量 Range 请求，逐个 readFileSync 会阻塞事件循环；
 * 本模块维护带失效机制的内存缓存：缓存键同时绑定二进制安装包及其同名 .sha256 sidecar 文件的
 * 大小（size）与最后修改时间（mtimeMs）。当同路径重新发布或 sidecar 被改写时，缓存自动失效并重新读取。
 */

import fs from 'node:fs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * 创建安装包 ETag 解析器（带基于文件元数据的失效缓存）。
 * @param {{
 *   readFile?: (path: string) => string,
 *   statFile?: (path: string) => { size: number, mtimeMs: number },
 *   maxEntries?: number
 * }} [options] 可注入文件读取、元数据获取与容量上限
 * @returns {(filePath: string, stat?: { size: number, mtimeMs: number }) => string | null}
 */
export function createAppUpdateETagResolver({ readFile, statFile, maxEntries = 512 } = {}) {
  const read = readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const statFn = statFile || ((filePath) => fs.statSync(filePath));
  /** @type {Map<string, { key: string, etag: string }>} */
  const cache = new Map();

  return function resolveAppUpdateETag(filePath, stat) {
    if (!stat) {
      try {
        const sha256 = String(read(`${filePath}.sha256`)).trim();
        if (SHA256_PATTERN.test(sha256)) {
          return `"sha256-${sha256.toLowerCase()}"`;
        }
      } catch {}
      return null;
    }

    let sidecarStat;
    try {
      sidecarStat = statFn(`${filePath}.sha256`);
    } catch {
      cache.delete(filePath);
      return null;
    }

    const key = `${stat.size}:${stat.mtimeMs}:${sidecarStat.size}:${sidecarStat.mtimeMs}`;
    const cached = cache.get(filePath);
    if (cached && cached.key === key) {
      return cached.etag;
    }

    let etag = null;
    try {
      const sha256 = String(read(`${filePath}.sha256`)).trim();
      if (SHA256_PATTERN.test(sha256)) {
        etag = `"sha256-${sha256.toLowerCase()}"`;
      }
    } catch {
      etag = null;
    }

    if (!etag) {
      cache.delete(filePath);
      return null;
    }

    cache.delete(filePath);
    if (cache.size >= maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(filePath, { key, etag });
    return etag;
  };
}
