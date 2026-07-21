import type { Component } from 'vue';
import {
  SoundOutlined,
  GiftOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons-vue';

/** 通知消息项的数据结构 */
export interface NoticeItem {
  id: string;
  /** 文本内容 */
  text: string;
  /** 通知类型，决定 LED 灯和高亮状态 */
  type: 'info' | 'success' | 'warn';
  /** 前缀图标组件 */
  icon: Component;
  /** 动作按钮文字 */
  actionText?: string;
  /** 动作触发类型 */
  actionType?: 'download' | 'link';
}

/** 轮播消息列表配置 */
export const NOTICE_LIST: NoticeItem[] = [
  {
    id: 'client-release',
    text: '雨燕桌面客户端现已发布！支持更强大的本地构建和极速部署体验。',
    type: 'success',
    icon: GiftOutlined,
    actionText: '下载客户端',
    actionType: 'download',
  },
  {
    id: 'client-feature',
    text: '客户端专属：中央配置按账号安全刷新，本地授权和构建缓存按设备隔离。',
    type: 'info',
    icon: SoundOutlined,
    actionText: '立即体验',
    actionType: 'download',
  },
  {
    id: 'ui-upgrade',
    text: '全面打通桌面操作链路，桌面版支持更灵活的端口分配与自更新能力。',
    type: 'warn',
    icon: CloudDownloadOutlined,
    actionText: '获取桌面版',
    actionType: 'download',
  },
];
