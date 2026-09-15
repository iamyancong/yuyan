import type { DeployTarget } from '@/api/deploy';

/** 站点就绪状态类型 */
export type TargetSiteStatus = 'unlinked' | 'incomplete' | 'accessible' | 'ready';

/** 站点摘要元数据快照 */
export interface TargetSiteMeta {
  /** 站点状态 */
  status: TargetSiteStatus;
  /** 状态展示文案 */
  statusLabel: string;
  /** 状态颜色映射 */
  statusColor: 'default' | 'success' | 'processing' | 'error' | 'warning';
  /** 域名或替代文本 */
  domainText: string;
  /** 目标路径与端口显示文本 */
  destinationText: string;
  /** 关联实例名称 */
  instanceName: string;
  /** 关联实例类型展示文案 */
  instanceTypeLabel: string;
  /** 是否可以直接打开访问 */
  isAccessible: boolean;
  /** 访问地址 */
  visitUrl: string;
}

/**
 * 计算前端部署目标的站点摘要与就绪状态。
 * @param target 部署目标对象
 * @returns 站点摘要快照
 */
export function getSiteReadinessStatus(target?: DeployTarget | null): TargetSiteMeta {
  if (!target) {
    return {
      status: 'unlinked',
      statusLabel: '未关联实例',
      statusColor: 'error',
      domainText: '—',
      destinationText: '—',
      instanceName: '',
      instanceTypeLabel: '',
      isAccessible: false,
      visitUrl: '',
    };
  }

  // 1. 未关联实例
  if (!target.nginxInstanceId) {
    return {
      status: 'unlinked',
      statusLabel: '未关联实例',
      statusColor: 'error',
      domainText: target.nginxServerName && target.nginxServerName !== '_' ? target.nginxServerName : '未填域名',
      destinationText: target.deployRoot || '未设路径',
      instanceName: '',
      instanceTypeLabel: '',
      isAccessible: false,
      visitUrl: '',
    };
  }

  const hasDomain = Boolean(String(target.nginxServerName || '').trim() && target.nginxServerName !== '_');
  const hasPort = Boolean(target.listenPort);
  const domainText = hasDomain ? String(target.nginxServerName).trim() : '未填域名';
  const portSuffix = hasPort ? `:${target.listenPort}` : '';
  const destinationText = `${target.deployRoot || '未设路径'}${portSuffix}`;
  const instanceTypeLabel = target.nginxInstanceType === 'managed' ? '托管' : target.nginxInstanceType === 'external' ? '已有' : '';

  // 2. 配置未完整（缺少域名或端口）
  if (!hasDomain || !hasPort) {
    return {
      status: 'incomplete',
      statusLabel: '配置未完整',
      statusColor: 'warning',
      domainText,
      destinationText,
      instanceName: target.nginxInstanceName || `实例 #${target.nginxInstanceId}`,
      instanceTypeLabel,
      isAccessible: false,
      visitUrl: '',
    };
  }

  // 3. 可访问（存在有效 visitUrl 且配置完整）
  if (target.visitUrl && target.visitUrl.trim()) {
    return {
      status: 'accessible',
      statusLabel: '可访问',
      statusColor: 'success',
      domainText,
      destinationText,
      instanceName: target.nginxInstanceName || `实例 #${target.nginxInstanceId}`,
      instanceTypeLabel,
      isAccessible: true,
      visitUrl: target.visitUrl.trim(),
    };
  }

  // 4. 配置完整待发布
  return {
    status: 'ready',
    statusLabel: '待发布',
    statusColor: 'processing',
    domainText,
    destinationText,
    instanceName: target.nginxInstanceName || `实例 #${target.nginxInstanceId}`,
    instanceTypeLabel,
    isAccessible: false,
    visitUrl: '',
  };
}
