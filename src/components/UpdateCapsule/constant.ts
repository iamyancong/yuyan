import type { Component } from 'vue';
import {
  CloudDownloadOutlined,
  LoadingOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons-vue';

/** 更新状态枚举 */
export type UpdateStatus = 'idle' | 'preparing' | 'downloading' | 'paused' | 'completed' | 'installing' | 'error';

/** 更新状态详情 */
export interface UpdateState {
  /** 当前状态 */
  status: UpdateStatus;
  /** 下载进度 (0-100) */
  progress: number;
  /** 错误信息 */
  error: string | null;
  /** 已下载字节数 */
  downloadedBytes: number;
  /** 文件总字节数 */
  totalBytes: number | null;
  /** 当前平均下载速度 */
  bytesPerSecond: number;
  /** 预计剩余秒数 */
  remainingSeconds: number | null;
  /** 当前服务是否支持断点续传 */
  resumable: boolean;
  /** 已自动重试次数 */
  retryCount: number;
}

/** 各状态下的胶囊展示配置 */
export interface CapsuleConfig {
  /** 状态图标组件 */
  icon: Component;
  /** 默认显示文案 */
  label: string;
  /** 是否可点击 */
  clickable: boolean;
  /** CSS 修饰类名 */
  className: string;
}

/** 状态映射：胶囊展示配置表 */
export const STATUS_CONFIG_MAP: Record<UpdateStatus, CapsuleConfig> = {
  idle: {
    icon: CloudDownloadOutlined,
    label: '更新',
    clickable: true,
    className: 'status-idle',
  },
  preparing: {
    icon: LoadingOutlined,
    label: '服务器正在准备更新包...',
    clickable: false,
    className: 'status-preparing',
  },
  downloading: {
    icon: CloudDownloadOutlined,
    label: '正在下载...',
    clickable: false,
    className: 'status-downloading',
  },
  paused: {
    icon: CloudDownloadOutlined,
    label: '继续更新',
    clickable: true,
    className: 'status-idle',
  },
  completed: {
    icon: ThunderboltOutlined,
    label: '新版本已就绪，点击安装',
    clickable: true,
    className: 'status-completed',
  },
  installing: {
    icon: LoadingOutlined,
    label: '正在安装更新...',
    clickable: false,
    className: 'status-installing',
  },
  error: {
    icon: WarningOutlined,
    label: '更新下载失败，点击重试',
    clickable: true,
    className: 'status-error',
  },
};

/** 自动更新检测轮询间隔（毫秒） */
export const AUTO_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** 首次启动延迟检测（毫秒） */
export const INITIAL_CHECK_DELAY_MS = 2000;

/** 下载进度轮询间隔（毫秒） */
export const PROGRESS_POLL_INTERVAL_MS = 1000;

/** 内网更新缓存状态轮询间隔（毫秒） */
export const CACHE_STATUS_POLL_INTERVAL_MS = 2000;

/** 单次服务器缓存准备的最长静默等待时间（毫秒） */
export const CACHE_STATUS_TIMEOUT_MS = 10 * 60 * 1000;

/** 缓存状态接口连续失败上限 */
export const CACHE_STATUS_MAX_ERRORS = 5;

/** 等待旧原生下载任务释放的轮询间隔（毫秒） */
export const NATIVE_TASK_RELEASE_INTERVAL_MS = 100;

/** 等待旧原生下载任务释放的最大次数 */
export const NATIVE_TASK_RELEASE_MAX_ATTEMPTS = 100;
