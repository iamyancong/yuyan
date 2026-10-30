import type {
  NginxDiscoveryRoot,
  NginxDiscoveryRuntime,
  NginxDiscoverySite,
  NginxInstancePayload,
} from '@/api/deploy';

/** 智能发现站点选择结果。 */
export interface ExistingNginxSelection {
  key: string;
  runtimeId: string;
  siteId: string;
  rootPath: string;
  formPatch: Partial<NginxInstancePayload>;
}

/**
 * 获取站点建议使用的前端根目录。
 * @param site Nginx server 站点
 * @returns 优先包含 index.html、其次存在、最后首个配置 root
 */
export function getPreferredDiscoveryRoot(site: NginxDiscoverySite): NginxDiscoveryRoot | null {
  return site.roots.find((root) => root.hasIndexHtml)
    || site.roots.find((root) => root.exists)
    || site.roots[0]
    || null;
}

/**
 * 生成发现站点的实例名称。
 * @description 统一以「已有」开头，并带上域名或安装目录 + 端口，避免同一服务器上多个「已有 Nginx N」无法区分（#47）。
 * @param site Nginx server 站点
 * @param runtime 可选的物理 Nginx 运行实例（用于取安装目录）
 * @returns 实例名称建议
 */
export function createDiscoveredInstanceName(site: NginxDiscoverySite, runtime?: Pick<NginxDiscoveryRuntime, 'prefix'> | null): string {
  const serverName = site.serverNames.find((name) => name
    && name !== '_'
    && !name.includes('$')
    && !name.includes('_')
    && !/[~*]/.test(name));
  if (serverName) return `已有 ${serverName}`;
  const port = site.listenPorts[0];
  const prefix = String(runtime?.prefix || '').replace(/\/+$/, '');
  if (prefix) return port ? `已有 ${prefix} :${port}` : `已有 ${prefix}`;
  return port ? `已有 Nginx :${port}` : '已有 Nginx';
}

/**
 * 将运行实例与站点选择转换为现有接入表单字段。
 * @param runtime 物理 Nginx 运行实例
 * @param site server 站点
 * @param root 选中的前端根目录
 * @param serverUseSudo 可选的服务器 sudo 状态
 * @returns 选择状态与表单补丁
 */
export function createExistingNginxSelection(
  runtime: NginxDiscoveryRuntime,
  site: NginxDiscoverySite,
  root: NginxDiscoveryRoot,
  serverUseSudo?: boolean,
): ExistingNginxSelection {
  const port = site.listenPorts[0] ?? 80;
  return {
    key: `${runtime.id}:${site.id}:${root.path}`,
    runtimeId: runtime.id,
    siteId: site.id,
    rootPath: root.path,
    formPatch: {
      name: createDiscoveredInstanceName(site, runtime),
      instanceType: 'external',
      runtimeFingerprint: runtime.runtimeFingerprint,
      defaultDeployRoot: root.path,
      defaultNginxConfPath: site.configPath || runtime.mainConfigPath,
      nginxWorkDir: runtime.nginxWorkDir,
      nginxTestCommand: runtime.nginxTestCommand,
      nginxReloadCommand: runtime.nginxReloadCommand,
      baseRoot: '',
      portStart: port,
      useSudo: runtime.useSudo || Boolean(serverUseSudo),
    },
  };
}
