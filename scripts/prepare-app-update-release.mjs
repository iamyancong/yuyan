#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 允许发布的目标平台目录。 */
const SUPPORTED_TARGETS = new Set([
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
]);

/** 计算文件 SHA-256。 */
async function calculateSha256(filePath) {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** 查找目录中的桌面端安装包。 */
async function findInstaller(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const installer = entries.find(
    (entry) => entry.isFile() && (entry.name.endsWith('.dmg') || entry.name.endsWith('.exe'))
  );
  if (!installer) {
    throw new Error(`目录中没有 DMG 或 EXE 安装包: ${directory}`);
  }
  return path.join(directory, installer.name);
}

/** 查找并复制可选的 Tauri Updater 签名资源。 */
async function prepareUpdaterAsset(sourceDirectory, destinationDirectory, installerPath) {
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sig'))
    .map((entry) => entry.name.slice(0, -4));
  const updaterName = candidates.find((name) => name !== path.basename(installerPath)) || candidates[0];
  if (!updaterName) return null;

  const updaterPath = path.join(sourceDirectory, updaterName);
  const signaturePath = `${updaterPath}.sig`;
  const signature = (await fs.readFile(signaturePath, 'utf8')).trim();
  const sha256 = await calculateSha256(updaterPath);
  const stats = await fs.stat(updaterPath);
  const destinationPath = path.join(destinationDirectory, updaterName);
  await fs.copyFile(updaterPath, destinationPath);
  await fs.writeFile(`${destinationPath}.sha256`, `${sha256}\n`, 'utf8');
  return {
    filename: updaterName,
    size: stats.size,
    sha256,
    signature,
    etag: `"sha256-${sha256}"`,
  };
}

/** 生成静态更新目录和原子发布清单。 */
async function prepareRelease(version, sourceDirectory, outputDirectory, channel = 'stable') {
  const normalizedVersion = version.replace(/^v/, '');
  const manifest = {
    version: normalizedVersion,
    notes: process.env.RELEASE_NOTES || '无更新说明。',
    pubDate: new Date().toISOString(),
    platforms: {},
  };
  const sourceEntries = await fs.readdir(sourceDirectory, { withFileTypes: true });

  for (const entry of sourceEntries) {
    if (!entry.isDirectory() || !SUPPORTED_TARGETS.has(entry.name)) continue;
    const installerPath = await findInstaller(path.join(sourceDirectory, entry.name));
    const filename = path.basename(installerPath);
    const destinationDirectory = path.join(
      outputDirectory,
      channel,
      normalizedVersion,
      entry.name
    );
    const destinationPath = path.join(destinationDirectory, filename);
    const sha256 = await calculateSha256(installerPath);
    const stats = await fs.stat(installerPath);
    await fs.mkdir(destinationDirectory, { recursive: true });
    await fs.copyFile(installerPath, destinationPath);
    await fs.writeFile(`${destinationPath}.sha256`, `${sha256}\n`, 'utf8');
    const updater = await prepareUpdaterAsset(
      path.join(sourceDirectory, entry.name),
      destinationDirectory,
      installerPath
    );

    manifest.platforms[entry.name] = {
      filename,
      size: stats.size,
      sha256,
      etag: `"sha256-${sha256}"`,
      updater,
    };
  }

  if (Object.keys(manifest.platforms).length === 0) {
    throw new Error('没有找到任何受支持平台的安装包');
  }

  const channelDirectory = path.join(outputDirectory, channel);
  await fs.mkdir(channelDirectory, { recursive: true });
  await fs.writeFile(
    path.join(channelDirectory, 'manifest.json.next'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
}

const [version, sourceDirectory, outputDirectory, channel = 'stable'] = process.argv.slice(2);
if (!version || !sourceDirectory || !outputDirectory) {
  throw new Error(
    '用法: node scripts/prepare-app-update-release.mjs <version> <sourceDir> <outputDir> [channel]'
  );
}

await prepareRelease(version, sourceDirectory, outputDirectory, channel);
