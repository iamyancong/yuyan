import axios from 'axios';
import {
  APP_UPDATE_PRELOAD_INITIAL_DELAY_MS,
  APP_UPDATE_PRELOAD_INTERVAL_MS,
} from '../config/constants.mjs';
import { selectLatestCompatibleRelease } from './app-update-service.mjs';
import { updateAssetCacheManager } from './app-update-cache-service.mjs';

/** GitHub 托管仓库名。 */
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || 'ycwang-dev/yuyan';

/** 需要主动预热的桌面端平台。 */
const APP_UPDATE_PRELOAD_TARGETS = [
  { platform: 'darwin', arch: 'aarch64' },
  { platform: 'darwin', arch: 'x86_64' },
  { platform: 'windows', arch: 'x86_64' },
];

/** 当前并发 GitHub Releases 查询。 */
let activeReleaseRequest = null;

/** 当前主动预热定时器。 */
let preloadInterval = null;

/** 当前首次主动预热定时器。 */
let preloadInitialTimer = null;

/**
 * 构建 GitHub API 请求头。
 * @returns {Record<string, string>} 请求头
 */
function getGithubApiHeaders() {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'yuyan-app',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 查询 GitHub Releases，并共享同一时刻的并发请求。
 * @returns {Promise<object[]>} Release 列表
 */
export async function fetchGithubAppReleases() {
  if (activeReleaseRequest) return activeReleaseRequest;
  activeReleaseRequest = axios.get(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
    headers: getGithubApiHeaders(),
    params: {
      per_page: 100,
      cacheBust: Date.now(),
    },
  }).then((response) => Array.isArray(response.data) ? response.data : [])
    .finally(() => {
      activeReleaseRequest = null;
    });
  return activeReleaseRequest;
}

/**
 * 将 GitHub Asset 转换为缓存服务元数据。
 * @param {object} asset - GitHub Release Asset
 * @returns {object} 缓存资源元数据
 */
export function mapGithubAssetToCacheAsset(asset) {
  return {
    assetId: String(asset?.id || ''),
    filename: String(asset?.name || ''),
    size: Number(asset?.size || 0),
    sha256: String(asset?.digest || '').replace(/^sha256:/i, ''),
    etag: '',
  };
}

/**
 * 主动预热最新 Release 中全部受支持平台安装包。
 * @returns {Promise<object[]>} 各资源启动后的缓存状态
 */
export async function preloadLatestAppUpdateAssets() {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    console.warn('[Update Preload] 未配置 GITHUB_TOKEN，跳过中央更新包主动预热');
    return [];
  }

  const releases = await fetchGithubAppReleases();
  const assets = new Map();
  for (const target of APP_UPDATE_PRELOAD_TARGETS) {
    const compatible = selectLatestCompatibleRelease(releases, target.platform, target.arch);
    if (!compatible?.asset?.id) continue;
    const asset = mapGithubAssetToCacheAsset(compatible.asset);
    assets.set(asset.assetId, asset);
  }

  const statuses = await Promise.all(
    Array.from(assets.values()).map((asset) => updateAssetCacheManager.ensureCached(asset))
  );
  if (statuses.length > 0) {
    const summary = statuses.map((status) => `${status.filename}:${status.status}`).join(', ');
    console.log(`[Update Preload] 最新安装包预热状态: ${summary}`);
  }
  return statuses;
}

/**
 * 安全执行一次主动预热，不让后台异常中断服务进程。
 * @returns {Promise<void>} 执行完成
 */
async function runScheduledPreload() {
  try {
    await preloadLatestAppUpdateAssets();
  } catch (error) {
    console.error('[Update Preload] 主动预热失败:', error.message || error);
  }
}

/**
 * 启动中央 API 的更新包主动预热调度器。
 * @returns {() => void} 停止调度器函数
 */
export function startAppUpdatePreloadScheduler() {
  if (preloadInterval || preloadInitialTimer) {
    return stopAppUpdatePreloadScheduler;
  }
  preloadInitialTimer = setTimeout(() => {
    preloadInitialTimer = null;
    void runScheduledPreload();
  }, APP_UPDATE_PRELOAD_INITIAL_DELAY_MS);
  preloadInitialTimer.unref?.();

  preloadInterval = setInterval(() => {
    void runScheduledPreload();
  }, APP_UPDATE_PRELOAD_INTERVAL_MS);
  preloadInterval.unref?.();
  console.log(`[Update Preload] 已启动主动预热调度，间隔 ${APP_UPDATE_PRELOAD_INTERVAL_MS}ms`);
  return stopAppUpdatePreloadScheduler;
}

/** 停止中央 API 的更新包主动预热调度器。 */
export function stopAppUpdatePreloadScheduler() {
  if (preloadInitialTimer) {
    clearTimeout(preloadInitialTimer);
    preloadInitialTimer = null;
  }
  if (preloadInterval) {
    clearInterval(preloadInterval);
    preloadInterval = null;
  }
}
