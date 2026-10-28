import type { DeployProgressEvent, DeployTarget } from '@/api/deploy';
import { formatDeployDateTime, type PublishStage, type PublishStageStatus } from '../../constant';
import { cleanLogMessage } from '../RecordLogDrawer/constant';
import { presentDeployLogMessage, shouldHideLevelTag } from '../../logPresentation';

/** 组件属性接口 */
export interface PublishConfirmModalProps {
  /** 中央故障期间阻止新发布。 */
  centralUnavailable?: boolean;
  /** 执行结果尚未核实，不能显示成功或再次发布。 */
  resultUnconfirmed?: boolean;
  /** 是否可以按已有任务标识核实结果。 */
  canVerifyResult?: boolean;
  /** 是否正在核实。 */
  verifyingResult?: boolean;
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
  /** 操作人 / 发布人 */
  operator?: string;
  /** 发起时间 */
  startedAt?: string;
  /** 当前登录用户名 */
  currentUserName?: string;
  /** 当前用户权限角色 */
  userRole?: string;
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
 * @param showHints - 是否在行尾追加白话提示
 * @returns 日志文本（工具输出以 │ 缩进并隐藏 info 标签）
 */
export const getLogText = (item: DeployProgressEvent, projectName?: string, showHints = false): string => {
  const time = formatDeployDateTime(item.timestamp);
  if (item.type === 'stage') return `${time} [阶段] ${item.message}${item.detail ? ` - ${item.detail}` : ''}`;
  if (item.type === 'log') {
    const tag = shouldHideLevelTag(item) ? ''.padEnd(item.level.length + 2, ' ') : `[${item.level}]`;
    return `${time} ${tag} ${presentDeployLogMessage(item, cleanLogMessage(item.message), showHints)}`;
  }
  if (item.type === 'result') return `${time} [完成] ${projectName || '当前项目'} 发布成功`;
  return `${time} [错误] ${cleanLogMessage(item.message)}`;
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
