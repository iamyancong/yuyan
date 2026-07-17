/**
 * 生成后台子进程选项。
 * @description Windows 隐藏控制台窗口，其他平台由 Node 忽略该选项；调用方仍可保留 stdout/stderr 管道。
 * @param {Record<string, unknown>} [options] 原始子进程选项
 * @returns {Record<string, unknown> & {windowsHide: true}} 后台子进程选项
 */
export function withHiddenWindow(options = {}) {
  return {
    ...options,
    windowsHide: true,
  };
}
