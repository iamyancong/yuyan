import type { DeployRecord, DeployRecordAction } from '@/api/deploy';

export type { DeployRecord, DeployRecordAction };

/** 回滚确认弹窗属性 */
export interface RollbackConfirmModalProps {
  /** 弹窗显隐 */
  open: boolean;
  /** 当前待操作的发布记录（线上当前版本） */
  record: DeployRecord | null;
  /** 所有发布历史记录（用于匹配 backupRecordId 对应版本详情） */
  records?: DeployRecord[];
  /** 操作类型：rollback (回滚) 或 undoRollback (撤销回滚) */
  action?: DeployRecordAction;
  /** 执行中状态 */
  loading?: boolean;
}

/** 执行说明条目 */
export interface ExecutionNoticeItem {
  icon: string;
  title: string;
  desc: string;
}

/** 回滚执行说明列表 */
export const ROLLBACK_EXECUTION_NOTICES: ExecutionNoticeItem[] = [
  {
    icon: '⚡',
    title: '秒级恢复',
    desc: '直接还原服务器本地备份快照，不重新拉取代码与安装构建。',
  },
  {
    icon: '🛡️',
    title: '安全可逆',
    desc: '当前线上目录将自动打入新快照，回滚后随时可再次「撤销回滚」。',
  },
  {
    icon: '📋',
    title: '日志留存',
    desc: '原发布记录与失败日志完整保留，不影响后续排查定位。',
  },
  {
    icon: '🔄',
    title: '平滑重载',
    desc: '自动校验 Nginx 配置语法并通过 reload 平滑生效。',
  },
];

/** 撤销回滚执行说明列表 */
export const UNDO_ROLLBACK_EXECUTION_NOTICES: ExecutionNoticeItem[] = [
  {
    icon: '⚡',
    title: '秒级复原',
    desc: '恢复至本次回滚执行前的现场备份，不重新执行构建流水线。',
  },
  {
    icon: '🛡️',
    title: '恢复状态',
    desc: '重新生效被回滚前的版本，回到回滚发生前的生产状态。',
  },
  {
    icon: '📋',
    title: '操作审计',
    desc: '撤销回滚将单独记入发布历史，完整留存操作人与执行轨迹。',
  },
];

/**
 * 格式化提交时间。
 * @param timeString ISO 时间字符串
 * @returns 格式化日期时间
 */
export function formatCommitDateTime(timeString?: string) {
  if (!timeString) return '-';
  const date = new Date(timeString);
  if (Number.isNaN(date.getTime())) return timeString;
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 格式化版本提交信息摘要。
 * @param record 发布记录
 * @returns 摘要信息
 */
export function getRecordCommitSummary(record?: DeployRecord | null) {
  if (!record) return { sha: '-', message: '-', author: '-', time: '-' };
  const sha = record.commitSha ? record.commitSha.slice(0, 8) : '-';
  const message = record.commitMessage || '未包含提交说明';
  const author = record.commitAuthor || record.operator || '未知作者';
  const time = record.finishedAt ? formatCommitDateTime(record.finishedAt) : record.startedAt ? formatCommitDateTime(record.startedAt) : '-';
  return { sha, message, author, time };
}

