import type { DeployEnvironment } from '@/api/deploy';

/** 环境状态展示元数据。 */
export interface EnvironmentStatusMeta {
  label: string;
  tone: 'success' | 'danger' | 'warning' | 'neutral';
}

/** 环境状态展示映射。 */
const ENVIRONMENT_STATUS_META: Record<DeployEnvironment['status'], EnvironmentStatusMeta> = {
  online: { label: '连接正常', tone: 'success' },
  offline: { label: '连接失败', tone: 'danger' },
  error: { label: '检测异常', tone: 'warning' },
  unknown: { label: '尚未检测', tone: 'neutral' },
};

/** 获取环境状态展示信息。 */
export const getEnvironmentStatusMeta = (status: DeployEnvironment['status']): EnvironmentStatusMeta =>
  ENVIRONMENT_STATUS_META[status] ?? ENVIRONMENT_STATUS_META.unknown;

/** 格式化环境最近检测时间。 */
export const formatEnvironmentCheckedAt = (value: string): string => {
  if (!value) return '等待首次检测';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `最近检测 ${date.toLocaleString('zh-CN', { hour12: false })}`;
};
