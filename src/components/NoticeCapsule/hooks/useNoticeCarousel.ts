import { ref, watch, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { checkAppUpdateFromServer } from '@/api/deploy';
import { detectPlatform } from '@/utils/platformDetect';
import {
  fetchLatestRelease,
  matchAssetForPlatform,
  formatFileSize,
  GITHUB_RELEASES_PAGE,
} from '@/utils/githubRelease';
import { NOTICE_LIST } from '../constant';
import { message } from 'ant-design-vue';

/** 视口内部左右 padding 像素值 */
const VIEWPORT_PADDING = 16;
/** 视口左右 padding 总和 */
const VIEWPORT_PADDING_TOTAL = VIEWPORT_PADDING * 2;

/** 非溢出消息的默认停留时长（毫秒） */
const NORMAL_STAY_MS = 6_000;

/** 滚动速度（像素/秒） */
const MARQUEE_SPEED = 50;

/** 首尾相接滚动的间隙宽度（像素） */
const MARQUEE_GAP = 32;

/**
 * NoticeCapsule 核心业务逻辑 Hook
 * @description 提供智能无缝跑马灯调度、客户端平台探测与下载
 */
export function useNoticeCarousel() {
  const currentIndex = ref(0);
  const isHovered = ref(false);
  const containerRef = ref<HTMLElement | null>(null);
  const textRef = ref<HTMLElement | null>(null);
  const isOverflow = ref(false);
  const downloadLoading = ref(false);

  /** 消息切换定时器 */
  let switchTimer: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  /** 当前显示的消息 */
  const currentNotice = computed(() => NOTICE_LIST[currentIndex.value]);

  /**
   * 计算跑马灯的动画 duration 并通过 CSS 变量返回
   * @description 仅当文字溢出时计算，否则返回空对象
   */
  const translateStyle = computed(() => {
    if (!isOverflow.value || !textRef.value) {
      return {};
    }
    const textWidth = textRef.value.scrollWidth;
    // 一轮滚动的总距离为文本宽度加上间隙
    const totalDistance = textWidth + MARQUEE_GAP;
    const duration = totalDistance / MARQUEE_SPEED;
    return {
      '--marquee-duration': `${duration}s`,
    };
  });

  // ======================== 定时器调度 ========================

  /** 清除切换定时器 */
  const clearAllTimers = () => {
    if (switchTimer !== null) {
      clearTimeout(switchTimer);
      switchTimer = null;
    }
  };

  /**
   * 调度下一条消息
   * @description 智能计算展示时长：不溢出固定 6s；溢出则至少 6s，若滚动一整轮所需时间更长，则刚好等待其滚动完一整轮
   */
  const scheduleNext = () => {
    clearAllTimers();

    if (NOTICE_LIST.length <= 1) return;
    if (isHovered.value) return;

    let stayMs = NORMAL_STAY_MS;

    if (isOverflow.value && textRef.value) {
      const textWidth = textRef.value.scrollWidth;
      const totalDistance = textWidth + MARQUEE_GAP;
      const duration = totalDistance / MARQUEE_SPEED;
      // 至少展示 6s，若滚动一轮需要更久，则精确等它滚完一整轮
      stayMs = Math.max(NORMAL_STAY_MS, duration * 1000);
    }

    switchTimer = window.setTimeout(() => {
      if (!isHovered.value) {
        nextNotice();
      }
    }, stayMs);
  };

  // ======================== 监听与监控 ========================

  /** 监听当前 index 变化，自动触发下一次溢出检测与切换调度 */
  watch(currentIndex, () => {
    nextTick(() => {
      checkOverflow();
      scheduleNext();
    });
  });

  watch(isHovered, (hovered) => {
    if (hovered) {
      // 鼠标悬停：清除消息切换定时器（CSS 滚动暂停在样式层通过 animation-play-state: paused 处理）
      clearAllTimers();
    } else {
      // 鼠标移出：重新为当前消息开始计时调度
      scheduleNext();
    }
  });

  // ======================== 系统探测与下载 ========================

  /**
   * 触发浏览器下载
   * @param url 下载地址
   * @param filename 建议的文件名
   */
  const triggerBrowserDownload = (url: string, filename?: string) => {
    const link = document.createElement('a');
    link.href = url;
    if (filename) {
      link.download = filename;
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  /**
   * 获取最新版本的客户端下载地址并执行下载
   * @description 三级兜底策略：后端代理 → GitHub Releases API 直连 → 跳转 GitHub 页面
   */
  const handleDownloadClient = async () => {
    if (downloadLoading.value) return;

    downloadLoading.value = true;
    const { platform, arch, platformName } = detectPlatform();

    message.loading({
      content: `正在获取适合您的 ${platformName} 客户端安装包...`,
      key: 'client-download',
      duration: 0,
    });

    // 🔹 第一优先级：走后端代理
    try {
      const res = await checkAppUpdateFromServer('0.0.0', platform, arch);

      if (res?.downloadUrl) {
        message.success({ content: '获取下载链接成功，开始下载！', key: 'client-download', duration: 2 });
        triggerBrowserDownload(res.downloadUrl, res.filename ?? `yuyan-client-${platform}-${arch}`);
        downloadLoading.value = false;
        return;
      }
    } catch (proxyError) {
      console.warn('[Download] 后端代理失败，尝试 GitHub 直连...', proxyError);
    }

    // 🔹 第二优先级：直连 GitHub Releases API
    try {
      const release = await fetchLatestRelease();

      if (release) {
        const asset = matchAssetForPlatform(release.assets, platform);

        if (asset) {
          const size = formatFileSize(asset.size);
          message.success({
            content: `正在从 GitHub 下载 ${release.tag_name}（${size}）...`,
            key: 'client-download',
            duration: 3,
          });
          triggerBrowserDownload(asset.browser_download_url, asset.name);
          downloadLoading.value = false;
          return;
        }
      }
    } catch (githubError) {
      console.warn('[Download] GitHub 直连失败:', githubError);
    }

    // 🔹 最终兜底：跳转 GitHub Releases 页面
    message.info({
      content: '已打开 GitHub Releases 页面，请手动选择适合您系统的安装包',
      key: 'client-download',
      duration: 4,
    });
    window.open(GITHUB_RELEASES_PAGE, '_blank');
    downloadLoading.value = false;
  };

  // ======================== 溢出检测 ========================

  /**
   * 计算当前文字是否被溢出遮挡
   * @description 对比文字的物理宽度与视口的可用宽度（扣除 padding 渐隐安全区）
   */
  const checkOverflow = () => {
    if (containerRef.value && textRef.value) {
      const containerWidth = containerRef.value.clientWidth;
      const textWidth = textRef.value.scrollWidth;
      isOverflow.value = textWidth > (containerWidth - VIEWPORT_PADDING_TOTAL);
    } else {
      isOverflow.value = false;
    }
  };

  /** 切换到下一条消息 */
  const nextNotice = () => {
    clearAllTimers();
    currentIndex.value = (currentIndex.value + 1) % NOTICE_LIST.length;
  };

  // ======================== 生命周期 ========================

  onMounted(() => {
    nextTick(() => {
      checkOverflow();
      scheduleNext();
    });

    if (containerRef.value) {
      resizeObserver = new ResizeObserver(() => {
        checkOverflow();
        scheduleNext();
      });
      resizeObserver.observe(containerRef.value);
    }
  });

  onUnmounted(() => {
    clearAllTimers();
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  });

  return {
    currentIndex,
    isHovered,
    containerRef,
    textRef,
    isOverflow,
    downloadLoading,
    currentNotice,
    translateStyle,
    handleDownloadClient,
    checkOverflow,
  };
}
