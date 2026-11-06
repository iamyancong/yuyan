/**
 * 雨燕中央部署 API 响应错误归一化策略（纯函数）。
 * @description 由 src/api/deploy.ts 的 axios 响应拦截器调用：
 * - 解析服务端不同接口返回的错误结构（顶层 code/error 与嵌套 error: { code, message, retryable }）；
 * - 回填服务端业务码到 error.code 与 error.apiCode，原始 axiosCode 妥善留存；
 * - 补充 error.userMessage 人类可读错误文案；
 * - 保持网络错误与取消请求（ERR_NETWORK、ERR_CANCELED、AbortError）的原始状态，供 centralReadRecovery 正确判定重试。
 */

/** 服务端规范错误结构。 */
export interface ApiErrorInfo {
  code?: string;
  message?: string;
  retryable?: boolean;
}

/**
 * 从服务端错误体中提取规范错误信息（纯函数）。
 * @param body 服务端响应体（response.data）
 * @returns 提取出的 code、message 与 retryable
 */
export function extractApiErrorInfo(body: any): ApiErrorInfo {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }

  const result: ApiErrorInfo = {};

  // 1. code：先读顶层 body.code（字符串且非空），否则读 body.error.code（error 为对象时）
  if (typeof body.code === 'string' && body.code.trim().length > 0) {
    result.code = body.code.trim();
  } else if (
    body.error &&
    typeof body.error === 'object' &&
    !Array.isArray(body.error) &&
    typeof body.error.code === 'string' &&
    body.error.code.trim().length > 0
  ) {
    result.code = body.error.code.trim();
  }

  // 2. message：优先 body.error（字符串）、再 body.error.message、再 body.message
  if (typeof body.error === 'string' && body.error.trim().length > 0) {
    result.message = body.error.trim();
  } else if (
    body.error &&
    typeof body.error === 'object' &&
    !Array.isArray(body.error) &&
    typeof body.error.message === 'string' &&
    body.error.message.trim().length > 0
  ) {
    result.message = body.error.message.trim();
  } else if (typeof body.message === 'string' && body.message.trim().length > 0) {
    result.message = body.message.trim();
  }

  // 3. retryable：只在 body.error.retryable 为布尔时给出
  if (
    body.error &&
    typeof body.error === 'object' &&
    !Array.isArray(body.error) &&
    typeof body.error.retryable === 'boolean'
  ) {
    result.retryable = body.error.retryable;
  }

  return result;
}

/**
 * 归一化部署相关的 HTTP 错误（原地修改并返回同一对象）。
 * @param error axios 抛出或拒绝的错误对象
 * @returns 归一化后的同一错误对象
 */
export function normalizeDeployHttpError<T = any>(error: T): T {
  if (!error || typeof error !== 'object') {
    return error;
  }

  const err = error as Record<string, any>;

  // 1. 取消请求（error.code === 'ERR_CANCELED' 或 name === 'CanceledError' / 'AbortError'）原样返回，不加任何字段
  const isCanceled =
    err.code === 'ERR_CANCELED' ||
    err.name === 'CanceledError' ||
    err.name === 'AbortError';

  if (isCanceled) {
    return error;
  }

  // 2. 无 response（断网/超时）不修改任何字段（保持 ERR_NETWORK / ECONNABORTED 等，centralReadRecovery 依赖它们）
  if (!err.response) {
    return error;
  }

  // 3. 有 error.response 时从 response.data 提取
  const info = extractApiErrorInfo(err.response.data);

  if (info.code) {
    if (err.code !== undefined && err.code !== null && err.code !== '') {
      err.axiosCode = err.code;
    }
    err.apiCode = info.code;
    err.code = info.code;
  }

  if (typeof info.retryable === 'boolean') {
    err.retryable = info.retryable;
  }

  if (info.message && !err.userMessage) {
    err.userMessage = info.message;
  }

  return error;
}
