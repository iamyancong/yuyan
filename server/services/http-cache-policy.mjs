/**
 * 动态 API 缓存策略。
 * @description WebKit 可能在没有可用缓存正文时继续发送条件请求，Express 随后返回空正文 304；
 * 部署、认证与健康检查均为动态数据，因此统一忽略条件缓存头并禁止中间缓存。
 */

const DYNAMIC_API_ROUTE_PATTERN = /^\/(?:api|scaffold-api|deploy-api|agent-api|health)(?:\/|$)/;

/**
 * 禁用动态 API 的条件缓存。
 * @param {import('express').Request} req - Express 请求
 * @param {import('express').Response} res - Express 响应
 * @param {import('express').NextFunction} next - 后续中间件
 * @returns {void}
 */
export function disableDynamicApiCache(req, res, next) {
  if (!DYNAMIC_API_ROUTE_PATTERN.test(req.path)) {
    next();
    return;
  }

  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}
