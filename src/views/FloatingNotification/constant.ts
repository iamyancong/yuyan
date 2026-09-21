/** 浮窗展示模式：长任务进度条模式或终态结果模式 */
export type DesktopFloatingTaskMode = 'progress' | 'result';

/** 浮窗任务与通知状态 */
export type DesktopFloatingTaskStatus = 'success' | 'error' | 'warning' | 'info' | 'downloading';

/** 浮窗操作按钮定义 */
export interface DesktopFloatingTaskAction {
  /** 按钮唯一标识，如 cancel / reveal / retry */
  id: string;
  /** 按钮文案 */
  text: string;
  /** 是否为主按钮高亮样式 */
  primary?: boolean;
  /** 是否为危险/警告样式 */
  danger?: boolean;
}

/**
 * 通用桌面全局任务与通知入参数据模型定义。
 * 兼容原有部署流水线通知字段与通用长任务字段。
 */
export interface FloatingNotificationData {
  /** 任务唯一标识 */
  taskId?: string;
  /** 展示模式：进度条模式或终态结果模式（未传时根据 status 自动推导） */
  mode?: DesktopFloatingTaskMode;
  /** 状态：成功、失败、警告、信息或进行中 */
  status: DesktopFloatingTaskStatus;
  /** 主标题，如「正在导出静态资源」「部署成功」 */
  title: string;
  /** 副标题或项目名称 */
  projectName?: string;
  /** 部署目标名称或副信息 */
  targetName?: string;
  /** 部署环境或次要状态胶囊标签 */
  envName?: string;
  /** 阶段说明，如「已写入 21.47 MB」或「依赖安装」 */
  stage?: string;
  /** 失败错误原因 */
  errorMessage?: string;
  /** 耗时格式化文本，如「38s」 */
  duration?: string;
  /** 进度百分比（0-100），null 为不确定进度 */
  progressPercentage?: number | null;
  /** 已传输/已写入字节数 */
  loadedBytes?: number;
  /** 总字节数，null 为未知大小 */
  totalBytes?: number | null;
  /** 操作按钮列表 */
  actions?: DesktopFloatingTaskAction[];
  /** 详情描述或自定义摘要（非部署场景使用） */
  description?: string;
  /** 是否自动倒计时关闭。长任务进度模式或带关键产物操作的长任务默认设为 false（常驻，由用户主动关闭）。 */
  autoDismiss?: boolean;
  /** 自动关闭倒计时毫秒数，未指定时使用 AUTO_DISMISS_DURATION_MS */
  durationMs?: number;
  /** 站点访问链接（仅成功且有配置时存在） */
  visitUrl?: string;
  /** 触发时间戳 */
  timestamp?: number;
}

/** 浮窗默认停留时长（毫秒） */
export const AUTO_DISMISS_DURATION_MS = 5200;

/** 默认兜底展示数据 */
export const DEFAULT_NOTIFICATION_DATA: FloatingNotificationData = {
  mode: 'result',
  status: 'success',
  title: '部署成功',
  projectName: '雨燕微前端应用',
  targetName: '生产主机集群',
  envName: '生产环境',
  duration: '38s',
  timestamp: Date.now(),
};

