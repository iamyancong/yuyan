/**
 * Nginx 配置历史版本、下载与保存失败提示的纯函数（不依赖 Vue，便于 node --test 直接运行）。
 */
import type { NginxConfHistoryItem } from '@/api/deploy';

/** 北京时间偏移（毫秒） */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 补零 */
const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * 把 ISO 时间格式化为北京时间 `YYYY-MM-DD HH:mm:ss`。
 * @param iso ISO 时间
 * @returns 北京时间文本，非法时返回空串
 */
export function formatBeijingTime(iso: string): string {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

/**
 * 北京时间短格式 `MM-DD HH:mm`，用于标题与提示。
 * @param iso ISO 时间
 * @returns 短格式文本
 */
export function formatBeijingShort(iso: string): string {
  const full = formatBeijingTime(iso);
  return full ? full.slice(5, 16) : '';
}

/**
 * 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前）。
 * @param iso ISO 时间
 * @param now 当前时间戳
 * @returns 相对时间文本
 */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, now - time);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前`;
  return `${Math.floor(diff / (365 * day))} 年前`;
}

/**
 * 字节数格式化。
 * @param size 字节数
 * @returns 例如 `812 B`、`12.4 KB`
 */
export function formatFileSize(size: number): string {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 历史条目的展示时间：平台备份用文件名里的 UTC 时间，外部备份用修改时间。
 * @param item 历史条目
 * @returns ISO 时间
 */
export function resolveHistoryItemTime(item: Pick<NginxConfHistoryItem, 'createdAt' | 'mtime'>): string {
  return item.createdAt || item.mtime || '';
}

/**
 * 历史条目的标题，如 `11-12 16:30 的版本`；外部备份没有时间时用文件名。
 * @param item 历史条目
 * @returns 标题
 */
export function describeHistoryItem(item: Pick<NginxConfHistoryItem, 'createdAt' | 'mtime' | 'name' | 'source'>): string {
  const time = formatBeijingShort(resolveHistoryItemTime(item));
  if (item.source === 'external') return time ? `外部备份 ${item.name}（修改于 ${time}）` : `外部备份 ${item.name}`;
  return `${time} 的版本`;
}

/**
 * 从配置路径取文件名（兼容 Windows 分隔符），失败时回退 nginx.conf。
 * @param configPath 配置路径
 * @returns 文件名
 */
export function resolveConfigFileName(configPath: string): string {
  const name = String(configPath || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return sanitizeDownloadName(name) || 'nginx.conf';
}

/**
 * 清理下载文件名中的非法字符。
 * @param name 文件名
 * @returns 安全文件名
 */
export function sanitizeDownloadName(name: string): string {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '')
    .slice(0, 200);
}

/**
 * 「编辑中」版本的下载文件名：在扩展名前插入 `.editing`（nginx.conf → nginx.editing.conf）。
 * @param fileName 原文件名
 * @returns 新文件名
 */
export function buildEditingFileName(fileName: string): string {
  const safe = sanitizeDownloadName(fileName) || 'nginx.conf';
  const dot = safe.lastIndexOf('.');
  if (dot <= 0) return `${safe}.editing`;
  return `${safe.slice(0, dot)}.editing${safe.slice(dot)}`;
}

/** 保存失败的分类提示 */
export interface NginxSaveFailureInfo {
  /** test：校验失败已还原；reload：重载失败已回滚；rollback-failed：回滚失败；conflict：线上已被修改；other：其他 */
  kind: 'test' | 'reload' | 'rollback-failed' | 'conflict' | 'other';
  /** 标题 */
  headline: string;
  /** 补充说明 */
  detail: string;
  /** 备份文件路径（回滚失败时用于手动恢复） */
  backupPath: string;
  /** 是否为严重错误（红色强提示） */
  severe: boolean;
}

/**
 * 解析后端保存错误的阶段信息，生成分阶段提示（#43 P1-2）。
 * @param error axios 错误或后端返回体
 * @returns 分类提示
 */
export function describeSaveFailure(error: any): NginxSaveFailureInfo {
  const data = error?.response?.data || {};
  const code = String(data.code || error?.apiCode || error?.code || '');
  const details = (data.details && typeof data.details === 'object' ? data.details : null) as Record<string, any> | null;
  const status = Number(error?.response?.status || error?.status || 0);
  if (code === 'NGINX_CONF_CHANGED' || status === 409) {
    return { kind: 'conflict', headline: '线上配置已被他人修改', detail: '请先查看差异再决定是否覆盖', backupPath: '', severe: false };
  }
  const backupPath = String(details?.backupPath || '');
  if (details && details.rolledBack === false) {
    return {
      kind: 'rollback-failed',
      headline: details.stage === 'reload' ? 'Nginx 重载失败，且自动回滚失败' : '语法校验未通过，且自动还原失败',
      detail: backupPath
        ? `服务器上可能是新配置但尚未生效，请尽快手动恢复：cp ${backupPath} 到原配置文件${details.rollbackError ? `（回滚失败原因：${String(details.rollbackError)}）` : ''}`
        : `服务器上可能是新配置但尚未生效：${String(details.rollbackError || '没有可用于回滚的备份')}`,
      backupPath,
      severe: true,
    };
  }
  if (details?.stage === 'reload' || code === 'NGINX_RELOAD_FAILED') {
    const retestFailed = details && details.restoreTestOk === false;
    return {
      kind: 'reload',
      headline: '语法通过，但 Nginx 重载失败，已自动回滚到原配置，线上未受影响',
      detail: retestFailed ? '注意：回滚后再次执行 nginx -t 未通过，请检查服务器上其他配置文件' : '编辑器里保留了你的修改，修复端口、证书等环境问题后可以重新保存',
      backupPath,
      severe: Boolean(retestFailed),
    };
  }
  if (details?.stage === 'test' || code === 'NGINX_TEST_FAILED') {
    return {
      kind: 'test',
      headline: details?.unchanged ? '语法校验未通过，线上配置未变更' : '语法校验未通过，已还原，线上未变更',
      detail: '编辑器里保留了你的修改，按提示修正后重新保存',
      backupPath,
      severe: false,
    };
  }
  return { kind: 'other', headline: '', detail: '', backupPath: '', severe: false };
}

/**
 * 是否为只读角色（viewer）。本地模式角色为空，视为可写。
 * @param role 角色
 * @returns 是否只读
 */
export function isReadonlyNginxRole(role: string | null | undefined): boolean {
  return String(role || '').trim() === 'viewer';
}

/**
 * 计算底部提示：已从历史版本载入且仍有未保存修改时给出明确提示。
 * @param restoredLabel 已载入的历史版本描述（如 `11-12 16:30 的版本`）
 * @param isDirty 是否有未保存修改
 * @returns 提示文本，空串表示不覆盖默认提示
 */
export function resolveRestoreHint(restoredLabel: string, isDirty: boolean): string {
  if (!restoredLabel || !isDirty) return '';
  return `已载入 ${restoredLabel}，点击「保存并重载」后生效（仍会执行 nginx -t 校验，失败自动回滚）`;
}
