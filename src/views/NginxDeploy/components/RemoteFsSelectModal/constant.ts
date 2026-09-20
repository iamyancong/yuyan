/**
 * 远程目录选择弹窗静态常量与配置
 * @description 定义目录表格列配置、格式化辅助函数与路径规范化工具
 */

import type { YTableColumn } from '@yss-ui/components/lite';

/** 路径片段 */
export interface SelectBreadcrumbSegment {
  name: string;
  path: string;
  isLast: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * 规范化 POSIX 路径。
 * @param raw 原始路径
 * @returns 统一斜杠的标准 POSIX 绝对路径
 */
export function normalizePosix(raw: string): string {
  const trimmed = String(raw || '').trim().replace(/\\/g, '/');
  if (!trimmed) return '/';
  const parts = trimmed.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

/**
 * 判断目标路径是否为受限根或其合法子路径。
 * @param targetPath 目标路径
 * @param rootPath 允许根路径
 * @returns 是否在允许根范围内
 */
export function isSubPathOrEqual(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizePosix(targetPath);
  const normRoot = normalizePosix(rootPath);
  return normTarget === normRoot || normTarget.startsWith(`${normRoot}/`);
}

/**
 * 判断目标路径是否落在任一允许根范围内。
 * @param targetPath 目标路径
 * @param roots 允许根列表
 * @returns 是否落在任一根范围内
 */
export function isPathWithinAnyRoot(targetPath: string, roots: Array<{ path: string }>): boolean {
  if (!roots || roots.length === 0) return true;
  return roots.some((r) => isSubPathOrEqual(targetPath, r.path));
}

/**
 * 格式化文件最后修改时间戳。
 * @param mtime 毫秒时间戳
 * @returns 紧凑日期时间文本
 */
export function formatMtime(mtime: number | null): string {
  if (!mtime) return '-';
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${month}-${day} ${hours}:${minutes}`;
}

/** 目录选择列表列配置 */
export const fsSelectTableColumns: YTableColumn[] = [
  {
    field: 'name',
    title: '名称',
    minWidth: 260,
    showOverflow: false,
    slots: { default: 'nameSlot' },
  },
  {
    field: 'permissions',
    title: '权限',
    width: 100,
    align: 'center',
  },
  {
    field: 'mtime',
    title: '修改时间',
    width: 130,
    align: 'center',
    formatter: ({ cellValue }: { cellValue: unknown }) => formatMtime(cellValue as number | null),
  },
  {
    title: '操作',
    width: 80,
    align: 'center',
    slots: { default: 'actionSlot' },
  },
];
