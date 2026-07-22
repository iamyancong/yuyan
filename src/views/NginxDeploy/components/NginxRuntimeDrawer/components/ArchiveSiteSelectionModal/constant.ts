import type { NginxArchiveDownloadType, NginxArchiveSiteOption } from '@/api/deploy';

/** 归档选择窗口属性。 */
export interface ArchiveSiteSelectionModalProps {
  open: boolean;
  loading: boolean;
  downloading: boolean;
  type: NginxArchiveDownloadType;
  configPath: string;
  sites: NginxArchiveSiteOption[];
}

/** 归档类型选项。 */
export const ARCHIVE_TYPE_OPTIONS: Array<{
  value: NginxArchiveDownloadType;
  label: string;
  description: string;
}> = [
  { value: 'all', label: '完整运行包', description: 'Nginx 运行文件、所选项目与裁剪配置' },
  { value: 'html', label: '静态产物', description: '只包含所选项目 root 目录' },
  { value: 'conf', label: 'Nginx 配置', description: '公共配置与所选 server 块' },
];
