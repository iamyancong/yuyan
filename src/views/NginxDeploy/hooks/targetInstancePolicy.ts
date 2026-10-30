import type { DeployTarget } from '@/api/deploy';

/** 部署目标中与 Nginx 实例相关的字段。 */
type TargetInstanceFields = Pick<DeployTarget, 'projectType' | 'serverId' | 'nginxInstanceId' | 'nginxInstanceName' | 'nginxInstanceType' | 'listenPort'> & {
  serverName?: string;
  serverHost?: string;
};

/** Nginx 实例筛选项。 */
export interface NginxInstanceFilterOption {
  /** 下拉展示的完整文案（单行纯文本或自定义渲染节点） */
  label: any;
  value: number;
  serverId: number;
  /** 悬浮显示的全文（与 label 一致，文字过长被省略时可看到） */
  title: string;
  /** 实例名称（含类型标签，如 `[已有] 已有 Nginx`），用于两行下拉标题与选中回显 */
  instanceTitle?: string;
  /** 实例位置信息（如 `192.168.165.13:9999` 或 `测试服 192.168.165.60:8082/8083`），用于两行下拉第二行 */
  description?: string;
}

/**
 * 获取实例类型短标签。
 * @param type 实例类型
 * @returns 「托管」/「已有」
 */
export function getNginxInstanceTypeLabel(type?: string | null): string {
  return type === 'managed' ? '托管' : '已有';
}

/**
 * 实例名末尾已带端口（如「已有 /report :80」）时去掉，端口统一放到地址里展示，避免重复。
 * @param name 实例名
 * @param ports 该实例对应的端口
 * @returns 去掉重复端口后的实例名
 */
export function stripInstanceNamePort(name: string, ports: number[]): string {
  const text = String(name || '').trim();
  const matched = text.match(/^(.*\S)\s+:(\d+)$/);
  if (matched && ports.includes(Number(matched[2]))) return matched[1];
  return text;
}

/**
 * 拼接「IP:端口」，同一实例多个端口时用 / 连接，例如 `192.168.165.60:8082/8083`。
 * @param host 服务器 IP / 域名
 * @param ports 端口列表
 * @returns 地址文本
 */
export function formatInstanceEndpoint(host: string | undefined, ports: number[]): string {
  const portText = ports.filter((port) => port > 0).join('/');
  const hostText = String(host || '').trim();
  if (hostText && portText) return `${hostText}:${portText}`;
  if (portText) return `:${portText}`;
  return hostText;
}

/**
 * 根据当前目标列表生成「Nginx 实例」筛选项；选中服务器后只列出该服务器的实例。
 * @description 每项显示 `[类型] 实例名 · IP:端口`；选项来自多台服务器时在地址前加服务器名，便于区分。
 * @param targets 全量部署目标
 * @param serverId 当前选中的服务器
 * @returns 实例筛选项
 */
export function createNginxInstanceFilterOptions(targets: Array<Partial<TargetInstanceFields>>, serverId?: number | null): NginxInstanceFilterOption[] {
  const selectedServerId = Number(serverId || 0);
  const groups = new Map<number, { target: Partial<TargetInstanceFields>; ports: number[] }>();
  targets.forEach((target) => {
    const instanceId = Number(target.nginxInstanceId || 0);
    if (!instanceId || target.projectType === 'backend') return;
    if (selectedServerId && Number(target.serverId || 0) !== selectedServerId) return;
    const group = groups.get(instanceId) || { target, ports: [] };
    const port = Number(target.listenPort || 0);
    if (port && !group.ports.includes(port)) group.ports.push(port);
    groups.set(instanceId, group);
  });
  const serverCount = new Set(Array.from(groups.values()).map((group) => Number(group.target.serverId || 0))).size;
  return Array.from(groups.entries()).map(([instanceId, { target, ports }]) => {
    const sortedPorts = [...ports].sort((left, right) => left - right);
    const name = stripInstanceNamePort(String(target.nginxInstanceName || ''), sortedPorts) || `实例 ${instanceId}`;
    const endpoint = formatInstanceEndpoint(target.serverHost, sortedPorts);
    const serverName = serverCount > 1 ? String(target.serverName || '').trim() : '';
    const location = [serverName, endpoint].filter(Boolean).join(' ');
    const instanceTitle = `[${getNginxInstanceTypeLabel(target.nginxInstanceType)}] ${name}`;
    const label = `${instanceTitle}${location ? ` · ${location}` : ''}`;
    return {
      value: instanceId,
      serverId: Number(target.serverId || 0),
      label,
      title: label,
      instanceTitle,
      description: location,
    };
  });
}

/**
 * 切换服务器后，若原来选中的实例不属于新服务器则清空。
 * @param instanceId 当前选中的实例
 * @param options 新的实例筛选项
 * @returns 保留的实例 ID
 */
export function resolveInstanceFilterAfterServerChange(
  instanceId: number | null | undefined,
  options: Array<Pick<NginxInstanceFilterOption, 'value'>>
): number | undefined {
  const value = Number(instanceId || 0);
  if (!value) return undefined;
  return options.some((option) => option.value === value) ? value : undefined;
}
