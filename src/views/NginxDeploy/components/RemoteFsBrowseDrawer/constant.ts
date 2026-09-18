/**
 * 远程文件浏览与命令执行常量与工具
 */

import type { YTableColumn } from '@yss-ui/components/lite';

/** 文件大小格式化 */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  const normalizedIndex = Math.min(index, units.length - 1);
  const size = bytes / Math.pow(1024, normalizedIndex);
  return `${size.toFixed(size >= 10 || normalizedIndex === 0 ? 0 : 1)} ${units[normalizedIndex]}`;
}

/** 时间格式化为 YYYY-MM-DD HH:mm:ss */
export function formatDateTime(timeMs: number | null): string {
  if (!timeMs) return '-';
  const date = new Date(timeMs);
  if (isNaN(date.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/** 预设安全命令芯片 */
export interface PresetCommandChip {
  label: string;
  command: string;
  description: string;
}

export const PRESET_COMMAND_CHIPS: PresetCommandChip[] = [
  { label: '列表详情', command: 'ls -lh', description: '查看当前目录下的文件详情与大小' },
  { label: '含隐藏项', command: 'ls -la', description: '查看包含 . 开头的全部条目与权限' },
  { label: '磁盘空间', command: 'df -h', description: '查看远程服务器各磁盘挂载点剩余空间' },
  { label: '目录体积', command: 'du -sh * 2>/dev/null', description: '统计当前目录下各子文件/文件夹总占用' },
  { label: '当前绝对路径', command: 'pwd', description: '打印远程服务器当前工作目录' },
];

/** 远程文件表格列配置 */
export const fsTableColumns: YTableColumn[] = [
  {
    field: 'name',
    title: '名称',
    minWidth: 260,
    showOverflow: false,
    slots: { default: 'nameSlot' },
  },
  {
    field: 'size',
    title: '大小',
    width: 100,
    align: 'right',
    formatter: ({ cellValue }) => formatFileSize(cellValue as number | null),
  },
  {
    field: 'permissions',
    title: '权限',
    width: 105,
    align: 'center',
    formatter: ({ cellValue }) => String(cellValue || '-'),
  },
  {
    field: 'mtime',
    title: '修改时间',
    width: 160,
    align: 'center',
    formatter: ({ cellValue }) => formatDateTime(cellValue as number | null),
  },
  {
    field: 'action',
    title: '操作',
    width: 90,
    align: 'center',
    fixed: 'right',
    slots: { default: 'actionSlot' },
  },
];
