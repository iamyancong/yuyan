/**
 * 用户资料抽屉纯函数策略与格式化工具。
 * @description 无浏览器或框架依赖，便于在 Node 环境下直接单测。
 */

export interface GitlabProfileView {
  id: number | null;
  host: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string;
  createdAt: string;
  webUrl: string;
}

export interface GitlabFallbackUser {
  id?: number | null;
  username?: string;
  name?: string;
  avatar_url?: string;
  email?: string;
  created_at?: string;
  web_url?: string;
}

export interface RoleDisplayMeta {
  label: string;
  shortLabel: string;
  color: string;
  description: string;
}

export interface DeployStatusMeta {
  label: string;
  color: string;
}

export interface ProfileStatsInput {
  totalCount: number;
  successCount: number;
  failedCount: number;
  stoppedCount: number;
  runningCount: number;
  finishedCount: number;
  successRate: number | null;
}

/**
 * 合并服务端返回的 GitLab 资料与前端登录态缓存的 GitLab 用户信息，缺失字段优雅降级。
 */
export function mergeGitlabProfile(
  backendGitlab?: Partial<GitlabProfileView> | null,
  fallbackUser?: GitlabFallbackUser | null,
  fallbackHost = '',
): GitlabProfileView {
  const username = String(backendGitlab?.username || fallbackUser?.username || '').trim();
  const displayName = String(
    backendGitlab?.displayName || fallbackUser?.name || username || 'GitLab 用户',
  ).trim();
  const avatarUrl = String(backendGitlab?.avatarUrl || fallbackUser?.avatar_url || '').trim();
  const email = String(backendGitlab?.email || fallbackUser?.email || '').trim();
  const createdAt = String(backendGitlab?.createdAt || fallbackUser?.created_at || '').trim();
  const webUrl = String(backendGitlab?.webUrl || fallbackUser?.web_url || '').trim();
  const host = String(backendGitlab?.host || fallbackHost || '').trim();
  const rawId = backendGitlab?.id ?? fallbackUser?.id ?? null;
  const id = typeof rawId === 'number' && Number.isFinite(rawId) && rawId > 0 ? rawId : null;

  return {
    id,
    host,
    username,
    displayName,
    avatarUrl,
    email,
    createdAt,
    webUrl,
  };
}

/**
 * 格式化日期（用于 GitLab 加入日期），无效或缺失时返回「未知」。
 */
export function formatProfileDate(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '未知';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return '未知';
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 格式化时间（用于会话最近活跃时间与发布记录时间），无效或缺失时返回「时间未知」。
 */
export function formatProfileDateTime(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '时间未知';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return '时间未知';
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * 将工作区 RBAC 角色映射为中文标签、颜色与权限说明。
 */
export function resolveRoleDisplay(role?: string | null): RoleDisplayMeta {
  switch (String(role || '').trim().toLowerCase()) {
    case 'admin':
      return {
        label: '工作区管理员 (admin)',
        shortLabel: 'admin',
        color: 'purple',
        description: '可管理服务器、环境、托管 Nginx 与执行发布/删除操作',
      };
    case 'operator':
      return {
        label: '运维操作员 (operator)',
        shortLabel: 'operator',
        color: 'blue',
        description: '可执行发布、回滚、Nginx 站点同步等日常运维操作',
      };
    case 'viewer':
      return {
        label: '只读成员 (viewer)',
        shortLabel: 'viewer',
        color: 'default',
        description: '可查看服务器、部署目标、发布记录与个人资料',
      };
    default:
      return {
        label: '网页临时会话',
        shortLabel: 'web',
        color: 'default',
        description: '当前未绑定中央桌面工作区成员身份',
      };
  }
}

/**
 * 解析设备平台显示名称。
 */
export function resolvePlatformLabel(platform?: string | null): string {
  switch (String(platform || '').trim().toLowerCase()) {
    case 'macos':
    case 'darwin':
      return 'macOS';
    case 'windows':
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    default:
      return String(platform || '').trim() || '未知平台';
  }
}

/**
 * 判断某条活跃会话是否允许在界面上执行注销操作（禁止注销当前会话）。
 */
export function canRevokeSessionItem(session: { isCurrent?: boolean; status?: string } | null | undefined): boolean {
  if (!session) return false;
  return !session.isCurrent && session.status === 'active';
}

/**
 * 格式化近 30 天发布成功率，尚无已结束记录时返回 `--`。
 */
export function formatSuccessRate(stats?: Partial<ProfileStatsInput> | null): string {
  if (!stats || !Number(stats.finishedCount)) return '--';
  const rate = stats.successRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '--';
  const rounded = Math.round(rate * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/**
 * 解析发布记录状态展示样式。
 */
export function resolveDeployStatusMeta(status?: string | null): DeployStatusMeta {
  switch (String(status || '').trim().toLowerCase()) {
    case 'success':
      return { label: '成功', color: 'success' };
    case 'failed':
      return { label: '失败', color: 'error' };
    case 'stopped':
      return { label: '已停止', color: 'default' };
    case 'running':
      return { label: '进行中', color: 'processing' };
    default:
      return { label: String(status || '未知'), color: 'default' };
  }
}

/**
 * 解析发布动作中文名。
 */
export function resolveDeployActionLabel(action?: string | null): string {
  switch (String(action || '').trim()) {
    case 'rollback':
      return '回滚';
    case 'undoRollback':
      return '撤销回滚';
    default:
      return '发布';
  }
}

/**
 * 缩略展示设备 ID，保留首尾便于排查。
 */
export function shortenDeviceId(deviceId?: string | null): string {
  const raw = String(deviceId || '').trim();
  if (!raw) return '';
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
}
