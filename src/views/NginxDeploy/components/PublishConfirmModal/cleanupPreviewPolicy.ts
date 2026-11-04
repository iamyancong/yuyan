/**
 * 部署目录清理预览策略与二次确认纯函数模块。
 * @description 提供共享根目录识别、清理项分类分组、发布开始门禁判定及默认上传策略推导等纯逻辑。
 */

import type { DeployTargetCleanupPreview, DeployUploadStrategy } from '@/api/deploy';

/** 共享根候选目标参数 */
export interface SharedDeployRootCandidate {
  id?: number;
  projectName?: string;
  projectDescription?: string;
  deployRoot?: string;
  serverId?: number;
  uploadStrategy?: DeployUploadStrategy;
}

/** 共享根关联的 Nginx 实例参数 */
export interface SharedDeployRootNginxInstance {
  id?: number;
  instanceType?: string;
  htmlRoot?: string;
}

/** 规范化路径段，去除尾斜杠与多余斜杠 */
function normalizePath(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const converted = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/');
  return converted.length > 1 ? converted.replace(/\/+$/, '') : converted;
}

/**
 * 判断部署目标或项目是否为主应用。
 * @param target 部署目标或候选项目
 * @returns 是否为主应用
 */
export function isMainDeployProject(target?: { projectName?: string; projectDescription?: string } | null): boolean {
  const text = `${target?.projectName || ''} ${target?.projectDescription || ''}`.toLowerCase();
  return text.includes('主应用');
}

/**
 * 判断部署目标是否位于共享根目录下。
 * 满足以下任一条件即视为共享根目录：
 * 1. 项目名称或描述包含「主应用」；
 * 2. 部署根目录等于所选托管 Nginx 实例的 htmlRoot；
 * 3. 同服务器下有嵌套在当前部署目录内的其他部署目标。
 *
 * @param params 判断参数
 * @returns 是否为共享根目录
 */
export function isSharedDeployRoot(params: {
  target?: SharedDeployRootCandidate | null;
  allServerTargets?: SharedDeployRootCandidate[];
  nginxInstance?: SharedDeployRootNginxInstance | null;
}): boolean {
  const { target, allServerTargets = [], nginxInstance = null } = params;
  if (!target) return false;

  // 1. 项目名称或描述包含「主应用」
  if (isMainDeployProject(target)) return true;

  const normalizedRoot = normalizePath(target.deployRoot || '');
  if (!normalizedRoot) return false;

  // 2. 等于所选托管 Nginx 实例的 htmlRoot
  if (nginxInstance && nginxInstance.instanceType === 'managed' && nginxInstance.htmlRoot) {
    const instHtmlRoot = normalizePath(nginxInstance.htmlRoot);
    if (normalizedRoot === instHtmlRoot) return true;
  }

  // 3. 同服务器下有嵌套在当前部署目录内的其他部署目标
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  for (const other of allServerTargets) {
    if (other.id !== undefined && target.id !== undefined && Number(other.id) === Number(target.id)) continue;
    const otherRoot = normalizePath(other.deployRoot || '');
    if (!otherRoot) continue;
    if (otherRoot.startsWith(prefix) && otherRoot !== normalizedRoot) {
      return true;
    }
  }

  return false;
}

/** 分组后的清理预览条目 */
export interface GroupedCleanupPreview {
  /** 待替换/清理项（上次清单 ∩ 已存在） */
  replaceOrCleanItems: string[];
  /** 受保护项（嵌套子应用 + 手填保留） */
  protectedItems: Array<{ name: string; source: 'nested' | 'manual'; reason: string }>;
  /** 未识别项（既不在雨燕清单也不在受保护名单的已有文件） */
  unknownItems: string[];
  /** 系统保留项（.yuyan-backups 等） */
  reservedItems: string[];
}

/**
 * 将接口返回的清理预览数据整理为界面三组列表。
 * @param preview 接口返回的预览数据
 * @returns 分组后的条目集合
 */
export function groupCleanupPreviewItems(
  preview?: Partial<DeployTargetCleanupPreview> | null
): GroupedCleanupPreview {
  if (!preview) {
    return {
      replaceOrCleanItems: [],
      protectedItems: [],
      unknownItems: [],
      reservedItems: [],
    };
  }

  const replaceOrCleanItems = Array.isArray(preview.willReplaceOrClean)
    ? [...new Set(preview.willReplaceOrClean)].sort()
    : [];

  const protectedItems = Array.isArray(preview.protected)
    ? preview.protected.map((item) => {
        const source: 'nested' | 'manual' = item.source === 'nested' ? 'nested' : 'manual';
        const label = source === 'nested' ? '已登记子应用' : '手填保留';
        return {
          name: item.name,
          source,
          reason: item.reason || `${label}: ${item.name}`,
        };
      })
    : [];

  const unknownItems = Array.isArray(preview.unknown)
    ? [...new Set(preview.unknown)].sort()
    : [];

  const reservedItems = Array.isArray(preview.reserved)
    ? [...new Set(preview.reserved)].sort()
    : [];

  return {
    replaceOrCleanItems,
    protectedItems,
    unknownItems,
    reservedItems,
  };
}

/** 开始发布按钮可用性判定参数 */
export interface CanStartPublishOptions {
  /** 是否为清空后替换策略 */
  isCleanReplace: boolean;
  /** 是否为共享根目录 */
  isSharedRoot: boolean;
  /** 用户是否勾选了二次确认框 */
  cleanReplaceConfirmed: boolean;
  /** 用户是否勾选了额外清理项 */
  hasSelectedExtra: boolean;
  /** 预览是否正在加载 */
  previewLoading: boolean;
  /** 预览是否加载失败 */
  previewError: boolean;
  /** 真实部署目录的风险等级 */
  riskLevel?: 'ok' | 'warn' | 'block';
}

/**
 * 判定发布确认抽屉中的「开始发布」按钮是否可用。
 * 门禁规则：
 * 1. 真实部署目录风险为 block 时直接禁用；
 * 2. 非清空后替换模式不受清理预览阻断；
 * 3. 预览加载中不可开始；
 * 4. 预览加载失败时：共享根目录强制阻断；非共享根目录允许继续发布；
 * 5. 共享根目录且清空后替换模式下，必须手动勾选二次确认；
 * 6. 用户勾选了额外清理项时，必须勾选二次确认。
 *
 * @param options 校验参数
 * @returns 是否允许开始发布
 */
export function canStartPublishWithCleanup(options: CanStartPublishOptions): boolean {
  const {
    isCleanReplace,
    isSharedRoot,
    cleanReplaceConfirmed,
    hasSelectedExtra,
    previewLoading,
    previewError,
    riskLevel = 'ok',
  } = options;

  // 1. 硬风险拦截
  if (riskLevel === 'block') {
    return false;
  }

  // 2. 覆盖上传保留旧资源模式不阻断
  if (!isCleanReplace) {
    return true;
  }

  // 3. 加载中不可点击
  if (previewLoading) {
    return false;
  }

  // 4. 预览失败处理：共享根阻断，非共享根放行
  if (previewError) {
    return !isSharedRoot;
  }

  // 5. 共享根强制二次确认
  if (isSharedRoot && !cleanReplaceConfirmed) {
    return false;
  }

  // 6. 勾选了额外清理项强制二次确认
  if (hasSelectedExtra && !cleanReplaceConfirmed) {
    return false;
  }

  return true;
}

/**
 * 表单新建部署目标时推导默认上传策略。
 * 共享根目录场景默认推荐并采用「覆盖上传并保留旧资源」，避免误删子应用或同目录文件。
 *
 * @param params 推导参数
 * @returns 推荐的上传策略
 */
export function resolveDefaultUploadStrategy(params: {
  target?: SharedDeployRootCandidate | null;
  allServerTargets?: SharedDeployRootCandidate[];
  nginxInstance?: SharedDeployRootNginxInstance | null;
  isNewTarget?: boolean;
}): DeployUploadStrategy {
  const { target, allServerTargets = [], nginxInstance = null, isNewTarget = true } = params;

  // 编辑已有目标时保留已有配置
  if (!isNewTarget && target?.uploadStrategy) {
    return target.uploadStrategy;
  }

  // 共享根默认推荐覆盖保留旧资源
  if (isSharedDeployRoot({ target, allServerTargets, nginxInstance })) {
    return 'overlayKeepAssets';
  }

  return target?.uploadStrategy || 'overlayKeepAssets';
}
