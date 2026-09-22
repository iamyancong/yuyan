import { getPersistentDeployTask, getRecord, getTarget } from './deploy-store.mjs';

/** 按目标所属团队验证任务访问权，并返回可用于断线对账的稳定快照。 */
export async function getDeployTaskReconciliation(targetId, taskId) {
  const target = await getTarget(targetId);
  if (!target) return null;
  const task = await getPersistentDeployTask(taskId);
  if (!task || String(task.targetId) !== String(target.id)) return null;
  const record = ['deploy', 'rollback', 'undoRollback'].includes(task.action) && task.resultRef ? await getRecord(task.resultRef) : null;
  return {
    taskId: task.id,
    targetId: task.targetId,
    action: task.action,
    operator: task.operator,
    startedAt: task.startedAt,
    currentStage: task.stage,
    running: task.status === 'running',
    result: record || task.result,
    error: ['failed', 'interrupted'].includes(task.status) ? task.error || '服务重启或任务执行中断' : null,
    events: [],
    maxConcurrent: 1,
    runningCount: task.status === 'running' ? 1 : 0,
  };
}
