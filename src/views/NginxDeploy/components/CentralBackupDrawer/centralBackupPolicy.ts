/**
 * 中央灾备纯逻辑策略与格式化函数（无 Vue 依赖，供 node --test 直接单测）。
 */

/** 默认远端备份目录 */
export const DEFAULT_BACKUP_REMOTE_DIR = '/bak/wangyancong-yuyan';

/** 禁止落盘的系统关键目录 */
const FORBIDDEN_SYSTEM_ROOTS = [
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/run',
  '/var/run',
];

/**
 * 映射备份执行状态为 Ant Design Tag 颜色与展示文案。
 * @param status 最近状态
 * @param running 是否正在执行
 */
export function resolveBackupStatusTag(
  status: string | undefined | null,
  running = false
): { color: 'processing' | 'success' | 'error' | 'default'; text: string } {
  if (running || status === 'running') {
    return { color: 'processing', text: '执行中' };
  }
  if (status === 'success') {
    return { color: 'success', text: '成功' };
  }
  if (status === 'failed') {
    return { color: 'error', text: '失败' };
  }
  return { color: 'default', text: '尚未执行' };
}

/**
 * 将字节数格式化为人类可读的文件大小。
 * @param bytes 字节数
 */
export function formatBackupSize(bytes: number | undefined | null): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.floor(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 截断展示 SHA-256 摘要。
 * @param sha256 64 位摘要
 * @param length 保留前导字符数
 */
export function truncateSha256(sha256: string | undefined | null, length = 12): string {
  const clean = String(sha256 || '').trim();
  if (!clean) return '-';
  if (clean.length <= length) return clean;
  return `${clean.slice(0, length)}…`;
}

/**
 * 证书到期分级结果
 */
export interface CertExpiryClassification {
  status: 'expired' | 'expiring' | 'valid' | 'unknown';
  color: 'error' | 'warning' | 'success' | 'default';
  label: string;
  daysRemaining: number | null;
}

/**
 * 按到期时间分级：已过期标红，30 天内到期标橙，30 天以上标绿，未知标灰。
 * @param notAfter ISO 时间字符串或 null
 * @param now 当前时间戳（毫秒）
 */
export function classifyCertExpiry(notAfter: string | null | undefined, now = Date.now()): CertExpiryClassification {
  if (!notAfter) {
    return { status: 'unknown', color: 'default', label: '未获取到到期时间', daysRemaining: null };
  }
  const expiresAt = Date.parse(notAfter);
  if (!Number.isFinite(expiresAt)) {
    return { status: 'unknown', color: 'default', label: '到期时间无效', daysRemaining: null };
  }
  const diffMs = expiresAt - now;
  const daysRemaining = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffMs <= 0) {
    return { status: 'expired', color: 'error', label: '已过期', daysRemaining };
  }
  if (daysRemaining <= 30) {
    return { status: 'expiring', color: 'warning', label: `剩余 ${daysRemaining} 天`, daysRemaining };
  }
  return { status: 'valid', color: 'success', label: `剩余 ${daysRemaining} 天`, daysRemaining };
}

/**
 * 解析当前角色在中央灾备抽屉中的操作权限。
 * @param role 用户角色
 */
export function resolveCentralBackupPermissions(role: string | undefined | null): {
  canEditSettings: boolean;
  canTriggerBackup: boolean;
  canTriggerPatrol: boolean;
  readonlyReason: string;
} {
  const normalized = String(role || '').trim();
  const isViewer = normalized === 'viewer';
  return {
    canEditSettings: normalized === 'admin',
    canTriggerBackup: !isViewer,
    canTriggerPatrol: !isViewer,
    readonlyReason: isViewer ? '只读账号不能触发备份' : '',
  };
}

/**
 * 前端校验远端备份目录（与后端 `normalizeBackupRemoteDir` 保持完全一致）。
 * @param input 用户输入的目录
 */
export function validateBackupRemoteDirClient(input: string): { valid: boolean; normalized: string; error: string } {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) {
    return { valid: false, normalized: '', error: '请输入远端备份目录' };
  }
  if (!trimmed.startsWith('/')) {
    return { valid: false, normalized: '', error: '必须使用以 / 开头的绝对路径' };
  }
  if (trimmed.includes('//')) {
    return { valid: false, normalized: '', error: '不能包含连续斜杠 //' };
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(trimmed)) {
    return { valid: false, normalized: '', error: '仅允许字母、数字、点、下划线、连字符与 /，禁止空白与特殊符号' };
  }
  const segments = trimmed.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.some((seg) => seg === '.' || seg === '..')) {
    return { valid: false, normalized: '', error: '不能包含 . 或 .. 路径段' };
  }
  const normalized = `/${segments.join('/')}`;
  if (!segments.length || normalized === '/') {
    return { valid: false, normalized: '', error: '不能使用根目录 /' };
  }
  if (segments.length < 2) {
    return { valid: false, normalized: '', error: '至少需要两级目录（例如 /bak/wangyancong-yuyan）' };
  }
  if (normalized === '/root') {
    return { valid: false, normalized: '', error: '不能直接放在 /root 目录' };
  }
  for (const forbidden of FORBIDDEN_SYSTEM_ROOTS) {
    if (normalized === forbidden || normalized.startsWith(`${forbidden}/`)) {
      return { valid: false, normalized: '', error: `不能位于系统目录 ${forbidden} 下` };
    }
  }
  return { valid: true, normalized, error: '' };
}

/**
 * 将 ISO 时间格式化为本地可读时间 `YYYY-MM-DD HH:mm:ss`。
 * @param iso ISO 时间字符串
 */
export function formatBackupDateTime(iso: string | undefined | null): string {
  if (!iso) return '-';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '-';
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 格式化执行耗时：小于 1 秒显示 `xxx ms`，否则显示 `x.x 秒`。
 * @param ms 耗时毫秒数
 */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === null || ms === undefined || ms === ('' as unknown as number)) return '-';
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} 秒`;
}

/**
 * 格式化触发方式与操作人摘要，如「手动 · alice」。
 * @param trigger 触发类型
 * @param operator 操作人
 */
export function formatBackupRunContext(trigger: string | undefined | null, operator: string | undefined | null): string {
  const triggerLabel =
    trigger === 'manual' ? '手动' : trigger === 'schedule' ? '定时' : String(trigger || '').trim();
  const op = String(operator || '').trim();
  if (triggerLabel && op) return `${triggerLabel} · ${op}`;
  return triggerLabel || op;
}
