import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_UPDATE_DIR } from '../config/constants.mjs';

/** 支持的桌面端更新通道。 */
export const APP_UPDATE_CHANNELS = new Set(['stable', 'beta']);

/** 将客户端平台名称转换为更新清单平台名称。 */
export function normalizeUpdatePlatform(platform = '') {
  if (platform === 'darwin' || platform === 'mac' || platform === 'macos') return 'darwin';
  if (platform === 'win32' || platform === 'windows') return 'windows';
  return '';
}

/** 将客户端架构名称转换为更新清单架构名称。 */
export function normalizeUpdateArch(arch = '') {
  const aliases = {
    arm64: 'aarch64',
    aarch64: 'aarch64',
    x64: 'x86_64',
    x86_64: 'x86_64',
  };
  return aliases[String(arch).toLowerCase()] || '';
}

/** 校验并返回更新通道。 */
export function normalizeUpdateChannel(channel = 'stable') {
  return APP_UPDATE_CHANNELS.has(channel) ? channel : 'stable';
}

/** 读取指定通道已经原子发布的更新清单。 */
export async function readPublishedUpdateManifest(channel = 'stable') {
  const safeChannel = normalizeUpdateChannel(channel);
  const manifestPath = path.join(APP_UPDATE_DIR, safeChannel, 'manifest.json');
  try {
    const content = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(content);
    if (!manifest?.version || !manifest?.platforms || typeof manifest.platforms !== 'object') {
      throw new Error('清单缺少 version 或 platforms');
    }
    return manifest;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`[App Update] 读取 ${safeChannel} 更新清单失败:`, error.message);
    }
    return null;
  }
}

/** 从清单中获取匹配平台和架构的发布资源。 */
export function getManifestAsset(manifest, platform, arch) {
  if (!manifest) return null;
  const normalizedPlatform = normalizeUpdatePlatform(platform);
  const normalizedArch = normalizeUpdateArch(arch);
  if (!normalizedPlatform || !normalizedArch) return null;
  return manifest.platforms?.[`${normalizedPlatform}-${normalizedArch}`] || null;
}

/** 构建静态更新资源的公开访问路径。 */
export function buildPublishedAssetUrl(channel, version, target, filename) {
  const segments = [normalizeUpdateChannel(channel), version, target, filename].map((segment) =>
    encodeURIComponent(String(segment))
  );
  return `/app-updates/${segments.join('/')}`;
}

/** 计算文件 SHA-256。 */
export async function calculateFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 验证发布清单所引用的文件大小和 SHA-256。 */
export async function validateManifestAsset(channel, version, target, asset) {
  const filename = path.basename(String(asset?.filename || ''));
  if (!filename || filename !== asset?.filename) return false;
  const filePath = path.join(APP_UPDATE_DIR, normalizeUpdateChannel(channel), String(version), target, filename);
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || Number(asset.size) !== stats.size) return false;
    if (!asset.sha256) return false;
    const digest = await calculateFileSha256(filePath);
    return digest.toLowerCase() === String(asset.sha256).toLowerCase();
  } catch {
    return false;
  }
}
