import type { DeployTarget } from '@/api/deploy';

/** 冲突检测草稿参数 */
export interface SiteConflictDraft {
  id?: number | null;
  serverId: number | string;
  nginxInstanceId: number | string;
  nginxServerName?: string;
  listenPort?: number | string;
  projectType?: string;
}

/** 冲突检测结果 */
export interface SiteConflictResult {
  hasConflict: boolean;
  conflictedTarget?: DeployTarget;
  reason?: string;
}

/**
 * 纯函数：同实例跨目标域名与监听端口冲突预检（Coolify 风格冲突防护）。
 * @param targetDraft 待保存的目标配置草稿
 * @param allTargets 系统中现有的全量部署目标列表
 * @returns 冲突检测结果
 */
export function checkSiteConflict(
  targetDraft: SiteConflictDraft,
  allTargets: DeployTarget[] = []
): SiteConflictResult {
  // 后端项目或无实例项目不参与 Nginx 站点冲突检测
  if (targetDraft.projectType === 'backend') {
    return { hasConflict: false };
  }

  const serverId = Number(targetDraft.serverId || 0);
  const instanceId = Number(targetDraft.nginxInstanceId || 0);
  const domain = String(targetDraft.nginxServerName || '').trim().toLowerCase();
  const port = Number(targetDraft.listenPort || 0);

  // 未填写完整域名或端口，或域名为系统默认通配符时跳过冲突预检
  if (!serverId || !instanceId || !domain || domain === '_' || domain === 'localhost' || !port) {
    return { hasConflict: false };
  }

  const conflict = allTargets.find((target) => {
    // 排除目标自身
    if (targetDraft.id && target.id === targetDraft.id) {
      return false;
    }
    // 只检查同服务器、同 Nginx 实例的前端站点
    if (target.projectType === 'backend' || target.serverId !== serverId || target.nginxInstanceId !== instanceId) {
      return false;
    }
    const otherDomain = String(target.nginxServerName || '').trim().toLowerCase();
    const otherPort = Number(target.listenPort || 0);

    return otherDomain === domain && otherPort === port;
  });

  if (conflict) {
    return {
      hasConflict: true,
      conflictedTarget: conflict,
      reason: `域名 "${domain}" 与监听端口 ${port} 已被部署目标【${conflict.projectName} (${conflict.defaultBranch})】占用`,
    };
  }

  return { hasConflict: false };
}
