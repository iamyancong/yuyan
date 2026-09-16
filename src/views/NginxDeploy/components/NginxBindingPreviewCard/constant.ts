import type { DeployServer, NginxInstance } from '@/api/deploy';

/** 绑定预览卡片信息快照 */
export interface BindingPreviewSnapshot {
  /** 服务器名称 */
  serverName: string;
  /** 服务器主机或 IP */
  serverHost: string;
  /** 服务器展示名称与 IP 组合 */
  serverDisplay: string;
  /** 实例名称 */
  instanceName: string;
  /** 实例版本 */
  instanceVersion: string;
  /** 实例名称与版本组合 */
  instanceDisplay: string;
  /** 实例类型 */
  instanceType: 'managed' | 'external' | '';
  /** 实例类型展示标签 */
  instanceTypeLabel: string;
  /** 实例类型标签颜色 */
  instanceTypeColor: string;
  /** 实例运行状态文案 */
  statusLabel: string;
  /** 实例运行状态圆点颜色 */
  statusColor: string;
  /** 默认静态根目录 */
  defaultRoot: string;
  /** 预期配置文件路径 */
  confPath: string;
  /** 站点路由简要表达 */
  routeSummary: string;
  /** 浮层详细解释 */
  tooltipText: string;
  /** 是否具备完整上下文展示卡片 */
  isComplete: boolean;
}

/**
 * 计算绑定预览卡片的数据快照。
 * @param server 关联服务器
 * @param instance 关联 Nginx 实例
 * @param domain 配置域名
 * @param port 监听端口
 * @param deployRoot 部署根目录
 * @returns 绑定快照
 */
export function resolveBindingPreviewInfo(
  server?: DeployServer | null,
  instance?: NginxInstance | null,
  domain?: string,
  port?: number | string,
  deployRoot?: string
): BindingPreviewSnapshot {
  if (!server || !instance) {
    return {
      serverName: '—',
      serverHost: '',
      serverDisplay: '—',
      instanceName: '—',
      instanceVersion: '',
      instanceDisplay: '—',
      instanceType: '',
      instanceTypeLabel: '',
      instanceTypeColor: 'default',
      statusLabel: '未就绪',
      statusColor: '#8c8c8c',
      defaultRoot: '—',
      confPath: '—',
      routeSummary: '—',
      tooltipText: '',
      isComplete: false,
    };
  }

  const serverName = server.name || '未知服务器';
  const serverHost = server.host || '';
  const serverDisplay = serverHost ? `${serverName} (${serverHost})` : serverName;

  const isManaged = instance.instanceType === 'managed';
  const instanceTypeLabel = isManaged ? '平台托管' : '已有外部';
  const instanceTypeColor = isManaged ? 'blue' : 'purple';
  const instanceName = instance.name || (isManaged ? 'yuyan托管' : '外部实例');
  const instanceVersion = instance.runtimeVersion ? `v${instance.runtimeVersion}` : '';
  const instanceDisplay = instanceVersion ? `${instanceName} · ${instanceVersion}` : instanceName;

  const isRunning = instance.status === 'running';
  const statusLabel = isRunning
    ? '运行中'
    : instance.status === 'stopped'
      ? '已停止'
      : instance.status === 'error'
        ? '异常'
        : '未就绪';
  const statusColor = isRunning
    ? '#52c41a'
    : instance.status === 'stopped'
      ? '#faad14'
      : instance.status === 'error'
        ? '#ff4d4f'
        : '#8c8c8c';

  const defaultRoot = instance.htmlRoot || instance.defaultDeployRoot || server.defaultDeployRoot || '/opt/yuyan/html';
  const resolvedRoot = deployRoot || defaultRoot;
  const confPath = instance.defaultNginxConfPath || server.defaultNginxConfPath || (isManaged ? `${instance.baseRoot || '/opt/yuyan'}/nginx/conf/conf.d/*.conf` : '/etc/nginx/conf.d/*.conf');

  const domainText = domain && domain.trim() && domain !== '_' ? domain.trim() : '未填域名';
  const portText = port ? `:${port}` : '';
  const routeSummary = `${domainText} → ${resolvedRoot}${portText}`;

  const tooltipText = `该目标将通过【${serverName}】上的 Nginx 实例【${instanceName}】（${instanceTypeLabel} · ${statusLabel}）进行静态代理。发布时自动在该实例下生成站点配置与路由。`;

  return {
    serverName,
    serverHost,
    serverDisplay,
    instanceName,
    instanceVersion,
    instanceDisplay,
    instanceType: instance.instanceType,
    instanceTypeLabel,
    instanceTypeColor,
    statusLabel,
    statusColor,
    defaultRoot,
    confPath,
    routeSummary,
    tooltipText,
    isComplete: true,
  };
}
