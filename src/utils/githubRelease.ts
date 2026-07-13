/**
 * GitHub Releases 直连工具
 * @description 当后端代理不可用时，直接通过 GitHub API 获取最新发布版本并匹配对应平台安装包
 */

/** GitHub Release Asset（安装包）的核心字段 */
export interface GitHubReleaseAsset {
  /** 文件名 */
  name: string;
  /** 浏览器直连下载地址 */
  browser_download_url: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件标签（如 "雨燕_1.0.6_aarch64.dmg"） */
  label: string;
}

/** GitHub Release 的核心字段 */
export interface GitHubReleaseInfo {
  /** Tag 名称（如 "v1.0.6"） */
  tag_name: string;
  /** Release 名称 */
  name: string;
  /** 发布时间 */
  published_at: string;
  /** 是否为预发布 */
  prerelease: boolean;
  /** 附带的安装包列表 */
  assets: GitHubReleaseAsset[];
  /** Release 说明 */
  body: string | null;
}

/** GitHub Releases API 基础地址 */
const GITHUB_RELEASES_API = 'https://api.github.com/repos/ycwang-dev/yuyan/releases';

/** GitHub Releases 页面地址（用于最终兜底跳转） */
export const GITHUB_RELEASES_PAGE = 'https://github.com/ycwang-dev/yuyan/releases';

/**
 * 从 GitHub Releases API 获取最新发布版本信息
 * @description 遍历所有 Release，返回第一个包含有效 assets 的版本（即最新可下载版本）
 * @returns 最新 Release 的详细信息，获取失败时返回 null
 */
export const fetchLatestRelease = async (): Promise<GitHubReleaseInfo | null> => {
  const response = await fetch(GITHUB_RELEASES_API, {
    headers: { Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub API 请求失败: ${response.status} ${response.statusText}`);
  }

  const releases: GitHubReleaseInfo[] = await response.json();

  // 返回第一个含安装包的版本（API 按时间倒序）
  return releases.find((r) => r.assets.length > 0) ?? null;
};

/**
 * 根据平台和架构匹配对应的安装包
 * @description 基于平台、CPU 架构和文件扩展名匹配安装包
 * @param assets Release 中的安装包列表
 * @param platform 平台标识（'darwin' | 'windows'）
 * @param arch CPU 架构（'aarch64' | 'x86_64'）
 * @returns 匹配的安装包信息，未找到时返回 null
 */
export const matchAssetForPlatform = (
  assets: GitHubReleaseAsset[],
  platform: string,
  arch: string,
): GitHubReleaseAsset | null => {
  if (platform === 'darwin') {
    const archPattern = arch === 'aarch64'
      ? /(?:^|[._-])(?:aarch64|arm64)(?:[._-]|$)/i
      : /(?:^|[._-])(?:x86_64|x64|amd64|intel)(?:[._-]|$)/i;
    return assets.find((asset) => asset.name.endsWith('.dmg') && archPattern.test(asset.name)) ?? null;
  }

  if (platform === 'windows') {
    return assets.find((a) => a.name.endsWith('.exe')) ?? null;
  }

  return null;
};

/**
 * 格式化文件大小为人类可读格式
 * @param bytes 字节数
 * @returns 格式化后的字符串（如 "54.7 MB"）
 */
export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
