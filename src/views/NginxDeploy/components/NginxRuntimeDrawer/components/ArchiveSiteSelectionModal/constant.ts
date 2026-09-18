import type { NginxArchiveDownloadType, NginxArchiveSiteOption } from '@/api/deploy';

/** 归档选择窗口属性。 */
export interface ArchiveSiteSelectionModalProps {
  open: boolean;
  loading: boolean;
  downloading: boolean;
  type: NginxArchiveDownloadType;
  configPath: string;
  sites: NginxArchiveSiteOption[];
  isManagedInstance?: boolean;
}

/** 归档类型展示配置。 */
export interface ArchiveTypeOption {
  value: NginxArchiveDownloadType;
  index: string;
  label: string;
  description: string;
  badge: string;
}

/** 托管实例归档类型选项。 */
export const MANAGED_ARCHIVE_TYPE_OPTIONS: ArchiveTypeOption[] = [
  { value: 'all', index: '01', label: '完整运行包', description: '运行文件、项目产物与裁剪配置', badge: '推荐' },
  { value: 'html', index: '02', label: '静态产物', description: '仅包含所选项目的 root 目录', badge: '轻量' },
  { value: 'conf', index: '03', label: 'Nginx 配置', description: '公共配置与所选 server 块', badge: '配置' },
];

/** 已有实例导出类型选项。 */
export const EXTERNAL_ARCHIVE_TYPE_OPTIONS: ArchiveTypeOption[] = [
  { value: 'all', index: '01', label: '完整导出', description: '配置文件与所选站点静态资源', badge: '推荐' },
  { value: 'html', index: '02', label: '仅站点静态资源', description: '仅包含所选项目的 root 目录', badge: '轻量' },
  { value: 'conf', index: '03', label: '仅 Nginx 配置', description: '公共配置与所选 server 块', badge: '配置' },
];

/** 获取针对实例类型的归档选项配置。 */
export const getArchiveTypeOptions = (isManaged = true): ArchiveTypeOption[] => {
  return isManaged ? MANAGED_ARCHIVE_TYPE_OPTIONS : EXTERNAL_ARCHIVE_TYPE_OPTIONS;
};

/** 兼容旧版引用。 */
export const ARCHIVE_TYPE_OPTIONS = MANAGED_ARCHIVE_TYPE_OPTIONS;
