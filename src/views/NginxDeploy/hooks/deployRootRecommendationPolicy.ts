import type { DeployRootOption, DeployRootOptionsResult } from '../../../api/deploy';
import type { DeployApplicationDetection } from './deployRootProjectDetector';

/** AutoComplete 部署根目录候选。 */
export interface DeployRootSelectOption {
  value: string;
  label: string;
  section: '智能推荐' | '服务器应用' | '已占用';
  description: string;
  disabled: boolean;
  recommended: boolean;
}

/** 自动写入推荐值的判断上下文。 */
export interface DeployRootWritePolicyContext {
  responseSequence: number;
  activeSequence: number;
  autoManaged: boolean;
  preserveInitialEditValue: boolean;
  recommendation: string;
  recommendationDisabled: boolean;
}

/**
 * 规范化服务器部署绝对路径。
 * @param value 原始路径
 * @returns 去除末尾斜杠的路径
 */
export function normalizeDeployRoot(value?: string): string {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (normalized === '/') return '/';
  return normalized.replace(/\/$/, '');
}

/**
 * 根据应用识别结果生成部署路径。
 * @param configuredRoot 服务器配置根目录
 * @param detection 项目识别结果
 * @returns 推荐路径
 */
export function createRecommendedDeployRoot(configuredRoot: string, detection: DeployApplicationDetection | null): string {
  const root = normalizeDeployRoot(configuredRoot);
  if (!root || detection?.status !== 'resolved') return '';
  if (detection.kind === 'main') return root;
  return detection.appName ? `${root}/${detection.appName}` : '';
}

/**
 * 格式化目录占用信息。
 * @param item 服务器目录候选
 * @returns 占用摘要
 */
function formatOccupancy(item: DeployRootOption): string {
  return item.occupiedBy
    .map((target) => [target.projectName, target.branch, target.envName].filter(Boolean).join(' · '))
    .join('；');
}

/**
 * 合并智能推荐与服务器真实应用目录。
 * @param serverResult 服务器目录响应
 * @param recommendedRoot 推荐路径
 * @param detection 项目识别结果
 * @returns AutoComplete 候选
 */
export function createDeployRootSelectOptions(
  serverResult: DeployRootOptionsResult | null,
  recommendedRoot: string,
  detection: DeployApplicationDetection | null
): DeployRootSelectOption[] {
  if (!serverResult) return [];
  const options: DeployRootSelectOption[] = [];
  const recommendedItem = serverResult.items.find((item) => item.path === recommendedRoot);
  if (recommendedRoot) {
    const occupied = Boolean(recommendedItem?.occupied);
    options.push({
      value: recommendedRoot,
      label: recommendedRoot,
      section: occupied ? '已占用' : '智能推荐',
      description: occupied
        ? `已由 ${formatOccupancy(recommendedItem as DeployRootOption)} 使用`
        : `${detection?.kind === 'main' ? '主应用根目录' : `微应用 ${detection?.appName || ''}`} · ${recommendedItem?.exists ? '服务器已存在' : recommendedItem ? '按已配置路径使用' : '发布时创建'}`,
      disabled: occupied,
      recommended: true,
    });
  }
  serverResult.items.forEach((item) => {
    if (item.path === recommendedRoot) return;
    options.push({
      value: item.path,
      label: item.path,
      section: item.occupied ? '已占用' : '服务器应用',
      description: item.occupied
        ? `已由 ${formatOccupancy(item)} 使用`
        : item.kind === 'root'
          ? item.exists
            ? `${item.hasIndexHtml ? '检测到主应用 index.html' : '服务器配置根目录'}`
            : '配置根目录暂不可读取，可继续手动使用'
          : item.exists
            ? `${item.name} · 已检测到 index.html`
            : `${item.name} · 当前目标已配置，服务器目录不存在`,
      disabled: item.occupied,
      recommended: false,
    });
  });
  return options;
}

/**
 * 判断异步识别结果是否仍属于当前表单签名。
 * @param responseSequence 响应序号
 * @param activeSequence 当前最新请求序号
 * @returns 是否允许提交响应
 */
export function isCurrentDeployRootRefresh(responseSequence: number, activeSequence: number): boolean {
  return responseSequence === activeSequence;
}

/**
 * 判断推荐路径是否可以自动写入表单。
 * @param context 自动写入上下文
 * @returns 是否写入
 */
export function shouldWriteDeployRootRecommendation(context: DeployRootWritePolicyContext): boolean {
  return isCurrentDeployRootRefresh(context.responseSequence, context.activeSequence)
    && context.autoManaged
    && !context.preserveInitialEditValue
    && Boolean(context.recommendation)
    && !context.recommendationDisabled;
}
