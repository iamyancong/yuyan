import type { DeployLogItem, DeployRecord } from '@/api/deploy';
import { formatDeployDateTime } from '../../constant';

/** 记录摘要项 */
export interface RecordSummaryItem {
  label: string;
  value: string;
  link?: string;
}

/**
 * 格式化空值展示。
 * @param value 原始值
 * @returns 展示文案
 */
export const formatEmptyText = (value?: string | number | null) => {
  const text = String(value ?? '').trim();
  return text || '-';
};

/**
 * 获取发布状态文案。
 * @param status 发布状态
 * @returns 状态文案
 */
export const getStatusLabel = (status?: DeployRecord['status']) => {
  const statusMap: Record<DeployRecord['status'], string> = {
    running: '执行中',
    success: '成功',
    failed: '失败',
    stopped: '已停止',
  };
  return status ? statusMap[status] : '-';
};

/**
 * 格式化单条发布日志
 * @param item 发布日志项
 * @returns 适合 Monaco 展示的日志文本
 */
export const formatLogItem = (item: DeployLogItem) => {
  const level = item.level.toUpperCase().padEnd(7, ' ');
  const stage = item.stage ? `[${item.stage}] ` : '';
  return `${formatDeployDateTime(item.timestamp)} ${level} ${stage}${item.message}`;
};
