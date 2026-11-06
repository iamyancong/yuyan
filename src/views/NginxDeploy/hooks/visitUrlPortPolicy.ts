/**
 * 访问地址端口与监听端口一致性策略（纯函数，便于单测）。
 * @description 访问地址（visitUrl）负责点击打开，监听端口（listenPort）是 Nginx 实际 listen 的端口，
 * 用于列表展示和端口冲突判断。两者可以合法地不同（前面还有反向代理时对外是 80/443），
 * 所以这里只负责「发现不一致并给出提示 / 一键同步的取值」，绝不自动改写任何一方。
 */

/** 端口不一致检测结果 */
export interface VisitUrlPortMismatch {
  /** 访问地址解析出的端口（含 http 默认 80、https 默认 443） */
  visitPort: number;
  /** 当前记录的监听端口；未填写或非法时为 null */
  listenPort: number | null;
}

/** http/https 默认端口 */
const DEFAULT_PORT_BY_PROTOCOL: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

/**
 * 归一化监听端口：只接受 1-65535 的整数。
 * @param value 表单或接口中的端口值
 * @returns 合法端口；空值、0、非整数或越界时返回 null
 */
export function normalizeListenPort(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * 从访问地址解析端口。
 * @description 只认 http/https；无显式端口时按协议取 80/443。支持 IPv6、带 path/query/hash 的地址。
 * @param visitUrl 访问地址
 * @returns 端口；空字符串、非 http(s)、无法解析时返回 null（表示无法比较）
 */
export function parseVisitUrlPort(visitUrl: unknown): number | null {
  const raw = typeof visitUrl === 'string' ? visitUrl.trim() : '';
  if (!raw || !/^https?:\/\/[^/?#]/i.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const defaultPort = DEFAULT_PORT_BY_PROTOCOL[parsed.protocol];
  if (!defaultPort || !parsed.hostname) return null;
  if (!parsed.port) return defaultPort;
  return normalizeListenPort(parsed.port);
}

/**
 * 检测访问地址端口与监听端口是否不一致。
 * @param visitUrl 访问地址
 * @param listenPort 当前记录的监听端口
 * @returns 不一致时返回双方端口；一致或访问地址无法解析时返回 null
 */
export function getVisitUrlPortMismatch(visitUrl: unknown, listenPort: unknown): VisitUrlPortMismatch | null {
  const visitPort = parseVisitUrlPort(visitUrl);
  if (visitPort === null) return null;
  const normalizedListenPort = normalizeListenPort(listenPort);
  if (normalizedListenPort === visitPort) return null;
  return { visitPort, listenPort: normalizedListenPort };
}

/**
 * 生成编辑表单中字段旁的提示文案。
 * @param mismatch 不一致检测结果
 * @returns 例如「访问地址是 8050，当前监听端口仍是 9999」
 */
export function formatListenPortSyncHint(mismatch: VisitUrlPortMismatch): string {
  return mismatch.listenPort === null
    ? `访问地址是 ${mismatch.visitPort}，当前监听端口未填写`
    : `访问地址是 ${mismatch.visitPort}，当前监听端口仍是 ${mismatch.listenPort}`;
}

/**
 * 生成列表摘要中不一致标记的 tooltip 文案。
 * @param mismatch 不一致检测结果
 * @returns 例如「访问地址端口为 8050，监听端口为 9999」
 */
export function formatSummaryPortMismatchHint(mismatch: VisitUrlPortMismatch): string {
  const listenText = mismatch.listenPort === null ? '未填写' : `为 ${mismatch.listenPort}`;
  return `访问地址端口为 ${mismatch.visitPort}，监听端口${listenText}。如果前面有反向代理，两者不同是正常的；否则请在编辑里把监听端口同步为 ${mismatch.visitPort}`;
}

/**
 * 「同步为 xxx」按钮的取值：只返回新的监听端口，不改访问地址。
 * @param visitUrl 访问地址
 * @param listenPort 当前监听端口
 * @returns 需要写入的监听端口；无需同步或无法解析时返回 null
 */
export function resolveListenPortSyncValue(visitUrl: unknown, listenPort: unknown): number | null {
  return getVisitUrlPortMismatch(visitUrl, listenPort)?.visitPort ?? null;
}

/**
 * 托管且由平台管理站点时，监听端口是主字段：改监听端口后把访问地址里的端口跟着改。
 * @description 只有访问地址原本就和「改之前的监听端口」一致时才改写，避免覆盖用户刻意填写的
 * 反代地址（例如 https://example.com）。只替换 authority 里的端口，协议、主机、path 原样保留。
 * @param visitUrl 当前访问地址
 * @param previousListenPort 改之前的监听端口
 * @param nextListenPort 改之后的监听端口
 * @returns 新访问地址；无需改写时原样返回
 */
export function syncVisitUrlWithListenPort(visitUrl: string, previousListenPort: unknown, nextListenPort: unknown): string {
  const previous = normalizeListenPort(previousListenPort);
  const next = normalizeListenPort(nextListenPort);
  if (previous === null || next === null || previous === next) return visitUrl;
  if (parseVisitUrlPort(visitUrl) !== previous) return visitUrl;
  const matched = String(visitUrl).match(/^(\s*https?:\/\/)([^/?#]*)(.*)$/is);
  if (!matched) return visitUrl;
  const [, prefix, authority, rest] = matched;
  const atIndex = authority.lastIndexOf('@');
  const userInfo = atIndex >= 0 ? authority.slice(0, atIndex + 1) : '';
  const hostPort = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
  const host = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : hostPort.replace(/:\d*$/, '');
  if (!host) return visitUrl;
  return `${prefix}${userInfo}${host}:${next}${rest}`;
}
