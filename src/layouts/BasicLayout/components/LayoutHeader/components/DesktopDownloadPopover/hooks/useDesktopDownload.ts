import { ref, computed, watch } from 'vue';
import { message } from 'ant-design-vue';
import { detectPlatform } from '@/utils/platformDetect';
import { fetchDesktopInstallerInfo } from '@/api/deploy';
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
 * @description 负责客户端平台嗅探、服务端安装包元数据拉取、平台切换及触发浏览器文件下载流。
 */
export const useDesktopDownload = () => {
  const platformInfo = detectPlatform();
  const currentPlatform = ref<DownloadPlatformOption>(
    matchDefaultPlatform(platformInfo.platform, platformInfo.arch)
  );

  const popoverVisible = ref(false);
  const downloading = ref(false);
  const fetchingMeta = ref(false);
  const showOtherPlatforms = ref(false);
  const latestVersion = ref('1.2.54');
  const assetsMap = ref<Partial<Record<PlatformKey, CachedAssetMeta>>>({});

  /** 其他平台列表（排除当前选中的主平台） */
  const otherPlatforms = computed(() =>
    SUPPORTED_DOWNLOAD_PLATFORMS.filter((p) => p.key !== currentPlatform.value.key)
  );

  /** 当前选中平台的缓存资产元数据 */
  const currentAssetMeta = computed(() => assetsMap.value[currentPlatform.value.key]);

  /**
   * 拉取指定平台的安装包信息。
   * @param platformOption - 目标平台
   */
  const loadInstallerMeta = async (platformOption: DownloadPlatformOption) => {
    if (assetsMap.value[platformOption.key]?.downloadUrl) return;
    fetchingMeta.value = true;
    try {
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
    } catch (error) {
      console.warn('[DesktopDownload] 获取安装包元数据失败，保留默认链接:', error);
    } finally {
      fetchingMeta.value = false;
    }
  };

  /**
   * 触发下载指定平台的安装包。
   * @param target - 目标平台（默认当前选中平台）
   */
  const triggerDownload = async (target = currentPlatform.value) => {
    if (downloading.value) return;
    downloading.value = true;

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
        message.success(`已开始下载雨燕桌面端 (${target.title})，请留意浏览器下载进度`);
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
      downloading.value = false;
    }
  };

  /**
   * 切换选中的主下载平台。
   * @param option - 目标平台选项
   */
  const selectPlatform = (option: DownloadPlatformOption) => {
    currentPlatform.value = option;
    showOtherPlatforms.value = false;
    loadInstallerMeta(option);
  };

  /** 展开或收起其他平台列表 */
  const toggleOtherPlatforms = () => {
    showOtherPlatforms.value = !showOtherPlatforms.value;
  };

  /** 打开 GitHub Releases 发布说明 */
  const openReleaseNotes = () => {
    window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
  };

  // 展开 Popover 时预热当前平台的安装包元数据
  watch(popoverVisible, (visible) => {
    if (visible) {
      loadInstallerMeta(currentPlatform.value);
    }
  });

  return {
    popoverVisible,
    downloading,
    fetchingMeta,
    currentPlatform,
    currentAssetMeta,
    latestVersion,
    showOtherPlatforms,
    otherPlatforms,
    triggerDownload,
    selectPlatform,
    toggleOtherPlatforms,
    openReleaseNotes,
  };
};
