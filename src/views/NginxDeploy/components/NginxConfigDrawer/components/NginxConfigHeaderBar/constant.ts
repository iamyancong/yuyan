import type { DeployTarget } from '@/api/deploy';

export type { DeployTarget };

/** 站点配置顶栏元数据 */
export interface ConfigHeaderBarMeta {
  /** 服务器名称 */
  serverName: string;
  /** 服务器主机/IP */
  serverHost: string;
  /** 实例标识文案 */
  instanceName: string;
  /** 实例类型 */
  instanceType: 'managed' | 'external';
  /** 实例类型标签 */
  instanceTypeLabel: string;
  /** 域名或替代文本 */
  domainText: string;
  /** 监听端口文本 */
  listenPort: string;
  /** 部署根目录 */
  deployRoot: string;
  /** 目标路由映射描述 */
  routeMapping: string;
  /** 完整配置文件路径 */
  configPathDisplay: string;
  /** 配置文件所在目录 */
  configDir: string;
  /** 配置文件名 */
  configFileName: string;
  /** 访问地址 */
  visitUrl?: string;
  /** 站点运行状态标签 */
  statusLabel: string;
  /** SSL 状态文案 */
  sslLabel: string;
  /** SSL 状态提示 */
  sslTip: string;
}

/**
 * 解析文件路径的文件名与目录前缀
 * @param fullPath 完整文件路径
 * @returns 目录与文件名对象
 */
export function splitFilePath(fullPath?: string): { dir: string; fileName: string } {
  if (!fullPath || fullPath === '—' || fullPath.includes('未选择') || fullPath.includes('自动推导')) {
    return { dir: '', fileName: fullPath || '未选择配置' };
  }
  const normalized = fullPath.replace(/\\/g, '/');
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return { dir: '', fileName: normalized };
  }
  return {
    dir: normalized.slice(0, lastSlashIndex + 1),
    fileName: normalized.slice(lastSlashIndex + 1),
  };
}

/**
 * 计算站点配置抽屉顶栏展示数据。
 * @param target 部署目标
 * @param currentConfigPath 当前编辑器加载的配置文件路径
 * @returns 顶栏元数据
 */
export function resolveConfigHeaderBarMeta(
  target?: DeployTarget | null,
  currentConfigPath?: string
): ConfigHeaderBarMeta {
  if (!target) {
    const rawPath = currentConfigPath || '未选择配置';
    const { dir, fileName } = splitFilePath(rawPath);
    return {
      serverName: '未知服务器',
      serverHost: '',
      instanceName: '未绑定实例',
      instanceType: 'external',
      instanceTypeLabel: '未绑定',
      domainText: '—',
      listenPort: '',
      deployRoot: '—',
      routeMapping: '—',
      configPathDisplay: rawPath,
      configDir: dir,
      configFileName: fileName,
      statusLabel: '未就绪',
      sslLabel: '未配置',
      sslTip: '当前部署目标尚未绑定生效的 Nginx 实例',
    };
  }

  const domain = target.nginxServerName && target.nginxServerName !== '_' ? target.nginxServerName : '未填域名';
  const listenPort = target.listenPort ? String(target.listenPort) : '';
  const portSuffix = listenPort ? `:${listenPort}` : '';
  const deployRoot = target.deployRoot || '未设根目录';
  const routeMapping = `${deployRoot}${portSuffix}`;
  const isManaged = target.nginxInstanceType === 'managed';
  const instanceType: 'managed' | 'external' = isManaged ? 'managed' : 'external';
  const instanceTypeLabel = isManaged ? '托管' : '已有';
  const serverName = target.serverName || '未知服务器';
  const serverHost = target.serverHost || '';
  const instanceName = target.nginxInstanceName || '默认实例';
  const configPathDisplay = currentConfigPath || target.nginxConfPath || '自动推导配置';
  const { dir: configDir, fileName: configFileName } = splitFilePath(configPathDisplay);

  return {
    serverName,
    serverHost,
    instanceName,
    instanceType,
    instanceTypeLabel,
    domainText: domain,
    listenPort,
    deployRoot,
    routeMapping,
    configPathDisplay,
    configDir,
    configFileName,
    visitUrl: target.visitUrl,
    statusLabel: '已启用',
    sslLabel: '未配置 SSL',
    sslTip: '当前站点未启用 SSL 证书（自动证书申请与托管功能规划中）',
  };
}
