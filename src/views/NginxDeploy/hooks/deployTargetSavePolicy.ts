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
