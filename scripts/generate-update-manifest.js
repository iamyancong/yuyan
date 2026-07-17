import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Tauri 静态更新清单支持的平台和产物扩展名。 */
const UPDATE_TARGETS = {
  'darwin-aarch64': '.app.tar.gz',
  'darwin-x86_64': '.app.tar.gz',
  'windows-x86_64': '.exe',
};

/**
 * 递归读取目录中的全部文件。
 * @param {string} directory 根目录
 * @returns {string[]} 文件路径集合
 */
const listFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const entryPath = path.join(directory, entry.name);
  return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
});

/**
 * 为 GitHub Release 资产名称生成安全 URL。
 * @param {string} repository GitHub 仓库
 * @param {string} tag Release Tag
 * @param {string} filename Release 资产文件名
 * @returns {string} 下载地址
 */
const createAssetUrl = (repository, tag, filename) => {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
};

/**
 * 生成包含三平台签名与下载地址的 Tauri updater 静态清单。
 * @param {{ version: string; tag: string; repository: string; distDirectory: string; notes?: string; publishedAt?: Date }} options 生成参数
 * @returns {object} 生成后的清单对象
 */
export const generateUpdateManifest = ({
  version,
  tag,
  repository,
  distDirectory,
  notes = `雨燕 ${version} 更新`,
  publishedAt = new Date(),
}) => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`更新版本号不是有效 SemVer：${version}`);
  }
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Release Tag 不是有效版本：${tag}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`GitHub 仓库名称无效：${repository}`);
  }

  const files = listFiles(distDirectory);
  const platforms = Object.fromEntries(Object.entries(UPDATE_TARGETS).map(([target, extension]) => {
    const targetDirectory = `${path.sep}${target}${path.sep}`;
    const artifacts = files.filter((file) => file.includes(targetDirectory)
      && file.endsWith(extension)
      && !file.endsWith('.sig'));
    if (!artifacts.length) throw new Error(`缺少 ${target} 更新产物 ${extension}`);

    const artifact = artifacts.find((file) => fs.existsSync(`${file}.sig`));
    if (!artifact) throw new Error(`缺少更新签名：${artifacts[0]}.sig`);

    const signaturePath = `${artifact}.sig`;
    const signature = fs.readFileSync(signaturePath, 'utf8').trim();
    if (!signature) throw new Error(`更新签名为空：${signaturePath}`);

    return [target, {
      signature,
      url: createAssetUrl(repository, tag, path.basename(artifact)),
    }];
  }));

  const manifest = {
    version,
    notes,
    pub_date: publishedAt.toISOString(),
    platforms,
  };
  fs.writeFileSync(
    path.join(distDirectory, 'latest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
};

/** 从命令行参数生成更新清单。 */
const runCli = () => {
  const [version, tag, repository, distDirectory = './dist-release'] = process.argv.slice(2);
  if (!version || !tag || !repository) {
    throw new Error('Usage: node scripts/generate-update-manifest.js <version> <tag> <owner/repo> [dist-directory]');
  }
  generateUpdateManifest({
    version,
    tag,
    repository,
    distDirectory: path.resolve(distDirectory),
    notes: process.env.RELEASE_NOTES || `雨燕 ${version} 更新`,
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
