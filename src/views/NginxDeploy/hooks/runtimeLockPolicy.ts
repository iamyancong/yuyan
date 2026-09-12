/**
 * 本地日期时间格式化器
 */
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * 格式化部署日期时间。
 * @param value ISO 日期时间字符串或时间戳
 * @returns 格式化后的日期时间文本
 */
export function formatDeployDateTime(value?: string | number | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return dateTimeFormatter.format(date).replace(/\//g, '-');
}

/** 运行时锁解析输入参数 */
export interface ResolveRuntimeLockInput {
  /** 当前登录用户名 */
  currentUserName?: string;
  /** 当前用户角色: 'viewer' | 'operator' | 'admin' | '' */
  userRole?: string;
  /** 任务操作人 */
  taskOperator?: string;
  /** 任务开始时间 */
  startedAt?: string;
  /** 是否运行中 */
  running?: boolean;
  /** 是否处于可停止阶段（如构建前/上传产物前） */
  stoppable?: boolean;
  /** 操作类型: 'deploy' | 'rollback' | 'undoRollback' | ... */
  action?: string;
  /** 当前阶段 */
  currentStage?: string;
}

/** 运行时锁与权限状态 */
export interface RuntimeLockState {
  /** 是否存在运行中任务持锁 */
  isLocked: boolean;
  /** 是否为当前用户发起的任务 */
  isSelfOperator: boolean;
  /** 当前用户是否为管理员 */
  isAdmin: boolean;
  /** 是否处于协同观察者模式（运行中且非本人） */
  isSubscriberMode: boolean;
  /** 是否允许停止当前任务 */
  canStop: boolean;
  /** 是否属于管理员跨人强制抢占停止 */
  canPreempt: boolean;
  /** 停止按钮文案 */
  stopButtonText: string;
  /** 停止按钮提示文案 */
  stopButtonTooltip: string;
  /** 协作锁说明文案 */
  lockDescription: string;
}

/**
 * 计算并格式化部署耗时。
 * @param startedAt 开始时间 ISO 字符串
 * @param finishedAt 完成时间 ISO 字符串
 * @returns 耗时文案，如 "25秒"、"1分30秒"、"进行中"、"-"
 */
export function formatDeployDuration(startedAt?: string | null, finishedAt?: string | null): string {
  if (!startedAt) return '-';
  if (!finishedAt) return '进行中';
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '-';
  const diffMs = end - start;
  if (diffMs < 1000) return '< 1秒';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}秒`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  return sec > 0 ? `${min}分${sec}秒` : `${min}分钟`;
}

/**
 * 判断当前用户是否具备停止任务权限。
 * @param taskOperator 任务发起人
 * @param currentOperator 当前操作人
 * @param role 当前角色
 * @returns 是否允许停止
 */
export function canStopDeployTask(
  taskOperator?: string | null,
  currentOperator?: string | null,
  role?: string | null
): boolean {
  const normalizedTaskOp = String(taskOperator || '').trim();
  const normalizedCurrentOp = String(currentOperator || '').trim();
  const normalizedRole = String(role || '').trim();

  // 若无具体发起人记录（历史任务或异常情况），默认允许操作人或管理员停止
  if (!normalizedTaskOp || normalizedTaskOp === '未知操作人') return true;

  // 管理员具有全局干预与强制停止权限
  if (normalizedRole === 'admin') return true;

  // 任务发起人本人可停止自己的任务
  if (normalizedCurrentOp && normalizedTaskOp === normalizedCurrentOp) return true;

  return false;
}

/**
 * 解析当前任务的协同运行锁与操作权限。
 * @param input 锁状态输入
 * @returns 锁状态与权限分析
 */
export function resolveRuntimeLockState(input: ResolveRuntimeLockInput): RuntimeLockState {
  const current = String(input.currentUserName || '').trim();
  const operator = String(input.taskOperator || '').trim();
  const role = String(input.userRole || '').trim();
  const running = Boolean(input.running);
  const stoppable = Boolean(input.stoppable);

  const isAdmin = role === 'admin';
  const isSelfOperator = Boolean(current && operator && current === operator);
  const isLocked = running;
  const isSubscriberMode = running && !isSelfOperator;

  // 仅在任务运行中且处于可停止阶段（未上传产物），且满足权限策略时可停止
  const hasPermission = canStopDeployTask(operator, current, role);
  const canStop = running && stoppable && hasPermission;
  const canPreempt = running && stoppable && isAdmin && !isSelfOperator;

  let stopButtonText = '停止';
  let stopButtonTooltip = '停止当前任务';

  if (!stoppable) {
    stopButtonText = '上传后不可停止';
    stopButtonTooltip = '产物已进入上传或重载阶段，不可中途停止';
  } else if (!hasPermission) {
    stopButtonText = '仅本人或管理员可停止';
    stopButtonTooltip = `当前任务由「${operator || '其他用户'}」发起，仅本人或管理员可停止`;
  } else if (canPreempt) {
    stopButtonText = '强制停止 (Admin)';
    stopButtonTooltip = `当前任务由「${operator}」发起，管理员可强制停止并接手`;
  }

  let lockDescription = '';
  if (running) {
    const formattedTime = input.startedAt ? formatDeployDateTime(input.startedAt) : '近期';
    if (isSelfOperator) {
      lockDescription = `您于 ${formattedTime} 发起了本次任务，正在执行中`;
    } else {
      lockDescription = `任务正由「${operator || '其他成员'}」于 ${formattedTime} 发起，您当前处于协同观察模式`;
    }
  }

  return {
    isLocked,
    isSelfOperator,
    isAdmin,
    isSubscriberMode,
    canStop,
    canPreempt,
    stopButtonText,
    stopButtonTooltip,
    lockDescription,
  };
}
