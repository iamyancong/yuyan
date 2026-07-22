/**
 * Agent 控制平面变更事件总线。
 * @description 仅广播递增版本与变更域，不携带任务、授权或审计业务数据。
 */

/** Agent 事件允许公开的变更域。 */
export const AGENT_CHANGE_DOMAINS = Object.freeze(['approvals', 'operations', 'grants', 'audit', 'policy']);

const VALID_AGENT_CHANGE_DOMAINS = new Set(AGENT_CHANGE_DOMAINS);
const subscribers = new Set();
const pendingDomains = new Set();
let revision = 0;
let flushTimer = null;

/** 读取当前 Agent 事件版本。 */
export function getAgentEventRevision() {
  return revision;
}

/**
 * 发布 Agent Store 变更，并在 100ms 内合并同一批写入。
 * @param {string|string[]} domains 变更域
 */
export function publishAgentChange(domains) {
  const values = Array.isArray(domains) ? domains : [domains];
  values.forEach((domain) => {
    if (VALID_AGENT_CHANGE_DOMAINS.has(domain)) pendingDomains.add(domain);
  });
  if (!pendingDomains.size || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!pendingDomains.size) return;
    revision += 1;
    const event = Object.freeze({
      revision,
      domains: [...pendingDomains],
    });
    pendingDomains.clear();
    subscribers.forEach((subscriber) => {
      try {
        subscriber(event);
      } catch {
        /** 单个订阅异常不得中断其他客户端。 */
      }
    });
  }, 100);
  flushTimer.unref?.();
}

/**
 * 订阅 Agent Store 变更。
 * @param {(event: {revision: number, domains: string[]}) => void} subscriber 订阅回调
 * @returns {() => void} 取消订阅函数
 */
export function subscribeAgentChanges(subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/** 仅供测试和服务关闭时清理事件状态。 */
export function resetAgentEventState() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingDomains.clear();
  subscribers.clear();
  revision = 0;
}
