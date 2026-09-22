import { isTauri } from './env.ts';

/** 部署通知状态类型 */
export type DeployNotificationStatus = 'success' | 'error' | 'stopped';

/** 部署系统通知入参 */
export interface DeployNotificationOptions {
  /** 终态状态：成功、失败或已停止 */
  status: DeployNotificationStatus;
  /** 项目名称 */
  projectName: string;
  /** 部署目标名称，如服务器名 */
  targetName?: string;
  /** 部署环境，如 测试环境、生产环境 */
  envName?: string;
  /** 失败或中止阶段，如 依赖安装、构建打包、上传产物 */
  stage?: string;
  /** 失败错误原因 */
  errorMessage?: string;
  /** 部署耗时文本，如 42s */
  duration?: string;
  /** 站点访问链接（仅成功时可配置） */
  visitUrl?: string;
  /** 部署任务标识，用于避免同一次流水线重复弹系统通知 */
  deployId?: string | number;
  /** 强制发送通知，忽略前台聚焦判定（供测试与调试） */
  force?: boolean;
}

/** 格式化后的通知内容 */
export interface FormattedNotificationContent {
  /** 通知主标题 */
  title: string;
  /** 通知详细正文 */
  body: string;
}

/** 通知权限状态 */
export type SystemNotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

/** 本地存储中是否启用部署系统通知的键名 */
export const DEPLOY_NOTIFICATION_STORAGE_KEY = 'yuyan_deploy_notification_enabled';

/**
 * 登记已发送通知的部署任务编号，避免同一流水线重复弹窗
 */
const recordNotifiedDeployId = (deployKey?: string): void => {
  if (!deployKey) return;
  notifiedDeployIds.add(deployKey);
  if (notifiedDeployIds.size > MAX_NOTIFIED_HISTORY) {
    const first = notifiedDeployIds.values().next().value;
    if (first) notifiedDeployIds.delete(first);
  }
};

/** 最近已发送通知的部署任务编号缓存（防刷屏与重复通知） */
const notifiedDeployIds = new Set<string>();
const MAX_NOTIFIED_HISTORY = 50;

/**
 * 格式化部署系统通知文案。
 * @param options 部署通知入参
 * @returns 包含标题与正文的对象
 */
export const formatDeployNotificationContent = (
  options: DeployNotificationOptions
): FormattedNotificationContent => {
  const { status, projectName, targetName, envName, stage, errorMessage } = options;
  const projectLabel = projectName?.trim() || '项目';

  if (status === 'success') {
    const destination = targetName?.trim() || envName?.trim() || '服务器';
    return {
      title: '部署成功',
      body: `${projectLabel} 已成功发布到「${destination}」`,
    };
  }

  if (status === 'stopped') {
    const stageLabel = stage?.trim() ? `（中断于「${stage.trim()}」）` : '';
    return {
      title: '部署已停止',
      body: `${projectLabel} 发布任务已手动停止${stageLabel}`.trim(),
    };
  }

  const destination = targetName?.trim() || envName?.trim();
  const stageName = stage?.trim();
  const contextLabel = destination && stageName
    ? `在「${destination}」的「${stageName}」阶段`
    : (destination ? `在「${destination}」` : (stageName ? `在「${stageName}」` : ''));
  const reason = errorMessage?.trim() || '未知异常';
  return {
    title: '部署失败',
    body: `${projectLabel} ${contextLabel ? `${contextLabel}执行失败` : '执行失败'}：${reason}`.replace(/\s+/g, ' ').trim(),
  };
};

/**
 * 读取用户是否开启了部署系统通知偏好。
 * @returns 是否开启（默认开启）
 */
export const isDeployNotificationEnabled = (): boolean => {
  if (typeof window === 'undefined' || !window.localStorage) return true;
  const stored = window.localStorage.getItem(DEPLOY_NOTIFICATION_STORAGE_KEY);
  return stored === null ? true : stored === 'true';
};

/**
 * 设置用户部署系统通知偏好。
 * @param enabled 是否开启
 */
export const setDeployNotificationEnabled = (enabled: boolean): void => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(DEPLOY_NOTIFICATION_STORAGE_KEY, enabled ? 'true' : 'false');
};

/**
 * 判断当前应用窗口是否处于前台且聚焦态。
 * @description 桌面端优先通过 Rust 原生检测 macOS/Windows 进程激活与窗口聚焦；Web 端通过 document.hasFocus 与 visibilityState 判定。
 * @returns 是否处于聚焦状态
 */
export const isWindowFocused = async (): Promise<boolean> => {
  if (typeof document === 'undefined') return false;

  // 1. Tauri 桌面端：优先调用 Rust 原生窗口与进程激活状态检查（100% 区分是否切到其他 App）
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const focused = await invoke<boolean>('is_desktop_window_focused');
      console.info('[DeployNotification] 桌面端 Rust 窗口聚焦与进程激活检测结果:', focused);
      return Boolean(focused);
    } catch (error) {
      console.warn('[DeployNotification] is_desktop_window_focused 检查异常，降级回退到 Web 检测:', error);
    }
  }

  // 2. Web 浏览器环境下，结合 document.hasFocus 与 visibilityState
  const hasDocumentFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  const isDocumentVisible = document.visibilityState === 'visible';
  const focused = Boolean(hasDocumentFocus && isDocumentVisible);
  console.info('[DeployNotification] Web 窗口聚焦检测结果:', focused, { hasDocumentFocus, isDocumentVisible });
  return focused;
};

/**
 * 查询当前运行环境的系统通知权限。
 * @returns 权限状态
 */
export const checkNotificationPermission = async (): Promise<SystemNotificationPermissionState> => {
  if (isTauri()) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
      const granted = await isPermissionGranted();
      return granted ? 'granted' : 'default';
    } catch (error) {
      console.warn('[DeployNotification] 读取桌面端通知权限异常，回退至待授权:', error);
      return 'default';
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    return window.Notification.permission as SystemNotificationPermissionState;
  }

  return 'unsupported';
};

/**
 * 申请系统通知权限。
 * @returns 授权是否成功
 */
export const requestNotificationPermission = async (): Promise<boolean> => {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
      let granted = await isPermissionGranted();
      if (!granted) {
        const permission = await requestPermission();
        granted = permission === 'granted';
      }
      return granted;
    } catch (error) {
      console.warn('[DeployNotification] 申请桌面端通知权限异常:', error);
      return false;
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      const result = await window.Notification.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  return false;
};

/**
 * 重置通知防重缓存（供单测或调试使用）。
 */
export const clearDeployNotificationHistory = (): void => {
  notifiedDeployIds.clear();
};

/**
 * 在发布流水线到达终态时，根据当前窗口焦点分流触发 OS / 浏览器系统通知。
 * @param options 部署通知配置
 * @returns 是否成功发出系统通知
 */
export const notifyDeployResult = async (options: DeployNotificationOptions): Promise<boolean> => {
  // 1. 校验用户开关
  if (!isDeployNotificationEnabled()) {
    console.info('[DeployNotification] 用户未开启部署通知开关，跳过通知发送');
    return false;
  }

  // 2. 校验前台聚焦态（前台聚焦时不触发系统通知，避免和应用内反馈重复）
  if (!options.force) {
    const focused = await isWindowFocused();
    if (focused) {
      console.info('[DeployNotification] 应用处于前台聚焦激活态，跳过系统通知以避免打扰');
      return false;
    }
  }

  // 3. 校验任务防重幂等
  const deployKey = options.deployId ? String(options.deployId) : undefined;
  if (deployKey && notifiedDeployIds.has(deployKey)) {
    console.info('[DeployNotification] 任务已在防重缓存中，跳过重复通知:', deployKey);
    return false;
  }

  const { title, body } = formatDeployNotificationContent(options);

  // 4. 桌面端（Tauri）通知触发：优先唤起雨燕专属 C4D 3D 玻璃拟态跨桌面微浮窗！
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const floatingStatus = options.status === 'stopped' ? 'warning' : options.status;
      await invoke('show_floating_notification', {
        payload: {
          status: floatingStatus,
          title,
          projectName: options.projectName,
          targetName: options.targetName,
          envName: options.envName,
          stage: options.stage,
          errorMessage: options.errorMessage,
          visitUrl: options.visitUrl,
          duration: options.duration,
          timestamp: Date.now(),
        },
      });
      recordNotifiedDeployId(deployKey);
      console.info('[DeployNotification] C4D 3D 玻璃拟态跨桌面全局浮窗唤起成功:', { title, body });
      return true;
    } catch (error) {
      console.warn('[DeployNotification] show_floating_notification 唤起异常，降级至原生系统通知:', error);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('send_desktop_notification', { title, body });
        recordNotifiedDeployId(deployKey);
        return true;
      } catch (pluginError) {
        console.error('[DeployNotification] 所有桌面通知通道均发送失败:', pluginError);
      }
    }
    return false;
  }

// 保持 Web 活跃通知对象的引用，防止 Chromium V8 过早垃圾回收导致系统横幅丢失
const activeWebNotifications = new Set<any>();

/**
 * 登记 Web 活跃通知实例，防止被 GC 并在关闭或超时后自动释放
 */
const trackWebNotification = (notification: any): void => {
  activeWebNotifications.add(notification);
  const cleanup = () => {
    activeWebNotifications.delete(notification);
  };
  notification.onclose = cleanup;
  notification.onerror = cleanup;
  if (typeof setTimeout === 'function') {
    const timer = setTimeout(cleanup, 15000);
    if (typeof timer === 'object' && timer && 'unref' in timer && typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
  }
};

  // 5. Web 浏览器桌面通知触发
  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      let permission = window.Notification.permission;
      if (permission === 'default') {
        permission = await window.Notification.requestPermission();
      }
      if (permission === 'granted') {
        const iconUrl = typeof window !== 'undefined' && window.location?.origin
          ? `${window.location.origin}/favicon.ico`
          : '/favicon.ico';

        const notification = new window.Notification(title, {
          body,
          icon: iconUrl,
        });

        trackWebNotification(notification);

        notification.onshow = () => {
          console.info('[DeployNotification] Web 桌面系统通知已展示:', { title, body });
        };
        notification.onerror = (err: any) => {
          console.warn('[DeployNotification] Web 桌面系统通知展示异常，请检查操作系统或浏览器权限:', err);
        };
        notification.onclick = () => {
          try {
            window.focus();
          } catch {
            // 忽略浏览器标签页激活失败
          }
        };
        recordNotifiedDeployId(deployKey);
        console.info('[DeployNotification] Web 桌面系统通知已成功派发给浏览器:', { title, body });
        return true;
      }
      console.info('[DeployNotification] Web 桌面通知未获得权限:', permission);
    } catch (error) {
      console.warn('[DeployNotification] 发送 Web 桌面通知失败，静默降级:', error);
    }
    return false;
  }

  return false;
};

/**
 * 发送一条测试部署系统通知（强制发送，忽略前台聚焦判定，用于设置页或调试验收）。
 * @returns 是否成功发出
 */
export const sendTestDeployNotification = async (): Promise<boolean> => {
  return notifyDeployResult({
    status: 'success',
    projectName: '雨燕微前端核心',
    targetName: '生产主机集群',
    envName: '生产环境',
    duration: '38s',
    visitUrl: 'https://yuyan.ops.internal',
    force: true,
  });
};
