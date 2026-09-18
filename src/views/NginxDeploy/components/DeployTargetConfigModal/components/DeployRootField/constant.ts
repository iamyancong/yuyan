/**
 * 部署根目录字段属性与类型定义
 */

export interface DeployRootFieldProps {
  modelValue?: string;
  projectType?: 'frontend' | 'backend';
  projectId?: number;
  projectName?: string;
  projectDescription?: string;
  defaultBranch?: string;
  serverId?: number;
  nginxInstanceId?: number;
  buildCommand?: string;
  artifactDir?: string;
  targetId?: number | null;
}
