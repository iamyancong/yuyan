import type { YTableColumn } from '@yss-ui/components/lite';

/** 存量内嵌备份清理模式选项 */
export const INLINE_BACKUP_CLEAN_OPTIONS = [
  {
    label: '保留最新 1 份（已迁移外置仓的则全清内嵌）',
    value: 'keep_latest_1',
  },
  {
    label: '仅清理脱离发布记录的孤儿内嵌备份',
    value: 'purge_unreferenced',
  },
  {
    label: '清空全部旧内嵌 .yuyan-backups（彻底瘦身 html/）',
    value: 'purge_all',
  },
  {
    label: '暂不处理内嵌备份（仅执行策略裁剪与 CAS GC）',
    value: 'none',
  },
] as const;

/**
 * 格式化字节体积为可读文本。
 * @param bytes - 字节数
 * @returns 格式化文本（如 755.42 MB）
 */
export const formatStorageBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : value >= 100 ? 1 : 2)} ${units[idx]}`;
};

/** 存储诊断应用明细列配置 */
export const storageAppColumns: YTableColumn[] = [
  { field: 'displayName', title: '应用 / 目录', minWidth: 180, slots: { default: 'displayName' } },
  { field: 'managed', title: '纳管状态', width: 105, slots: { default: 'managed' } },
  {
    field: 'runtimeBytes',
    title: '纯运行态',
    width: 105,
    formatter: ({ cellValue }) => formatStorageBytes(Number(cellValue || 0)),
  },
  { field: 'inlineBackupBytes', title: '旧内嵌备份', width: 135, slots: { default: 'inlineBackupBytes' } },
  { field: 'externalBackupCount', title: '外置 CAS 快照', width: 140, slots: { default: 'externalBackupCount' } },
  {
    field: 'assetsBytes',
    title: 'assets 体积',
    width: 105,
    formatter: ({ cellValue }) => formatStorageBytes(Number(cellValue || 0)),
  },
  { field: 'stagingBytes', title: '残留暂存', width: 95, slots: { default: 'stagingBytes' } },
];
