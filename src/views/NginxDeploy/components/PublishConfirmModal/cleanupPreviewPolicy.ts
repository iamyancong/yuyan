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

/**
 * 格式化精简版发布信息下方摘要文案（微应用与共享根统一格式）。
 * 格式为「清空后替换 · 替换 N 项」，若与上次确认一致则为「清空后替换 · 替换 N 项 · 与上次确认一致」。
 *
 * @param replaceCountOrParams 待替换数量或统计参数对象
 * @param maybeMatchesConfirmed 是否与上次确认一致
 * @returns 摘要文本
 */
export function formatShortCleanupSummary(
  replaceCountOrParams: number | { replaceCount?: number; matchesConfirmed?: boolean },
  maybeMatchesConfirmed?: boolean
): string {
  let replaceCount = 0;
  let matchesConfirmed = false;
  if (typeof replaceCountOrParams === 'object' && replaceCountOrParams !== null) {
    replaceCount = Math.max(0, replaceCountOrParams.replaceCount || 0);
    matchesConfirmed = Boolean(replaceCountOrParams.matchesConfirmed);
  } else {
    replaceCount = Math.max(0, Number(replaceCountOrParams) || 0);
    matchesConfirmed = Boolean(maybeMatchesConfirmed);
  }
  const base = `清空后替换 · 替换 ${replaceCount} 项`;
  return matchesConfirmed ? `${base} · 与上次确认一致` : base;
}

/**
 * 格式化发布信息下方 ⓘ 图标的完整说明 Tooltip。
 * matchesConfirmed 一致时：写上次确认人和时间；
 * 微应用：“将替换 N 项雨燕旧文件，其他内容不受影响”；
 * 共享根：输出动态保留说明，如“只替换 11 项雨燕旧文件，保留 4 个子应用和 5 个其他目录”。
 *
 * @param params 参数集合
 * @returns 提示文案
 */
export function formatCleanupSummaryTooltip(params: {
  isSharedRoot: boolean;
  replaceCount?: number;
  nestedCount?: number;
  manualCount?: number;
  unknownCount?: number;
  extraCleanupCount?: number;
  matchesConfirmed?: boolean;
  lastConfirmedAt?: string;
  lastConfirmedBy?: string;
}): string {
  if (params.matchesConfirmed && (params.lastConfirmedBy || params.lastConfirmedAt)) {
    const by = params.lastConfirmedBy || '-';
    const at = params.lastConfirmedAt || '-';
    return `上次确认人：${by}，确认时间：${at}`;
  }
  const replaceCount = Math.max(0, params.replaceCount || 0);
  if (params.isSharedRoot) {
    const full = formatSharedRootCleanupSummary(params);
    return full.replace(/^共享根目录：/, '');
  }
  return `将替换 ${replaceCount} 项雨燕旧文件，其他内容不受影响`;
}

/**
 * 获取开始发布前确认气泡的标题。
 *
 * @param options 判断条件
 * @returns 气泡标题
 */
export function getPublishConfirmPopupTitle(options: {
  isSharedRoot: boolean;
  hasSelectedExtra?: boolean;
}): string {
  if (options.isSharedRoot) {
    return '共享根目录，确认清空发布？';
  }
  if (options.hasSelectedExtra) {
    return '存在额外清理，确认清空发布？';
  }
  return '确认清空后替换发布？';
}

/**
 * 格式化开始发布前确认气泡的正文内容。
 * 共享根场景输出「只替换 N 项雨燕旧文件，保留 X 个子应用和 Y 个其他目录」（0 的部分省略）。
 * 不一致且有变更记录时追加变化说明（如「和上次相比新增未识别：x、y」）。
 * 额外清理场景输出对应清理项提示。
 *
 * @param params 统计参数
 * @returns 气泡正文
 */
export function formatPublishConfirmPopupBody(
  params: SharedRootCleanupSummaryParams & {
    isSharedRoot: boolean;
    scopeDiff?: {
      addedProtected?: string[];
      addedUnknown?: string[];
      removedItems?: string[];
      hasChanges?: boolean;
    } | null;
  }
): string {
  let baseText = '';
  if (params.isSharedRoot) {
    const full = formatSharedRootCleanupSummary(params);
    baseText = full.replace(/^共享根目录：/, '');
  } else {
    const extraCount = Math.max(0, params.extraCleanupCount || 0);
    baseText = `本次发布将额外清理勾选的 ${extraCount} 项未识别文件`;
  }

  const diff = params.scopeDiff;
  if (diff && diff.hasChanges) {
    const changes: string[] = [];
    if (diff.addedUnknown && diff.addedUnknown.length > 0) {
      changes.push(`新增未识别：${diff.addedUnknown.join('、')}`);
    }
    if (diff.addedProtected && diff.addedProtected.length > 0) {
      changes.push(`新增受保护：${diff.addedProtected.join('、')}`);
    }
    if (diff.removedItems && diff.removedItems.length > 0) {
      changes.push(`减少项：${diff.removedItems.join('、')}`);
    }
    if (changes.length > 0) {
      baseText = `${baseText}。和上次相比${changes.join('，')}`;
    }
  }

  return baseText;
}

/**
 * 判断当前发布是否需要通过气泡进行二次确认。
 * 规则：
 * 1. 非清空后替换模式不需要确认；
 * 2. 勾选了额外清理项必须确认；
 * 3. 共享根目录且 matchesConfirmed 时免确认放行；不一致或未确认时必须确认；
 * 4. 普通微应用且无额外清理直接发布，不需要弹气泡。
 *
 * @param options 校验参数
 * @returns 是否需要气泡确认
 */
export function needsPublishConfirmation(options: {
  isCleanReplace: boolean;
  isSharedRoot: boolean;
  hasSelectedExtra: boolean;
  matchesConfirmed?: boolean;
}): boolean {
  if (!options.isCleanReplace) return false;
  if (options.hasSelectedExtra) return true;
  if (options.isSharedRoot) {
    return !options.matchesConfirmed;
  }
  return false;
}

/**
 * 判断当前发布是否能够直接发布（无需气泡确认）。
 *
 * @param options 校验参数
 * @returns 是否可直接发布
 */
export function canDirectlyPublish(options: {
  isCleanReplace: boolean;
  isSharedRoot: boolean;
  hasSelectedExtra: boolean;
  matchesConfirmed?: boolean;
}): boolean {
  return !needsPublishConfirmation(options);
}

/**
 * 发布门禁判定纯函数。
 * handleStart / handleRepublish 必须经过此函数校验，确保未确认的共享根或额外清理发布无法绕过气泡。
 *
 * @param options 门禁参数
 * @returns 判定结果：canPublish 是否允许真正发布；needConfirm 是否需要阻断并弹气泡
 */
export function resolvePublishGate(options: {
  isCleanReplace: boolean;
  isSharedRoot: boolean;
  hasSelectedExtra: boolean;
  matchesConfirmed?: boolean;
  confirmed?: boolean;
}): { canPublish: boolean; needConfirm: boolean } {
  const needConfirm = needsPublishConfirmation(options);
  if (!needConfirm) {
    return { canPublish: true, needConfirm: false };
  }
  return {
    canPublish: Boolean(options.confirmed),
    needConfirm: true,
  };
}

export interface SharedRootCleanupSummaryParams {
  /** 待替换/清理的雨燕旧文件数量 */
  replaceCount?: number;
  /** 受保护的已登记子应用数量 */
  nestedCount?: number;
  /** 手填保留项数量 */
  manualCount?: number;
  /** 未识别项数量 */
  unknownCount?: number;
  /** 用户勾选的额外清理项数量 */
  extraCleanupCount?: number;
}

/**
 * 格式化非共享根/微应用的清空后替换摘要文案。
 * @param replaceCount 待替换/清理项数量
 * @returns 摘要文案，如「清空后替换：将替换 7 项旧文件，其他内容不受影响」
 */
export function formatMicroDeployCleanupSummary(replaceCount: number): string {
  const count = Math.max(0, replaceCount || 0);
  if (count === 0) {
    return '清空后替换：暂无待替换旧文件，其他内容不受影响';
  }
  return `清空后替换：将替换 ${count} 项旧文件，其他内容不受影响`;
}

/**
 * 格式化主应用/共享根目录的清空后替换摘要文案。
 * 遵循平实中文，数字动态，为 0 的部分省略。
 * 如「共享根目录：只替换 11 项雨燕旧文件，保留 4 个子应用和 5 个其他目录」。
 *
 * @param params 统计参数
 * @returns 格式化后的文案
 */
export function formatSharedRootCleanupSummary(params: SharedRootCleanupSummaryParams): string {
  const replaceCount = Math.max(0, params.replaceCount || 0);
  const nestedCount = Math.max(0, params.nestedCount || 0);
  const manualCount = Math.max(0, params.manualCount || 0);
  const unknownCount = Math.max(0, params.unknownCount || 0);
  const extraCleanupCount = Math.max(0, params.extraCleanupCount || 0);

  const remainingUnknownCount = Math.max(0, unknownCount - extraCleanupCount);
  const segments: string[] = [];

  // 1. 雨燕旧文件替换
  if (replaceCount > 0) {
    segments.push(`只替换 ${replaceCount} 项雨燕旧文件`);
  }

  // 2. 额外清理项
  if (extraCleanupCount > 0) {
    segments.push(`额外清理 ${extraCleanupCount} 项`);
  }

  // 3. 保留项列表（子应用、手填保留项、其他目录）
  const keepItems: string[] = [];
  if (nestedCount > 0) {
    keepItems.push(`${nestedCount} 个子应用`);
  }
  if (manualCount > 0) {
    keepItems.push(`${manualCount} 个手填保留项`);
  }
  if (remainingUnknownCount > 0) {
    keepItems.push(`${remainingUnknownCount} 个其他目录`);
  }

  if (keepItems.length > 0) {
    let keepText = '';
    if (keepItems.length === 1) {
      keepText = keepItems[0];
    } else if (keepItems.length === 2) {
      keepText = `${keepItems[0]}和 ${keepItems[1]}`;
    } else {
      keepText = `${keepItems.slice(0, -1).join('、')} 和 ${keepItems[keepItems.length - 1]}`;
    }
    segments.push(`保留 ${keepText}`);
  }

  if (segments.length === 0) {
    return '共享根目录：无待替换或保留项';
  }

  return `共享根目录：${segments.join('，')}`;
}

/**
 * 格式化清空后替换开始发布二次确认文案。
 *
 * @param params 确认参数
 * @returns 二次确认复选框文案
 */
export function formatCleanupSecondaryConfirmText(params: {
  isSharedRoot: boolean;
  replaceCount?: number;
  nestedCount?: number;
  manualCount?: number;
  unknownCount?: number;
  extraCleanupCount?: number;
}): string {
  if (params.isSharedRoot) {
    return formatSharedRootCleanupSummary(params);
  }
  if ((params.extraCleanupCount || 0) > 0) {
    return `确认额外清理勾选的 ${params.extraCleanupCount} 项未识别文件`;
  }
  return '我已核对清理预览，确认执行清空后替换';
}

/** 构造发布启动参数纯函数输入选项 */
export interface BuildPublishStartPayloadOptions {
  /** 是否强制重新安装依赖 */
  forceInstallDependencies: boolean;
  /** 额外勾选清理的顶层文件名列表 */
  extraCleanupNames?: string[];
  /** 预览中当前清理范围指纹 */
  scopeFingerprint?: string;
  /** 是否在气泡中显式确认 */
  confirmed?: boolean;
}

/**
 * 组装发布/重新发布的参数对象。
 * cleanReplaceConfirmed 仅在用户显式确认（confirmed === true）时为 true；
 * 仅在 confirmed === true 时附带 confirmedFingerprint。
 *
 * @param options 组装选项
 * @returns 最终发布参数载荷
 */
export function buildPublishStartPayload(options: BuildPublishStartPayloadOptions) {
  const isConfirmed = options.confirmed === true;
  return {
    forceInstallDependencies: Boolean(options.forceInstallDependencies),
    extraCleanupNames: Array.isArray(options.extraCleanupNames) ? [...options.extraCleanupNames] : [],
    cleanReplaceConfirmed: isConfirmed,
    confirmedFingerprint: isConfirmed && options.scopeFingerprint ? options.scopeFingerprint : undefined,
  };
}

