import type { DeployServer } from '@/api/deploy';
import type { RuntimeAwareDeployTarget } from '../../types';

/** 流程第二步（Nginx 关联配置）诊断状态 */
export type Step2DiagnosticState = 'no_server' | 'no_instance' | 'unlinked_targets' | 'healthy';

/** 流程第二步诊断结果快照 */
export interface Step2Diagnostic {
  state: Step2DiagnosticState;
  tagText: string;
  tagColor: 'warning' | 'error' | 'success' | 'processing';
  tooltip: string;
}

/**
 * 计算 Hero 流程第二步的 Checklist 诊断状态。
 * @param servers 当前服务器列表
 * @param targets 当前部署目标列表
 * @returns 诊断结果
 */
export function calcStep2Diagnostic(
  servers: DeployServer[] = [],
  targets: RuntimeAwareDeployTarget[] = []
): Step2Diagnostic {
  if (servers.length === 0) {
    return {
      state: 'no_server',
      tagText: '需添加服务器',
      tagColor: 'warning',
      tooltip: '当前尚未添加任何独立服务器，点击前往新增服务器',
    };
  }

  const hasAnyInstance = servers.some(
    (s) => (s.nginxInstances && s.nginxInstances.length > 0) || Boolean(s.nginxRuntime?.initializedAt)
  );
  if (!hasAnyInstance) {
    return {
      state: 'no_instance',
      tagText: '无 Nginx 实例',
      tagColor: 'warning',
      tooltip: '服务器尚未初始化托管 Nginx 或扫描宿主机已有实例，点击进行管理',
    };
  }

  const frontendTargets = targets.filter((t) => t.projectType !== 'backend');
  const unlinkedCount = frontendTargets.filter((t) => !t.nginxInstanceId).length;
  if (unlinkedCount > 0) {
    return {
      state: 'unlinked_targets',
      tagText: `${unlinkedCount} 目标未关联`,
      tagColor: 'error',
      tooltip: `有 ${unlinkedCount} 个前端部署目标尚未关联 Nginx 实例，点击查看`,
    };
  }

  return {
    state: 'healthy',
    tagText: '已就绪',
    tagColor: 'success',
    tooltip: 'Nginx 实例与部署目标均已关联就绪，点击打开 Nginx 运维抽屉',
  };
}
