import type { GitLabBranch } from '@/api/gitlab';

/** GitLab 分支接口单页上限 */
export const BRANCH_PAGE_SIZE = 100;

/** 分支列表前端缓存时长（毫秒） */
export const BRANCH_CACHE_TTL_MS = 60_000;

/** 分支远程搜索防抖时长（毫秒） */
export const BRANCH_SEARCH_DEBOUNCE_MS = 300;

/**
 * 判断首页分支列表是否可能被截断。
 * @param list 首页分支列表
 * @returns 是否达到单页上限
 */
export function isBranchListTruncated(list: GitLabBranch[]): boolean {
  return list.length >= BRANCH_PAGE_SIZE;
}

/**
 * 合并多组分支并按名称去重，默认分支置顶，其余保持首次出现顺序。
 * @param groups 分支分组
 * @returns 合并后的分支列表
 */
export function mergeBranches(...groups: GitLabBranch[][]): GitLabBranch[] {
  const merged = new Map<string, GitLabBranch>();
  groups.flat().forEach((branch) => {
    const name = String(branch?.name || '').trim();
    if (!name) return;
    const existing = merged.get(name);
    merged.set(name, existing ? { ...existing, default: Boolean(existing.default || branch.default) } : branch);
  });
  const list = Array.from(merged.values());
  return [...list.filter((branch) => branch.default), ...list.filter((branch) => !branch.default)];
}

/**
 * 找出需要精确补齐的分支名称（已加载列表中不存在的）。
 * @param list 已加载分支
 * @param names 必须可选的分支名称（当前已选、项目默认分支等）
 * @returns 缺失的分支名称
 */
export function collectMissingBranchNames(list: GitLabBranch[], names: Array<string | null | undefined>): string[] {
  const loaded = new Set(list.map((branch) => branch.name));
  return Array.from(new Set(names.map((name) => String(name || '').trim()).filter(Boolean))).filter((name) => !loaded.has(name));
}
