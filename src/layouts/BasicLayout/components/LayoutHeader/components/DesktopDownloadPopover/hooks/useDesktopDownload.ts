import { ref, computed, watch } from 'vue';
import { message } from 'ant-design-vue';
import { detectPlatform } from '@/utils/platformDetect';
import { fetchDesktopInstallerInfo } from '@/api/deploy';
import { showMacQuarantineNotification } from './useMacNotification';
import {
  type DownloadPlatformOption,
  type PlatformKey,
  SUPPORTED_DOWNLOAD_PLATFORMS,
  GITHUB_RELEASES_URL,
  matchDefaultPlatform,
} from '../constant';

/** 缓存的安装包元数据 */
interface CachedAssetMeta {
  downloadUrl?: string;
  filename?: string;
  size?: number;
  version?: string;
}

/**
 * 触发浏览器原生文件下载。
 * @param url - 下载地址
 * @param filename - 建议保存文件名
 */
const executeBrowserDownload = (url: string, filename?: string) => {
  const link = document.createElement('a');
  link.href = url;
  if (filename) {
    link.download = filename;
  }
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

/**
 * 桌面端下载业务逻辑 Hook。
 * @description 负责平台识别、多架构全量元数据并发拉取、各平台一键直接下载流管理以及 macOS 隔离引导。
 */
export const useDesktopDownload = () => {
  const platformInfo = detectPlatform();
  const isMac = computed(() => platformInfo.platform === 'darwin');

  const currentPlatform = ref<DownloadPlatformOption>(
    matchDefaultPlatform(platformInfo.platform, platformInfo.arch)
  );

  const popoverVisible = ref(false);
  const downloadingKey = ref<string | null>(null);
  const fetchingMeta = ref(false);
  const latestVersion = ref('1.2.54');
  const assetsMap = ref<Partial<Record<PlatformKey, CachedAssetMeta>>>({});

  /** 其他平台列表（排除当前选中的主推荐平台） */
  const otherPlatforms = computed(() =>
    SUPPORTED_DOWNLOAD_PLATFORMS.filter((p) => p.key !== currentPlatform.value.key)
  );

  /** 当前推荐平台的缓存资产元数据 */
  const currentAssetMeta = computed(() => assetsMap.value[currentPlatform.value.key]);

  /**
   * 并发拉取全部平台的安装包元数据（确保所有平铺项均可瞬间展示文件大小）。
   */
  const loadAllInstallerMeta = async () => {
    fetchingMeta.value = true;
    try {
      await Promise.allSettled(
        SUPPORTED_DOWNLOAD_PLATFORMS.map(async (platformOption) => {
          if (assetsMap.value[platformOption.key]?.downloadUrl) return;
          const result = await fetchDesktopInstallerInfo(
            platformOption.platform,
            platformOption.arch
          );
          if (result && result.downloadUrl) {
            assetsMap.value[platformOption.key] = {
              downloadUrl: result.downloadUrl,
              filename: result.filename,
              size: result.size,
              version: result.latestVersion || result.version,
            };
            if (result.latestVersion || result.version) {
              latestVersion.value = String(result.latestVersion || result.version).replace(/^v/, '');
            }
          }
        })
      );
    } catch (error) {
      console.warn('[DesktopDownload] 并行预热安装包元数据失败:', error);
    } finally {
      fetchingMeta.value = false;
    }
  };

  /**
   * 触发下载指定平台的安装包（直接下载，不切换主状态）。
   * @param target - 目标平台（默认当前推荐平台）
   */
  const triggerDownload = async (target = currentPlatform.value) => {
    if (downloadingKey.value) return;
    downloadingKey.value = target.key;

    try {
      let asset = assetsMap.value[target.key];
      if (!asset?.downloadUrl) {
        const result = await fetchDesktopInstallerInfo(target.platform, target.arch);
        if (result && result.downloadUrl) {
          asset = {
            downloadUrl: result.downloadUrl,
            filename: result.filename,
            size: result.size,
            version: result.latestVersion || result.version,
          };
          assetsMap.value[target.key] = asset;
          if (result.latestVersion || result.version) {
            latestVersion.value = String(result.latestVersion || result.version).replace(/^v/, '');
          }
        }
      }

      if (asset?.downloadUrl) {
        executeBrowserDownload(asset.downloadUrl, asset.filename);
        message.success(`已开始下载雨燕桌面端 (${target.title})，请留意浏览器下载栏`);

        // 若下载的是 macOS 安装包，额外提供贴心的系统风格首次安装 Gatekeeper 提示
        if (target.platform === 'darwin') {
          showMacQuarantineNotification();
        }
      } else {
        // 安全降级：跳转 GitHub Releases
        window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
        message.info('正在打开 GitHub Releases 官方发布页');
      }
    } catch (error) {
      console.warn('[DesktopDownload] 下载请求失败，降级到 Releases 页面:', error);
      window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
      message.info('正在打开 GitHub Releases 官方发布页');
    } finally {
      downloadingKey.value = null;
    }
  };

  /** 打开 GitHub Releases 发布说明 */
  const openReleaseNotes = () => {
    window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
  };

  // 展开 Popover 时预热全部支持平台的安装包元数据
  watch(popoverVisible, (visible) => {
    if (visible) {
      loadAllInstallerMeta();
    }
  });

  return {
    popoverVisible,
    downloadingKey,
    fetchingMeta,
    isMac,
    currentPlatform,
    currentAssetMeta,
    latestVersion,
    assetsMap,
    otherPlatforms,
    triggerDownload,
    openReleaseNotes,
  };
};
