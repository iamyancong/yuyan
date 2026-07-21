import type { AgentOperationStatus } from '@/api/agent';

/** AI 控制中心可折叠区域。 */
export type AiSectionKey = 'identity' | 'clients' | 'operations' | 'grants' | 'audit';

/** AI 控制中心默认展开区域。 */
export const DEFAULT_EXPANDED_AI_SECTIONS: AiSectionKey[] = ['identity', 'clients'];

/** 操作状态显示配置。 */
export const AGENT_STATUS_META: Record<AgentOperationStatus, { label: string; color: string }> = {
  pending_approval: { label: '待审批', color: 'orange' },
  queued: { label: '排队中', color: 'blue' },
  running: { label: '执行中', color: 'processing' },
  succeeded: { label: '成功', color: 'success' },
  failed: { label: '失败', color: 'error' },
  rejected: { label: '已拒绝', color: 'default' },
  cancelled: { label: '已取消', color: 'default' },
  expired: { label: '已过期', color: 'default' },
};

/** 风险等级中文显示。 */
export const AGENT_RISK_LABELS = {
  read: '只读',
  config_write: '配置写入',
  external_effect: '外部操作',
  destructive: '高危操作',
} as const;

/** 可在当前账号所有设备上强制人工审批的普通写工具。 */
export const ACCOUNT_APPROVAL_TOOL_OPTIONS = [
  { label: '应用项目配置', value: 'yuyan_apply_project_config' },
  { label: '创建微应用', value: 'yuyan_create_microapp' },
  { label: '发布项目', value: 'yuyan_deploy_target' },
  { label: '回滚发布', value: 'yuyan_rollback_deployment' },
  { label: '启停/重启服务', value: 'yuyan_control_service' },
  { label: '生成 OpenAPI', value: 'yuyan_generate_openapi' },
] as const;
