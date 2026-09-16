import type { DeployServer, NginxInstance } from '@/api/deploy';
import { getVisibleNginxInstances } from '../../../../utils';
export { resolveBindingPreviewInfo, type BindingPreviewSnapshot } from '../../../NginxBindingPreviewCard/constant';

/** Nginx 实例下拉项数据结构 */
export interface NginxInstanceOptionItem {
  label: string;
  title: string;
  value: number;
  searchKey: string;
  instanceType: 'managed' | 'external';
  typeLabel: string;
  typeColor: string;
  status: string;
  statusColor: string;
  statusLabel: string;
  description: string;
}

/**
 * 将过长路径压缩为保留首尾的中间省略文本。
 * @param value 原始路径
 * @param maxLength 展示文本最大长度
 * @returns 适合在窄容器内展示的路径文本
 */
export function formatPathForDisplay(value: string, maxLength = 34): string {
  const text = value.trim();
  if (!text || text.length <= maxLength) return text || '—';

  const contentLength = Math.max(maxLength - 1, 2);
  const headLength = Math.ceil(contentLength / 2);
  const tailLength = Math.floor(contentLength / 2);
  return `${text.slice(0, headLength)}…${text.slice(-tailLength)}`;
}

/**
 * 构造服务器下可见 Nginx 实例的选项列表。
 * @param server 关联服务器
 * @returns 下拉选项列表
 */
export function buildNginxInstanceOptions(server?: DeployServer | null): NginxInstanceOptionItem[] {
  if (!server) return [];
  return getVisibleNginxInstances(server).map((instance: NginxInstance) => {
    const isManaged = instance.instanceType === 'managed';
    const typeLabel = isManaged ? '系统托管' : '外部已有';
    const typeColor = isManaged ? 'blue' : 'purple';
    const isRunning = instance.status === 'running';
    const statusLabel = isRunning ? '运行中' : instance.status === 'stopped' ? '已停止' : instance.status === 'error' ? '异常' : '未就绪';
    const statusColor = isRunning ? '#52c41a' : instance.status === 'stopped' ? '#faad14' : instance.status === 'error' ? '#ff4d4f' : '#8c8c8c';
    const desc = `${typeLabel} · ${statusLabel} · 绑定 ${instance.targetCount || 0} 个站点`;

    return {
      label: instance.name,
      title: instance.name,
      value: instance.id,
      searchKey: `${instance.name} ${desc}`,
      instanceType: instance.instanceType,
      typeLabel,
      typeColor,
      status: instance.status,
      statusColor,
      statusLabel,
      description: desc,
    };
  });
}
