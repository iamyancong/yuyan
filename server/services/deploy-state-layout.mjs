/**
 * 部署状态外置仓布局与三维保留策略模块
 * @description 负责托管 Nginx 平级外置元数据仓（.yuyan-state）路径推导、权限降级、
 * 目标目录稳定标识（slug）生成，以及按份数/空间/TTL 的三维保留策略解析。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import {
  DEPLOY_BACKUP_KEEP_ENTRY,
  DEPLOY_BACKUP_KEEP_FULL,
  DEPLOY_BACKUP_KEEP_PER_TARGET,
  DEPLOY_BACKUP_MAX_SIZE_MB,
  DEPLOY_BACKUP_TTL_DAYS,
  DEPLOY_ORPHAN_ASSET_MIN_AGE_DAYS,
} from '../config/constants.mjs';
import { isReservedDeployEntry, isValidEntryName, normalizeDeployRootPath } from './deploy-cleanup-policy.mjs';

/** 平级外置状态仓根目录名 */
export const STATE_ROOT_DIR_NAME = '.yuyan-state';

/** 外置仓共享 CAS 对象池目录名 */
export const STATE_OBJECTS_DIR_NAME = 'objects';

/** 外置仓目标状态目录名 */
export const STATE_TARGETS_DIR_NAME = 'targets';

/** 外置仓对象池 GC 互斥锁目录名 */
export const STATE_GC_LOCK_NAME = '.gc.lock';

/** 外置仓 CAS 活跃读/写租约目录名（备份写入与回滚读取注册于此，GC 见活跃租约自动让步） */
export const STATE_CAS_USERS_DIR_NAME = '.cas-users';

/** 外置仓版本元信息文件名 */
export const STATE_META_FILE_NAME = 'state-meta.json';

/** 单目标状态归属元信息文件名 */
export const TARGET_META_FILE_NAME = 'target.json';

/**
 * 退役标记文件名（目标已删除 / 已改路径 / 部署目录已消失时写入）。
 * @description 由雨燕在删除目标或修改部署目录时写入外置仓 targets/<slug>/ 与内嵌 .yuyan-backups/，
 * 服务器端 gc-backups 定时任务在宽限期（默认等于 TTL 天数）过后整份回收；再次发布会自动清除该标记。
 */
export const TARGET_RETIRED_MARKER_NAME = '.retired';

/** 历史内嵌备份目录名 */
export const LEGACY_BACKUP_DIR_NAME = '.yuyan-backups';

/** 历史内嵌清单目录名 */
export const LEGACY_MANIFEST_DIR_NAME = '.yuyan-manifests';

/** 默认带哈希静态资源目录列表 */
export const DEFAULT_HASHED_ASSET_DIRS = Object.freeze(['assets']);

/** 常见 Web 静态根目录名（用于非托管场景平级外置启发式推导） */
const COMMON_WEB_ROOT_NAMES = new Set(['html', 'www', 'htdocs', 'webroot', 'public_html']);

/** 严禁作为 .yuyan-state 直接父目录的系统顶级路径 */
const FORBIDDEN_STATE_PARENT_DIRS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
]);

/**
 * 安全规范化 POSIX 绝对路径（出错时兜底清洗，避免空串或尾斜杠漂移）。
 * @param {string} rawPath - 原始路径
 * @returns {string} 规范化路径
 */
export function normalizePosixAbsPath(rawPath) {
  const text = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!text) return '';
  try {
    return normalizeDeployRootPath(text);
  } catch {
    const normalized = path.posix.normalize(text);
    if (normalized.length > 1 && normalized.endsWith('/')) {
      return normalized.replace(/\/+$/, '');
    }
    return normalized;
  }
}

/**
 * 判断 childPath 是否等于 parentPath 或位于 parentPath 内部。
 * @param {string} childPath - 子路径
 * @param {string} parentPath - 父路径
 * @returns {boolean} 是否包含
 */
export function isSameOrSubPath(childPath, parentPath) {
  const child = normalizePosixAbsPath(childPath);
  const parent = normalizePosixAbsPath(parentPath);
  if (!child || !parent) return false;
  if (child === parent) return true;
  if (parent === '/') return child.startsWith('/');
  return child.startsWith(`${parent}/`);
}

/**
 * 判断候选目录是否允许作为 .yuyan-state 的父目录。
 * @param {string} candidateParent - 候选父目录
 * @param {string} realRoot - 当前目标的真实部署目录
 * @returns {boolean} 是否安全
 */
export function isSafeStateParentDir(candidateParent, realRoot = '') {
  const parent = normalizePosixAbsPath(candidateParent);
  if (!parent || !parent.startsWith('/')) return false;
  if (FORBIDDEN_STATE_PARENT_DIRS.has(parent)) return false;

  // 禁止在单层系统根目录（如 /xxx）直接创建外置仓，至少需要两级业务路径（如 /opt/yuyan、/var/www）
  const segments = parent.split('/').filter(Boolean);
  if (segments.length < 2) return false;

  // 禁止在任何隐藏/元数据目录下嵌套建 .yuyan-state
  if (segments.some((seg) => seg === STATE_ROOT_DIR_NAME || seg === LEGACY_BACKUP_DIR_NAME || seg === LEGACY_MANIFEST_DIR_NAME)) {
    return false;
  }

  // 外置仓绝不能落在目标部署根目录内部（否则就不是外置了）
  if (realRoot && isSameOrSubPath(parent, realRoot)) {
    return false;
  }

  return true;
}

/**
 * 基于真实部署根目录生成全局稳定、人类可读的目录标识（slug）。
 * @description 同一服务器同一 realRoot 在不同终端或重建目标后均映射到完全相同的 slug，防止状态分裂。
 * @param {string} realRoot - 真实部署根目录
 * @returns {string} 目标状态目录 slug（仅包含安全字符）
 */
export function buildTargetStateSlug(realRoot) {
  const normalized = normalizePosixAbsPath(realRoot) || '/';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const rawBase = normalized === '/' ? 'root' : path.posix.basename(normalized);
  const safeBase = rawBase
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(0, 32) || 'app';
  return `${safeBase}-${hash}`;
}

/**
 * 解析并校验自定义带哈希静态资源目录列表（始终包含 assets）。
 * @param {string|string[]|null|undefined} rawDirs - 原始配置（逗号/空白分隔字符串或数组）
 * @returns {string[]} 规范化且安全的顶层目录名数组
 */
export function parseHashedAssetDirs(rawDirs) {
  const items = [];
  if (Array.isArray(rawDirs)) {
    items.push(...rawDirs);
  } else if (typeof rawDirs === 'string') {
    const trimmed = rawDirs.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items.push(...parsed);
      } catch {
        items.push(...trimmed.split(/[,，\s]+/));
      }
    } else if (trimmed) {
      items.push(...trimmed.split(/[,，\s]+/));
    }
  }

  const result = new Set(DEFAULT_HASHED_ASSET_DIRS);
  for (const raw of items) {
    const clean = String(raw || '').trim().replace(/^\/+|\/+$/g, '');
    if (!clean) continue;
    if (!isValidEntryName(clean)) continue;
    if (isReservedDeployEntry(clean)) continue;
    result.add(clean);
  }
  return [...result];
}

/**
 * 格式化前端/接口传入的带哈希目录为数据库存储文本（仅保留合法条目，用逗号连接）。
 * @param {string|string[]|null|undefined} rawDirs - 原始输入
 * @returns {string} 规范化后的逗号分隔文本，空表示使用默认 assets
 */
export function normalizeHashedAssetDirsInput(rawDirs) {
  if (rawDirs === null || rawDirs === undefined) return '';
  const list = Array.isArray(rawDirs)
    ? rawDirs
    : String(rawDirs).split(/[,，]+/);
  const cleaned = [];
  const seen = new Set();
  for (const item of list) {
    const val = String(item || '').trim().replace(/^\/+|\/+$/g, '');
    if (!val) continue;
    if (!isValidEntryName(val) || isReservedDeployEntry(val)) {
      throw new Error(`静态资源目录名不合法：${val}（仅支持单个顶层目录名，不能包含路径斜杠或隐藏目录）`);
    }
    if (!seen.has(val)) {
      seen.add(val);
      cleaned.push(val);
    }
  }
  return cleaned.join(',');
}

/**
 * 构造外置模式布局对象。
 * @param {Object} params - 参数
 * @param {string} params.realRoot - 真实部署根
 * @param {string} params.stateRoot - 外置状态仓根
 * @param {string} params.source - 推导来源
 * @returns {Object} 状态布局
 */
function buildExternalLayout({ realRoot, stateRoot, source }) {
  const normRoot = normalizePosixAbsPath(realRoot);
  const normStateRoot = normalizePosixAbsPath(stateRoot);
  const slug = buildTargetStateSlug(normRoot);
  const targetStateDir = path.posix.join(normStateRoot, STATE_TARGETS_DIR_NAME, slug);
  return {
    mode: 'external',
    source,
    realRoot: normRoot,
    slug,
    stateRoot: normStateRoot,
    objectsDir: path.posix.join(normStateRoot, STATE_OBJECTS_DIR_NAME),
    gcLockDir: path.posix.join(normStateRoot, STATE_GC_LOCK_NAME),
    casUsersDir: path.posix.join(normStateRoot, STATE_CAS_USERS_DIR_NAME),
    metaFilePath: path.posix.join(normStateRoot, STATE_META_FILE_NAME),
    targetStateDir,
    targetMetaFilePath: path.posix.join(targetStateDir, TARGET_META_FILE_NAME),
    backupRoot: path.posix.join(targetStateDir, 'backups'),
    manifestDir: path.posix.join(targetStateDir, 'manifests'),
    legacyBackupRoot: path.posix.join(normRoot, LEGACY_BACKUP_DIR_NAME),
    legacyManifestDir: path.posix.join(normRoot, LEGACY_MANIFEST_DIR_NAME),
  };
}

/**
 * 将任意布局安全降级为内嵌模式（如父目录无写权限时的无感回退）。
 * @param {Object|string} layoutOrRoot - 原布局对象或真实部署根目录
 * @param {string} [reason='inline-fallback'] - 降级原因标识
 * @returns {Object} 内嵌模式布局
 */
export function toInlineStateLayout(layoutOrRoot, reason = 'inline-fallback') {
  const realRoot = typeof layoutOrRoot === 'string'
    ? normalizePosixAbsPath(layoutOrRoot)
    : normalizePosixAbsPath(layoutOrRoot?.realRoot || '');
  const slug = buildTargetStateSlug(realRoot);
  const legacyBackupRoot = path.posix.join(realRoot, LEGACY_BACKUP_DIR_NAME);
  const legacyManifestDir = path.posix.join(realRoot, LEGACY_MANIFEST_DIR_NAME);
  return {
    mode: 'inline',
    source: reason,
    realRoot,
    slug,
    stateRoot: '',
    objectsDir: '',
    gcLockDir: '',
    casUsersDir: '',
    metaFilePath: '',
    targetStateDir: '',
    targetMetaFilePath: '',
    backupRoot: legacyBackupRoot,
    manifestDir: legacyManifestDir,
    legacyBackupRoot,
    legacyManifestDir,
  };
}

/**
 * 解析部署目标对应的状态仓布局（优先目标固定 stateRoot → 托管 Nginx 平级外置仓 → 外部 Nginx → 启发式外置）。
 * @param {Object} params - 解析参数
 * @param {string} params.realRoot - 目标真实部署根目录
 * @param {Object|null} [params.nginxInstance=null] - 关联的 Nginx 实例
 * @param {string} [params.realBaseRoot=''] - 托管 Nginx 真实 baseRoot（穿透软链后，可选）
 * @param {string} [params.realHtmlRoot=''] - Nginx 实例真实 htmlRoot（穿透软链后，可选）
 * @param {string[]} [params.otherTargetRoots=[]] - 同物理机其他部署目标的真实根目录（防止启发式外置仓落入上级站点 web 根）
 * @param {string} [params.pinnedStateRoot=''] - 已持久化固定在目标记录上的 stateRoot（优先级最高，彻底杜绝增删父目标导致漂移）
 * @returns {Object} 状态仓布局对象
 */
export function resolveDeployStateLocation({
  realRoot,
  nginxInstance = null,
  realBaseRoot = '',
  realHtmlRoot = '',
  otherTargetRoots = [],
  pinnedStateRoot = '',
} = {}) {
  const normRealRoot = normalizePosixAbsPath(realRoot);
  if (!normRealRoot || !normRealRoot.startsWith('/')) {
    return toInlineStateLayout(normRealRoot || '/', 'invalid-root');
  }

  // 0. 最高优先级：已持久化固定在目标上的 stateRoot（增删父目标、多层嵌套均绝不漂移，#63）
  const normPinned = normalizePosixAbsPath(pinnedStateRoot || '');
  if (
    normPinned &&
    normPinned.startsWith('/') &&
    path.posix.basename(normPinned) === STATE_ROOT_DIR_NAME
  ) {
    const pinnedParent = path.posix.dirname(normPinned);
    if (isSafeStateParentDir(pinnedParent, normRealRoot)) {
      return buildExternalLayout({
        realRoot: normRealRoot,
        stateRoot: normPinned,
        source: 'pinned-target-state',
      });
    }
  }

  // 1. 优先：托管 Nginx 实例平级外置（<baseRoot>/.yuyan-state）
  if (nginxInstance && nginxInstance.instanceType === 'managed') {
    const instBase = normalizePosixAbsPath(realBaseRoot || nginxInstance.baseRoot || '');
    const instHtml = normalizePosixAbsPath(
      realHtmlRoot || nginxInstance.htmlRoot || (instBase ? path.posix.join(instBase, 'html') : '')
    );
    if (instBase && instHtml && isSameOrSubPath(normRealRoot, instHtml) && isSafeStateParentDir(instBase, normRealRoot)) {
      return buildExternalLayout({
        realRoot: normRealRoot,
        stateRoot: path.posix.join(instBase, STATE_ROOT_DIR_NAME),
        source: 'managed-nginx-sibling',
      });
    }
  }

  // 2. 次选：外部 Nginx 实例若显式配置了 htmlRoot，且目标位于其下，放到 htmlRoot 的平级目录
  if (nginxInstance && (realHtmlRoot || nginxInstance.htmlRoot)) {
    const instHtml = normalizePosixAbsPath(realHtmlRoot || nginxInstance.htmlRoot);
    if (instHtml && isSameOrSubPath(normRealRoot, instHtml)) {
      const siblingParent = path.posix.dirname(instHtml);
      if (isSafeStateParentDir(siblingParent, normRealRoot)) {
        return buildExternalLayout({
          realRoot: normRealRoot,
          stateRoot: path.posix.join(siblingParent, STATE_ROOT_DIR_NAME),
          source: 'external-nginx-sibling',
        });
      }
    }
  }

  // 3. 启发式平级外置：识别常见 html/www/htdocs/webroot 层级，确保状态仓落在 webRoot 之外
  const normalizedOthers = (otherTargetRoots || [])
    .map(normalizePosixAbsPath)
    .filter((p) => p && p.startsWith('/') && p !== normRealRoot);
  const isInsideAnyWebRoot = (dir) => normalizedOthers.some((otherRoot) => isSameOrSubPath(dir, otherRoot));

  const segments = normRealRoot.split('/').filter(Boolean);
  let candidateParent = '';
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    if (COMMON_WEB_ROOT_NAMES.has(segments[i].toLowerCase())) {
      candidateParent = `/${segments.slice(0, i).join('/')}`;
      break;
    }
  }
  if (!candidateParent) {
    candidateParent = path.posix.dirname(normRealRoot);
  }
  // 嵌套项目防护（#63）：若推导出的候选父目录本身是上级站点部署根（或其子目录），继续向上跳出上级 web 根
  let guard = 0;
  while (candidateParent && isInsideAnyWebRoot(candidateParent) && guard < 8) {
    const upper = path.posix.dirname(candidateParent);
    if (!upper || upper === candidateParent) {
      candidateParent = '';
      break;
    }
    candidateParent = upper;
    guard += 1;
  }
  if (candidateParent && !isInsideAnyWebRoot(candidateParent) && isSafeStateParentDir(candidateParent, normRealRoot)) {
    return buildExternalLayout({
      realRoot: normRealRoot,
      stateRoot: path.posix.join(candidateParent, STATE_ROOT_DIR_NAME),
      source: 'heuristic-sibling',
    });
  }

  // 4. 安全兜底：回落内嵌模式
  return toInlineStateLayout(normRealRoot, 'inline-fallback');
}

/**
 * 解析目标的首选外置状态仓布局及全部可能的历史兼容候选布局（支持固定 stateRoot + 向上多层祖先仓枚举，#63）。
 * @description
 * 1. 若传入合法 pinnedStateRoot，primary 即为固定仓；
 * 2. 同时枚举不带 pinned/otherTargetRoots 的默认推算仓，以及沿 dirname(realRoot) 向上逐级（最多 8 层）
 *    所有合法安全父目录下的 `.yuyan-state`，彻底覆盖「三层嵌套新建父目标」与「删除父目标反向漂移」的历史老仓。
 * @param {Object} params - 同 resolveDeployStateLocation
 * @returns {{ primary: Object, legacyCandidates: Array<Object>, allExternal: Array<Object> }}
 */
export function resolveCandidateDeployStateLocations(params = {}) {
  const primary = resolveDeployStateLocation(params);
  const normRealRoot = normalizePosixAbsPath(params?.realRoot || '');
  const seen = new Set();
  const allExternal = [];
  const legacyCandidates = [];

  const registerLayout = (layout, isPrimary = false) => {
    if (!layout || layout.mode !== 'external' || !layout.stateRoot) return;
    const sr = normalizePosixAbsPath(layout.stateRoot);
    if (!sr || seen.has(sr)) return;
    seen.add(sr);
    allExternal.push(layout);
    if (!isPrimary) legacyCandidates.push(layout);
  };

  registerLayout(primary, true);

  // 兼容：不带 pinnedStateRoot 的当前规则推导
  const unpinnedPrimary = params?.pinnedStateRoot
    ? resolveDeployStateLocation({ ...params, pinnedStateRoot: '' })
    : primary;
  if (params?.pinnedStateRoot) {
    registerLayout(unpinnedPrimary);
  }

  // 兼容：不带 otherTargetRoots 的历史规则推导（优先排在 legacyCandidates 首位，覆盖最常见的新增父目标粘性仓）
  if (Array.isArray(params?.otherTargetRoots) && params.otherTargetRoots.length > 0) {
    registerLayout(resolveDeployStateLocation({ ...params, pinnedStateRoot: '', otherTargetRoots: [] }));
  }

  // 兼容：仅对非托管/启发式布局，沿 dirname(realRoot) 向上枚举合法安全父目录（最多 6 层），
  // 覆盖「三层嵌套新建父目标」与「删除父目标反向漂移」的历史老仓；托管 Nginx / htmlRoot 内目标路径恒定无需漫游祖先。
  const isHeuristicFlow =
    unpinnedPrimary.source !== 'managed-nginx-base' && unpinnedPrimary.source !== 'nginx-html-parent';
  if (isHeuristicFlow && normRealRoot && normRealRoot.startsWith('/')) {
    let anc = path.posix.dirname(normRealRoot);
    let depth = 0;
    while (anc && anc !== '/' && depth < 6) {
      if (isSafeStateParentDir(anc, normRealRoot)) {
        registerLayout(
          buildExternalLayout({
            realRoot: normRealRoot,
            stateRoot: path.posix.join(anc, STATE_ROOT_DIR_NAME),
            source: 'ancestor-legacy-candidate',
          })
        );
      }
      const next = path.posix.dirname(anc);
      if (!next || next === anc) break;
      anc = next;
      depth += 1;
    }
  }

  return { primary, legacyCandidates, allExternal };
}

/**
 * 解析托管 Nginx 实例级别的外置状态仓路径。
 * @param {Object} nginxInstance - Nginx 实例对象
 * @returns {{ stateRoot: string, objectsDir: string, targetsDir: string, gcLockDir: string, htmlRoot: string, baseRoot: string } | null}
 */
export function resolveNginxInstanceStatePaths(nginxInstance) {
  if (!nginxInstance) return null;
  const baseRoot = normalizePosixAbsPath(nginxInstance.baseRoot || '');
  const htmlRoot = normalizePosixAbsPath(nginxInstance.htmlRoot || (baseRoot ? path.posix.join(baseRoot, 'html') : ''));
  let parentDir = '';
  if (nginxInstance.instanceType === 'managed' && baseRoot && isSafeStateParentDir(baseRoot)) {
    parentDir = baseRoot;
  } else if (htmlRoot) {
    const parent = path.posix.dirname(htmlRoot);
    if (isSafeStateParentDir(parent)) parentDir = parent;
  }
  if (!parentDir) return null;
  const stateRoot = path.posix.join(parentDir, STATE_ROOT_DIR_NAME);
  return {
    baseRoot: parentDir,
    htmlRoot,
    stateRoot,
    objectsDir: path.posix.join(stateRoot, STATE_OBJECTS_DIR_NAME),
    targetsDir: path.posix.join(stateRoot, STATE_TARGETS_DIR_NAME),
    gcLockDir: path.posix.join(stateRoot, STATE_GC_LOCK_NAME),
    casUsersDir: path.posix.join(stateRoot, STATE_CAS_USERS_DIR_NAME),
  };
}

/**
 * 判断某绝对路径是否属于外置状态仓下的备份路径，若是则反推出 stateRoot 与 objectsDir。
 * @param {string} backupPath - 备份绝对路径
 * @returns {{ isExternal: boolean, stateRoot: string, objectsDir: string, targetStateDir: string }}
 */
export function parseExternalBackupPath(backupPath) {
  const norm = normalizePosixAbsPath(backupPath);
  const marker = `/${STATE_ROOT_DIR_NAME}/${STATE_TARGETS_DIR_NAME}/`;
  const idx = norm.indexOf(marker);
  if (idx === -1) {
    return { isExternal: false, stateRoot: '', objectsDir: '', targetStateDir: '' };
  }
  const stateRoot = norm.slice(0, idx + STATE_ROOT_DIR_NAME.length + 1);
  const rest = norm.slice(idx + marker.length);
  const slug = rest.split('/')[0] || '';
  if (!slug || slug === '.' || slug === '..') {
    return { isExternal: false, stateRoot: '', objectsDir: '', targetStateDir: '' };
  }
  return {
    isExternal: true,
    stateRoot,
    objectsDir: path.posix.join(stateRoot, STATE_OBJECTS_DIR_NAME),
    targetStateDir: path.posix.join(stateRoot, STATE_TARGETS_DIR_NAME, slug),
  };
}

/** 判断备份归属。历史内嵌备份也可沿用调用方传入的配置路径。 */
export function backupPathBelongsToDeployRoot(backupPath, realRoot, extraInlineRoots = []) {
  const backup = normalizePosixAbsPath(backupPath);
  const root = normalizePosixAbsPath(realRoot);
  if (!backup.startsWith('/') || !root.startsWith('/')) return false;

  const backupParent = path.posix.dirname(backup);
  const external = parseExternalBackupPath(backup);
  if (external.isExternal) {
    return path.posix.basename(external.targetStateDir) === buildTargetStateSlug(root) &&
      backupParent === path.posix.join(external.targetStateDir, 'backups');
  }
  const inlineRoot = path.posix.dirname(backupParent);
  return path.posix.basename(backupParent) === LEGACY_BACKUP_DIR_NAME &&
    (inlineRoot === root || extraInlineRoots.some((candidate) => normalizePosixAbsPath(candidate) === inlineRoot));
}

/**
 * 解析部署目标的三维备份保留策略（份数 + 空间上限 MB + TTL 天数）及带哈希资源目录。
 * 强制满足：
 * 1. backupKeepCount >= 1（至少硬保底保留最新 1 份）；
 * 2. manifestKeepCount >= backupKeepCount（防止差一误删静态资源）；
 * 3. backupMaxSizeMb / backupTtlDays 传 0 表示不限制，null/undefined/'' 表示使用全局默认（200MB / 14天）。
 * @param {Object} [target={}] - 部署目标对象
 * @returns {{
 *   backupKeepCount: number,
 *   manifestKeepCount: number,
 *   backupMaxSizeMb: number,
 *   backupTtlDays: number,
 *   hashedAssetDirs: string[],
 *   orphanAssetMinAgeDays: number,
 *   minKeepCount: number,
 * }}
 */
export function resolveDeployRetentionPolicy(target = {}) {
  const isCleanReplace = String(target?.uploadStrategy || '') === 'cleanReplace';
  const strategyDefaultKeep = isCleanReplace
    ? Math.max(1, Number(DEPLOY_BACKUP_KEEP_FULL || 3))
    : Math.max(1, Number(DEPLOY_BACKUP_KEEP_ENTRY || 6));
  const fallbackDefaultKeep = DEPLOY_BACKUP_KEEP_PER_TARGET
    ? Math.max(1, Number(DEPLOY_BACKUP_KEEP_PER_TARGET))
    : strategyDefaultKeep;

  const rawBackupKeep = target?.backupKeepCount;
  const parsedBackupKeep = rawBackupKeep === null || rawBackupKeep === undefined || rawBackupKeep === ''
    ? NaN
    : Number(rawBackupKeep);
  const backupKeepCount = Number.isInteger(parsedBackupKeep) && parsedBackupKeep > 0
    ? Math.min(50, parsedBackupKeep)
    : fallbackDefaultKeep;

  const rawManifestKeep = target?.manifestKeepCount;
  const parsedManifestKeep = rawManifestKeep === null || rawManifestKeep === undefined || rawManifestKeep === ''
    ? NaN
    : Number(rawManifestKeep);
  let manifestKeepCount = Number.isInteger(parsedManifestKeep) && parsedManifestKeep > 0
    ? Math.min(100, parsedManifestKeep)
    : backupKeepCount;
  if (manifestKeepCount < backupKeepCount) {
    manifestKeepCount = backupKeepCount;
  }

  const rawMaxSize = target?.backupMaxSizeMb;
  const parsedMaxSize = rawMaxSize === null || rawMaxSize === undefined || rawMaxSize === ''
    ? NaN
    : Number(rawMaxSize);
  const backupMaxSizeMb = Number.isInteger(parsedMaxSize) && parsedMaxSize >= 0
    ? Math.min(102400, parsedMaxSize)
    : Math.max(0, Number(DEPLOY_BACKUP_MAX_SIZE_MB ?? 200));

  const rawTtl = target?.backupTtlDays;
  const parsedTtl = rawTtl === null || rawTtl === undefined || rawTtl === ''
    ? NaN
    : Number(rawTtl);
  const backupTtlDays = Number.isInteger(parsedTtl) && parsedTtl >= 0
    ? Math.min(3650, parsedTtl)
    : Math.max(0, Number(DEPLOY_BACKUP_TTL_DAYS ?? 14));

  const hashedAssetDirs = parseHashedAssetDirs(target?.hashedAssetDirs);

  return {
    backupKeepCount,
    manifestKeepCount,
    backupMaxSizeMb,
    backupTtlDays,
    hashedAssetDirs,
    orphanAssetMinAgeDays: Math.max(1, Number(DEPLOY_ORPHAN_ASSET_MIN_AGE_DAYS || 7)),
    minKeepCount: 1,
  };
}
