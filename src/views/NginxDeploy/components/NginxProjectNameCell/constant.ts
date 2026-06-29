import type { DeployTarget } from '@/api/deploy';

/**
 * 获取项目备注展示文本。
 * @param record 部署目标
 * @returns 项目备注
 */
export const getProjectDescription = (record: DeployTarget): string => {
  return String(record.projectDescription || '').trim() || '-';
};
