import type { DeployTarget } from '@/api/deploy';
import { formatSummaryPortMismatchHint, getVisitUrlPortMismatch } from '../../hooks/visitUrlPortPolicy.ts';

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
  /** 监听端口 */
  listenPort?: number;
  /** 是否可以直接打开访问 */
  isAccessible: boolean;
  /** 访问地址 */
  visitUrl: string;
  /** 是否存在可展示的门户站点配置 */
  showSiteConfig: boolean;
  /** 是否存在可展示的部署路径 */
  showDeploymentPath: boolean;
  /** 访问地址端口与监听端口不一致时的提示；一致、未记录监听端口或无法比较时为空 */
  portMismatchHint: string;
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
      showSiteConfig: false,
      showDeploymentPath: false,
      portMismatchHint: '',
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
      showSiteConfig: false,
      showDeploymentPath: Boolean(target.deployRoot?.trim()),
      portMismatchHint: '',
    };
  }

  const hasDomain = Boolean(String(target.nginxServerName || '').trim() && target.nginxServerName !== '_');
  const hasPort = Boolean(target.listenPort);
  const isAccessible = Boolean(target.visitUrl && target.visitUrl.trim());
  // 仅门户站点配置或明确填写域名时展示域名/就绪状态，避免微应用的历史访问地址触发虚假提示。
  const showSiteConfig = Boolean(target.nginxSiteManaged || hasDomain);
  const showDeploymentPath = Boolean(target.deployRoot?.trim());
  const domainText = hasDomain ? String(target.nginxServerName).trim() : '未填域名';
  const listenPort = target.listenPort ? Number(target.listenPort) : undefined;
  const portSuffix = listenPort ? `:${listenPort}` : '';
  const destinationText = `${target.deployRoot || '未设路径'}${portSuffix}`;
  const instanceTypeLabel = target.nginxInstanceType === 'managed' ? '托管' : target.nginxInstanceType === 'external' ? '已有' : '';
  const rawInstanceName = target.nginxInstanceName || (target.nginxInstanceId ? `实例 #${target.nginxInstanceId}` : '');
  const matchedPort = listenPort ? rawInstanceName.match(/^(.*\S)\s+:(\d+)$/) : null;
  const instanceName = matchedPort && Number(matchedPort[2]) === listenPort ? matchedPort[1] : rawInstanceName;
  // 列表仍以监听端口为准；只有记录了监听端口且和访问地址端口对不上时才给轻量提示，
  // 未记录监听端口的历史目标（多为已有实例下的微应用）不提示，避免满屏标记。
  // 已记录为微应用且非平台托管站点的目标，portMismatchHint 置空（与编辑表单一致，不再提示同步端口）。
  const isMicroWithoutManagedSite = target.applicationKind === 'micro' && !target.nginxSiteManaged;
  const portMismatch = (!isMicroWithoutManagedSite && listenPort) ? getVisitUrlPortMismatch(target.visitUrl, listenPort) : null;
  const portMismatchHint = portMismatch ? formatSummaryPortMismatchHint(portMismatch) : '';

  // 2. 可访问优先判定：只看 visitUrl 是否有效，彻底解耦端口和域名要求
  if (isAccessible) {
    return {
      status: 'accessible',
      statusLabel: '可访问',
      statusColor: 'success',
      domainText,
      destinationText,
      instanceName,
      instanceTypeLabel,
      listenPort,
      isAccessible: true,
      visitUrl: String(target.visitUrl).trim(),
      showSiteConfig,
      showDeploymentPath,
      portMismatchHint,
    };
  }

  // 3. 配置未完整：未配置访问地址且缺少域名或端口
  if (!hasDomain || !hasPort) {
    return {
      status: 'incomplete',
      statusLabel: '配置未完整',
      statusColor: 'warning',
      domainText,
      destinationText,
      instanceName,
      instanceTypeLabel,
      listenPort,
      isAccessible: false,
      visitUrl: '',
      showSiteConfig,
      showDeploymentPath,
      portMismatchHint,
    };
  }

  // 4. 配置完整待发布
  return {
    status: 'ready',
    statusLabel: '待发布',
    statusColor: 'processing',
    domainText,
    destinationText,
    instanceName,
    instanceTypeLabel,
    listenPort,
    isAccessible: false,
    visitUrl: '',
    showSiteConfig,
    showDeploymentPath,
    portMismatchHint,
  };
}
