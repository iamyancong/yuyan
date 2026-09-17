import { ref, onMounted } from 'vue';
import { DESKTOP_DOWNLOAD_GUIDE_STORAGE_KEY } from '../constant';

/**
 * 桌面端下载弱引导交互 Hook。
 * @description 控制首次访问内网网页版时顶栏图标旁的微弱小红点与引导气泡，支持持久化静音。
 */
export const useDownloadGuide = () => {
  const guideVisible = ref(false);

  /** 初始化读取弱引导状态。 */
  onMounted(() => {
    try {
      const dismissed = localStorage.getItem(DESKTOP_DOWNLOAD_GUIDE_STORAGE_KEY);
      if (!dismissed) {
        guideVisible.value = true;
      }
    } catch {
      // 容错处理无 localStorage 访问权限的场景
      guideVisible.value = false;
    }
  });

  /**
   * 关闭弱引导并持久化记录，避免重复干扰用户。
   */
  const dismissGuide = () => {
    if (!guideVisible.value) return;
    guideVisible.value = false;
    try {
      localStorage.setItem(DESKTOP_DOWNLOAD_GUIDE_STORAGE_KEY, 'true');
    } catch {
      // 容错处理
    }
  };

  return {
    guideVisible,
    dismissGuide,
  };
};
