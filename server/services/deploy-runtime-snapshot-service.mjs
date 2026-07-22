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
