import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import { APP_UPDATE_CACHE_DIR } from '../config/constants.mjs';

/** 更新包最小有效体积，避免把错误页或截断响应当作安装包。 */
const MIN_UPDATE_ASSET_SIZE = 1024 * 1024;

/** 更新包后台预下载最大自动重试次数。 */
const MAX_PRELOAD_RETRIES = 3;

/** 预下载失败后的冷却时间。 */
const PRELOAD_FAILURE_COOLDOWN_MS = 30_000;

/** GitHub Release Asset 下载超时。 */
const PRELOAD_REQUEST_TIMEOUT_MS = 5 * 60_000;

/**
 * 等待指定毫秒数。
 * @param {number} milliseconds - 等待时长
 * @returns {Promise<void>} 等待完成
 */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 规范化 GitHub Release Asset 元数据。
 * @param {object} asset - 原始资源信息
 * @returns {{ assetId: string, filename: string, size: number, sha256: string, etag: string }} 安全资源信息
 */
export function normalizeUpdateAsset(asset = {}) {
  const assetId = String(asset.assetId ?? asset.id ?? '').trim();
  if (!/^\d+$/.test(assetId)) {
    throw new Error('更新资源 ID 无效');
  }

  const originalFilename = String(asset.filename ?? asset.name ?? '').trim();
  const filename = path.basename(originalFilename);
  if (!filename || filename !== originalFilename) {
    throw new Error('更新安装包文件名无效');
  }

  const size = Number(asset.size || 0);
  const digest = String(asset.sha256 || asset.digest || '')
    .trim()
    .replace(/^sha256:/i, '')
    .toLowerCase();
  return {
    assetId,
    filename,
    size: Number.isSafeInteger(size) && size > 0 ? size : 0,
    sha256: /^[a-f0-9]{64}$/.test(digest) ? digest : '',
    etag: String(asset.etag || '').trim(),
  };
}

/**
 * 解析 HTTP Content-Range。
 * @param {string} value - Content-Range 响应头
 * @returns {{ start: number, end: number, total: number } | null} 分段范围
 */
export function parseUpdateContentRange(value = '') {
  const match = String(value).match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

/**
 * 计算文件 SHA-256。
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} 十六进制摘要
 */
async function calculateSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 校验 DMG/EXE 安装包格式签名。
 * @param {string} filePath - 安装包路径
 * @param {string} filename - 安装包文件名
 * @returns {boolean} 是否为受支持的有效安装包格式
 */
export function validateUpdateAssetSignature(filePath, filename) {
  try {
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= MIN_UPDATE_ASSET_SIZE) return false;

    const extension = path.extname(filename).toLowerCase();
    const descriptor = fsSync.openSync(filePath, 'r');
    try {
      if (extension === '.exe') {
        const header = Buffer.alloc(2);
        fsSync.readSync(descriptor, header, 0, header.length, 0);
        return header.equals(Buffer.from('MZ'));
      }
      if (extension === '.dmg') {
        const trailer = Buffer.alloc(4);
        fsSync.readSync(descriptor, trailer, 0, trailer.length, stats.size - 512);
        return trailer.equals(Buffer.from('koly'));
      }
      return false;
    } finally {
      fsSync.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

/**
 * 创建更新缓存管理器。
 * @param {object} options - 管理器依赖
 * @returns {UpdateAssetCacheManager} 缓存管理器
 */
export function createUpdateAssetCacheManager(options = {}) {
  return new UpdateAssetCacheManager(options);
}

/** GitHub Release Asset 内网缓存管理器。 */
export class UpdateAssetCacheManager {
  /**
   * 初始化缓存管理器。
   * @param {object} options - 配置项
   * @param {string} [options.cacheDir] - 缓存目录
   * @param {(config: object) => Promise<object>} [options.downloadClient] - 下载客户端
   * @param {string} [options.githubRepo] - GitHub 仓库
   * @param {() => string} [options.getGithubToken] - Token 获取函数
   * @param {number} [options.maxRetries] - 最大重试次数
   * @param {number} [options.failureCooldownMs] - 失败冷却时间
   */
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || APP_UPDATE_CACHE_DIR;
    this.downloadClient = options.downloadClient || ((config) => axios(config));
    this.githubRepo = options.githubRepo || process.env.GITHUB_REPOSITORY || 'ycwang-dev/yuyan';
    this.getGithubToken = options.getGithubToken || (() => String(process.env.GITHUB_TOKEN || '').trim());
    this.maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : MAX_PRELOAD_RETRIES;
    this.failureCooldownMs = Number.isFinite(options.failureCooldownMs)
      ? options.failureCooldownMs
      : PRELOAD_FAILURE_COOLDOWN_MS;
    this.activeTasks = new Map();
    this.knownAssets = new Map();
    this.failures = new Map();
    this.validatedFiles = new Map();
  }

  /**
   * 合并并保存可信资源元数据。
   * @param {object} asset - 资源元数据
   * @returns {{ assetId: string, filename: string, size: number, sha256: string, etag: string }} 合并结果
   */
  registerAsset(asset) {
    const normalized = normalizeUpdateAsset(asset);
    const previous = this.knownAssets.get(normalized.assetId);
    if (previous && previous.filename !== normalized.filename) {
      throw new Error('更新资源 ID 与文件名不一致');
    }
    const merged = {
      ...previous,
      ...normalized,
      size: normalized.size || previous?.size || 0,
      sha256: normalized.sha256 || previous?.sha256 || '',
      etag: normalized.etag || previous?.etag || '',
    };
    this.knownAssets.set(merged.assetId, merged);
    return merged;
  }

  /**
   * 获取已登记资源，未登记时使用身份信息建立最小记录。
   * @param {object} asset - 资源身份或完整元数据
   * @returns {{ assetId: string, filename: string, size: number, sha256: string, etag: string }} 资源信息
   */
  resolveAsset(asset) {
    const normalized = normalizeUpdateAsset(asset);
    const known = this.knownAssets.get(normalized.assetId);
    if (!known) return this.registerAsset(normalized);
    if (known.filename !== normalized.filename) {
      throw new Error('更新资源 ID 与文件名不一致');
    }
    return this.registerAsset({ ...known, ...normalized });
  }

  /**
   * 获取资源缓存文件路径。
   * @param {object} asset - 资源信息
   * @returns {{ cachePath: string, partialPath: string, etagPath: string }} 缓存路径集合
   */
  getPaths(asset) {
    const normalized = this.resolveAsset(asset);
    const basename = `${normalized.assetId}-${normalized.filename}`;
    return {
      cachePath: path.join(this.cacheDir, basename),
      partialPath: path.join(this.cacheDir, `${basename}.part`),
      etagPath: path.join(this.cacheDir, `${basename}.part.etag`),
    };
  }

  /**
   * 校验缓存文件的大小、摘要和格式。
   * @param {string} filePath - 待校验文件
   * @param {object} asset - 资源元数据
   * @returns {Promise<{ valid: boolean, size: number, error: string | null }>} 校验结果
   */
  async validateFile(filePath, asset) {
    const normalized = this.resolveAsset(asset);
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) return { valid: false, size: 0, error: '缓存不是普通文件' };
      const validationKey = `${normalized.filename}:${normalized.size}:${normalized.sha256}`;
      const previousValidation = this.validatedFiles.get(filePath);
      if (
        previousValidation?.key === validationKey
        && previousValidation.size === stats.size
        && previousValidation.mtimeMs === stats.mtimeMs
      ) {
        return { valid: true, size: stats.size, error: null };
      }
      if (normalized.size > 0 && stats.size !== normalized.size) {
        this.validatedFiles.delete(filePath);
        return { valid: false, size: stats.size, error: '缓存文件大小不一致' };
      }
      if (!validateUpdateAssetSignature(filePath, normalized.filename)) {
        this.validatedFiles.delete(filePath);
        return { valid: false, size: stats.size, error: '缓存安装包格式签名无效' };
      }
      if (normalized.sha256) {
        const digest = await calculateSha256(filePath);
        if (digest.toLowerCase() !== normalized.sha256) {
          this.validatedFiles.delete(filePath);
          return { valid: false, size: stats.size, error: '缓存文件 SHA-256 不一致' };
        }
      }
      const verifiedStats = await fs.stat(filePath);
      this.validatedFiles.set(filePath, {
        key: validationKey,
        size: verifiedStats.size,
        mtimeMs: verifiedStats.mtimeMs,
      });
      return { valid: true, size: stats.size, error: null };
    } catch (error) {
      this.validatedFiles.delete(filePath);
      if (error?.code === 'ENOENT') return { valid: false, size: 0, error: '缓存文件不存在' };
      return { valid: false, size: 0, error: error.message || '缓存校验失败' };
    }
  }

  /**
   * 获取任务对外状态快照。
   * @param {object} task - 内部任务
   * @returns {object} 可序列化状态
   */
  snapshotTask(task) {
    const totalBytes = Number(task.totalBytes || task.asset.size || 0);
    const downloadedBytes = Number(task.downloadedBytes || 0);
    const progress = totalBytes > 0
      ? Math.min(task.status === 'ready' ? 100 : 99, Math.floor(downloadedBytes * 100 / totalBytes))
      : 0;
    const remainingSeconds = task.bytesPerSecond > 0 && totalBytes > downloadedBytes
      ? Math.ceil((totalBytes - downloadedBytes) / task.bytesPerSecond)
      : null;
    return {
      status: task.status,
      assetId: task.asset.assetId,
      filename: task.asset.filename,
      downloadedBytes,
      totalBytes: totalBytes || null,
      progress,
      bytesPerSecond: Number(task.bytesPerSecond || 0),
      remainingSeconds,
      retryCount: Number(task.retryCount || 0),
      error: task.error || null,
      etag: task.asset.etag || '',
      updatedAt: task.updatedAt || new Date().toISOString(),
    };
  }

  /**
   * 查询资源缓存状态。
   * @param {object} asset - 资源身份或元数据
   * @returns {Promise<object>} 缓存状态
   */
  async getStatus(asset) {
    const normalized = this.resolveAsset(asset);
    const activeTask = this.activeTasks.get(normalized.assetId);
    if (activeTask) return this.snapshotTask(activeTask);

    const { cachePath } = this.getPaths(normalized);
    const validation = await this.validateFile(cachePath, normalized);
    if (validation.valid) {
      return this.snapshotTask({
        status: 'ready',
        asset: normalized,
        downloadedBytes: validation.size,
        totalBytes: validation.size,
        bytesPerSecond: 0,
        retryCount: 0,
        error: null,
      });
    }
    if (validation.size > 0) {
      this.validatedFiles.delete(cachePath);
      await fs.rm(cachePath, { force: true });
      console.warn(`[Update Cache] 删除校验失败的缓存: ${cachePath} (${validation.error})`);
    }

    const failure = this.failures.get(normalized.assetId);
    if (failure && failure.retryAt > Date.now()) {
      return this.snapshotTask({
        status: 'failed',
        asset: normalized,
        downloadedBytes: failure.downloadedBytes,
        totalBytes: normalized.size,
        bytesPerSecond: 0,
        retryCount: failure.retryCount,
        error: failure.error,
        updatedAt: failure.updatedAt,
      });
    }
    if (failure) this.failures.delete(normalized.assetId);

    const { partialPath } = this.getPaths(normalized);
    const partialSize = await fs.stat(partialPath).then((stats) => stats.size).catch(() => 0);
    return this.snapshotTask({
      status: 'missing',
      asset: normalized,
      downloadedBytes: partialSize,
      totalBytes: normalized.size,
      bytesPerSecond: 0,
      retryCount: 0,
      error: null,
    });
  }

  /**
   * 确保资源已经缓存或启动唯一后台预下载任务。
   * @param {object} asset - 资源元数据
   * @returns {Promise<object>} 当前缓存状态
   */
  async ensureCached(asset) {
    const normalized = this.registerAsset(asset);
    const status = await this.getStatus(normalized);
    if (status.status === 'ready' || status.status === 'preparing' || status.status === 'failed') {
      return status;
    }
    const existingTask = this.activeTasks.get(normalized.assetId);
    if (existingTask) return this.snapshotTask(existingTask);

    const task = {
      status: 'preparing',
      asset: normalized,
      downloadedBytes: status.downloadedBytes || 0,
      totalBytes: normalized.size || status.totalBytes || 0,
      bytesPerSecond: 0,
      retryCount: 0,
      error: null,
      updatedAt: new Date().toISOString(),
      controller: new AbortController(),
      source: null,
      writer: null,
      promise: null,
    };
    this.activeTasks.set(normalized.assetId, task);
    task.promise = this.runPreload(task)
      .then(() => {
        task.status = 'ready';
        task.bytesPerSecond = 0;
        task.error = null;
        task.updatedAt = new Date().toISOString();
        this.failures.delete(normalized.assetId);
        return this.snapshotTask(task);
      })
      .catch((error) => {
        task.status = 'failed';
        task.bytesPerSecond = 0;
        task.error = error.message || String(error);
        task.updatedAt = new Date().toISOString();
        this.failures.set(normalized.assetId, {
          error: task.error,
          retryAt: Date.now() + this.failureCooldownMs,
          retryCount: task.retryCount,
          downloadedBytes: task.downloadedBytes,
          updatedAt: task.updatedAt,
        });
        console.error(`[Update Cache] 资源预下载失败: ${normalized.assetId}`, task.error);
        return this.snapshotTask(task);
      })
      .finally(() => {
        this.activeTasks.delete(normalized.assetId);
      });
    return this.snapshotTask(task);
  }

  /**
   * 等待当前资源任务结束或超时。
   * @param {object} asset - 资源信息
   * @param {number} timeoutMs - 最大等待时间
   * @returns {Promise<object>} 最新缓存状态
   */
  async waitForAsset(asset, timeoutMs = 15_000) {
    const normalized = this.resolveAsset(asset);
    const task = this.activeTasks.get(normalized.assetId);
    if (task?.promise) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
        task.promise.finally(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    return this.getStatus(normalized);
  }

  /**
   * 执行带断点续传与指数退避的预下载。
   * @param {object} task - 内部任务
   * @returns {Promise<void>} 下载完成
   */
  async runPreload(task) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const { cachePath, partialPath, etagPath } = this.getPaths(task.asset);
    const token = this.getGithubToken();
    const url = `https://api.github.com/repos/${this.githubRepo}/releases/assets/${task.asset.assetId}`;
    console.log(`[Update Cache] 开始后台预下载: ${task.asset.assetId} -> ${cachePath}`);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (task.controller.signal.aborted) throw new Error('更新资源预下载已中断');
      task.retryCount = attempt;
      task.error = null;
      task.updatedAt = new Date().toISOString();
      try {
        const partialSize = await fs.stat(partialPath).then((stats) => stats.size).catch(() => 0);
        if (task.asset.size > 0 && partialSize > task.asset.size) {
          await fs.rm(partialPath, { force: true });
          await fs.rm(etagPath, { force: true });
        }

        const currentSize = await fs.stat(partialPath).then((stats) => stats.size).catch(() => 0);
        if (currentSize > 0 && task.asset.size > 0 && currentSize === task.asset.size) {
          const existingValidation = await this.validateFile(partialPath, task.asset);
          if (existingValidation.valid) {
            await fs.rename(partialPath, cachePath);
            await fs.rm(etagPath, { force: true });
            task.downloadedBytes = existingValidation.size;
            task.totalBytes = existingValidation.size;
            return;
          }
          await fs.rm(partialPath, { force: true });
          await fs.rm(etagPath, { force: true });
        }

        await this.downloadAttempt(task, url, partialPath, etagPath, token);
        const validation = await this.validateFile(partialPath, task.asset);
        if (!validation.valid) {
          if (task.asset.size > 0 && validation.size < task.asset.size) {
            throw new Error(`更新包下载不完整：${validation.size}/${task.asset.size}`);
          }
          await fs.rm(partialPath, { force: true });
          await fs.rm(etagPath, { force: true });
          throw new Error(validation.error || '更新包校验失败');
        }

        await fs.rm(cachePath, { force: true });
        await fs.rename(partialPath, cachePath);
        await fs.rm(etagPath, { force: true });
        task.downloadedBytes = validation.size;
        task.totalBytes = validation.size;
        console.log(`[Update Cache] 资源预下载完成: ${cachePath}`);
        return;
      } catch (error) {
        if (task.controller.signal.aborted) throw new Error('更新资源预下载已中断');
        task.error = error.message || String(error);
        task.updatedAt = new Date().toISOString();
        if (attempt >= this.maxRetries) throw error;
        await delay(2 ** (attempt + 1) * 1000);
      }
    }
  }

  /**
   * 执行一次 GitHub Release Asset 分段下载。
   * @param {object} task - 内部任务
   * @param {string} url - GitHub Asset API 地址
   * @param {string} partialPath - 临时文件路径
   * @param {string} etagPath - ETag 记录路径
   * @param {string} token - GitHub Token
   * @returns {Promise<void>} 本次响应写入完成
   */
  async downloadAttempt(task, url, partialPath, etagPath, token) {
    const offset = await fs.stat(partialPath).then((stats) => stats.size).catch(() => 0);
    const storedEtag = await fs.readFile(etagPath, 'utf8').then((value) => value.trim()).catch(() => '');
    const headers = {
      'User-Agent': 'yuyan-app',
      'Accept': 'application/octet-stream',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      const ifRange = storedEtag || task.asset.etag;
      if (ifRange) headers['If-Range'] = ifRange;
    }

    const response = await this.downloadClient({
      method: 'get',
      url,
      responseType: 'stream',
      headers,
      timeout: PRELOAD_REQUEST_TIMEOUT_MS,
      signal: task.controller.signal,
      validateStatus: (status) => status === 200 || status === 206,
    });
    const status = Number(response.status);
    if (status !== 200 && status !== 206) {
      throw new Error(`GitHub 更新资源响应异常: ${status}`);
    }

    const contentRange = parseUpdateContentRange(response.headers?.['content-range']);
    if (status === 206 && (!contentRange || contentRange.start !== offset)) {
      throw new Error('GitHub 更新资源续传位置不一致');
    }
    const writeOffset = status === 206 ? offset : 0;
    const responseLength = Number(response.headers?.['content-length'] || 0);
    const totalBytes = contentRange?.total
      || task.asset.size
      || (responseLength > 0 ? writeOffset + responseLength : 0);
    const responseEtag = String(response.headers?.etag || '').trim();
    if (responseEtag) {
      task.asset = this.registerAsset({ ...task.asset, etag: responseEtag });
      await fs.writeFile(etagPath, responseEtag, 'utf8');
    }

    task.downloadedBytes = writeOffset;
    task.totalBytes = totalBytes;
    const sessionStartedAt = Date.now();
    const sessionStartBytes = writeOffset;
    const writer = fsSync.createWriteStream(partialPath, { flags: writeOffset > 0 ? 'a' : 'w' });
    const source = response.data;
    task.source = source;
    task.writer = writer;

    /** 中断当前源流和文件写入流。 */
    const abortTransfer = () => {
      source.destroy?.(new Error('更新资源预下载已中断'));
      writer.destroy?.(new Error('更新资源预下载已中断'));
    };
    task.controller.signal.addEventListener('abort', abortTransfer, { once: true });
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        /** 完成当前流式操作。 */
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        source.on('data', (chunk) => {
          task.downloadedBytes += chunk.length;
          const elapsedSeconds = Math.max(1, Math.floor((Date.now() - sessionStartedAt) / 1000));
          task.bytesPerSecond = Math.floor((task.downloadedBytes - sessionStartBytes) / elapsedSeconds);
          task.updatedAt = new Date().toISOString();
        });
        source.once('error', (error) => finish(error));
        writer.once('error', (error) => finish(error));
        writer.once('finish', () => finish());
        source.pipe(writer);
      });
    } finally {
      task.controller.signal.removeEventListener('abort', abortTransfer);
      task.source = null;
      task.writer = null;
    }

    if (totalBytes > 0 && task.downloadedBytes !== totalBytes) {
      throw new Error(`更新包响应长度不一致：${task.downloadedBytes}/${totalBytes}`);
    }
  }

  /** 中断全部正在执行的预下载任务。 */
  abortAll() {
    for (const task of this.activeTasks.values()) {
      task.controller.abort('shutdown');
      task.source?.destroy?.(new Error('更新资源预下载已中断'));
      task.writer?.destroy?.(new Error('更新资源预下载已中断'));
    }
  }
}

/** 全局更新资源缓存管理器。 */
export const updateAssetCacheManager = createUpdateAssetCacheManager();
