/**
 * 部署根目录字段属性与类型定义
 */

import type { DeployServer } from '@/api/deploy';
import type { DeployRootSelectOption } from '../../../../hooks/useDeployRootRecommendation';
import { normalizePosix, isSubPathOrEqual } from '../../../RemoteFsSelectModal/constant.ts';

export interface DeployRootFieldProps {
  modelValue?: string;
  projectType?: 'frontend' | 'backend';
  projectId?: number;
  projectName?: string;
  projectDescription?: string;
  defaultBranch?: string;
  serverId?: number;
  nginxInstanceId?: number;
  buildCommand?: string;
  artifactDir?: string;
  targetId?: number | null;
  isExplorerOpen?: boolean;
}

/**
 * 计算当前部署目标锁定的根作用域路径与展示文案。
 * @description 无论是托管 Nginx 还是已有 Nginx，默认将安全基准根开放到 html 静态目录的上一级（要求至少两级），
 * 兼顾安全隔离与平行微前端站点目录切换能力。
 * @param server 当前服务器
 * @param projectType 项目类型
 * @param nginxInstanceId Nginx 实例 ID
 * @returns 锁定根路径、默认打开路径与作用域说明
 */
export function resolveLockedScope(
  server?: DeployServer | null,
  projectType?: 'frontend' | 'backend',
  nginxInstanceId?: number
): { root: string; defaultPath?: string; label: string } {
  if (!server) return { root: '', defaultPath: '', label: '' };

  if (projectType === 'backend') {
    const backendRoot = server.defaultBackendRoot ? normalizePosix(server.defaultBackendRoot) : '';
    return {
      root: backendRoot,
      defaultPath: backendRoot,
      label: '后端服务根',
    };
  }

  const instances = Array.isArray(server.nginxInstances) ? server.nginxInstances : [];
  const instance = nginxInstanceId
    ? instances.find((item) => Number(item.id) === Number(nginxInstanceId))
    : instances.find((item) => Number(item.id) === Number(server.defaultNginxInstanceId || 0)) || instances[0];

  // 1. 获取当前实例或服务器设定的静态站点根（兼容 htmlRoot 与 defaultDeployRoot）
  const rawSiteRoot = instance?.htmlRoot || instance?.defaultDeployRoot || server.defaultDeployRoot || '';
  const siteRoot = rawSiteRoot ? normalizePosix(rawSiteRoot) : '';

  // 2. 如果配置了服务器上层根且其严格短于 siteRoot（例如 /opt/yuyan 包含 /opt/yuyan/html），优先作为基准根
  const serverDeployRoot = server.defaultDeployRoot ? normalizePosix(server.defaultDeployRoot) : '';
  const isServerRootStrictParent =
    Boolean(serverDeployRoot &&
    siteRoot &&
    serverDeployRoot !== siteRoot &&
    isSubPathOrEqual(siteRoot, serverDeployRoot));

  // 3. 计算 siteRoot 的上一级父目录（要求至少保留两级，严密防范穿出到 / 或单级敏感目录）
  let directParent = '';
  if (siteRoot) {
    const parts = siteRoot.split('/').filter(Boolean);
    if (parts.length >= 2) {
      parts.pop();
      directParent = `/${parts.join('/')}`;
    }
  }

  // 4. 确定最终安全天花板（root）：
  // - 若存在更上层的服务器根（如 /opt/yuyan），优先使用
  // - 否则若存在合法的直接父级（如 /home/app/frontend），使用直接父级
  // - 兜底使用 siteRoot 自身
  let root = '';
  if (isServerRootStrictParent) {
    root = serverDeployRoot;
  } else if (directParent) {
    root = directParent;
  } else {
    root = siteRoot;
  }

  const label = instance?.name ? `Nginx: ${instance.name}` : '站点根目录';
  return {
    root,
    defaultPath: siteRoot || root,
    label,
  };
}

export interface OccupiedCandidateItem {
  value?: string;
  disabled?: boolean;
  description?: string;
  [key: string]: unknown;
}

/**
 * 从推荐候选中提取被占用的目录映射字典。
 * @param options 推荐候选列表
 * @returns 规范化路径与占用说明字典
 */
export function extractOccupiedMap(options: OccupiedCandidateItem[]): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(options)) return map;
  options.forEach((opt) => {
    if (opt.disabled && opt.value) {
      const norm = normalizePosix(opt.value);
      map[norm] = opt.description || '已由其他项目占用';
    }
  });
  return map;
}
