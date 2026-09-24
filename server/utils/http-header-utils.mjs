/**
 * HTTP 响应头安全构建工具
 */

/**
 * 构建符合 RFC 6266 与 RFC 5987 标准的 Content-Disposition 响应头。
 * filename="..." 严格过滤非 ASCII 字符，防止触发 Node.js ERR_INVALID_CHAR 崩溃；
 * filename*=UTF-8''... 提供完整的 UTF-8 中文/国际化文件名供现代客户端与浏览器解析。
 * @param {string} fileName - 目标文件名
 * @param {string} [fallback='download'] - 备用纯 ASCII 文件名
 * @returns {string} 安全的 Content-Disposition 头字符串
 */
export function buildSafeContentDisposition(fileName, fallback = 'download') {
  const raw = String(fileName || '').trim() || fallback;
  // 清洗引号、换行与非法控制字符，并将非 ASCII 字符（如中文）替换为安全下划线作为 fallback
  const safeAscii = raw.replace(/["\r\n\0]/g, '').replace(/[^\x20-\x7E]/g, '_').trim() || fallback;
  const encoded = encodeURIComponent(raw);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}
