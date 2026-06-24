export function isTauri(): boolean {
  return typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
}

/**
 * 获取 API 请求的基础路径
 * @description 根据运行环境或 LocalStorage 配置返回请求的前缀。如果是桌面端，默认直连指定的网页端服务器，同时也支持通过 localStorage 进行动态切换。
 * @param {string} path - API 相对路径 (例如 '/scaffold-api')
 * @returns {string} 完整的 API 基础请求路径
 */
export function getApiBase(path: string): string {
  // 允许通过 localStorage 动态修改 API 基础路径，便于后续切换调试环境而无需重新打包
  const customBase = typeof window !== 'undefined' ? window.localStorage.getItem('CUSTOM_API_BASE') : null;
  if (customBase) {
    return `${customBase.replace(/\/$/, '')}${path}`;
  }

  if (isTauri()) {
    // 桌面端直连网页端部署的 Express 服务地址
    return `http://192.168.164.27:3100${path}`;
  }
  // 网页端走相对路径代理
  return path;
}

