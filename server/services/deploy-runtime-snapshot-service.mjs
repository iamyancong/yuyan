/** 中央部署任务仍视为运行中的状态。 */
const ACTIVE_CENTRAL_OPERATION_STATUSES = new Set(['uploading', 'queued', 'running']);

/** 将中央后端操作映射为既有部署运行态快照。 */
function mapCentralOperationRuntime(operation) {
  const progress = operation.result?.progress;
  return {
    operationId: operation.id,
    targetId: Number(operation.resourceId),
    action: 'deploy',
    operator: operation.actor?.accountId || '当前账号',
    startedAt: operation.createdAt,
    currentStage: progress?.stage || operation.status,
    running: ACTIVE_CENTRAL_OPERATION_STATUSES.has(operation.status),
    result: operation.result?.record || null,
    error: operation.error?.message || null,
    events: progress ? [{ type: 'stage', ...progress, timestamp: operation.updatedAt || new Date().toISOString() }] : [],
    maxConcurrent: 1,
    runningCount: 1,
  };
}

/**
 * 合并当前团队可见的进程内任务和中央后端任务。
 * @param {{targetIds: number[], inMemorySnapshots: object[], centralOperations: object[]}} input 聚合输入
 * @returns {object[]} 去重后的运行态快照
 */
export function mergeDeployRuntimeSnapshots({ targetIds, inMemorySnapshots, centralOperations }) {
  const allowedTargetIds = new Set(targetIds.map(Number));
  const snapshotsByTargetId = new Map();

  inMemorySnapshots.forEach((snapshot) => {
    const targetId = Number(snapshot.targetId);
    if (snapshot.running && allowedTargetIds.has(targetId)) snapshotsByTargetId.set(targetId, snapshot);
  });

  centralOperations.forEach((operation) => {
    const targetId = Number(operation.resourceId);
    if (
      operation.resourceType === 'deploy_target'
      && ACTIVE_CENTRAL_OPERATION_STATUSES.has(operation.status)
      && allowedTargetIds.has(targetId)
      && !snapshotsByTargetId.has(targetId)
    ) {
      snapshotsByTargetId.set(targetId, mapCentralOperationRuntime(operation));
    }
  });

  const items = [...snapshotsByTargetId.values()];
  const runningCount = items.length;
  return items.map((snapshot) => ({ ...snapshot, runningCount }));
}

/**
 * 从尾部查找最近一次阶段事件。
 * @description 构建任务的事件数组可达数万条，原实现每次快照都 `[...events].reverse()` 整体复制，
 * 多构建并发时每次运行态广播都要复制全部日志；改为从尾部回溯，不再分配整份副本。
 * @param {object[]} events 任务事件
 * @returns {object|undefined} 最近的阶段事件
 */
export function findLatestStageEvent(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'stage') return events[index];
  }
  return undefined;
}
