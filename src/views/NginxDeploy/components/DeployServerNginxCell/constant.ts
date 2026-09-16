import type { DeployServer, NginxInstance } from '@/api/deploy';

/** 系统自动生成的外部 Nginx 实例名称 */
export const SYSTEM_NGINX_INSTANCE_NAME = '系统 Nginx';

/**
 * 判断是否为系统自动生成的外部占位 Nginx 实例。
 * @param instance Nginx 实例
 * @returns 是否系统实例
 */
export function isSystemNginxInstance(instance: NginxInstance | null | undefined): boolean {
  return Boolean(instance?.instanceType === 'external' && instance.name === SYSTEM_NGINX_INSTANCE_NAME);
}

/**
 * 判断实例是否应在业务选择与状态统计中展示（过滤未绑定业务站点的幽灵占位实例）。
 * @param instance Nginx 实例
 * @returns 是否展示
 */
export function isVisibleNginxInstance(instance: NginxInstance | null | undefined): boolean {
  if (!instance) return false;
  return !(isSystemNginxInstance(instance) && !Number(instance.targetCount || 0));
}

/**
 * 获取可展示的 Nginx 实例列表。
 * @param server 部署服务器
 * @returns 可展示实例列表
 */
export function getVisibleNginxInstances(server?: DeployServer | null): NginxInstance[] {
  return (server?.nginxInstances || []).filter(isVisibleNginxInstance);
}

/** 服务器 Nginx 综合健康状态 */
export type ServerNginxHealth = 'running' | 'connected' | 'stopped' | 'uninitialized' | 'error' | 'empty';

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
  /** 简明描述文本 */
  instanceText: string;
  /** 悬浮提示文案 */
  tooltipText: string;
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
      instanceText: '',
      tooltipText: '当前服务器未配置 Nginx 实例，点击新增或接入',
    };
  }

  // 必须使用 getVisibleNginxInstances 过滤掉未绑定业务站点的“系统 Nginx”历史占位实例
  const instances = getVisibleNginxInstances(server);

  // 若无可见实例，尝试兼容旧版单一 nginxRuntime 数据（必须 initializedAt 有效）
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
        instanceText: '托管',
        tooltipText: isRunning ? 'Nginx 运行正常（校验通过），点击管理' : 'Nginx 状态异常或已停止，点击管理',
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
      instanceText: '',
      tooltipText: '当前服务器未配置 Nginx 实例，点击新增或接入',
    };
  }

  const managedInstances = instances.filter((item) => item.instanceType === 'managed');
  const externalInstances = instances.filter((item) => item.instanceType === 'external');
  const managedCount = managedInstances.length;
  const externalCount = externalInstances.length;

  // 综合最差健康状态优先级判定：error > stopped > uninitialized > connected / running
  // 注意：只有托管实例（managed）需要平台初始化（!item.initializedAt）；已有实例（external）只要未报错即为已接入健康态
  let health: ServerNginxHealth = 'running';
  if (instances.some((item) => item.status === 'error')) {
    health = 'error';
  } else if (instances.some((item) => item.status === 'stopped')) {
    health = 'stopped';
  } else if (managedInstances.some((item) => item.status === 'uninitialized' || !item.initializedAt)) {
    health = 'uninitialized';
  } else if (managedCount === 0 && externalInstances.every((item) => item.status !== 'running')) {
    // 全为已有外部实例且未执行探活校验时，对齐抽屉展示为“已接入”
    health = 'connected';
  }

  const labelMap: Record<ServerNginxHealth, string> = {
    running: '运行中',
    connected: '已接入',
    stopped: '已停止',
    uninitialized: '未就绪',
    error: '异常',
    empty: '无实例',
  };

  const colorMap: Record<ServerNginxHealth, string> = {
    running: 'success',
    connected: 'success',
    stopped: 'warning',
    uninitialized: 'default',
    error: 'error',
    empty: 'default',
  };

  const tooltipMap: Record<ServerNginxHealth, string> = {
    running: 'Nginx 运行正常（已通过连通性校验），点击进行管理',
    connected: '已有 Nginx 已登记接入（待在线探活），点击前往抽屉校验连通性',
    stopped: 'Nginx 实例已停止，点击前往启动或管理',
    uninitialized: '托管 Nginx 尚未初始化，点击前往初始化',
    error: 'Nginx 实例状态异常，点击排查问题',
    empty: '当前服务器未配置 Nginx 实例，点击新增或接入',
  };

  let instanceText = '';
  if (instances.length === 1) {
    instanceText = managedCount === 1 ? '托管' : '已有';
  } else {
    const parts: string[] = [];
    if (managedCount > 0) parts.push(`${managedCount} 托管`);
    if (externalCount > 0) parts.push(`${externalCount} 已有`);
    instanceText = parts.join(' · ');
  }

  return {
    totalCount: instances.length,
    managedCount,
    externalCount,
    health,
    healthLabel: labelMap[health],
    healthColor: colorMap[health],
    hasInstance: true,
    instanceText,
    tooltipText: tooltipMap[health],
  };
}
