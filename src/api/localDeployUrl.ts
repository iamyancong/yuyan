const LOCAL_DEPLOY_API_PREFIX = '/deploy-api';

/**
 * 构建本地辅助服务的部署 API 地址。
 * @param baseUrl 本地辅助服务根地址
 * @param path 部署接口路径，可包含或省略 `/deploy-api` 前缀
 * @returns 带部署路由前缀的完整地址
 */
export function buildLocalDeployApiUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`;
  const deployApiPath = normalizedPath === LOCAL_DEPLOY_API_PREFIX
    || normalizedPath.startsWith(`${LOCAL_DEPLOY_API_PREFIX}/`)
    ? normalizedPath
    : `${LOCAL_DEPLOY_API_PREFIX}${normalizedPath}`;
  return `${normalizedBaseUrl}${deployApiPath}`;
}
