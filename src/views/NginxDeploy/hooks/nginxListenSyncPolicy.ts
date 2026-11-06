/**
 * Nginx 配置 listen 端口 → 部署目标监听端口的同步策略（纯函数，便于单测）。
 * @description 只解析文本，不发请求。决定「该建议哪个端口」以及「何时只提示、不擅自选」：
 * - 配置里只有一个唯一端口：建议它；
 * - 当前监听端口仍在配置里：视为一致，不打扰；
 * - 能对比保存前后的配置，且明显是「旧端口 → 一个新端口」的单端口替换：建议新端口；
 * - 其余多个端口的情况一律只提示，让用户在部署目标里手动确认。
 */
import { normalizeListenPort, parseVisitUrlPort, syncVisitUrlWithListenPort } from './visitUrlPortPolicy.ts';

/** 端口同步建议 */
export type ListenPortSuggestion =
  /** 保存前后 listen 端口集合没变，这次保存与端口无关 */
  | { kind: 'config-unchanged'; ports: number[] }
  /** 配置里没找到可识别的 listen */
  | { kind: 'no-listen' }
  /** 当前监听端口仍在配置的 listen 里，无需同步 */
  | { kind: 'in-sync'; ports: number[]; listenPort: number }
  /** 明确建议同步到某个端口 */
  | { kind: 'suggest'; from: number | null; to: number; ports: number[] }
  /** 多个端口且无法判断是哪一个替换了旧端口，只提示 */
  | { kind: 'ambiguous'; ports: number[] };

/** 去掉 # 注释（引号内的 # 保留） */
function stripNginxComments(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      let quote: string | null = null;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote) {
          if (char === '\\') index += 1;
          else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '#') {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join('\n');
}

/**
 * 从 listen 指令的第一个参数解析端口。
 * @description 支持 `80`、`8050`、`[::]:8050`、`[::]`、`127.0.0.1:8050`、`*:8050`、`localhost`；
 * 只写地址不写端口时按 Nginx 规则取 80；`unix:` 套接字返回 null。
 * @param address listen 的地址参数
 * @returns 端口；无法识别时返回 null
 */
export function parseListenAddressPort(address: string): number | null {
  const value = String(address || '').trim().replace(/^["']|["']$/g, '');
  if (!value || /^unix:/i.test(value)) return null;
  if (/^\d+$/.test(value)) return normalizeListenPort(value);
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (!rest) return 80;
    const matched = rest.match(/^:(\d+)$/);
    return matched ? normalizeListenPort(matched[1]) : null;
  }
  const colonIndex = value.lastIndexOf(':');
  if (colonIndex >= 0) {
    const port = value.slice(colonIndex + 1);
    return /^\d+$/.test(port) ? normalizeListenPort(port) : null;
  }
  // 只有主机名或 IPv4 地址时，Nginx 默认监听 80
  return /^[\w.*-]+$/.test(value) ? 80 : null;
}

/**
 * 解析 Nginx 配置文本里所有 listen 端口。
 * @description 忽略注释；同一端口的 ssl/http2/default_server 等变体去重（listen 8050 与 listen 8050 ssl 算一个）。
 * @param content Nginx 配置文本
 * @returns 去重并升序排列的端口
 */
export function parseNginxListenPorts(content: string): number[] {
  const text = stripNginxComments(String(content || ''));
  const ports = new Set<number>();
  const pattern = /(?<=^|[\s;{}])listen\s+([^;{}]+);/g;
  let matched: RegExpExecArray | null;
  while ((matched = pattern.exec(text))) {
    const address = matched[1].trim().split(/\s+/)[0];
    const port = parseListenAddressPort(address);
    if (port !== null) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * 决定是否、以及建议把部署目标的监听端口同步到哪个端口。
 * @param options.currentListenPort 部署目标当前记录的监听端口
 * @param options.nextPorts 最新配置里的 listen 端口
 * @param options.previousPorts 保存前配置里的 listen 端口；不传表示无法对比（如直接从服务器读取）
 * @returns 同步建议
 */
export function resolveListenPortSuggestion(options: {
  currentListenPort: unknown;
  nextPorts: number[];
  previousPorts?: number[];
}): ListenPortSuggestion {
  const next = [...new Set(options.nextPorts.map(normalizeListenPort).filter((port): port is number => port !== null))].sort((a, b) => a - b);
  const previous = options.previousPorts
    ? [...new Set(options.previousPorts.map(normalizeListenPort).filter((port): port is number => port !== null))].sort((a, b) => a - b)
    : null;
  if (previous && previous.length === next.length && previous.every((port, index) => port === next[index])) {
    return { kind: 'config-unchanged', ports: next };
  }
  if (!next.length) return { kind: 'no-listen' };
  const current = normalizeListenPort(options.currentListenPort);
  if (current !== null && next.includes(current)) return { kind: 'in-sync', ports: next, listenPort: current };
  if (next.length === 1) return { kind: 'suggest', from: current, to: next[0], ports: next };
  if (previous && current !== null && previous.includes(current)) {
    const removed = previous.filter((port) => !next.includes(port));
    const added = next.filter((port) => !previous.includes(port));
    if (removed.length === 1 && added.length === 1) {
      return { kind: 'suggest', from: current, to: added[0], ports: next };
    }
  }
  return { kind: 'ambiguous', ports: next };
}

/** 同步计划：确定后要写回部署目标的值 */
export interface ListenPortSyncPlan {
  listenPort: number;
  visitUrl: string;
  /** 访问地址是否会跟着改端口 */
  visitUrlChanged: boolean;
}

/**
 * 根据建议生成同步计划：监听端口改成新端口；访问地址只有端口正好等于旧监听端口时才改端口，
 * 反代地址（如 https://example.com）保持不变。
 * @param suggestion `kind === 'suggest'` 的建议
 * @param visitUrl 当前访问地址
 * @returns 同步计划
 */
export function buildListenPortSyncPlan(
  suggestion: Extract<ListenPortSuggestion, { kind: 'suggest' }>,
  visitUrl: string
): ListenPortSyncPlan {
  const currentVisitUrl = String(visitUrl || '');
  const nextVisitUrl = syncVisitUrlWithListenPort(currentVisitUrl, suggestion.from, suggestion.to);
  return { listenPort: suggestion.to, visitUrl: nextVisitUrl, visitUrlChanged: nextVisitUrl !== currentVisitUrl };
}

/**
 * 询问弹窗正文。
 * @param suggestion 同步建议
 * @param plan 同步计划
 * @returns 多行文案
 */
export function formatListenPortSyncConfirm(
  suggestion: Extract<ListenPortSuggestion, { kind: 'suggest' }>,
  plan: ListenPortSyncPlan
): string[] {
  const lines = [
    suggestion.from === null
      ? `该站点配置里的监听端口是 ${suggestion.to}，部署目标还没有填写监听端口，是否同步到部署目标？`
      : `该站点监听端口已从 ${suggestion.from} 改为 ${suggestion.to}，是否同步到部署目标？`,
  ];
  if (plan.visitUrlChanged) {
    lines.push(`访问地址会同步改为 ${plan.visitUrl}`);
  } else if (plan.visitUrl.trim() && parseVisitUrlPort(plan.visitUrl) !== null) {
    lines.push(`访问地址 ${plan.visitUrl.trim()} 保持不变`);
  }
  return lines;
}

/**
 * 多端口无法判断时的提示文案。
 * @param ports 配置里的端口
 */
export function formatAmbiguousListenPortsHint(ports: number[]): string {
  return `配置里检测到多个监听端口：${ports.join('、')}，请在部署目标里手动确认`;
}

/**
 * 校验从 Nginx 配置同步监听端口的异步结果是否仍然处于有效生命周期内。
 * @param state 当前请求的中止、组件销毁、请求世代与目标 ID
 * @returns 若请求已被中止、组件已卸载、世代不匹配或目标 ID 已变更则返回 false，否则返回 true
 */
export function isNginxConfSyncResultActive(state: {
  aborted: boolean;
  disposed: boolean;
  requestGeneration: number;
  currentGeneration: number;
  requestTargetId: number;
  currentTargetId: number;
}): boolean {
  if (state.aborted || state.disposed) return false;
  if (state.requestGeneration !== state.currentGeneration) return false;
  if (state.requestTargetId !== state.currentTargetId) return false;
  return true;
}
