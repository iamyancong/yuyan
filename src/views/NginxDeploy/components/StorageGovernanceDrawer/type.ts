import type { NginxInstance } from '@/api/deploy';

/** 存储与备份治理抽屉属性 */
export interface StorageGovernanceDrawerProps {
  /** 是否打开抽屉 */
  open: boolean;
  /** 当前 Nginx 实例 */
  instance: NginxInstance | null;
  /** 服务器显示名称 */
  serverName?: string;
}

/** 存储与备份治理抽屉事件 */
export type StorageGovernanceDrawerEmits = {
  (e: 'update:open', value: boolean): void;
  /** 清理完成后通知外层刷新记录或状态 */
  (e: 'cleaned'): void;
};
