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
    // 优先读取环境变量配置，便于本地开发调试，否则使用默认网页端部署的 Express 服务地址
    const appServer = import.meta.env.VITE_APP_SERVER_URL || '';
    return `${appServer.replace(/\/$/, '')}${path}`;
  }
  // 网页端走相对路径代理
  return path;
}

/**
 * 判断当前是否处于可展示测试功能的本地服务环境。
 * @description
 * 1. 支持通过 localStorage 中 'YUYAN_DEBUG_NOTIFICATION' 为 'true' 作为手动调试开关；
 * 2. 生产打包的 Tauri 桌面端（非 DEV）属于正式发布版本，严格隐藏测试功能；
 * 3. 本地开发环境（import.meta.env.DEV）属于本地服务；
 * 4. 浏览器端访问本地回环地址（localhost / 127.0.0.1 / ::1）属于本地服务；
 * 5. 线上部署环境（域名或非回环 IP）不展示测试功能。
 * @param options 可选测试覆盖选项
 * @returns 是否允许展示测试功能
 */
export function isLocalService(options?: { isDev?: boolean; customWindow?: any }): boolean {
  const win = options?.customWindow ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return false;

  try {
    if (win.localStorage?.getItem('YUYAN_DEBUG_NOTIFICATION') === 'true') {
      return true;
    }
  } catch {
    // 忽略 localStorage 访问受限异常
  }

  const isDev = options?.isDev !== undefined
    ? options.isDev
    : Boolean(typeof import.meta !== 'undefined' && import.meta.env?.DEV);

  const isTauriEnv = Boolean((win as any).__TAURI_INTERNALS__ !== undefined);

  if (isTauriEnv) {
    return isDev;
  }

  if (isDev) {
    return true;
  }

  const hostname = String(win.location?.hostname || '').trim().toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  return false;
}

