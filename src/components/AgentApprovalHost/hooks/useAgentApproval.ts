import { computed, onMounted, onUnmounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  approveAgentOperation,
  getAgentSnapshot,
  rejectAgentOperation,
  syncAgentRuntimeSettings,
  type AgentOperation,
} from '@/api/agent';
import { isTauri } from '@/utils/env';

/** 全局轮询并处理最早的待审批 Agent 操作。 */
export function useAgentApproval() {
  const operations = ref<AgentOperation[]>([]);
  const deciding = ref(false);
  let timer: number | undefined;

  const currentOperation = computed(() => operations.value[0] || null);

  /** 静默刷新待审批任务。 */
  const refresh = async () => {
    if (!isTauri()) return;
    try {
      const snapshot = await getAgentSnapshot();
      operations.value = snapshot.operations.items.filter((item) => item.status === 'pending_approval').reverse();
    } catch {
      operations.value = [];
    }
  };

  /** 批准或拒绝当前任务。 */
  const decide = async (action: 'approve' | 'reject') => {
    const operation = currentOperation.value;
    if (!operation) return;
    deciding.value = true;
    try {
      if (action === 'approve') await approveAgentOperation(operation.id);
      else await rejectAgentOperation(operation.id);
      message.success(action === 'approve' ? '已批准，任务将在雨燕后台执行' : '已拒绝 Agent 操作');
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '审批失败');
    } finally {
      deciding.value = false;
    }
  };

  onMounted(async () => {
    if (!isTauri()) return;
    await syncAgentRuntimeSettings().catch(() => undefined);
    await refresh();
    timer = window.setInterval(() => void refresh(), 1500);
  });

  onUnmounted(() => {
    if (timer) window.clearInterval(timer);
  });

  return { currentOperation, deciding, decide };
}
