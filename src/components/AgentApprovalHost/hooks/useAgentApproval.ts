import { computed, onMounted, onUnmounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  approveAgentOperation,
  rejectAgentOperation,
} from '@/api/agent';
import { useAgentEventStream } from '@/composables/useAgentEventStream';

/** 全局订阅并处理最早的待审批 Agent 操作。 */
export function useAgentApproval() {
  const deciding = ref(false);
  const { pendingApprovals, refreshPendingApprovals, start, stop } = useAgentEventStream();

  const currentOperation = computed(() => pendingApprovals.value[0] || null);

  /** 批准或拒绝当前任务。 */
  const decide = async (action: 'approve' | 'reject') => {
    const operation = currentOperation.value;
    if (!operation) return;
    deciding.value = true;
    try {
      if (action === 'approve') await approveAgentOperation(operation.id);
      else await rejectAgentOperation(operation.id);
      message.success(action === 'approve' ? '已批准，任务将在雨燕后台执行' : '已拒绝 Agent 操作');
      await refreshPendingApprovals();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '审批失败');
    } finally {
      deciding.value = false;
    }
  };

  onMounted(start);
  onUnmounted(stop);

  return { currentOperation, deciding, decide };
}
