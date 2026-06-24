import type { DeployProgressEvent } from '@/api/deploy';
import { formatDeployDateTime } from '../../constant';

/**
 * 获取日志展示文本
 * @param item - 进度事件
 * @returns 日志文本
 */
export const getLogText = (item: DeployProgressEvent) => {
  const time = formatDeployDateTime(item.timestamp);
  if (item.type === 'stage') return `${time} [阶段] ${item.message}${item.detail ? ` - ${item.detail}` : ''}`;
  if (item.type === 'log') return `${time} [${item.level}] ${item.message}`;
  if (item.type === 'result') return `${time} [完成] 操作成功`;
  return `${time} [错误] ${item.message}`;
};
