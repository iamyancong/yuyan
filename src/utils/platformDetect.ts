/**
 * 平台探测工具
 * @description 智能检测用户操作系统和 CPU 架构，支持现代 userAgentData API 和传统 UA 解析
 */

/** 平台探测结果 */
export interface PlatformInfo {
  /** 平台标识（用于 API 参数） */
  platform: 'darwin' | 'windows' | 'unknown';
  /** CPU 架构 */
  arch: 'aarch64' | 'x86_64';
  /** 人类可读的平台名称 */
  platformName: string;
  /** 探测来源 */
  source: 'userAgentData' | 'userAgent';
}

/**
 * NavigatorUAData 类型定义
 * @see https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData
 */
interface NavigatorUAData {
  platform: string;
  mobile: boolean;
}

/**
 * 智能检测客户端操作系统和 CPU 架构
 * @description 优先使用现代 navigator.userAgentData API（更精准），降级到传统 UA 字符串解析
 * @returns 包含平台、架构、友好名称的检测结果
 */
export const detectPlatform = (): PlatformInfo => {
  // 🔹 优先使用现代 API: navigator.userAgentData
  const uaData = (navigator as unknown as { userAgentData?: NavigatorUAData }).userAgentData;

  if (uaData?.platform) {
    const platformStr = uaData.platform.toLowerCase();
    const isMac = platformStr === 'macos';
    const isWin = platformStr === 'windows';

    if (isMac) {
      // macOS 下通过 UA 辅助判断 Intel vs Apple Silicon
      const ua = navigator.userAgent.toLowerCase();
      const isAppleSilicon = !ua.includes('intel');

      return {
        platform: 'darwin',
        arch: isAppleSilicon ? 'aarch64' : 'x86_64',
        platformName: isAppleSilicon ? 'macOS (Apple Silicon)' : 'macOS (Intel)',
        source: 'userAgentData',
      };
    }

    if (isWin) {
      return {
        platform: 'windows',
        arch: 'x86_64',
        platformName: 'Windows (x64)',
        source: 'userAgentData',
      };
    }

    return {
      platform: 'unknown',
      arch: 'x86_64',
      platformName: '未知系统',
      source: 'userAgentData',
    };
  }

  // 🔹 降级：传统 UA 字符串解析
  const ua = navigator.userAgent.toLowerCase();
  const isMac = ua.includes('macintosh') || ua.includes('mac os x');
  const isWin = ua.includes('windows') || ua.includes('win32');

  if (isMac) {
    const isAppleSilicon = !ua.includes('intel');
    return {
      platform: 'darwin',
      arch: isAppleSilicon ? 'aarch64' : 'x86_64',
      platformName: isAppleSilicon ? 'macOS (Apple Silicon)' : 'macOS (Intel)',
      source: 'userAgent',
    };
  }

  if (isWin) {
    return {
      platform: 'windows',
      arch: 'x86_64',
      platformName: 'Windows (x64)',
      source: 'userAgent',
    };
  }

  return {
    platform: 'unknown',
    arch: 'x86_64',
    platformName: '未知系统',
    source: 'userAgent',
  };
};
