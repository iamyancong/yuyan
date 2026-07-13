import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_UPDATE_DIR } from '../config/constants.mjs';

/** 支持的桌面端更新通道。 */
export const APP_UPDATE_CHANNELS = new Set(['stable', 'beta']);

/**
 * 解析应用语义版本号。
 * @param {string} version - 待解析版本号
 * @returns {{ main: number[], prerelease: string[] } | null} 解析结果
 */
function parseAppVersion(version = '') {
  const match = String(version)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * 比较两个应用语义版本号。
 * @param {string} left - 左侧版本号
 * @param {string} right - 右侧版本号
 * @returns {number} 左侧较新返回正数，右侧较新返回负数，相同返回 0
 */
export function compareAppVersions(left, right) {
  const leftVersion = parseAppVersion(left);
  const rightVersion = parseAppVersion(right);
  if (!leftVersion || !rightVersion) return 0;

  for (let index = 0; index < leftVersion.main.length; index += 1) {
    const difference = leftVersion.main[index] - rightVersion.main[index];
    if (difference !== 0) return difference;
  }

  const leftPrerelease = leftVersion.prerelease;
  const rightPrerelease = rightVersion.prerelease;
  if (leftPrerelease.length === 0 && rightPrerelease.length > 0) return 1;
  if (leftPrerelease.length > 0 && rightPrerelease.length === 0) return -1;

  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

/**
 * 判断远程版本是否比本地版本新。
 * @param {string} local - 本地版本号
 * @param {string} remote - 远程版本号
 * @returns {boolean} 是否存在更新
 */
export function isNewerAppVersion(local, remote) {
  return compareAppVersions(remote, local) > 0;
}

/**
 * 获取 Release 中与客户端平台匹配的安装包。
 * @param {object} release - GitHub Release
 * @param {string} platform - 标准化平台名称
 * @param {string} arch - 标准化 CPU 架构
 * @returns {object | null} 匹配的 Release Asset
 */
function getCompatibleReleaseAsset(release, platform, arch) {
  const expectedExtension = platform === 'darwin' ? '.dmg' : '.exe';
  const candidates = (release?.assets || []).filter((asset) =>
    String(asset?.name || '').toLowerCase().endsWith(expectedExtension)
  );
  if (platform !== 'darwin') return candidates[0] || null;

  const normalizedArch = normalizeUpdateArch(arch);
  const archPattern = normalizedArch === 'aarch64'
    ? /(?:^|[._-])(?:aarch64|arm64)(?:[._-]|$)/i
    : /(?:^|[._-])(?:x86_64|x64|amd64|intel)(?:[._-]|$)/i;
  return candidates.find((asset) => archPattern.test(String(asset?.name || ''))) || null;
}

/**
 * 从 GitHub Releases 中选择版本最高且包含当前平台安装包的发布。
 * @param {object[]} releases - GitHub Releases
 * @param {string} platform - 标准化平台名称
 * @param {string} arch - 标准化 CPU 架构
 * @returns {{ release: object, asset: object } | null} 发布及安装包
 */
export function selectLatestCompatibleRelease(releases, platform, arch = 'x86_64') {
  if (!Array.isArray(releases)) return null;

  const candidates = releases
    .filter((release) => !release?.draft && parseAppVersion(release?.tag_name))
    .map((release) => ({
      release,
      asset: getCompatibleReleaseAsset(release, platform, arch),
    }))
    .filter(({ asset }) => Boolean(asset))
    .sort((left, right) =>
      compareAppVersions(right.release.tag_name, left.release.tag_name)
    );

  return candidates[0] || null;
}

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
