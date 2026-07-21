/**
 * 规范化 URL.hostname 返回的主机名。
 * @param hostname URL 主机名
 * @returns 去除 IPv6 方括号并转为小写后的主机名
 */
const normalizeHostname = (hostname: string): string => hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');

/**
 * 判断主机名是否为回环地址或 RFC1918 IPv4 私网地址。
 * @param hostname URL 主机名
 * @returns 是否允许在可信内网使用 HTTP
 */
export const isPrivateCentralHostname = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized === '::1') return true;

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (!ipv4Match) return false;

  const octets = ipv4Match.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [first, second] = octets;

  return first === 127
    || first === 10
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
};

/**
 * 判断中央服务地址是否满足传输策略。
 * @description 公网地址必须使用 HTTPS；回环与 RFC1918 私网地址允许 HTTP。
 * @param value 中央服务根地址
 * @returns 地址是否可用于客户端登录、设备管理与更新代理
 */
export const isAllowedCentralUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isPrivateCentralHostname(url.hostname);
  } catch {
    return false;
  }
};

/**
 * 断言中央服务地址满足传输策略。
 * @param value 中央服务根地址
 * @returns 通过校验的原始地址
 * @throws 地址无效、包含凭据，或公网 HTTP 时抛出错误
 */
export const assertAllowedCentralUrl = (value: string): string => {
  if (!isAllowedCentralUrl(value)) {
    throw new Error('VITE_APP_SERVER_URL 必须使用 HTTPS；仅回环或 RFC1918 私网地址允许 HTTP');
  }
  return value;
};
