import { readonly, ref } from 'vue';
import {
  getPendingAgentApprovals,
  invalidateAgentRuntimeCache,
  subscribeAgentEvents,
  syncAgentRuntimeSettings,
  type AgentChangeDomain,
  type AgentPendingApproval,
} from '@/api/agent';
import { isTauri } from '@/utils/env';
import { getAgentReconnectDelay } from '@/api/agentStream';

const pendingApprovalsState = ref<AgentPendingApproval[]>([]);
const eventSequenceState = ref(0);
const eventDomainsState = ref<AgentChangeDomain[]>([]);
const connectedState = ref(false);

let active = false;
let streamGeneration = 0;
let streamAbortController: AbortController | null = null;
let pendingRefreshPromise: Promise<boolean> | null = null;
let pendingRefreshGeneration = -1;

/** 等待下一次重连，Abort 后提前结束。 */
function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, delayMs);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** 静默刷新轻量待审批任务，并合并并发刷新请求。 */
export async function refreshAgentPendingApprovals(generation = streamGeneration): Promise<boolean> {
  if (!isTauri()) return false;
  if (pendingRefreshPromise) {
    const inFlightGeneration = pendingRefreshGeneration;
    const succeeded = await pendingRefreshPromise;
    if (active && generation === streamGeneration && inFlightGeneration !== generation) {
      return refreshAgentPendingApprovals(generation);
    }
    return succeeded && inFlightGeneration === generation;
  }
  const requestGeneration = generation;
  pendingRefreshGeneration = requestGeneration;
  pendingRefreshPromise = (async () => {
    try {
      const result = await getPendingAgentApprovals();
      if (active && requestGeneration === streamGeneration) {
        pendingApprovalsState.value = result.items;
        return true;
      }
      return false;
    } catch {
      /** 短暂断线时保留已有审批，重连后会重新同步。 */
      return false;
    }
  })();
  try {
    return await pendingRefreshPromise;
  } finally {
    pendingRefreshPromise = null;
  }
}

/** 运行当前代次的 SSE 连接与指数退避循环。 */
async function runConnectionLoop(generation: number, lifetimeController: AbortController): Promise<void> {
  let reconnectAttempt = 0;
  let runtimeSettingsSyncRequired = true;
  while (active && generation === streamGeneration && !lifetimeController.signal.aborted) {
    try {
      if (runtimeSettingsSyncRequired) {
        await syncAgentRuntimeSettings();
        runtimeSettingsSyncRequired = false;
      }
      const pendingSynchronized = await refreshAgentPendingApprovals(generation);
      if (!pendingSynchronized) throw new Error('Agent 待审批状态同步失败');
      await subscribeAgentEvents({
        signal: lifetimeController.signal,
        onEvent: (event, eventName) => {
          if (!active || generation !== streamGeneration) return;
          connectedState.value = true;
          reconnectAttempt = 0;
          if (eventName === 'ready') {
            eventDomainsState.value = ['approvals', 'operations', 'grants', 'audit', 'policy'];
            eventSequenceState.value += 1;
            void refreshAgentPendingApprovals(generation);
            return;
          }
          eventDomainsState.value = event.domains;
          eventSequenceState.value += 1;
          if (event.domains.includes('approvals')) void refreshAgentPendingApprovals(generation);
        },
      });
    } catch {
      if (lifetimeController.signal.aborted || !active || generation !== streamGeneration) return;
      connectedState.value = false;
      invalidateAgentRuntimeCache();
      runtimeSettingsSyncRequired = true;
    }
    if (lifetimeController.signal.aborted || !active || generation !== streamGeneration) return;
    const delay = getAgentReconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    await waitForReconnect(delay, lifetimeController.signal);
  }
}

/** 重新同步身份并建立新代次 SSE。 */
async function restartAgentEventStream(clearPending = false): Promise<void> {
  if (!active || !isTauri()) return;
  streamGeneration += 1;
  const generation = streamGeneration;
  streamAbortController?.abort();
  streamAbortController = new AbortController();
  connectedState.value = false;
  pendingRefreshGeneration = -1;
  if (clearPending) pendingApprovalsState.value = [];
  if (!active || generation !== streamGeneration || !streamAbortController) return;
  void runConnectionLoop(generation, streamAbortController);
}

/** 账号切换后立即废弃旧身份流与待审批数据。 */
function handleAuthStateChanged() {
  void restartAgentEventStream(true);
}

/** 页面重新可见时补一次一致性同步。 */
function handleVisibilityChange() {
  if (document.visibilityState === 'visible') void refreshAgentPendingApprovals();
}

/** 网络恢复后跳过当前退避，立即重连。 */
function handleOnline() {
  void restartAgentEventStream(false);
}

/** 启动全局唯一 Agent SSE。 */
export function startAgentEventStream(): void {
  if (active || !isTauri()) return;
  active = true;
  window.addEventListener('auth-state-changed', handleAuthStateChanged);
  window.addEventListener('online', handleOnline);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void restartAgentEventStream(false);
}

/** 停止 Agent SSE 并释放生命周期监听器。 */
export function stopAgentEventStream(): void {
  if (!active) return;
  active = false;
  streamGeneration += 1;
  streamAbortController?.abort();
  streamAbortController = null;
  connectedState.value = false;
  window.removeEventListener('auth-state-changed', handleAuthStateChanged);
  window.removeEventListener('online', handleOnline);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}

/** 获取 Agent 全局事件状态。 */
export function useAgentEventStream() {
  return {
    pendingApprovals: readonly(pendingApprovalsState),
    eventSequence: readonly(eventSequenceState),
    eventDomains: readonly(eventDomainsState),
    connected: readonly(connectedState),
    refreshPendingApprovals: refreshAgentPendingApprovals,
    start: startAgentEventStream,
    stop: stopAgentEventStream,
  };
}
