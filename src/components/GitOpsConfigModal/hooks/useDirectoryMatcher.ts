/**
 * 目录名相似度匹配工具
 * 用于在 GitOps 配置中智能匹配手工创建的目录名
 */

/**
 * 计算两个字符串的 Levenshtein 编辑距离
 */
const levenshteinDistance = (str1: string, str2: string): number => {
  const len1 = str1.length;
  const len2 = str2.length;
  const dp: number[][] = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) dp[i][0] = i;
  for (let j = 0; j <= len2; j++) dp[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }

  return dp[len1][len2];
};

/**
 * 提取目录名的核心关键词
 * 移除通用前缀,保留业务相关部分
 */
const extractKeywords = (dirName: string): string[] => {
  const normalized = dirName
    .toLowerCase()
    .replace(/^yss-datamiddle-frontend-/, '')
    .replace(/^yss-datamiddle-/, '')
    .replace(/^datamiddle-/, '');

  return normalized.split('-').filter(Boolean);
};

/**
 * 计算两个字符串的相似度 (0-1)
 * 综合考虑编辑距离和关键词匹配
 */
export const calculateSimilarity = (str1: string, str2: string): number => {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;

  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  // 1. 基于编辑距离的相似度
  const distance = levenshteinDistance(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  const distanceSimilarity = 1 - distance / maxLen;

  // 2. 基于关键词的相似度
  const keywords1 = new Set(extractKeywords(str1));
  const keywords2 = new Set(extractKeywords(str2));
  const intersection = new Set([...keywords1].filter((k) => keywords2.has(k)));
  const union = new Set([...keywords1, ...keywords2]);
  const keywordSimilarity = union.size > 0 ? intersection.size / union.size : 0;

  // 3. 前缀权重
  const commonPrefixLen = Math.min(s1.length, s2.length);
  let prefixMatch = 0;
  for (let i = 0; i < commonPrefixLen; i++) {
    if (s1[i] === s2[i]) prefixMatch++;
    else break;
  }
  const prefixSimilarity = prefixMatch / maxLen;

  // 综合权重: 编辑距离 40%, 关键词 40%, 前缀 20%
  return distanceSimilarity * 0.4 + keywordSimilarity * 0.4 + prefixSimilarity * 0.2;
};

/**
 * 相似目录匹配结果
 */
export type SimilarDirectory = {
  dir: string;
  similarity: number;
};

/**
 * 在目录列表中查找与目标目录相似的目录
 * @param targetDir 目标目录名
 * @param dirList 可用目录列表
 * @param threshold 相似度阈值 (0-1)
 * @param maxResults 最多返回结果数
 * @returns 相似目录列表,按相似度降序排列
 */
export const findSimilarDirectories = (targetDir: string, dirList: string[], threshold = 0.7, maxResults = 3): SimilarDirectory[] => {
  if (!targetDir || !dirList || dirList.length === 0) return [];

  const results: SimilarDirectory[] = [];

  for (const dir of dirList) {
    const similarity = calculateSimilarity(targetDir, dir);
    if (similarity >= threshold) {
      results.push({ dir, similarity });
    }
  }

  // 按相似度降序排列
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, maxResults);
};

/**
 * 相似度匹配配置
 */
export const SIMILARITY_CONFIG = {
  /** 自动填充阈值 */
  AUTO_FILL_THRESHOLD: 0.7,
  /** 警告提示阈值 */
  WARNING_THRESHOLD: 0.6,
  /** 最多显示建议数 */
  MAX_SUGGESTIONS: 3,
} as const;
