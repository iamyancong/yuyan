import { ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  clearCompletedAgentOperations,
  deleteAgentOperation,
  updateAgentOperationRetentionPolicy,
  type AgentOperationRetentionPolicy,
} from '@/api/agent';

/**
 * 管理 Agent 任务记录的保留、单条删除和批量清理状态。
 * @param refreshSnapshot 任务记录变更后的快照刷新函数
 * @returns 任务记录维护状态和操作方法
 */
export function useAgentOperationMaintenance(refreshSnapshot: () => Promise<void>) {
  const operationRetentionSaving = ref(false);
  const completedOperationsClearing = ref(false);
  const deletingOperationIds = ref<string[]>([]);

  /** 更新已结束任务保留期限；后端会立即清理超期记录。 */
  const changeOperationRetention = async (retentionDays: AgentOperationRetentionPolicy['retentionDays']) => {
    operationRetentionSaving.value = true;
    try {
      const result = await updateAgentOperationRetentionPolicy(retentionDays);
      const policyText = retentionDays === 0 ? '永久保留' : `保留 ${retentionDays} 天`;
      message.success(result.deletedCount > 0
        ? `已设为${policyText}，并清理 ${result.deletedCount} 条超期任务`
        : `任务记录已设为${policyText}`);
      await refreshSnapshot();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '任务保留策略更新失败');
    } finally {
      operationRetentionSaving.value = false;
    }
  };

  /** 删除一条已结束任务记录。 */
  const removeOperation = async (id: string) => {
    if (deletingOperationIds.value.includes(id)) return;
    deletingOperationIds.value = [...deletingOperationIds.value, id];
    try {
      await deleteAgentOperation(id);
      message.success('任务记录已删除，安全审计保持不变');
      await refreshSnapshot();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '任务记录删除失败');
    } finally {
      deletingOperationIds.value = deletingOperationIds.value.filter((item) => item !== id);
    }
  };

  /** 清空全部已结束任务，保留待审批、执行中任务和安全审计。 */
  const clearCompletedOperations = async () => {
    completedOperationsClearing.value = true;
    try {
      const result = await clearCompletedAgentOperations();
      message.success(result.deletedCount > 0 ? `已清理 ${result.deletedCount} 条已结束任务` : '暂无可清理的已结束任务');
      await refreshSnapshot();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '任务记录清理失败');
    } finally {
      completedOperationsClearing.value = false;
    }
  };

  return {
    operationRetentionSaving,
    completedOperationsClearing,
    deletingOperationIds,
    changeOperationRetention,
    removeOperation,
    clearCompletedOperations,
  };
}
