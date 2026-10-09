import type { RemoteFsEntry } from '@/api/deploy';

/** 右键菜单操作动作标识。 */
export type RemoteFsContextAction = 'download' | 'drillDown' | 'preview' | 'copyPath' | 'navigateUp';

/** 右键菜单项定义。 */
export interface ContextMenuItem {
  key: RemoteFsContextAction;
  label: string;
  iconName: string;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * 根据条目类型获取可用的右键操作菜单项。
 * @param entry 当前操作的文件系统条目
 * @returns 菜单项列表
 */
export const getContextMenuItems = (entry: RemoteFsEntry | null): ContextMenuItem[] => {
  if (!entry) return [];

  if (entry.type === 'parent_dir') {
    return [
      { key: 'navigateUp', label: '返回上一级', iconName: 'ArrowUpOutlined' },
    ];
  }

  if (entry.type === 'directory') {
    return [
      { key: 'download', label: '打包下载到本地', iconName: 'CloudDownloadOutlined' },
      { key: 'drillDown', label: '进入目录', iconName: 'FolderOpenOutlined' },
      { key: 'copyPath', label: '复制绝对路径', iconName: 'CopyOutlined' },
    ];
  }

  return [
    { key: 'download', label: '下载到本地', iconName: 'DownloadOutlined' },
    { key: 'preview', label: '快速预览', iconName: 'EyeOutlined' },
    { key: 'copyPath', label: '复制绝对路径', iconName: 'CopyOutlined' },
  ];
};

/**
 * 根据多选条目集合生成批量操作菜单项。
 * @param entries 已选文件系统条目列表
 * @returns 批量菜单项列表
 */
export const getBatchContextMenuItems = (entries: RemoteFsEntry[]): ContextMenuItem[] => {
  if (!entries || entries.length === 0) return [];
  const count = entries.length;
  return [
    {
      key: 'download',
      label: `打包下载到本地 (${count} 项)`,
      iconName: 'CloudDownloadOutlined',
    },
    {
      key: 'copyPath',
      label: `复制所有选中路径 (${count} 项)`,
      iconName: 'CopyOutlined',
    },
  ];
};
