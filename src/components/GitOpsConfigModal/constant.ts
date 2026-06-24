/**
 * GitOps 配置模态框常量和类型定义
 */

/** 文件项类型 */
export type FileItem = {
  /** 模板路径 */
  originalPath: string;
  /** 目标路径 */
  targetPath: string;
  /** 模板原始内容 */
  templateContent: string;
  /** 替换变量后的可编辑内容 */
  editedContent: string;
  /** 目标仓库当前内容（更新模式使用） */
  existingContent?: string;
};

/** 操作模式 */
export type OperationMode = 'create' | 'update';

/** 自动完成选项类型 */
export type AutoCompleteOption = {
  value?: string;
  label?: string;
};

/** 文件类型标签 */
export type FileTypeTag = {
  text: string;
  color: string;
};

/** 关键 YAML 文件名 */
export const YAML_FILE_NAME = 'k8s-deployments-service.yml';

/**
 * 目录选项过滤函数（模糊匹配）
 */
export const filterDirOption = (input: string, option?: AutoCompleteOption): boolean => {
  const keyword = (input || '').trim().toLowerCase();
  if (!keyword) return true;
  const text = String(option?.label ?? option?.value ?? '').toLowerCase();
  // 简单子序列模糊匹配（兼容连字符等分隔符），含子串时也为 true
  let index = 0;
  for (const ch of keyword) {
    index = text.indexOf(ch, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
};

/**
 * 生成分支名称
 */
export const generateBranchName = (appSlug: string): string => {
  const slug = appSlug || 'app';
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `feature/gitops-${slug}-${ts}`;
};
