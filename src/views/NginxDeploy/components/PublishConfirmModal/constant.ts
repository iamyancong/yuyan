import type { DeployProgressEvent, DeployTarget } from '@/api/deploy';
import { formatDeployDateTime, type PublishStage, type PublishStageStatus } from '../../constant';

/** 组件属性接口 */
export interface PublishConfirmModalProps {
  /** 是否打开 */
  open: boolean;
  /** 部署目标 */
  target: DeployTarget | null;
  /** 进度百分比 */
  percent: number;
  /** 标题 */
  title: string;
  /** 详情说明 */
  detail: string;
  /** 日志列表 */
  logs: DeployProgressEvent[];
  /** 是否正在运行 */
  running: boolean;
  /** 是否已开始 */
  started: boolean;
  /** 是否已停止 */
  stopped: boolean;
  /** 是否可停止 */
  stoppable: boolean;
  /** 是否正在停止 */
  stopping: boolean;
}

/** 发布启动选项 */
export interface PublishStartOptions {
  /** 是否强制重新安装依赖 */
  forceInstallDependencies: boolean;
}

/**
 * 获取日志展示文本
 * @param item - 进度事件
 * @param projectName - 项目名称
 * @returns 日志文本
 */
export const getLogText = (item: DeployProgressEvent, projectName?: string): string => {
  const time = formatDeployDateTime(item.timestamp);
  if (item.type === 'stage') return `${time} [阶段] ${item.message}${item.detail ? ` - ${item.detail}` : ''}`;
  if (item.type === 'log') return `${time} [${item.level}] ${item.message}`;
  if (item.type === 'result') return `${time} [完成] ${projectName || '当前项目'} 发布成功`;
  return `${time} [错误] ${item.message}`;
};

/**
 * 计算发布节点状态
 */
export const calcStageStatus = (params: {
  stage: PublishStage;
  stopped: boolean;
  hasError: boolean;
  started: boolean;
  running: boolean;
  percent: number;
  currentStageKey: string;
}): PublishStageStatus => {
  const { stage, stopped, hasError, started, running, percent, currentStageKey } = params;
  if (stopped && stage.key === currentStageKey) return 'stopped';
  if (hasError && stage.key === currentStageKey) return 'error';
  if (!started) return 'wait';
  if (stage.key === currentStageKey && running) return 'process';
  return percent >= stage.percent ? 'finish' : 'wait';
};
