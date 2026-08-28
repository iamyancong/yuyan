import type { DeployRecord, DeployTarget } from '@/api/deploy';

/**
 * 获取项目备注展示文本。
 * @param record 部署目标或发布记录
 * @returns 项目备注
 */
export const getProjectDescription = (record: DeployTarget | DeployRecord): string => {
  const targetDesc = 'projectDescription' in record ? record.projectDescription : '';
  const desc = String(targetDesc || '').trim() || String(record.projectPath || record.repositoryUrl || '').trim();
  return desc || '-';
};
