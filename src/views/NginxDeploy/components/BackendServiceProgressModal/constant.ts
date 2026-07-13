import type { DeployProgressEvent, DeployTarget } from '@/api/deploy';

/** 后端服务操作类型 */
export type BackendServiceAction = 'start' | 'stop' | 'restart';

/** 后端服务进度弹窗属性 */
export interface BackendServiceProgressModalProps {
  open: boolean;
  action: BackendServiceAction;
  target: DeployTarget | null;
  percent: number;
  title: string;
  detail: string;
  logs: DeployProgressEvent[];
  running: boolean;
}

/** 服务操作视觉配置 */
export const SERVICE_ACTION_META: Record<BackendServiceAction, { label: string; verb: string; hint: string }> = {
  start: { label: 'START SERVICE', verb: '启动', hint: '正在唤醒服务并等待运行状态确认' },
  stop: { label: 'STOP SERVICE', verb: '停止', hint: '正在安全终止服务进程并释放运行资源' },
  restart: { label: 'RESTART SERVICE', verb: '重启', hint: '正在重建服务进程并恢复运行状态' },
};

/** 操作阶段定义 */
export const SERVICE_PROGRESS_STAGES = [
  { key: 'prepare', label: '准备环境', threshold: 0 },
  { key: 'execute', label: '执行指令', threshold: 30 },
  { key: 'verify', label: '确认状态', threshold: 100 },
] as const;

/**
 * 格式化日志时间。
 * @param timestamp ISO 时间
 * @returns 时分秒文本
 */
export const formatServiceLogTime = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour12: false });
};

/**
 * 获取日志正文。
 * @param event 进度事件
 * @returns 日志正文
 */
export const getServiceLogMessage = (event: DeployProgressEvent) => {
  if (event.type === 'stage') return event.detail ? `${event.message} · ${event.detail}` : event.message;
  if (event.type === 'result') return '服务操作已完成';
  return event.message;
};

/**
 * 获取日志级别标签。
 * @param event 进度事件
 * @returns 日志级别
 */
export const getServiceLogLevel = (event: DeployProgressEvent) => {
  if (event.type === 'error') return 'ERROR';
  if (event.type === 'result') return 'DONE';
  if (event.type === 'stage') return 'STAGE';
  return event.level.toUpperCase();
};
