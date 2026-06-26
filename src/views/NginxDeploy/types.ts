import type { DeployProgressSnapshot, DeployProjectSource, DeployTarget } from '@/api/deploy';

/** 当前项目上下文 */
export interface DeployProjectContext {
  projectId: number;
  projectName: string;
  projectDescription: string;
  projectPath: string;
  repositoryUrl: string;
  defaultBranch: string;
}

/** 部署目标项目表单快照 */
export interface DeployTargetProjectDraft {
  projectSource: DeployProjectSource;
  projectId: number;
  projectName: string;
  projectDescription: string;
  projectPath: string;
  repositoryUrl: string;
  defaultBranch: string;
}

/** 部署目标筛选表单 */
export interface TargetFilterForm {
  projectKeyword: string;
  branch?: string;
  serverId?: number;
}

/** 部署中心 Tab Key */
export type NginxDeployTabKey = 'targets' | 'servers' | 'records';

/** Formily 实例最小接口 */
export interface FormilyRef {
  getValues: () => Record<string, any>;
  setValues?: (values: Record<string, any>) => void;
  setFieldState?: (path: string, callback: (state: any) => void) => void;
}

/** 发布历史项目筛选项 */
export interface RecordProjectOption {
  label: unknown;
  title: string;
  description: string;
  searchKey: string;
  value: string;
  targetId?: number;
  serverId?: number;
  serverName?: string;
  serverHost?: string;
  projectId: number;
  projectName: string;
  projectPath: string;
}

/** 发布历史服务器筛选项 */
export interface RecordServerOption {
  label: unknown;
  title?: string;
  searchKey?: string;
  value: number;
}

/** 当前激活 Tab 刷新选项 */
export interface RefreshActiveTabOptions {
  resetRecordsPage?: boolean;
}

/** 发布进度模式 */
export type DeployProgressMode = 'deploy' | 'rollback' | 'undoRollback';

/** 部署目标筛选项来源 */
export type DeployTargetProjectInfo = Pick<DeployTarget, 'projectId' | 'projectPath'> | DeployProjectContext;

/** 携带运行态快照的部署目标行 */
export interface RuntimeAwareDeployTarget extends DeployTarget {
  runtimeSnapshot?: DeployProgressSnapshot;
}
