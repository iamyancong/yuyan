/**
 * Nginx 配置文件管理常量、类型与纯函数
 */

/** 接口：Nginx 配置文件读取结果 */
export interface NginxConfigResult {
  /** 文件路径 */
  path: string;
  /** 文件内容 */
  content: string;
}

/** 接口：变更摘要统计 */
export interface DiffSummary {
  /** 变更处数 */
  changeCount: number;
  /** 新增行数 */
  addedLines: number;
  /** 删除行数 */
  removedLines: number;
}

/** 底部操作提示常量 */
export const NGINX_ACTION_TIPS = {
  CLEAN: '当前配置未修改',
  NO_SEMANTIC_CHANGE: '当前配置无实质变更（仅空白或格式）',
  DIRTY_EDIT: '配置已修改，保存并重载时将自动执行远程 Nginx 语法校验',
  DIFF_ACTIVE: '对比中（右侧可直接编辑或还原块）',
} as const;

/** Diff 编辑器默认配置选项（支持右侧编辑与还原块图标） */
export const DIFF_MONACO_OPTIONS = {
  minimap: { enabled: true },
  readOnly: false,
  originalEditable: false,
  renderSideBySide: true,
  renderIndicators: true,
  renderMarginRevertIcon: true,
  renderGutterMenu: false,
  glyphMargin: true,
  diffAlgorithm: 'advanced',
  fontSize: 13,
} as const;

/** 单栏编辑态默认配置选项 */
export const DEFAULT_MONACO_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
} as const;

/**
 * 提取操作错误文案。
 * @param error 错误对象
 * @returns 错误文案
 */
export const getErrorMessage = (error: any): string => {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || '操作失败';
};

/**
 * 规范化 Nginx 配置文本。
 * 统一跨平台换行符，剔除每行末尾无意义空白，用于语义级实质变更对比。
 * @param text 原始文本
 * @returns 规范化文本
 */
export const normalizeNginxContent = (text: string): string => {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
};

/**
 * 解析 Monaco DiffEditor 的 lineChanges 数组生成精确变更统计。
 * @param lineChanges Monaco 原生行变更数组
 * @returns 差异统计
 */
export const calcMonacoLineChangesSummary = (lineChanges: any[] | null | undefined): DiffSummary => {
  if (!lineChanges || lineChanges.length === 0) {
    return { changeCount: 0, addedLines: 0, removedLines: 0 };
  }

  let addedLines = 0;
  let removedLines = 0;

  for (const change of lineChanges) {
    const modStart = change.modifiedStartLineNumber ?? 0;
    const modEnd = change.modifiedEndLineNumber ?? 0;
    const origStart = change.originalStartLineNumber ?? 0;
    const origEnd = change.originalEndLineNumber ?? 0;

    if (modEnd > 0 && modEnd >= modStart) {
      addedLines += modEnd - modStart + 1;
    }
    if (origEnd > 0 && origEnd >= origStart) {
      removedLines += origEnd - origStart + 1;
    }
  }

  return {
    changeCount: lineChanges.length,
    addedLines,
    removedLines,
  };
};

/**
 * 按行计算原始文本与当前缓冲的多块变更概要（基于 LCS 动态规划）。
 * 能精确识别多个非连续的独立修改处（hunks），并统计各自的新增/删除行数。
 * @param original 基线文本
 * @param current 当前编辑文本
 * @returns 差异统计
 */
export const calcSimpleTextDiffSummary = (original: string, current: string): DiffSummary => {
  if (original === current) {
    return { changeCount: 0, addedLines: 0, removedLines: 0 };
  }

  // 语义上若无差异，则视为 0 处变更
  if (normalizeNginxContent(original) === normalizeNginxContent(current)) {
    return { changeCount: 0, addedLines: 0, removedLines: 0 };
  }

  const origLines = original.replace(/\r\n/g, '\n').split('\n');
  const currLines = current.replace(/\r\n/g, '\n').split('\n');

  // 首尾双指针快速去除相同公共行，缩小矩阵规模
  let prefix = 0;
  while (prefix < origLines.length && prefix < currLines.length && origLines[prefix] === currLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < origLines.length - prefix &&
    suffix < currLines.length - prefix &&
    origLines[origLines.length - 1 - suffix] === currLines[currLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const subOrig = origLines.slice(prefix, origLines.length - suffix);
  const subCurr = currLines.slice(prefix, currLines.length - suffix);

  if (subOrig.length === 0 && subCurr.length === 0) {
    return { changeCount: 0, addedLines: 0, removedLines: 0 };
  }
  if (subOrig.length === 0) {
    return { changeCount: 1, addedLines: subCurr.length, removedLines: 0 };
  }
  if (subCurr.length === 0) {
    return { changeCount: 1, addedLines: 0, removedLines: subOrig.length };
  }

  // 保护性阈值：如果中间裁剪区域过大（超过 1500*1500），做兜底
  const m = subOrig.length;
  const n = subCurr.length;
  if (m * n > 400000) {
    return {
      changeCount: 1,
      addedLines: subCurr.length,
      removedLines: subOrig.length,
    };
  }

  // 动态规划计算 LCS
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (subOrig[i] === subCurr[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // 回溯构建 diff 操作流
  let i = m;
  let j = n;
  type Op = 'same' | 'add' | 'del';
  const ops: Op[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && subOrig[i - 1] === subCurr[j - 1]) {
      ops.push('same');
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push('add');
      j--;
    } else {
      ops.push('del');
      i--;
    }
  }

  ops.reverse();

  // 连续的 add/del 归为一个独立的变更块（change hunk）
  let changeCount = 0;
  let inChangeBlock = false;
  let addedLines = 0;
  let removedLines = 0;

  for (const op of ops) {
    if (op === 'same') {
      inChangeBlock = false;
    } else {
      if (!inChangeBlock) {
        changeCount++;
        inChangeBlock = true;
      }
      if (op === 'add') addedLines++;
      if (op === 'del') removedLines++;
    }
  }

  return {
    changeCount,
    addedLines,
    removedLines,
  };
};

/**
 * 格式化变更摘要展示文本。
 * @param summary 差异统计
 * @returns 摘要展示文案
 */
export const formatDiffSummary = (summary: DiffSummary): string => {
  if (summary.changeCount === 0) return '';
  return `已改 ${summary.changeCount} 处 · +${summary.addedLines} −${summary.removedLines}`;
};
