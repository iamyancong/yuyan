import type { DeployServer } from '@/api/deploy';

/** 服务器 Nginx 综合健康状态 */
export type ServerNginxHealth = 'running' | 'stopped' | 'uninitialized' | 'error' | 'empty';

/** 服务器 Nginx 资产汇总快照 */
export interface ServerNginxSummary {
  /** 实例总数 */
  totalCount: number;
  /** 平台托管实例数 */
  managedCount: number;
  /** 宿主机已有外部实例数 */
  externalCount: number;
  /** 综合健康状态 */
  health: ServerNginxHealth;
  /** 健康展示文案 */
  healthLabel: string;
  /** 状态标签色系 */
  healthColor: string;
  /** 是否存在任何实例 */
  hasInstance: boolean;
}

/**
 * 汇总并计算服务器的 Nginx 实例与综合健康状态。
 * @param server 部署服务器信息
 * @returns 汇总快照
 */
export function calcServerNginxSummary(server?: DeployServer | null): ServerNginxSummary {
  if (!server) {
    return {
      totalCount: 0,
      managedCount: 0,
      externalCount: 0,
      health: 'empty',
      healthLabel: '无实例',
      healthColor: 'default',
      hasInstance: false,
    };
  }

  const instances = server.nginxInstances || [];

  // 若无实例数组，尝试兼容旧版单一 nginxRuntime 数据
  if (instances.length === 0) {
    if (server.nginxRuntime?.initializedAt) {
      const status = server.nginxRuntime.status || 'uninitialized';
      const isRunning = status === 'running';
      return {
        totalCount: 1,
        managedCount: 1,
        externalCount: 0,
        health: status as ServerNginxHealth,
        healthLabel: isRunning ? '运行中' : status === 'stopped' ? '已停止' : status === 'error' ? '异常' : '未就绪',
        healthColor: isRunning ? 'success' : status === 'stopped' ? 'warning' : status === 'error' ? 'error' : 'default',
        hasInstance: true,
      };
    }
    return {
      totalCount: 0,
      managedCount: 0,
      externalCount: 0,
      health: 'empty',
      healthLabel: '无实例',
      healthColor: 'default',
      hasInstance: false,
    };
  }

  const managedCount = instances.filter((item) => item.instanceType === 'managed').length;
  const externalCount = instances.filter((item) => item.instanceType === 'external').length;

  // 综合最差健康状态优先级判定：error > uninitialized > stopped > running
  let health: ServerNginxHealth = 'running';
  if (instances.some((item) => item.status === 'error')) {
    health = 'error';
  } else if (instances.some((item) => item.status === 'uninitialized' || !item.initializedAt)) {
    health = 'uninitialized';
  } else if (instances.some((item) => item.status === 'stopped')) {
    health = 'stopped';
  }

  const labelMap: Record<ServerNginxHealth, string> = {
    running: '运行中',
    stopped: '已停止',
    uninitialized: '未就绪',
    error: '异常',
    empty: '无实例',
  };

  const colorMap: Record<ServerNginxHealth, string> = {
    running: 'success',
    stopped: 'warning',
    uninitialized: 'default',
    error: 'error',
    empty: 'default',
  };

  return {
    totalCount: instances.length,
    managedCount,
    externalCount,
    health,
    healthLabel: labelMap[health],
    healthColor: colorMap[health],
    hasInstance: true,
  };
}
