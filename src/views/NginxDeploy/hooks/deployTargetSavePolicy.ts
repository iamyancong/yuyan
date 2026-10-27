/** 部署目标重复冲突响应的最小结构。 */
interface DeployTargetConflictError {
  response?: {
    data?: {
      code?: unknown;
      details?: {
        targetId?: unknown;
      };
    };
  };
}

/** 可用于定位重复目标的最小字段。 */
interface DeployTargetIdentity {
  id?: string | number;
  projectId?: string | number;
  projectPath?: string;
  projectName?: string;
  envName?: string;
  serverId?: string | number;
  deployRoot?: string;
}

/** 归一化部署目录，避免尾斜杠影响重复目标恢复。 */
const normalizeIdentityPath = (value?: string): string => String(value || '').trim().replace(/\/+$/, '') || '/';

/**
 * 判断接口错误是否为部署目标重复冲突。
 * @param error 接口错误
 * @returns 是否为重复目标冲突
 */
export function isDuplicateDeployTargetError(error: unknown): boolean {
  const response = (error as DeployTargetConflictError & { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  const message = typeof response?.error === 'string' ? response.error : '';
  return response?.code === 'deploy_target_exists' || message.includes('已存在部署目标');
}

/**
 * 从部署目标重复冲突中提取已有目标 ID。
 * @param error 接口错误
 * @returns 已有目标 ID；非重复冲突时返回空字符串
 */
export function getDuplicateDeployTargetId(error: unknown): string {
  const response = (error as DeployTargetConflictError | null)?.response?.data;
  if (response?.code !== 'deploy_target_exists') return '';
  const targetId = response.details?.targetId;
  return typeof targetId === 'string' || typeof targetId === 'number' ? String(targetId) : '';
}

/**
 * 从最新目标列表中定位重复记录。
 * @param targets 当前工作区全部部署目标
 * @param payload 本次新增表单数据
 * @param conflictTargetId 服务端返回的冲突目标 ID
 * @returns 已存在的部署目标
 */
export function findDuplicateDeployTarget<T extends DeployTargetIdentity>(
  targets: T[],
  payload: DeployTargetIdentity,
  conflictTargetId = '',
): T | undefined {
  if (conflictTargetId) {
    const matchedById = targets.find((target) => String(target.id ?? '') === conflictTargetId);
    if (matchedById) return matchedById;
  }
  const matchesProject = (target: T) => (
    (payload.projectId && String(target.projectId ?? '') === String(payload.projectId))
    || (payload.projectPath && target.projectPath === payload.projectPath)
    || (payload.projectName && target.projectName === payload.projectName)
  );
  return targets.find((target) => (
    String(target.serverId ?? '') === String(payload.serverId ?? '')
    && String(target.envName || '测试') === String(payload.envName || '测试')
    && normalizeIdentityPath(target.deployRoot) === normalizeIdentityPath(payload.deployRoot)
    && matchesProject(target)
  ));
}

/**
 * 计算保存部署目标时是否需要携带 `buildMemoryMb` 字段：
 * - 新增目标时始终携带规范化后的数值（0 ~ 65536 整数）；
 * - 编辑已有目标时，若用户未修改「构建内存」字段，返回 `undefined`（不随请求发送），避免覆盖服务端刚由 OOM 重试记住的扩容值。
 */
export function resolveTargetSaveBuildMemoryMb(options: {
  isEditing: boolean;
  initialBuildMemoryMb: number | null | undefined;
  currentBuildMemoryMb: unknown;
}): number | undefined {
  const normalized = Math.min(
    Math.max(0, Math.floor(Number(options.currentBuildMemoryMb ?? 0) || 0)),
    65536,
  );
  if (
    options.isEditing &&
    options.initialBuildMemoryMb !== null &&
    options.initialBuildMemoryMb !== undefined
  ) {
    const normalizedInitial = Math.min(
      Math.max(0, Math.floor(Number(options.initialBuildMemoryMb) || 0)),
      65536,
    );
    if (normalized === normalizedInitial) {
      return undefined;
    }
  }
  return normalized;
}
