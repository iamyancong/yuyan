/**
 * GitLab 认证检查决策策略。
 * @description 抽离纯策略逻辑以便单测覆盖边界情况，不依赖 Vue 单例或浏览器环境。
 */

export type RemoteUserKind = 'ok' | 'unauthorized' | 'unavailable';

/**
 * 根据 GitLab /user 调用的异常分类。
 * 仅 401 视为 unauthorized，其余（含无 response、超时、5xx、403）为 unavailable。
 */
export function classifyGitlabUserError(error: unknown): 'unauthorized' | 'unavailable' {
  const status = (error as any)?.response?.status;
  return status === 401 ? 'unauthorized' : 'unavailable';
}

/** 在代次仍有效的前提下，根据远程结果决定 checkAuth 下一步。 */
export type CheckAuthRemoteDecision =
  | { action: 'logout' }
  | { action: 'apply-remote' }
  | { action: 'apply-cached' }; // 离线恢复

export function decideCheckAuthRemoteAction(
  kind: 'ok' | 'unauthorized' | 'unavailable'
): CheckAuthRemoteDecision {
  if (kind === 'unauthorized') return { action: 'logout' };
  if (kind === 'ok') return { action: 'apply-remote' };
  return { action: 'apply-cached' };
}

/**
 * 代次门闩检查：若当前全局代次与本轮检查持有的代次不一致，则必须中止。
 * @param owned 本轮 checkAuth 持有的代次号
 * @param current 全局最新代次号（logout 或并发 checkAuth 会自增）
 */
export function shouldAbortAuthGeneration(owned: number, current: number): boolean {
  return owned !== current;
}
