/**
 * 行内文件选择器静态配置与类型定义
 */

import type { YTableColumn } from '@yss-ui/components/lite';
import type { DeployServer, RemoteFsEntry } from '@/api/deploy';
import {
  normalizePosix,
  isSubPathOrEqual,
  isPathWithinAnyRoot,
  getEntryOccupant,
  formatMtime,
  type SelectBreadcrumbSegment,
  type SelectFsEntry,
} from '../../../RemoteFsSelectModal/constant.ts';

export {
  normalizePosix,
  isSubPathOrEqual,
  isPathWithinAnyRoot,
  getEntryOccupant,
  formatMtime,
  type SelectBreadcrumbSegment,
  type SelectFsEntry,
};

/** 行内文件选择器组件属性 */
export interface InlineFsExplorerProps {
  server?: DeployServer | null;
  modelValue?: string;
  lockedRoot?: string;
  defaultPath?: string;
  scopeLabel?: string;
  occupiedMap?: Record<string, string>;
}

/** 行内目录表格列配置（撑满宽度展示） */
export const inlineFsColumns: YTableColumn[] = [
  {
    field: 'name',
    title: '目录名称',
    minWidth: 260,
    showOverflow: false,
    slots: { default: 'name' },
  },
  {
    field: 'status',
    title: '部署状态',
    width: 260,
    showOverflow: false,
    slots: { default: 'status' },
  },
  {
    field: 'mtime',
    title: '修改时间',
    width: 140,
    align: 'center',
    formatter: ({ cellValue }: { cellValue: unknown }) => formatMtime(cellValue as number | null),
  },
  {
    field: 'action',
    title: '操作',
    width: 80,
    align: 'center',
    fixed: 'right',
    slots: { default: 'action' },
  },
];
