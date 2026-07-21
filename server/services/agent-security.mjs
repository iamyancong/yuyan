/**
 * Agent 控制平面安全工具。
 * @description 统一处理规范化序列化、参数哈希和敏感信息脱敏。
 */

import crypto from 'node:crypto';

const SENSITIVE_KEY_PATTERN = /(?:authorization|credential|password|passphrase|private.?key|secret|token)/i;
const SENSITIVE_TEXT_PATTERNS = [
  [/\b(Bearer|Private-Token|X-Deploy-Token)\s*[:=]?\s*[^\s,;]+/gi, '$1 ***'],
  [/([?&](?:token|access_token|private_token|password)=)[^&\s]+/gi, '$1***'],
  [/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1***:***@'],
  [/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, '[PRIVATE KEY REDACTED]'],
];

/**
 * 对对象键排序后生成稳定 JSON 文本。
 * @param {unknown} value 待序列化值
 * @returns {string} 稳定 JSON 文本
 */
export function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (input) => {
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    return Object.keys(input)
      .sort()
      .reduce((result, key) => {
        result[key] = normalize(input[key]);
        return result;
      }, {});
  };
  return JSON.stringify(normalize(value));
}

/**
 * 生成参数摘要哈希。
 * @param {unknown} value 参数
 * @returns {string} SHA-256 十六进制摘要
 */
export function hashAgentPayload(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * 脱敏自由文本中的凭据片段。
 * @param {unknown} value 原始文本
 * @returns {string} 脱敏文本
 */
export function redactAgentText(value) {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    String(value ?? '')
  );
}

/**
 * 深度脱敏参数与结果，禁止凭据进入日志和审计正文。
 * @param {unknown} value 原始值
 * @returns {unknown} 脱敏副本
 */
export function redactAgentValue(value) {
  if (typeof value === 'string') return redactAgentText(value);
  if (Array.isArray(value)) return value.map(redactAgentValue);
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((result, [key, item]) => {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '***' : redactAgentValue(item);
    return result;
  }, {});
}

/**
 * 使用固定时序比较会话令牌。
 * @param {unknown} actual 请求令牌
 * @param {unknown} expected 预期令牌
 * @returns {boolean} 是否一致
 */
export function timingSafeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length > 0
    && actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
