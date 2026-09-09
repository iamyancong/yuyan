/**
 * 项目下拉搜索策略模块
 * @description 规范化搜索关键字，处理中文输入法分词空格与短词容错，并在本地与远程项目集间执行智能融合检索。
 */

import type { GitLabProject } from '@/api/gitlab';

/** 规范化后的关键词检索上下文 */
export interface NormalizedSearchContext {
  /** 原始去除首尾空格的关键字 */
  rawKeyword: string;
  /** 去除所有内部空格的紧凑关键字 */
  compactKeyword: string;
  /** 用于匹配的变体列表（大写/小写等均包含） */
  variants: string[];
}

/**
 * 规范化搜索关键词。
 * 针对中文输入法未成词按回车产生的音节分词空格（如 "p y" 或 "p y j o b"）生成紧凑变体。
 * @param keyword 输入关键词
 * @returns 规范化上下文
 */
export function normalizeSearchKeyword(keyword: string): NormalizedSearchContext {
  const rawKeyword = String(keyword || '').trim();
  if (!rawKeyword) {
    return { rawKeyword: '', compactKeyword: '', variants: [] };
  }

  const lowerRaw = rawKeyword.toLowerCase();
  // 去除所有连续空格
  const compactKeyword = lowerRaw.replace(/\s+/g, '');

  const variantSet = new Set<string>();
  variantSet.add(lowerRaw);
  if (compactKeyword && compactKeyword !== lowerRaw) {
    variantSet.add(compactKeyword);
  }

  return {
    rawKeyword,
    compactKeyword,
    variants: Array.from(variantSet),
  };
}

/**
 * 判断指定 GitLab 项目是否与搜索关键词或其变体匹配。
 * 支持不区分大小写，对项目名称、描述、命名空间路径均进行模糊匹配。
 * @param project GitLab 项目对象
 * @param searchContext 规范化搜索上下文或原始关键词
 * @returns 是否匹配
 */
export function matchProjectCandidate(
  project: GitLabProject | null | undefined,
  searchContext: NormalizedSearchContext | string
): boolean {
  if (!project) return false;

  const context = typeof searchContext === 'string'
    ? normalizeSearchKeyword(searchContext)
    : searchContext;

  if (!context.variants.length) return true;

  const name = String(project.name || '').toLowerCase();
  const description = String(project.description || '').toLowerCase();
  const path = String(project.path || '').toLowerCase();
  const pathWithNamespace = String(project.path_with_namespace || '').toLowerCase();

  // 项目各维度的纯净紧凑文本（去空格）
  const compactName = name.replace(/\s+/g, '');
  const compactDescription = description.replace(/\s+/g, '');

  return context.variants.some((variant) => {
    if (!variant) return false;
    // 1. 标准子串命中
    if (name.includes(variant) || description.includes(variant) || pathWithNamespace.includes(variant) || path.includes(variant)) {
      return true;
    }
    // 2. 紧凑文本匹配（容错拼音分词空格）
    if (compactName.includes(variant) || compactDescription.includes(variant)) {
      return true;
    }
    return false;
  });
}

/**
 * 合并并去重项目列表。
 * 保持远程项目与本地高优先级匹配项的唯一性（按 project.id 去重）。
 * @param remoteProjects 远程 API 返回的项目
 * @param localMatches 本地缓存中模糊匹配出的项目
 * @returns 合并去重后的项目列表
 */
export function mergeAndDeduplicateProjects(
  remoteProjects: GitLabProject[] = [],
  localMatches: GitLabProject[] = []
): GitLabProject[] {
  const seenIds = new Set<number>();
  const result: GitLabProject[] = [];

  // 1. 先加入本地强匹配项（确保即时可见性，特别是在远程短词返回空或延迟时）
  for (const item of localMatches) {
    if (item && item.id && !seenIds.has(item.id)) {
      seenIds.add(item.id);
      result.push(item);
    }
  }

  // 2. 追加远程补充项
  for (const item of remoteProjects) {
    if (item && item.id && !seenIds.has(item.id)) {
      seenIds.add(item.id);
      result.push(item);
    }
  }

  return result;
}
