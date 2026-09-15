import type { DeployTarget } from '@/api/deploy';

/** 站点配置顶栏元数据 */
export interface ConfigHeaderBarMeta {
  /** 域名或替代文本 */
  domainText: string;
  /** 目标路由映射 */
  routeMapping: string;
  /** 实例标识文案 */
  instanceText: string;
  /** 实例类型标签 */
  instanceTypeLabel: string;
  /** 配置文件路径 */
  configPathDisplay: string;
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
    return {
      domainText: '—',
      routeMapping: '—',
      instanceText: '—',
      instanceTypeLabel: '',
      configPathDisplay: currentConfigPath || '未选择配置',
    };
  }

  const domain = target.nginxServerName && target.nginxServerName !== '_' ? target.nginxServerName : '未填域名';
  const port = target.listenPort ? `:${target.listenPort}` : '';
  const routeMapping = `${target.deployRoot || '未设根目录'}${port}`;
  const instanceTypeLabel = target.nginxInstanceType === 'managed' ? '托管' : '已有';
  const instanceText = `${target.serverName || '未知服务器'} · ${target.nginxInstanceName || '默认实例'}`;
  const configPathDisplay = currentConfigPath || target.nginxConfPath || '自动推导配置';

  return {
    domainText: domain,
    routeMapping,
    instanceText,
    instanceTypeLabel,
    configPathDisplay,
  };
}
