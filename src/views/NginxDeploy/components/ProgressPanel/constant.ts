import type { DeployProgressEvent } from '@/api/deploy';
import { formatDeployDateTime } from '../../constant';
import { cleanLogMessage } from '../RecordLogDrawer/constant';
import { presentDeployLogMessage, shouldHideLevelTag } from '../../logPresentation';

/**
 * 获取日志展示文本
 * @param item - 进度事件
 * @param showHints - 是否在行尾追加白话提示
 * @returns 日志文本（工具输出以 │ 缩进并隐藏 info 标签）
 */
export const getLogText = (item: DeployProgressEvent, showHints = false) => {
  const time = formatDeployDateTime(item.timestamp);
  if (item.type === 'stage') return `${time} [阶段] ${item.message}${item.detail ? ` - ${item.detail}` : ''}`;
  if (item.type === 'log') {
    const tag = shouldHideLevelTag(item) ? ''.padEnd(item.level.length + 2, ' ') : `[${item.level}]`;
    return `${time} ${tag} ${presentDeployLogMessage(item, cleanLogMessage(item.message), showHints)}`;
  }
  if (item.type === 'result') return `${time} [完成] 操作成功`;
  return `${time} [错误] ${cleanLogMessage(item.message)}`;
};
