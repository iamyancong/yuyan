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
  source: 'userAgentData' | 'userAgent' | 'webgl';
}

/**
 * NavigatorUAData 类型定义
 * @see https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData
 */
interface NavigatorUAData {
  platform: string;
  mobile: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
}

/** 缓存异步 Client Hints 探测出的 macOS 架构，避免重复查询 */
let cachedMacArch: 'aarch64' | 'x86_64' | null = null;

// 在现代 Chromium 浏览器环境下，若支持 Client Hints，后台静默异步预热精确架构
if (typeof navigator !== 'undefined') {
  const uaData = (navigator as unknown as { userAgentData?: NavigatorUAData }).userAgentData;
  if (uaData?.getHighEntropyValues) {
    uaData.getHighEntropyValues(['architecture'])
      .then((hints) => {
        if (hints?.architecture) {
          const isArm = hints.architecture.toLowerCase().includes('arm');
          cachedMacArch = isArm ? 'aarch64' : 'x86_64';
        }
      })
      .catch(() => {
        // 忽略高熵查询失败
      });
  }
}

/**
 * 探测 macOS 系统的物理 CPU 架构 (Apple Silicon vs Intel)
 * @description
 * 1. 现代浏览器在 macOS 上因防指纹追踪与历史网站兼容性，navigator.userAgent 均被冻结为 'Intel Mac OS X 10_15_7'。
 *    因此绝对不能使用 !ua.includes('intel') 判断，否则所有 Mac 都会被误判为 Intel。
 * 2. 方案一：若 Client Hints 已异步取得 architecture，直接复用。
 * 3. 方案二：通过 WebGL 的 WEBGL_debug_renderer_info 扩展，同步读取真实的 GPU 渲染器硬件名称（Unmasked Renderer）。
 *    - Apple Silicon 会返回包含 "Apple M"、"Apple GPU" 或 "Apple" 等字样。
 *    - Intel Mac 会返回包含 "Intel"、"AMD" 或 "Radeon" 等字样。
 * 4. 方案三（兜底）：现代 macOS（2020 年发布 M1，2023 年全面停售 Intel）绝大多数机器为 Apple Silicon，默认推断为 aarch64。
 * @returns 架构与探测来源
 */
export const detectMacCpuArch = (): { arch: 'aarch64' | 'x86_64'; source: 'userAgentData' | 'webgl' | 'userAgent' } => {
  if (cachedMacArch) {
    return { arch: cachedMacArch, source: 'userAgentData' };
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          if (typeof renderer === 'string') {
            const lower = renderer.toLowerCase();
            // 明确为 Intel 集显/独显或 AMD 显卡
            if (lower.includes('intel') || lower.includes('amd') || lower.includes('radeon')) {
              return { arch: 'x86_64', source: 'webgl' };
            }
            // 明确为 Apple 芯片（如 Apple M1/M2/M3/M4, Apple GPU）
            if (lower.includes('apple')) {
              return { arch: 'aarch64', source: 'webgl' };
            }
          }
        }
      }
    } catch {
      // 忽略 WebGL 探测异常
    }
  }

  // 现代 Mac 默认为 Apple Silicon (aarch64)
  return { arch: 'aarch64', source: 'userAgent' };
};

/**
 * 智能检测客户端操作系统和 CPU 架构
 * @description 优先使用现代 navigator.userAgentData API，并配合 WebGL 硬件级渲染器识别 macOS 芯片架构
 * @returns 包含平台、架构、友好名称的检测结果
 */
export const detectPlatform = (): PlatformInfo => {
  // 🔹 优先使用现代 API: navigator.userAgentData
  const uaData = (typeof navigator !== 'undefined'
    ? (navigator as unknown as { userAgentData?: NavigatorUAData }).userAgentData
    : undefined);

  if (uaData?.platform) {
    const platformStr = uaData.platform.toLowerCase();
    const isMac = platformStr === 'macos';
    const isWin = platformStr === 'windows';

    if (isMac) {
      const { arch, source } = detectMacCpuArch();
      const isAppleSilicon = arch === 'aarch64';

      return {
        platform: 'darwin',
        arch,
        platformName: isAppleSilicon ? 'macOS (Apple Silicon)' : 'macOS (Intel)',
        source,
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
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();
  const isMac = ua.includes('macintosh') || ua.includes('mac os x');
  const isWin = ua.includes('windows') || ua.includes('win32');

  if (isMac) {
    const { arch, source } = detectMacCpuArch();
    const isAppleSilicon = arch === 'aarch64';
    return {
      platform: 'darwin',
      arch,
      platformName: isAppleSilicon ? 'macOS (Apple Silicon)' : 'macOS (Intel)',
      source,
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
