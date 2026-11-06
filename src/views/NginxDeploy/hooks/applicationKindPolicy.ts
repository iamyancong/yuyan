/**
 * 应用类型（主应用 / 微应用）及监听端口显隐纯函数策略
 * @description 纯函数模块，禁止 import vue、@/ 别名或 axios，供前端组件与 Node 单测复用
 */

export type ApplicationKind = 'main' | 'micro' | '';

/**
 * 归一化应用类型。
 * @param value 原始类型输入
 * @returns 'main' | 'micro' | ''
 */
export function normalizeApplicationKind(value: unknown): ApplicationKind {
  if (value === 'main') return 'main';
  if (value === 'micro') return 'micro';
  return '';
}

/**
 * 决策最终生效的应用类型。
 * @description detected（本次探测识别出的 kind）优先；探测未识别或失败时回落到 saved（记录里已保存的）；都没有时为 ''。
 * @param options 输入参数
 * @returns 最终决定的 applicationKind
 */
export function resolveApplicationKind(options: {
  detected?: unknown;
  saved?: unknown;
}): ApplicationKind {
  const detectedKind = normalizeApplicationKind(options?.detected);
  if (detectedKind) return detectedKind;
  return normalizeApplicationKind(options?.saved);
}

/**
 * 判定当前部署目标是否应当展示「监听端口」字段。
 * @description
 * 1. 后端目标（projectType === 'backend'）→ false（隐藏）
 * 2. 微应用且未开启平台托管站点（applicationKind === 'micro' && !nginxSiteManaged）→ false（隐藏）
 * 3. 微应用开启平台托管站点（applicationKind === 'micro' && nginxSiteManaged）→ true（端口是站点配置的生成依据，仍显示）
 * 4. 主应用（main）及未识别（''）→ true（照常显示，保守不隐藏）
 * @param options 目标类型、应用类型及托管状态
 * @returns 是否显示监听端口字段
 */
export function shouldShowListenPort(options: {
  projectType?: unknown;
  applicationKind?: unknown;
  nginxSiteManaged?: unknown;
}): boolean {
  if (options?.projectType === 'backend') {
    return false;
  }
  const kind = normalizeApplicationKind(options?.applicationKind);
  const isManagedSite = Boolean(options?.nginxSiteManaged);

  if (kind === 'micro' && !isManagedSite) {
    return false;
  }
  return true;
}
