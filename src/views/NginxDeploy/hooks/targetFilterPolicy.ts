import type { DeployTarget, DeployTargetQuery } from '@/api/deploy';

/**
 * 在前端按筛选条件过滤部署目标，语义与中央 `listTargets` 保持一致：
 * - projectKeyword：项目名、路径、描述不区分大小写包含匹配（对应 SQL LIKE）；
 * - branch / serverId / projectType：精确匹配，projectType 为 all 时不过滤。
 * @description 部署目标列表只需请求一次全量数据，筛选切换不再访问中央服务，多人使用时请求量与筛选操作次数无关。
 * @param targets 全量部署目标（保持服务端排序）
 * @param query 筛选条件
 * @returns 过滤后的部署目标，保持原始顺序与对象引用
 */
export function filterDeployTargets<T extends Pick<DeployTarget, 'projectName' | 'projectPath' | 'projectDescription' | 'defaultBranch' | 'serverId' | 'projectType'>>(
  targets: T[],
  query: DeployTargetQuery = {}
): T[] {
  const keyword = String(query.projectKeyword || '').trim().toLowerCase();
  const branch = String(query.branch || '').trim();
  const serverId = Number(query.serverId || 0);
  const projectType = String(query.projectType || '').trim();
  if (!keyword && !branch && !serverId && (!projectType || projectType === 'all')) return targets;
  return targets.filter((target) => {
    if (keyword) {
      const haystack = [target.projectName, target.projectPath, target.projectDescription].map((value) => String(value || '').toLowerCase());
      if (!haystack.some((value) => value.includes(keyword))) return false;
    }
    if (branch && target.defaultBranch !== branch) return false;
    if (serverId && Number(target.serverId || 0) !== serverId) return false;
    if (projectType && projectType !== 'all' && target.projectType !== projectType) return false;
    return true;
  });
}
