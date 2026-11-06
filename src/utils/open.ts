import { isTauri } from './env';

/**
 * 在系统默认浏览器中打开外部链接。
 * 如果是在 Tauri 桌面端环境中，使用 @tauri-apps/plugin-opener 的 openUrl 方法；
 * 如果是在网页端环境中，则使用传统的 window.open。
 *
 * @param {string} url - 要打开的外部链接 URL
 * @returns {Promise<void>}
 */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  if (isTauri()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch {
      // 降级方案：使用浏览器标准能力打开
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
