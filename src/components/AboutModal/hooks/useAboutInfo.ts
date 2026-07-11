import { ref, onMounted } from 'vue';
import { message } from 'ant-design-vue';
import { isTauri } from '@/utils/env';
import { ABOUT_CONFIG, type SystemInfo } from '../constant';

/**
 * 关于雨燕组件业务逻辑 Hook
 * @description 获取桌面端诊断信息，管理面板折叠，提供诊断数据复制能力
 */
export const useAboutInfo = () => {
  const systemInfo = ref<SystemInfo>(ABOUT_CONFIG.defaultInfo());
  const infoLoading = ref(false);
  const diagnosticExpanded = ref(false);

  /** 提取当前 Web 渲染引擎版本 */
  const getRenderEngineInfo = (): string => {
    const ua = navigator.userAgent;
    
    // 匹配 Chrome/Chromium 核心
    const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
    if (chromeMatch) {
      return `Chromium v${chromeMatch[1]}`;
    }

    // 匹配 Safari/WebKit 核心 (macOS 默认)
    const safariMatch = ua.match(/Version\/([\d.]+).*Safari/);
    if (safariMatch) {
      return `Safari v${safariMatch[1]}`;
    }

    const webkitMatch = ua.match(/AppleWebKit\/([\d.]+)/);
    if (webkitMatch) {
      return `WebKit v${webkitMatch[1]}`;
    }

    return 'Unknown Render Engine';
  };

  /** 获取底层诊断信息 */
  const fetchSystemInfo = async () => {
    if (!isTauri()) {
      // 网页端或非桌面端，使用 Mock 占位
      systemInfo.value = {
        appVersion: __APP_VERSION__,
        tauriVersion: 'N/A (Web Mode)',
        nodeVersion: 'N/A',
        osInfo: `${navigator.platform || 'Unknown OS'} (${navigator.language})`,
        renderEngine: getRenderEngineInfo(),
      };
      return;
    }

    infoLoading.value = true;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const rustInfo = await invoke<any>('get_system_info');
      systemInfo.value = {
        appVersion: rustInfo.appVersion || 'Unknown',
        tauriVersion: rustInfo.tauriVersion ? `v${rustInfo.tauriVersion}` : 'Unknown',
        nodeVersion: rustInfo.nodeVersion || 'Unknown',
        osInfo: rustInfo.osInfo || 'Unknown',
        renderEngine: getRenderEngineInfo(),
      };
    } catch (error) {
      console.error('获取关于系统诊断信息失败:', error);
      message.error('无法读取桌面端环境诊断数据');
    } finally {
      infoLoading.value = false;
    }
  };

  /** 一键复制诊断信息至剪切板 */
  const handleCopyInfo = async () => {
    const infoText = [
      `${ABOUT_CONFIG.appName} (${ABOUT_CONFIG.appKey})`,
      `版本 (Version): v${systemInfo.value.appVersion}`,
      `操作系统 (OS): ${systemInfo.value.osInfo}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(infoText);
      message.success('诊断信息已成功复制到剪贴板');
    } catch (err) {
      console.error('复制失败:', err);
      message.error('复制诊断信息失败，请手动选定复制');
    }
  };

  /** 切换诊断面板展开折叠 */
  const toggleDiagnostic = () => {
    diagnosticExpanded.value = !diagnosticExpanded.value;
  };

  onMounted(() => {
    void fetchSystemInfo();
  });

  return {
    systemInfo,
    infoLoading,
    diagnosticExpanded,
    toggleDiagnostic,
    handleCopyInfo,
  };
};
