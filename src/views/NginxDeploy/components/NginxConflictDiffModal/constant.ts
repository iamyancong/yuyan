import type { DeployTarget } from '@/api/deploy';
import { DIFF_MONACO_OPTIONS } from '../NginxConfigDrawer/constant';

/** 接口：Nginx 站点配置冲突详情 */
export interface NginxConflictData {
  /** 冲突配置文件绝对路径 */
  path: string;
  /** 远程服务器当前配置内容（左侧基准） */
  currentContent: string;
  /** 平台将要写入的托管配置内容（右侧目标） */
  generatedContent: string;
  /** 当前远程配置 SHA-256 哈希值，用于并发防篡改 */
  currentSha256: string;
  /** 冲突/未接管原因 */
  reason?: string;
}

/** 接口：Nginx 冲突差异对比弹窗属性 */
export interface NginxConflictDiffModalProps {
  /** 弹窗是否可见 */
  open: boolean;
  /** 关联部署目标 */
  target: DeployTarget | null;
  /** 冲突详情数据 */
  conflictData: NginxConflictData | null;
  /** 覆盖接管执行中加载状态 */
  loading?: boolean;
}

/** 冲突弹窗 Diff 编辑器配置选项（只读 side-by-side 对比） */
export const CONFLICT_DIFF_MONACO_OPTIONS = {
  ...DIFF_MONACO_OPTIONS,
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  renderIndicators: true,
  minimap: { enabled: false },
  fontSize: 13,
} as const;
