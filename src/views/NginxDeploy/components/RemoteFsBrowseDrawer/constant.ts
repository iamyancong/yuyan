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

/** 面包屑分段类型 */
export interface BreadcrumbSegment {
  name: string;
  path: string;
  isLast: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

/** 规范化 POSIX 路径 */
export function normalizePosix(raw: string): string {
  const trimmed = String(raw || '').trim().replace(/\\/g, '/');
  if (!trimmed) return '/';
  const parts = trimmed.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

/** 判断路径是否在允许根内 */
export function isSubPathOrEqual(targetPath: string, rootPath: string): boolean {
  const normTarget = normalizePosix(targetPath);
  const normRoot = normalizePosix(rootPath);
  return normTarget === normRoot || normTarget.startsWith(`${normRoot}/`);
}

/** 判断路径是否在任一允许根内 */
export function isPathWithinAnyRoot(targetPath: string, roots: Array<{ path: string }>): boolean {
  if (!roots || roots.length === 0) return true;
  return roots.some((r) => isSubPathOrEqual(targetPath, r.path));
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

/** 文件视觉感知类型 */
export type FileCategory =
  | 'directory'
  | 'parent_dir'
  | 'code'
  | 'page'
  | 'config'
  | 'archive'
  | 'image'
  | 'log'
  | 'default';

export interface FileVisualBadge {
  category: FileCategory;
  tag: string;
}

/**
 * 根据文件名与类型推断视觉分类与文字标签
 * @param name 文件名
 * @param type 条目类型 ('directory' | 'file' | 'parent_dir')
 * @returns 视觉分类与徽章标识
 */
export function getFileVisualBadge(name: string, type: string): FileVisualBadge {
  if (type === 'parent_dir') {
    return { category: 'parent_dir', tag: '..' };
  }
  if (type === 'directory') {
    return { category: 'directory', tag: 'DIR' };
  }
  const parts = name.split('.');
  const ext = (parts.length > 1 ? parts.pop() || '' : '').toLowerCase();

  if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    return { category: 'code', tag: 'JS' };
  }
  if (['html', 'htm', 'vue'].includes(ext)) {
    return { category: 'page', tag: '</>' };
  }
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) {
    return { category: 'config', tag: '{}' };
  }
  if (['conf', 'nginx', 'env', 'ini', 'sh'].includes(ext)) {
    return { category: 'config', tag: 'CFG' };
  }
  if (['gz', 'br', 'zip', 'tar', 'tgz', 'rar', '7z'].includes(ext)) {
    return { category: 'archive', tag: 'ZIP' };
  }
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'ico', 'gif'].includes(ext)) {
    return { category: 'image', tag: 'IMG' };
  }
  if (['log', 'txt', 'md', 'out'].includes(ext)) {
    return { category: 'log', tag: 'LOG' };
  }
  return { category: 'default', tag: 'FILE' };
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
    minWidth: 280,
    showOverflow: false,
    headerAlign: 'left',
    slots: { default: 'name', header: 'name-header' },
  },
  {
    field: 'size',
    title: '大小',
    width: 120,
    align: 'right',
    headerAlign: 'right',
    slots: { header: 'size-header' },
    formatter: ({ cellValue }) => formatFileSize(cellValue as number | null),
  },
  {
    field: 'permissions',
    title: '权限',
    width: 110,
    align: 'center',
    headerAlign: 'center',
    formatter: ({ cellValue }) => String(cellValue || '-'),
  },
  {
    field: 'mtime',
    title: '修改时间',
    width: 180,
    align: 'center',
    headerAlign: 'center',
    slots: { header: 'mtime-header' },
    formatter: ({ cellValue }) => formatDateTime(cellValue as number | null),
  },
  {
    field: 'action',
    title: '快捷操作',
    width: 130,
    align: 'center',
    headerAlign: 'center',
    fixed: 'right',
    slots: { default: 'action' },
  },
];

/**
 * 构建不含非法路径字符的下载建议文件名。
 * @param server 当前服务器
 * @param entry 当前文件或目录项
 * @returns 格式化后的文件名
 */
export function buildFsSuggestedFileName(
  server: { name?: string; host?: string } | null | undefined,
  entry: { name: string; type: string }
): string {
  const sanitize = (value: string, fallback: string) =>
    value
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback;

  const pad = (value: number) => String(value).padStart(2, '0');
  const now = new Date();
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const serverPrefix = sanitize(server?.name || server?.host || '', 'server');
  const namePart = sanitize(entry.name, entry.type === 'directory' ? 'folder' : 'file');

  if (entry.type === 'directory') {
    return `${serverPrefix}-${namePart}-${timestamp}.tar.gz`;
  }
  return entry.name;
}

