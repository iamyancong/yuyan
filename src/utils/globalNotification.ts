import { h, type VNode } from 'vue';
import { notification } from 'ant-design-vue';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  ExclamationCircleFilled,
  InfoCircleFilled,
  SyncOutlined,
} from '@ant-design/icons-vue';

/** 通知类型 */
export type GlassNotificationType = 'success' | 'warning' | 'error' | 'info' | 'loading';

/** 快捷操作按钮定义 */
export interface GlassNotificationAction {
  /** 按钮文字 */
  text: string;
  /** 是否为主按钮样式 */
  primary?: boolean;
  /** 点击回调 */
  onClick: () => void | Promise<void>;
}

/** 玻璃拟态通知参数 */
export interface ShowGlassNotificationOptions {
  /** 通知类型，决定图标盒子颜色与默认关闭时间 */
  type?: GlassNotificationType;
  /** 通知主标题 */
  title: string;
  /** 辅助徽标，如「测试」「生产」「Gatekeeper」等 */
  badge?: string;
  /** 通知详细描述内容，支持字符串或 VNode */
  description?: string | VNode;
  /** 快捷操作按钮组 */
  actions?: GlassNotificationAction[];
  /** 自动关闭时长（秒），传 0 则不自动关闭；未传时根据类型赋予合理时长 */
  duration?: number;
  /** 弹窗自定义 key，用于同类型更新或精准关闭 */
  key?: string;
  /** 距离视口顶部高度，默认 76px 避让 Header 导航栏 */
  top?: string;
  /** 关闭回调 */
  onClose?: () => void;
}

/** 默认通知停留时长（秒）配置 */
export const DEFAULT_NOTIFICATION_DURATIONS: Record<GlassNotificationType, number> = {
  success: 3.5,
  warning: 4.0,
  error: 5.0,
  info: 3.5,
  loading: 0,
};

/** 全局通知是否已经初始化完成 */
let notificationConfigured = false;

/**
 * 根据类型获取对应的默认停留时长。
 * @param type 通知类型
 * @param explicitDuration 显式传入的时长
 * @returns 合理的秒数
 */
export const resolveNotificationDuration = (
  type: GlassNotificationType = 'info',
  explicitDuration?: number
): number => {
  if (typeof explicitDuration === 'number' && explicitDuration >= 0) {
    return explicitDuration;
  }
  return DEFAULT_NOTIFICATION_DURATIONS[type] ?? 3.5;
};

/**
 * 根据类型创建标题左侧的发光图标 VNode。
 * @param type 通知类型
 * @returns 图标 VNode
 */
export const createGlassNotificationIcon = (type: GlassNotificationType = 'info'): VNode => {
  switch (type) {
    case 'success':
      return h(CheckCircleFilled, { class: 'glass-noti-type-icon is-success' });
    case 'warning':
      return h(ExclamationCircleFilled, { class: 'glass-noti-type-icon is-warning' });
    case 'error':
      return h(CloseCircleFilled, { class: 'glass-noti-type-icon is-error' });
    case 'loading':
      return h(SyncOutlined, { class: 'glass-noti-type-icon is-loading', spin: true });
    case 'info':
    default:
      return h(InfoCircleFilled, { class: 'glass-noti-type-icon is-info' });
  }
};

/**
 * 创建通用玻璃拟态关闭图标。
 * @returns 关闭按钮 VNode
 */
export const createGlassCloseIcon = (): VNode => {
  return h(CloseOutlined, { 'aria-label': '关闭通知', class: 'glass-noti-close-x' });
};

/**
 * 全局初始化通知服务，配置统一避让距离、默认自动关闭时间与堆叠上限。
 */
export const configureGlobalNotification = (): void => {
  if (notificationConfigured) return;
  notificationConfigured = true;

  notification.config({
    top: '76px', // 默认避让顶部 Header 区域（64px + 12px 留白）
    duration: 3.5, // 默认 3.5 秒平滑自动关闭
    maxCount: 3, // 最多同时展示 3 条通知，防止堆叠遮挡
    placement: 'topRight',
  });
};

/**
 * 弹出符合雨燕 C4D 玻璃拟态设计风格的高阶通知卡片。
 * @param options 通知配置项
 */
export const showGlassNotification = (options: ShowGlassNotificationOptions): void => {
  const {
    type = 'info',
    title,
    badge,
    description,
    actions = [],
    duration,
    key,
    top = '76px',
    onClose,
  } = options;

  const resolvedDuration = resolveNotificationDuration(type, duration);
  const notificationKey = key || `yuyan-glass-noti-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // 构建标题区域 VNode
  const titleVNode = h('div', { class: `glass-noti-title-wrap is-${type}` }, [
    h('div', { class: `glass-noti-icon-box is-${type}` }, [createGlassNotificationIcon(type)]),
    h('span', { class: 'glass-noti-title', title }, title),
    badge ? h('span', { class: `glass-noti-badge is-${type}` }, badge) : null,
  ]);

  // 构建内容区域 VNode
  const descriptionVNode = h('div', { class: 'glass-noti-body' }, [
    typeof description === 'string'
      ? h('p', { class: 'glass-noti-desc' }, description)
      : description,
    actions.length > 0
      ? h(
          'div',
          { class: 'glass-noti-actions' },
          actions.map((action) =>
            h(
              'button',
              {
                key: action.text,
                type: 'button',
                class: ['glass-noti-action-btn', action.primary ? 'is-primary' : 'is-default'],
                onClick: async () => {
                  try {
                    await action.onClick();
                  } finally {
                    notification.close(notificationKey);
                  }
                },
              },
              action.text
            )
          )
        )
      : null,
  ]);

  notification.open({
    key: notificationKey,
    class: `yuyan-glass-notification is-${type}`,
    top,
    duration: resolvedDuration,
    placement: 'topRight',
    style: {
      width: '410px',
    },
    closeIcon: createGlassCloseIcon(),
    message: titleVNode,
    description: descriptionVNode,
    onClose,
  });
};

/** 导出统一语义化捷径 */
export const glassNotification = {
  success: (title: string, description?: string | VNode, options?: Partial<ShowGlassNotificationOptions>) =>
    showGlassNotification({ ...options, title, description, type: 'success' }),
  warning: (title: string, description?: string | VNode, options?: Partial<ShowGlassNotificationOptions>) =>
    showGlassNotification({ ...options, title, description, type: 'warning' }),
  error: (title: string, description?: string | VNode, options?: Partial<ShowGlassNotificationOptions>) =>
    showGlassNotification({ ...options, title, description, type: 'error' }),
  info: (title: string, description?: string | VNode, options?: Partial<ShowGlassNotificationOptions>) =>
    showGlassNotification({ ...options, title, description, type: 'info' }),
  close: (key: string) => notification.close(key),
};
