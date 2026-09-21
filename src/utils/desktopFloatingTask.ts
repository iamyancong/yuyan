import { isTauri } from './env.ts';
import type {
  DesktopFloatingTaskAction,
  DesktopFloatingTaskMode,
  DesktopFloatingTaskStatus,
  FloatingNotificationData,
} from '@/views/FloatingNotification/constant.ts';

/** 启动桌面悬浮任务通知的配置选项 */
export interface DesktopFloatingTaskOptions {
  /** 任务唯一标识 */
  taskId?: string;
  /** 展示模式：默认根据 status 判断，长任务为 progress */
  mode?: DesktopFloatingTaskMode;
  /** 任务状态：默认 downloading 或 success */
  status?: DesktopFloatingTaskStatus;
  /** 主标题，如「正在导出站点静态资源」 */
  title: string;
  /** 副标题或项目名称 */
  projectName?: string;
  /** 部署目标名称或目标环境 */
  targetName?: string;
  /** 环境名称标签 */
  envName?: string;
  /** 阶段与传输状态描述，如「已写入 21.47 MB」 */
  stage?: string;
  /** 详细描述或自定义文案 */
  description?: string;
  /** 是否自动倒计时关闭。长任务进度模式或带操作按钮默认 false（常驻） */
  autoDismiss?: boolean;
  /** 自动关闭倒计时毫秒数 */
  durationMs?: number;
  /** 失败错误原因 */
  errorMessage?: string;
  /** 耗时文本 */
  duration?: string;
  /** 进度百分比 (0-100)，null 为未知进度 */
  progressPercentage?: number | null;
  /** 已加载/已写入字节数 */
  loadedBytes?: number;
  /** 总字节数 */
  totalBytes?: number | null;
  /** 操作按钮配置 */
  actions?: DesktopFloatingTaskAction[];
  /** 站点访问地址 */
  visitUrl?: string;
  /** 悬浮窗用户点击操作按钮的回调 */
  onAction?: (actionId: string, taskId?: string) => void | Promise<void>;
}

/** 进度更新参数 */
export interface DesktopFloatingProgressUpdate {
  /** 进度百分比 (0-100) */
  progressPercentage?: number | null;
  /** 已加载字节数 */
  loadedBytes?: number;
  /** 总字节数 */
  totalBytes?: number | null;
  /** 阶段描述 */
  stage?: string;
}

/** 格式化字节数大小为人类友好文本 */
export const formatTaskBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/** 内部活跃任务状态跟踪 */
interface ActiveTaskSession {
  taskId: string;
  onAction?: (actionId: string, taskId?: string) => void | Promise<void>;
  unlistenAction?: () => void;
  lastProgressEmitTime: number;
  pendingProgressTimer?: number | null;
}

let activeSession: ActiveTaskSession | null = null;

/** 清除当前任务事件监听与会话缓存 */
const cleanupActiveSession = () => {
  if (!activeSession) return;
  if (activeSession.unlistenAction) {
    activeSession.unlistenAction();
  }
  if (activeSession.pendingProgressTimer) {
    clearTimeout(activeSession.pendingProgressTimer);
  }
  activeSession = null;
};

/**
 * 全局桌面悬浮任务与通知管理器 (Desktop Floating Task Service)。
 * 统一调度 Tauri 独立桌面透明悬浮窗，在非桌面环境下优雅降级。
 */
export const desktopFloatingTask = {
  /**
   * 启动长任务进度展示（电脑全局右上角透明悬浮窗）。
   * @param options 启动配置项
   */
  async startProgress(options: DesktopFloatingTaskOptions): Promise<void> {
    cleanupActiveSession();
    const taskId = options.taskId || `task-${Date.now()}`;

    const payload: FloatingNotificationData = {
      taskId,
      mode: 'progress',
      status: options.status || 'downloading',
      title: options.title,
      projectName: options.projectName,
      targetName: options.targetName,
      envName: options.envName || '处理中',
      stage: options.stage,
      description: options.description,
      progressPercentage: options.progressPercentage ?? null,
      loadedBytes: options.loadedBytes ?? 0,
      totalBytes: options.totalBytes ?? null,
      autoDismiss: false,
      actions: options.actions || [
        { id: 'cancel', text: '取消', danger: true },
      ],
      timestamp: Date.now(),
    };

    activeSession = {
      taskId,
      onAction: options.onAction,
      lastProgressEmitTime: 0,
    };

    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');

        // 监听来自浮窗的按钮点击事件
        const unlisten = await listen<{ actionId: string; taskId?: string }>(
          'desktop-task-action',
          (event) => {
            if (activeSession && event.payload) {
              const { actionId, taskId: eventTaskId } = event.payload;
              if (!eventTaskId || eventTaskId === activeSession.taskId) {
                void activeSession.onAction?.(actionId, eventTaskId);
              }
            }
          }
        );

        if (activeSession) {
          activeSession.unlistenAction = unlisten;
        }

        await invoke('show_floating_notification', { payload });
      } catch (error) {
        console.warn('[DesktopFloatingTask] show_floating_notification 唤起异常:', error);
      }
    }
  },

  /**
   * 更新正在进行的任务进度（带 60ms 节流保证性能）。
   * @param progress 进度参数
   */
  async updateProgress(progress: DesktopFloatingProgressUpdate): Promise<void> {
    if (!isTauri() || !activeSession) return;

    const now = Date.now();
    const THROTTLE_MS = 60;

    const doEmit = async () => {
      try {
        const { emitTo } = await import('@tauri-apps/api/event');
        await emitTo('floating-notification', 'desktop-task-progress', progress);
      } catch (e) {
        // 忽略异常
      }
    };

    if (now - activeSession.lastProgressEmitTime >= THROTTLE_MS) {
      activeSession.lastProgressEmitTime = now;
      if (activeSession.pendingProgressTimer) {
        clearTimeout(activeSession.pendingProgressTimer);
        activeSession.pendingProgressTimer = null;
      }
      void doEmit();
    } else if (!activeSession.pendingProgressTimer) {
      activeSession.pendingProgressTimer = window.setTimeout(() => {
        if (activeSession) {
          activeSession.lastProgressEmitTime = Date.now();
          activeSession.pendingProgressTimer = null;
          void doEmit();
        }
      }, THROTTLE_MS);
    }
  },

  /**
   * 将当前任务转入终态（成功或失败）。若带操作按钮则默认常驻，等待用户主动触发或关闭。
   * @param options 终态配置项
   */
  async finish(options: DesktopFloatingTaskOptions): Promise<void> {
    cleanupActiveSession();
    const taskId = options.taskId || `task-${Date.now()}`;
    const autoDismiss = options.autoDismiss ?? (options.actions?.length ? false : true);

    const payload: FloatingNotificationData = {
      taskId,
      mode: 'result',
      status: options.status || 'success',
      title: options.title,
      projectName: options.projectName,
      targetName: options.targetName,
      envName: options.envName,
      stage: options.stage,
      description: options.description,
      errorMessage: options.errorMessage,
      duration: options.duration,
      visitUrl: options.visitUrl,
      actions: options.actions,
      autoDismiss,
      durationMs: options.durationMs,
      timestamp: Date.now(),
    };

    if (options.actions?.length && options.onAction) {
      activeSession = {
        taskId,
        onAction: options.onAction,
        lastProgressEmitTime: 0,
      };
    }

    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (activeSession) {
          const { listen } = await import('@tauri-apps/api/event');
          const unlisten = await listen<{ actionId: string; taskId?: string }>(
            'desktop-task-action',
            (event) => {
              if (activeSession && event.payload) {
                const { actionId, taskId: eventTaskId } = event.payload;
                if (!eventTaskId || eventTaskId === activeSession.taskId) {
                  void activeSession.onAction?.(actionId, eventTaskId);
                }
              }
            }
          );
          if (activeSession) {
            activeSession.unlistenAction = unlisten;
          }
        }
        await invoke('show_floating_notification', { payload });
      } catch (error) {
        console.warn('[DesktopFloatingTask] finish 展示失败:', error);
      }
    }
  },

  /**
   * 立即收起并隐藏桌面悬浮通知。
   */
  async dismiss(): Promise<void> {
    cleanupActiveSession();
    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('hide_floating_notification', { force: true });
      } catch {
        // 忽略异常
      }
    }
  },
};
