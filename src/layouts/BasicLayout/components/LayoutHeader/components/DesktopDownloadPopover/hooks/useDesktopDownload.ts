import { ref, computed, watch, onMounted } from 'vue';
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
/** 全局模块级单例缓存：避免多个组件（如顶栏气泡与登录弹窗）及页面重刷时重复发起网络请求 */
const sharedAssetsMap = ref<Partial<Record<PlatformKey, CachedAssetMeta>>>({});
const inFlightRequests = new Map<PlatformKey, Promise<CachedAssetMeta | null>>();
const sharedLatestVersion = ref('1.2.54');

/**
 * 获取单个平台的安装包元数据（带 Promise 内存去重与全局缓存）。
 * @param platformOption - 目标平台选项
 */
const fetchSingleInstallerMeta = async (platformOption: DownloadPlatformOption): Promise<CachedAssetMeta | null> => {
  if (sharedAssetsMap.value[platformOption.key]?.downloadUrl) {
    return sharedAssetsMap.value[platformOption.key]!;
  }
  if (inFlightRequests.has(platformOption.key)) {
    return inFlightRequests.get(platformOption.key)!;
  }

  const promise = fetchDesktopInstallerInfo(platformOption.platform, platformOption.arch)
    .then((result) => {
      if (result && result.downloadUrl) {
        const meta: CachedAssetMeta = {
          downloadUrl: result.downloadUrl,
          filename: result.filename,
          size: result.size,
          version: result.latestVersion || result.version,
        };
        sharedAssetsMap.value[platformOption.key] = meta;
        if (result.latestVersion || result.version) {
          sharedLatestVersion.value = String(result.latestVersion || result.version).replace(/^v/, '');
        }
        return meta;
      }
      return null;
    })
    .catch((err) => {
      console.warn(`[DesktopDownload] 获取 ${platformOption.key} 安装包元数据失败:`, err);
      return null;
    })
    .finally(() => {
      inFlightRequests.delete(platformOption.key);
    });

  inFlightRequests.set(platformOption.key, promise);
  return promise;
};

/**
 * 桌面端下载业务逻辑 Hook。
 * @description 负责平台识别、按需懒加载安装包元数据、一键下载流管理以及 macOS 隔离引导。
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
  const assetsMap = sharedAssetsMap;
  const latestVersion = sharedLatestVersion;

  /** 其他平台列表（排除当前选中的主推荐平台） */
  const otherPlatforms = computed(() =>
    SUPPORTED_DOWNLOAD_PLATFORMS.filter((p) => p.key !== currentPlatform.value.key)
  );

  /** 当前推荐平台的缓存资产元数据 */
  const currentAssetMeta = computed(() => assetsMap.value[currentPlatform.value.key]);

  /**
   * 仅在需要时按需并发拉取全部支持平台的安装包元数据（如展开气泡时）。
   */
  const loadAllInstallerMeta = async () => {
    fetchingMeta.value = true;
    try {
      await Promise.allSettled(
        SUPPORTED_DOWNLOAD_PLATFORMS.map((platformOption) => fetchSingleInstallerMeta(platformOption))
      );
    } catch (error) {
      console.warn('[DesktopDownload] 按需拉取安装包元数据失败:', error);
    } finally {
      fetchingMeta.value = false;
    }
  };

  /**
   * 触发下载指定平台的安装包（直接下载，不切换主状态）。
   * @param target - 目标平台（默认当前推荐平台）
   */
  const triggerDownload = async (target = currentPlatform.value) => {
    if (downloadingKey.value) {
      message.warning({
        content: '正在处理下载任务，请稍候勿重复点击...',
        key: 'desktop-download-wait',
        duration: 2,
      });
      return;
    }
    downloadingKey.value = target.key;

    // 立即向用户展示友好的系统识别与拉取中反馈，消除等待感
    message.loading({
      content: `正在识别系统并获取适用于 ${target.title} 的安装包...`,
      key: 'desktop-download',
      duration: 0,
    });

    try {
      let asset = assetsMap.value[target.key];
      if (!asset?.downloadUrl) {
        asset = (await fetchSingleInstallerMeta(target)) ?? undefined;
      }

      if (asset?.downloadUrl) {
        executeBrowserDownload(asset.downloadUrl, asset.filename);
        message.success({
          content: `识别成功！已开始下载雨燕桌面端 (${target.title})，请留意浏览器下载栏`,
          key: 'desktop-download',
          duration: 3,
        });

        // 若下载的是 macOS 安装包，额外提供贴心的系统风格首次安装 Gatekeeper 提示
        if (target.platform === 'darwin') {
          showMacQuarantineNotification();
        }
      } else {
        // 安全降级：跳转 GitHub Releases
        window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
        message.info({
          content: '正在为您打开 GitHub Releases 官方发布页手动选择安装包...',
          key: 'desktop-download',
          duration: 3,
        });
      }
    } catch (error) {
      console.warn('[DesktopDownload] 下载请求失败，降级到 Releases 页面:', error);
      window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
      message.info({
        content: '正在为您打开 GitHub Releases 官方发布页手动选择安装包...',
        key: 'desktop-download',
        duration: 3,
      });
    } finally {
      downloadingKey.value = null;
    }
  };

  /** 打开 GitHub Releases 发布说明 */
  const openReleaseNotes = () => {
    window.open(GITHUB_RELEASES_URL, '_blank', 'noopener,noreferrer');
  };

  // 页面就绪后仅在 Chromium 下轻量异步校准物理架构（无网络开销），不主动触发安装包接口
  onMounted(() => {
    if (typeof navigator !== 'undefined') {
      const uaData = (navigator as unknown as { userAgentData?: any }).userAgentData;
      if (uaData?.getHighEntropyValues && platformInfo.platform === 'darwin') {
        uaData.getHighEntropyValues(['architecture']).then((hints: any) => {
          if (hints?.architecture) {
            const isArm = String(hints.architecture).toLowerCase().includes('arm');
            const targetArch = isArm ? 'aarch64' : 'x86_64';
            if (currentPlatform.value.arch !== targetArch) {
              currentPlatform.value = matchDefaultPlatform('darwin', targetArch);
            }
          }
        }).catch(() => {});
      }
    }
  });

  // 展开 Popover 时若未拉取完，再次安全预热
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
