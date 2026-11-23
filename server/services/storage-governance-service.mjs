/**
 * 部署存储诊断与垃圾回收治理服务
 * @description 提供托管 Nginx 实例 / 部署目标维度的存储占用透视、存量内嵌 .yuyan-backups 清理、
 * 三维备份瘦身、CAS 对象池 GC 以及两段式（预览→确认）无主历史静态资源清理能力。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import {
  clearTargetBackupReferencesByPaths,
  getNginxInstanceContext,
  getTarget,
  listBackupReferencesByTargetIds,
  listPhysicalServerTargets,
  listTargets,
  syncTargetBackupReferences,
} from './deploy-store.mjs';
import { getRequestTeamId } from './request-context.mjs';
import { execSsh, withSsh } from './ssh-service.mjs';
import { getTestHooks } from './test-hooks.mjs';
import {
  isReservedDeployEntry,
  isSharedDeployRoot,
  isValidEntryName,
  resolveTopmostLockRoot,
} from './deploy-cleanup-policy.mjs';
import {
  buildTargetStateSlug,
  DEFAULT_HASHED_ASSET_DIRS,
  isSameOrSubPath,
  LEGACY_BACKUP_DIR_NAME,
  LEGACY_MANIFEST_DIR_NAME,
  normalizePosixAbsPath,
  resolveDeployRetentionPolicy,
  resolveDeployStateLocation,
  resolveNginxInstanceStatePaths,
  STATE_OBJECTS_DIR_NAME,
  STATE_ROOT_DIR_NAME,
  STATE_TARGETS_DIR_NAME,
  TARGET_META_FILE_NAME,
} from './deploy-state-layout.mjs';
import {
  BACKUP_KIND_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  BACKUP_META_FILE_NAME,
  buildCasObjectPoolGcCommand,
  buildPosixShellCommand,
  buildPruneBackupsCommand,
  CAS_INDEX_FILE_NAME,
  DEFAULT_CAS_GC_GRACE_MINUTES,
  DEPLOY_CURRENT_MANIFEST_NAME,
  parseCasGcOutput,
  parsePruneBackupsOutput,
} from './deploy-cas-backup.mjs';
import {
  acquireDeployRootLocks,
  batchDetectRealRoots,
  getTargetContext,
  resolveEffectiveDeploySudo,
  resolveProtectedEntriesWithDetails,
} from './deploy-service.mjs';

/** 无主静态资源预检令牌有效期（15 分钟） */
const ORPHAN_PREVIEW_TTL_MS = 15 * 60_000;

/** 内存态无主静态资源预检缓存（previewToken -> 校验上下文） */
const orphanAssetPreviewStore = new Map();

/** 常见前端静态资源扩展名 */
const BUILD_ASSET_EXT_REGEX = /\.(js|mjs|cjs|css|woff2?|ttf|eot|otf|png|jpe?g|gif|webp|avif|svg|ico|wasm|json)$/i;

/**
 * 清理过期的无主资源预检令牌。
 */
function purgeExpiredOrphanPreviews() {
  const now = Date.now();
  for (const [token, entry] of orphanAssetPreviewStore.entries()) {
    if (!entry || entry.expiresAt <= now) {
      orphanAssetPreviewStore.delete(token);
    }
  }
}

/**
 * 判断相对路径是否符合典型前端构建哈希产物命名特征（如 Vite/Rollup/Webpack chunk、含 .br/.gz/.map）。
 * 严防将人工放置的普通语义命名文件（如 logo-homepage.png）误标为高置信度构建垃圾。
 * @param {string} relPath - 相对路径（如 assets/index-B3kL9x2A.js.br）
 * @returns {boolean} 是否高置信度带哈希构建产物
 */
export function isLikelyHashedBuildAsset(relPath) {
  const base = path.posix.basename(String(relPath || '').trim());
  if (!base || base.startsWith('.')) return false;

  // 剥离常见压缩与 sourcemap 尾后缀
  let stripped = base;
  while (/\.(gz|br|map)$/i.test(stripped)) {
    stripped = stripped.replace(/\.(gz|br|map)$/i, '');
  }
  if (!BUILD_ASSET_EXT_REGEX.test(stripped)) return false;

  const stem = stripped.replace(/\.[^.]+$/, '');
  const parts = stem.split(/[-.]/).filter(Boolean);
  if (parts.length < 2) return false;

  const lastToken = parts[parts.length - 1];
  if (lastToken.length < 8 || lastToken.length > 64) return false;
  if (!/^[a-zA-Z0-9_]+$/.test(lastToken)) return false;

  // 必须包含数字（规避 -homepage / -dashboard 等纯英文语义词），或为 8+ 位 hex
  const hasDigit = /\d/.test(lastToken);
  const isPureHex8 = /^[a-fA-F0-9]{8,}$/.test(lastToken);
  if (!hasDigit && !isPureHex8) return false;

  // 排除纯日期/时间戳命名如 20261123 以外的纯数字版本号若仅有数字仍可能是 hash，但至少 8 位
  if (/^(19|20)\d{6}$/.test(lastToken)) return false;
  return true;
}

/**
 * 严格校验待删除的单个备份目录路径是否属于合法雨燕备份路径，防止任何越界删除。
 * @param {string} backupPath - 待删备份绝对路径
 * @returns {string} 规范化后的安全路径
 */
export function assertSafeBackupEntryPath(backupPath) {
  const raw = String(backupPath || '').trim();
  if (!raw || !raw.startsWith('/')) {
    throw new Error(`非法备份路径（必须为绝对路径）：${raw}`);
  }
  if (/[\r\n\x00]/.test(raw) || raw.includes('..')) {
    throw new Error(`非法备份路径（包含危险字符或路径穿越）：${raw}`);
  }
  const normalized = normalizePosixAbsPath(raw);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 3) {
    throw new Error(`非法备份路径（层级过浅）：${normalized}`);
  }
  const entryName = parts[parts.length - 1];
  if (!isValidEntryName(entryName) || entryName.startsWith('.')) {
    throw new Error(`非法备份条目名：${entryName}`);
  }

  // 允许模式 1：<root>/.yuyan-backups/<entryName>
  const parentName = parts[parts.length - 2];
  if (parentName === LEGACY_BACKUP_DIR_NAME) {
    return normalized;
  }

  // 允许模式 2：<stateParent>/.yuyan-state/targets/<slug>/backups/<entryName>
  if (
    parts.length >= 5 &&
    parts[parts.length - 2] === 'backups' &&
    parts[parts.length - 4] === STATE_TARGETS_DIR_NAME &&
    parts[parts.length - 5] === STATE_ROOT_DIR_NAME &&
    isValidEntryName(parts[parts.length - 3])
  ) {
    return normalized;
  }

  throw new Error(`拒绝删除非雨燕备份目录路径：${normalized}`);
}

/**
 * 返回跨 GNU Linux / BSD(macOS) 的文件统计函数片段。
 * @returns {string[]} Shell 行
 */
function buildPortableStatLines() {
  return [
    'if stat -c "%s" / >/dev/null 2>&1; then',
    '  yuyan_file_size() { stat -c "%s" "$1" 2>/dev/null || echo 0; }',
    '  yuyan_file_mtime() { stat -c "%Y" "$1" 2>/dev/null || echo 0; }',
    'else',
    '  yuyan_file_size() { stat -f "%z" "$1" 2>/dev/null || echo 0; }',
    '  yuyan_file_mtime() { stat -f "%m" "$1" 2>/dev/null || echo 0; }',
    'fi',
    'yuyan_dir_bytes() {',
    '  if [ ! -e "$1" ]; then echo 0; return 0; fi',
    '  kb=$(du -sk "$1" 2>/dev/null | awk \'{print $1}\')',
    '  case "$kb" in ""|*[!0-9]*) kb=0 ;; esac',
    '  echo $((kb * 1024))',
    '}',
  ];
}

/**
 * 生成扫描 Nginx 实例或指定目标列表存储占用的远程只读 Shell 命令。
 * @param {Object} params - 扫描参数
 * @param {string} [params.htmlRoot=''] - 实例 htmlRoot
 * @param {string} [params.stateRoot=''] - 实例外置 .yuyan-state 根目录
 * @param {string[]} [params.targetRoots=[]] - 已纳管前端目标的 deployRoot 列表
 * @param {boolean} [params.useSudo=false] - 是否 sudo
 * @returns {string} 远程只读命令
 */
export function buildInspectNginxStorageCommand({
  htmlRoot = '',
  stateRoot = '',
  targetRoots = [],
  useSudo = false,
} = {}) {
  const safeRoots = [...new Set((targetRoots || []).map(normalizePosixAbsPath).filter((p) => p && p.startsWith('/')))];

  const script = [
    '# yuyan:inspect-storage',
    'set -u',
    'html_root="$1"',
    'state_root="$2"',
    'shift 2',
    ...buildPortableStatLines(),
    'tmp_app_roots=$(mktemp)',
    'cleanup() { rm -f "$tmp_app_roots" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    '',
    '# 1. 输出 htmlRoot 总体积',
    'html_exists=0',
    'html_total_bytes=0',
    'if [ -n "$html_root" ] && [ -d "$html_root" ]; then',
    '  html_exists=1',
    '  html_total_bytes=$(yuyan_dir_bytes "$html_root")',
    'fi',
    'printf "HTML_ROOT\\t%s\\t%s\\t%s\\n" "$html_root" "$html_exists" "$html_total_bytes"',
    '',
    '# 2. 输出外置状态仓总览与对象池物理占用',
    'state_exists=0',
    'state_total_bytes=0',
    'objects_bytes=0',
    'objects_count=0',
    'if [ -n "$state_root" ] && [ -d "$state_root" ]; then',
    '  state_exists=1',
    '  state_total_bytes=$(yuyan_dir_bytes "$state_root")',
    `  if [ -d "$state_root/${STATE_OBJECTS_DIR_NAME}" ]; then`,
    `    objects_bytes=$(yuyan_dir_bytes "$state_root/${STATE_OBJECTS_DIR_NAME}")`,
    `    objects_count=$(find "$state_root/${STATE_OBJECTS_DIR_NAME}" -mindepth 2 -maxdepth 2 -type f 2>/dev/null | wc -l | tr -d " ")`,
    '  fi',
    'fi',
    'printf "STATE_ROOT\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$state_root" "$state_exists" "$state_total_bytes" "$objects_bytes" "$objects_count"',
    '',
    '# 3. 收集全部需要扫描的应用目录（含 htmlRoot 自身、子目录含 .yuyan-backups/.yuyan-manifests 的目录，以及所有纳管目标）',
    'for r in "$@"; do',
    '  [ -n "$r" ] && printf "%s\\n" "$r" >> "$tmp_app_roots"',
    'done',
    'if [ -n "$html_root" ] && [ -d "$html_root" ]; then',
    '  printf "%s\\n" "$html_root" >> "$tmp_app_roots"',
    '  # 扫描一级子目录（常见微应用目录）及二级内含 .yuyan-backups 的目录',
    '  for sub in "$html_root"/*; do',
    '    [ -d "$sub" ] || continue',
    '    bname=$(basename "$sub")',
    '    case "$bname" in ""|"."|".."|.*) continue ;; esac',
    '    printf "%s\\n" "$sub" >> "$tmp_app_roots"',
    '  done',
    `  find "$html_root" -maxdepth 3 -type d \\( -name "${LEGACY_BACKUP_DIR_NAME}" -o -name "${LEGACY_MANIFEST_DIR_NAME}" \\) 2>/dev/null | while IFS= read -r mdir; do`,
    '    dirname "$mdir" >> "$tmp_app_roots"',
    '  done',
    'fi',
    '',
    '# 4. 遍历外置仓 targets/<slug> 读取归属元信息与外置快照明细',
    `if [ -n "$state_root" ] && [ -d "$state_root/${STATE_TARGETS_DIR_NAME}" ]; then`,
    `  for tdir in "$state_root/${STATE_TARGETS_DIR_NAME}"/*; do`,
    '    [ -d "$tdir" ] || continue',
    '    slug=$(basename "$tdir")',
    '    case "$slug" in ""|"."|".."|.*) continue ;; esac',
    '    mapped_root=""',
    `    if [ -f "$tdir/${TARGET_META_FILE_NAME}" ]; then`,
    `      mapped_root=$(sed -n 's/.*"realRoot"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$tdir/${TARGET_META_FILE_NAME}" | head -n 1 || true)`,
    '    fi',
    '    has_ext_manifest=0',
    `    if [ -f "$tdir/manifests/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_ext_manifest=1; fi`,
    '    printf "EXT_TARGET\\t%s\\t%s\\t%s\\t%s\\n" "$slug" "$mapped_root" "$tdir" "$has_ext_manifest"',
    '    if [ -n "$mapped_root" ]; then printf "%s\\n" "$mapped_root" >> "$tmp_app_roots"; fi',
    '    if [ -d "$tdir/backups" ]; then',
    '      for bdir in "$tdir/backups"/*; do',
    '        [ -d "$bdir" ] || continue',
    '        bname=$(basename "$bdir")',
    '        case "$bname" in ""|"."|".."|.*) continue ;; esac',
    '        bkind="full"',
    `        if [ -f "$bdir/${BACKUP_KIND_FILE_NAME}" ]; then bkind=$(tr -d "[:space:]" < "$bdir/${BACKUP_KIND_FILE_NAME}"); fi`,
    '        bts=0',
    '        blogical=0',
    `        if [ -f "$bdir/${BACKUP_META_FILE_NAME}" ]; then`,
    `          bts=$(sed -n 's/.*"createdAtEpoch":\\([0-9][0-9]*\\).*/\\1/p' "$bdir/${BACKUP_META_FILE_NAME}" | head -n 1 || true)`,
    `          blogical=$(sed -n 's/.*"logicalBytes":\\([0-9][0-9]*\\).*/\\1/p' "$bdir/${BACKUP_META_FILE_NAME}" | head -n 1 || true)`,
    '        fi',
    '        case "$bts" in ""|*[!0-9]*|0) bts=$(yuyan_file_mtime "$bdir") ;; esac',
    '        bphys=$(yuyan_dir_bytes "$bdir")',
    '        case "$blogical" in ""|*[!0-9]*|0) blogical="$bphys" ;; esac',
    '        printf "BACKUP\\texternal\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$slug" "$mapped_root" "$bdir" "$bkind" "$bts" "$bphys" "$blogical"',
    '      done',
    '    fi',
    '  done',
    'fi',
    '',
    '# 5. 对去重后的每个应用目录统计运行态、内嵌备份、内嵌清单、暂存垃圾及 assets 体积',
    'sort -u "$tmp_app_roots" | while IFS= read -r app_dir; do',
    '  [ -n "$app_dir" ] || continue',
    '  if [ ! -d "$app_dir" ]; then',
    '    printf "APP\\t%s\\t0\\t0\\t0\\t0\\t0\\t0\\t0\\t0\\n" "$app_dir"',
    '    continue',
    '  fi',
    '  total_b=$(yuyan_dir_bytes "$app_dir")',
    `  ib_dir="$app_dir/${LEGACY_BACKUP_DIR_NAME}"`,
    `  im_dir="$app_dir/${LEGACY_MANIFEST_DIR_NAME}"`,
    '  ib_bytes=0',
    '  ib_count=0',
    '  if [ -d "$ib_dir" ]; then',
    '    ib_bytes=$(yuyan_dir_bytes "$ib_dir")',
    '    for bdir in "$ib_dir"/*; do',
    '      [ -d "$bdir" ] || continue',
    '      bname=$(basename "$bdir")',
    '      case "$bname" in ""|"."|".."|.*) continue ;; esac',
    '      ib_count=$((ib_count + 1))',
    '      bkind="full"',
    `      if [ -f "$bdir/${BACKUP_KIND_FILE_NAME}" ]; then bkind=$(tr -d "[:space:]" < "$bdir/${BACKUP_KIND_FILE_NAME}"); fi`,
    '      bts=$(yuyan_file_mtime "$bdir")',
    '      bphys=$(yuyan_dir_bytes "$bdir")',
    '      printf "BACKUP\\tinline\\t\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$app_dir" "$bdir" "$bkind" "$bts" "$bphys" "$bphys"',
    '    done',
    '  fi',
    '  im_bytes=0',
    '  has_im_current=0',
    '  if [ -d "$im_dir" ]; then',
    '    im_bytes=$(yuyan_dir_bytes "$im_dir")',
    `    if [ -f "$im_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_im_current=1; fi`,
    '  fi',
    '  staging_bytes=0',
    '  for sdir in "$app_dir"/.yuyan-retiring-* "$app_dir"/.yuyan-trash-*; do',
    '    [ -e "$sdir" ] || continue',
    '    sb=$(yuyan_dir_bytes "$sdir")',
    '    staging_bytes=$((staging_bytes + sb))',
    '  done',
    '  assets_bytes=0',
    '  if [ -d "$app_dir/assets" ]; then',
    '    assets_bytes=$(yuyan_dir_bytes "$app_dir/assets")',
    '  fi',
    '  printf "APP\\t%s\\t1\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$app_dir" "$total_b" "$ib_bytes" "$ib_count" "$im_bytes" "$staging_bytes" "$has_im_current" "$assets_bytes"',
    'done',
  ].join('\n');

  return buildPosixShellCommand(script, [htmlRoot || '', stateRoot || '', ...safeRoots], useSudo);
}

/**
 * 解析远程存储扫描输出并与部署目标、DB 回滚记录关联聚合。
 * @param {string} stdout - 远程扫描输出
 * @param {Object} [context={}] - 上下文（targets、backupReferences、nginxInstance）
 * @returns {Object} 结构化存储诊断报告
 */
export function parseInspectNginxStorageOutput(stdout, context = {}) {
  const { targets = [], backupReferences = [], nginxInstance = null } = context;
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);

  const htmlRootInfo = { path: '', exists: false, totalBytes: 0 };
  const stateRootInfo = { path: '', exists: false, totalBytes: 0, objectsBytes: 0, objectsCount: 0 };
  const extTargetsBySlug = new Map();
  const extTargetsByRoot = new Map();
  const appMap = new Map();
  const allBackups = [];

  for (const line of lines) {
    const cols = line.split('\t');
    const tag = cols[0];
    if (tag === 'HTML_ROOT') {
      htmlRootInfo.path = cols[1] || '';
      htmlRootInfo.exists = cols[2] === '1';
      htmlRootInfo.totalBytes = Number(cols[3] || 0) || 0;
    } else if (tag === 'STATE_ROOT') {
      stateRootInfo.path = cols[1] || '';
      stateRootInfo.exists = cols[2] === '1';
      stateRootInfo.totalBytes = Number(cols[3] || 0) || 0;
      stateRootInfo.objectsBytes = Number(cols[4] || 0) || 0;
      stateRootInfo.objectsCount = Number(cols[5] || 0) || 0;
    } else if (tag === 'EXT_TARGET') {
      const slug = cols[1] || '';
      const mappedRoot = normalizePosixAbsPath(cols[2] || '');
      const stateDir = cols[3] || '';
      const hasExternalManifest = cols[4] === '1';
      const item = { slug, mappedRoot, stateDir, hasExternalManifest };
      if (slug) extTargetsBySlug.set(slug, item);
      if (mappedRoot) extTargetsByRoot.set(mappedRoot, item);
    } else if (tag === 'APP') {
      const appPath = normalizePosixAbsPath(cols[1] || '');
      if (!appPath) continue;
      appMap.set(appPath, {
        path: appPath,
        exists: cols[2] === '1',
        totalBytes: Number(cols[3] || 0) || 0,
        inlineBackupBytes: Number(cols[4] || 0) || 0,
        inlineBackupCount: Number(cols[5] || 0) || 0,
        inlineManifestBytes: Number(cols[6] || 0) || 0,
        stagingBytes: Number(cols[7] || 0) || 0,
        hasInlineManifest: cols[8] === '1',
        assetsBytes: Number(cols[9] || 0) || 0,
      });
    } else if (tag === 'BACKUP') {
      const storageMode = cols[1] === 'external' ? 'external' : 'inline';
      const slug = cols[2] || '';
      const appRoot = normalizePosixAbsPath(cols[3] || '');
      const backupPath = normalizePosixAbsPath(cols[4] || '');
      if (!backupPath) continue;
      allBackups.push({
        storageMode,
        slug,
        appRoot,
        backupPath,
        name: path.posix.basename(backupPath),
        kind: cols[5] || 'full',
        createdAtEpoch: Number(cols[6] || 0) || 0,
        createdAt: Number(cols[6] || 0) > 0 ? new Date(Number(cols[6]) * 1000).toISOString() : '',
        physicalBytes: Number(cols[7] || 0) || 0,
        logicalBytes: Number(cols[8] || 0) || 0,
      });
    }
  }

  // 构建 DB 目标与回滚引用索引
  const targetByRoot = new Map();
  const targetBySlug = new Map();
  for (const t of targets) {
    if (!t?.deployRoot) continue;
    const normRoot = normalizePosixAbsPath(t.deployRoot);
    targetByRoot.set(normRoot, t);
    targetBySlug.set(buildTargetStateSlug(normRoot), t);
  }
  const refByBackupPath = new Map();
  for (const ref of backupReferences) {
    const bp = normalizePosixAbsPath(ref.backupPath);
    if (bp) refByBackupPath.set(bp, ref);
  }

  // 关联每条备份的归属应用与 DB 引用状态
  const backupsByAppKey = new Map();
  let inlineBackupTotalBytes = 0;
  let inlineBackupTotalCount = 0;
  let externalBackupTotalCount = 0;
  let externalLogicalTotalBytes = 0;
  let unreferencedBackupBytes = 0;
  let unreferencedBackupCount = 0;

  for (const b of allBackups) {
    const dbRef = refByBackupPath.get(b.backupPath) || null;
    const enriched = {
      ...b,
      referencedByDb: Boolean(dbRef),
      recordId: dbRef?.id || 0,
      branch: dbRef?.branch || '',
      commitSha: dbRef?.commitSha || '',
    };

    const resolvedRoot = b.appRoot || extTargetsBySlug.get(b.slug)?.mappedRoot || targetBySlug.get(b.slug)?.deployRoot || '';
    const appKey = resolvedRoot ? normalizePosixAbsPath(resolvedRoot) : `external:${b.slug}`;
    if (!backupsByAppKey.has(appKey)) backupsByAppKey.set(appKey, []);
    backupsByAppKey.get(appKey).push(enriched);

    if (b.storageMode === 'inline') {
      inlineBackupTotalBytes += b.physicalBytes;
      inlineBackupTotalCount += 1;
    } else {
      externalBackupTotalCount += 1;
      externalLogicalTotalBytes += b.logicalBytes;
    }

    if (!enriched.referencedByDb) {
      unreferencedBackupCount += 1;
      unreferencedBackupBytes += b.storageMode === 'inline' ? b.physicalBytes : b.logicalBytes;
    }
  }

  // 汇总每个应用条目（含孤儿目录）
  const allAppKeys = new Set([...appMap.keys(), ...backupsByAppKey.keys()]);
  const apps = [];
  let inlineManifestTotalBytes = 0;
  let inlineStagingTotalBytes = 0;

  for (const key of allAppKeys) {
    const stat = appMap.get(key) || {
      path: key.startsWith('external:') ? '' : key,
      exists: false,
      totalBytes: 0,
      inlineBackupBytes: 0,
      inlineBackupCount: 0,
      inlineManifestBytes: 0,
      stagingBytes: 0,
      hasInlineManifest: false,
      assetsBytes: 0,
    };
    const appBackups = (backupsByAppKey.get(key) || []).sort((a, b) => b.createdAtEpoch - a.createdAtEpoch);
    const target = stat.path ? targetByRoot.get(stat.path) || null : null;
    const slug = stat.path ? buildTargetStateSlug(stat.path) : key.replace(/^external:/, '');
    const extMeta = (stat.path && extTargetsByRoot.get(stat.path)) || extTargetsBySlug.get(slug) || null;

    const inlineBackups = appBackups.filter((b) => b.storageMode === 'inline');
    const externalBackups = appBackups.filter((b) => b.storageMode === 'external');
    const externalLogicalBytes = externalBackups.reduce((sum, b) => sum + b.logicalBytes, 0);
    const unreferencedCount = appBackups.filter((b) => !b.referencedByDb).length;

    // 跳过 htmlRoot 下既未纳管又无任何备份/清单/暂存的纯静态杂项目录（减少噪音）
    const isHtmlRootSelf = htmlRootInfo.path && stat.path === normalizePosixAbsPath(htmlRootInfo.path);
    const hasGovernanceSignal =
      Boolean(target) ||
      stat.inlineBackupCount > 0 ||
      stat.inlineManifestBytes > 0 ||
      stat.stagingBytes > 0 ||
      externalBackups.length > 0;
    if (!hasGovernanceSignal && !isHtmlRootSelf) continue;

    inlineManifestTotalBytes += stat.inlineManifestBytes;
    inlineStagingTotalBytes += stat.stagingBytes;

    const runtimeBytes = Math.max(
      0,
      stat.totalBytes - stat.inlineBackupBytes - stat.inlineManifestBytes - stat.stagingBytes
    );
    const policy = target ? resolveDeployRetentionPolicy(target) : null;
    const sharedRoot = target
      ? isSharedDeployRoot({ target, allServerTargets: targets, nginxInstance })
      : Boolean(isHtmlRootSelf);

    apps.push({
      key,
      deployRoot: stat.path,
      slug,
      displayName: target?.projectName || (isHtmlRootSelf ? '站点根目录 (html)' : path.posix.basename(stat.path || slug)),
      targetId: target?.id || 0,
      envName: target?.envName || '',
      uploadStrategy: target?.uploadStrategy || '',
      managed: Boolean(target),
      isSharedRoot: sharedRoot,
      exists: stat.exists,
      hasCurrentManifest: Boolean(extMeta?.hasExternalManifest || stat.hasInlineManifest),
      hasExternalManifest: Boolean(extMeta?.hasExternalManifest),
      hasInlineManifest: stat.hasInlineManifest,
      totalBytes: stat.totalBytes,
      runtimeBytes,
      assetsBytes: stat.assetsBytes,
      inlineBackupBytes: stat.inlineBackupBytes,
      inlineBackupCount: inlineBackups.length || stat.inlineBackupCount,
      inlineManifestBytes: stat.inlineManifestBytes,
      stagingBytes: stat.stagingBytes,
      externalBackupCount: externalBackups.length,
      externalLogicalBytes,
      unreferencedBackupCount: unreferencedCount,
      retentionPolicy: policy,
      backups: appBackups,
    });
  }

  // 按「内嵌遗留备份体积」+「外置逻辑备份体积」倒序，最该治理的排最前
  apps.sort((a, b) => {
    const scoreA = a.inlineBackupBytes * 2 + a.externalLogicalBytes + a.stagingBytes;
    const scoreB = b.inlineBackupBytes * 2 + b.externalLogicalBytes + b.stagingBytes;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.displayName.localeCompare(b.displayName);
  });

  const htmlOverheadBytes = inlineBackupTotalBytes + inlineManifestTotalBytes + inlineStagingTotalBytes;
  const htmlRuntimeBytes = Math.max(0, htmlRootInfo.totalBytes - htmlOverheadBytes);
  const dedupSavedBytes = Math.max(0, externalLogicalTotalBytes - stateRootInfo.objectsBytes);
  const dedupSavedPercent = externalLogicalTotalBytes > 0
    ? Math.min(99, Math.round((dedupSavedBytes / externalLogicalTotalBytes) * 100))
    : 0;

  return {
    scannedAt: new Date().toISOString(),
    htmlRoot: htmlRootInfo,
    stateRoot: stateRootInfo,
    summary: {
      htmlTotalBytes: htmlRootInfo.totalBytes,
      htmlRuntimeBytes,
      inlineBackupTotalBytes,
      inlineBackupTotalCount,
      inlineManifestTotalBytes,
      inlineStagingTotalBytes,
      externalObjectsBytes: stateRootInfo.objectsBytes,
      externalObjectsCount: stateRootInfo.objectsCount,
      externalLogicalTotalBytes,
      externalBackupTotalCount,
      dedupSavedBytes,
      dedupSavedPercent,
      unreferencedBackupBytes,
      unreferencedBackupCount,
      reclaimableHtmlBytes: htmlOverheadBytes,
    },
    apps,
  };
}

/**
 * 扫描指定 Nginx 实例的存储占用情况（只读）。
 * @param {number} instanceId - Nginx 实例 ID
 * @returns {Promise<Object>} 存储诊断报告
 */
export async function inspectNginxInstanceStorage(instanceId) {
  const { instance, server } = await getNginxInstanceContext(Number(instanceId));
  if (!instance || !server) {
    throw Object.assign(new Error('Nginx 实例或关联服务器不存在'), { statusCode: 404 });
  }

  const useSudo = resolveEffectiveDeploySudo(server, instance);
  const statePaths = resolveNginxInstanceStatePaths(instance);
  const allTargets = await listTargets({ serverId: server.id });
  const instanceTargets = allTargets.filter(
    (t) =>
      t.projectType !== 'backend' &&
      (Number(t.nginxInstanceId) === Number(instance.id) ||
        (statePaths?.htmlRoot && isSameOrSubPath(t.deployRoot, statePaths.htmlRoot)))
  );

  const backupReferences = await listBackupReferencesByTargetIds(instanceTargets.map((t) => t.id));
  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  const stdout = await effectiveWithSsh(server, async (conn) => {
    const cmd = buildInspectNginxStorageCommand({
      htmlRoot: statePaths?.htmlRoot || instance.htmlRoot || '',
      stateRoot: statePaths?.stateRoot || '',
      targetRoots: instanceTargets.map((t) => t.deployRoot),
      useSudo,
    });
    const res = await execSsh(conn, cmd, {
      allowFailure: true,
      label: '扫描 Nginx 实例存储占用',
    });
    if (res.code !== 0) {
      throw new Error(`存储扫描失败（退出码 ${res.code}）：${res.stderr || res.stdout || '未知错误'}`);
    }
    return String(res.stdout || '');
  });

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    serverId: server.id,
    serverName: server.name,
    ...parseInspectNginxStorageOutput(stdout, {
      targets: instanceTargets,
      backupReferences,
      nginxInstance: instance,
    }),
  };
}

/**
 * 生成安全删除指定备份目录列表（及可选清理空壳内嵌目录）的远程 Shell 命令。
 * @param {Object} params - 删除参数
 * @param {string[]} params.backupPaths - 经校验的待删备份绝对路径
 * @param {string[]} [params.cleanupEmptyInlineRoots=[]] - 允许清理空壳 .yuyan-backups 的应用目录
 * @param {string[]} [params.cleanupLegacyManifestRoots=[]] - 已有外置清单、可移除历史内嵌 .yuyan-manifests 的应用目录
 * @param {boolean} [params.useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildDeleteBackupEntriesCommand({
  backupPaths = [],
  cleanupEmptyInlineRoots = [],
  cleanupLegacyManifestRoots = [],
  useSudo = false,
}) {
  const safeBackupPaths = [...new Set(backupPaths.map(assertSafeBackupEntryPath))];
  const safeInlineRoots = [...new Set(cleanupEmptyInlineRoots.map(normalizePosixAbsPath).filter((p) => p && p.startsWith('/')))];
  const safeManifestRoots = [...new Set(cleanupLegacyManifestRoots.map(normalizePosixAbsPath).filter((p) => p && p.startsWith('/')))];

  const script = [
    '# yuyan:delete-backup-entries',
    'set -eu',
    'b_count="$1"',
    'i_count="$2"',
    'm_count="$3"',
    'shift 3',
    ...buildPortableStatLines(),
    'deleted_count=0',
    'freed_bytes=0',
    'tmp_deleted=$(mktemp)',
    'cleanup() { rm -f "$tmp_deleted" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    'idx=0',
    'for arg in "$@"; do',
    '  idx=$((idx + 1))',
    '  if [ "$idx" -le "$b_count" ]; then',
    '    if [ -d "$arg" ]; then',
    '      sz=$(yuyan_dir_bytes "$arg")',
    '      if rm -rf "$arg"; then',
    '        deleted_count=$((deleted_count + 1))',
    '        freed_bytes=$((freed_bytes + sz))',
    '        printf "%s\\n" "$arg" >> "$tmp_deleted"',
    '      fi',
    '    fi',
    '  elif [ "$idx" -le $((b_count + i_count)) ]; then',
    `    rmdir "$arg/${LEGACY_BACKUP_DIR_NAME}" 2>/dev/null || true`,
    '  else',
    `    if [ -d "$arg/${LEGACY_MANIFEST_DIR_NAME}" ]; then`,
    `      sz=$(yuyan_dir_bytes "$arg/${LEGACY_MANIFEST_DIR_NAME}")`,
    `      if rm -rf "$arg/${LEGACY_MANIFEST_DIR_NAME}"; then`,
    '        freed_bytes=$((freed_bytes + sz))',
    '      fi',
    '    fi',
    '  fi',
    'done',
    'echo "deleted_count=$deleted_count freed_bytes=$freed_bytes"',
    'echo "===DELETED_BACKUPS==="',
    'cat "$tmp_deleted"',
    'echo "===END_DELETED_BACKUPS==="',
  ].join('\n');

  return buildPosixShellCommand(
    script,
    [
      String(safeBackupPaths.length),
      String(safeInlineRoots.length),
      String(safeManifestRoots.length),
      ...safeBackupPaths,
      ...safeInlineRoots,
      ...safeManifestRoots,
    ],
    useSudo
  );
}

/**
 * 解析批量删除备份命令输出。
 * @param {string} stdout - 命令输出
 * @returns {{ deletedCount: number, freedBytes: number, deletedPaths: string[] }}
 */
export function parseDeleteBackupEntriesOutput(stdout) {
  const text = String(stdout || '');
  const num = (key) => {
    const m = text.match(new RegExp(`\\b${key}=(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  const s = text.indexOf('===DELETED_BACKUPS===\n');
  const e = text.indexOf('===END_DELETED_BACKUPS===');
  const deletedPaths = s !== -1
    ? (e === -1 ? text.slice(s + '===DELETED_BACKUPS===\n'.length) : text.slice(s + '===DELETED_BACKUPS===\n'.length, e))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return {
    deletedCount: num('deleted_count') || deletedPaths.length,
    freedBytes: num('freed_bytes'),
    deletedPaths,
  };
}

/**
 * 执行托管 Nginx 实例级备份清理与对象池 GC（持最外层目录锁防并发发布冲突）。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} [options={}] - 清理选项
 * @param {'none'|'keep_latest_1'|'purge_unreferenced'|'purge_all'} [options.inlineAction='keep_latest_1'] - 存量内嵌备份清理策略
 * @param {boolean} [options.applyRetentionPolicy=true] - 是否按三维策略裁剪纳管目标备份
 * @param {boolean} [options.runCasGc=true] - 是否运行外置仓 CAS 对象池 GC
 * @param {number} [options.gcGraceMinutes=10] - 对象池 GC 宽限期（分钟）
 * @param {string[]} [options.targetRoots=[]] - 限定处理的应用目录（为空表示实例下全部）
 * @param {string} [options.operator=''] - 操作人
 * @returns {Promise<Object>} 清理统计结果
 */
export async function pruneNginxInstanceBackups(instanceId, options = {}) {
  const inlineAction = ['none', 'keep_latest_1', 'purge_unreferenced', 'purge_all'].includes(options.inlineAction)
    ? options.inlineAction
    : 'keep_latest_1';
  const applyRetentionPolicy = options.applyRetentionPolicy !== false;
  const runCasGc = options.runCasGc !== false;
  const gcGraceMinutes = Math.max(0, Math.min(1440, Number(options.gcGraceMinutes ?? DEFAULT_CAS_GC_GRACE_MINUTES)));
  const rootFilterSet = Array.isArray(options.targetRoots) && options.targetRoots.length > 0
    ? new Set(options.targetRoots.map(normalizePosixAbsPath).filter(Boolean))
    : null;

  const inspection = await inspectNginxInstanceStorage(instanceId);
  const { instance, server } = await getNginxInstanceContext(Number(instanceId));
  const useSudo = resolveEffectiveDeploySudo(server, instance);
  const allTargets = await listTargets({ serverId: server.id });
  const targetById = new Map(allTargets.map((t) => [Number(t.id), t]));

  const selectedApps = inspection.apps.filter((app) => {
    if (!rootFilterSet) return true;
    return (app.deployRoot && rootFilterSet.has(normalizePosixAbsPath(app.deployRoot))) || rootFilterSet.has(app.key);
  });

  // 规划要直接删除的内嵌旧备份路径
  const inlinePathsToDelete = [];
  const cleanupEmptyInlineRoots = [];
  const cleanupLegacyManifestRoots = [];

  for (const app of selectedApps) {
    const inlineBackups = (app.backups || [])
      .filter((b) => b.storageMode === 'inline')
      .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch);

    if (inlineBackups.length > 0 && inlineAction !== 'none') {
      if (inlineAction === 'purge_all') {
        inlineBackups.forEach((b) => inlinePathsToDelete.push(b.backupPath));
        if (app.deployRoot) cleanupEmptyInlineRoots.push(app.deployRoot);
        if (app.deployRoot && app.hasExternalManifest && app.hasInlineManifest) {
          cleanupLegacyManifestRoots.push(app.deployRoot);
        }
      } else if (inlineAction === 'keep_latest_1') {
        // 如果该应用已经在外置仓有有效快照，则所有内嵌旧备份都可以清空；否则保底留最新 1 份内嵌
        const startIdx = app.externalBackupCount > 0 ? 0 : 1;
        inlineBackups.slice(startIdx).forEach((b) => inlinePathsToDelete.push(b.backupPath));
        if (startIdx === 0 && app.deployRoot) {
          cleanupEmptyInlineRoots.push(app.deployRoot);
          if (app.hasExternalManifest && app.hasInlineManifest) {
            cleanupLegacyManifestRoots.push(app.deployRoot);
          }
        }
      } else if (inlineAction === 'purge_unreferenced') {
        inlineBackups.filter((b) => !b.referencedByDb).forEach((b) => inlinePathsToDelete.push(b.backupPath));
        if (app.deployRoot) cleanupEmptyInlineRoots.push(app.deployRoot);
      }
    } else if (app.deployRoot && inlineBackups.length === 0 && app.hasExternalManifest && app.hasInlineManifest && inlineAction !== 'none') {
      cleanupEmptyInlineRoots.push(app.deployRoot);
      cleanupLegacyManifestRoots.push(app.deployRoot);
    }
  }

  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  let totalDeletedBackups = 0;
  let totalFreedBytes = 0;
  let totalDbCleared = 0;
  const allDeletedPaths = [];
  let casGcResult = null;

  const lockRootCandidate = inspection.htmlRoot.path
    || selectedApps.find((a) => a.deployRoot)?.deployRoot
    || '';

  await effectiveWithSsh(server, async (conn) => {
    let lockHandle = null;
    if (lockRootCandidate) {
      lockHandle = await acquireDeployRootLocks(conn, {
        server,
        lockRoot: lockRootCandidate,
        useSudo,
        recordId: 0,
        owner: {
          projectName: `存储治理(${instance.name})`,
          targetId: 0,
          recordId: 0,
          operator: options.operator || 'storage-governance',
          actionLabel: '存储清理',
        },
        waitTimeoutMs: 30_000,
      });
    }

    try {
      // 1. 删除规划好的存量内嵌备份与空壳元数据目录
      if (inlinePathsToDelete.length > 0 || cleanupEmptyInlineRoots.length > 0 || cleanupLegacyManifestRoots.length > 0) {
        const delCmd = buildDeleteBackupEntriesCommand({
          backupPaths: inlinePathsToDelete,
          cleanupEmptyInlineRoots,
          cleanupLegacyManifestRoots,
          useSudo,
        });
        const delRes = await execSsh(conn, delCmd, {
          allowFailure: true,
          label: '清理存量内嵌部署备份',
        });
        if (delRes.code !== 0) {
          throw new Error(`清理内嵌备份失败（退出码 ${delRes.code}）：${delRes.stderr || delRes.stdout || '未知错误'}`);
        }
        const parsedDel = parseDeleteBackupEntriesOutput(delRes.stdout);
        totalDeletedBackups += parsedDel.deletedCount;
        totalFreedBytes += parsedDel.freedBytes;
        allDeletedPaths.push(...parsedDel.deletedPaths);
      }

      // 2. 对选中的纳管目标立即执行三维保留策略裁剪
      if (applyRetentionPolicy) {
        for (const app of selectedApps) {
          if (!app.targetId || !app.deployRoot) continue;
          const target = targetById.get(Number(app.targetId));
          if (!target) continue;
          const policy = resolveDeployRetentionPolicy(target);
          const layout = resolveDeployStateLocation({ realRoot: app.deployRoot, nginxInstance: instance });
          const pruneCmd = buildPruneBackupsCommand({
            primaryBackupRoot: layout.mode === 'external' ? layout.backupRoot : layout.legacyBackupRoot,
            legacyBackupRoot: layout.mode === 'external' ? layout.legacyBackupRoot : '',
            keepCount: policy.backupKeepCount,
            maxSizeMb: policy.backupMaxSizeMb,
            ttlDays: policy.backupTtlDays,
            minKeepCount: policy.minKeepCount,
            useSudo,
          });
          const pruneRes = await execSsh(conn, pruneCmd, {
            allowFailure: true,
            label: `按保留策略裁剪备份(${target.projectName})`,
          });
          if (pruneRes.code === 0) {
            const parsed = parsePruneBackupsOutput(pruneRes.stdout);
            totalDeletedBackups += parsed.deletedCount;
            allDeletedPaths.push(...parsed.deletedPaths);
            const syncRes = await syncTargetBackupReferences(target.id, {
              deletedPaths: parsed.deletedPaths,
              survivingPaths: parsed.survivingPaths,
            });
            totalDbCleared += syncRes.clearedRecords;
          }
        }
      }

      // 3. 同步外置仓 CAS 对象池 GC
      if (runCasGc && inspection.stateRoot.exists && inspection.stateRoot.path) {
        const gcRes = await execSsh(
          conn,
          buildCasObjectPoolGcCommand(inspection.stateRoot.path, { graceMinutes: gcGraceMinutes, useSudo }),
          { allowFailure: true, label: '回收外置仓 CAS 孤儿对象' }
        );
        if (gcRes.code === 0) {
          casGcResult = parseCasGcOutput(gcRes.stdout);
          totalFreedBytes += casGcResult.freedBytes;
        }
      }
    } finally {
      if (lockHandle) {
        await lockHandle.release().catch(() => {});
      }
    }
  });

  // 4. 精确清空已删除备份对应的 DB 回滚引用
  if (allDeletedPaths.length > 0) {
    const dbClearRes = await clearTargetBackupReferencesByPaths(0, allDeletedPaths);
    totalDbCleared += dbClearRes.clearedRecords;
  }

  return {
    deletedBackups: totalDeletedBackups,
    freedBytes: totalFreedBytes,
    clearedDbRecords: totalDbCleared,
    deletedPaths: [...new Set(allDeletedPaths)],
    casGc: casGcResult,
  };
}

/**
 * 构建只读扫描单个目标无主历史静态资源（Orphan Assets）的远程命令。
 * 强制门禁：必须存在有效的 current.txt 清单，否则直接输出 status=no_manifest 拒扫防误删。
 * @param {Object} params - 扫描参数
 * @returns {string} 远程只读命令
 */
export function buildPreviewOrphanAssetsCommand({
  rootPath,
  manifestDir = '',
  legacyManifestDir = '',
  backupRoot = '',
  legacyBackupRoot = '',
  hashedDirs = DEFAULT_HASHED_ASSET_DIRS,
  minAgeDays = 7,
  useSudo = false,
}) {
  const safeHashedDirs = [...new Set((hashedDirs || DEFAULT_HASHED_ASSET_DIRS).filter(isValidEntryName).filter((d) => !isReservedDeployEntry(d)))];
  const minAgeSec = Math.max(0, Number(minAgeDays ?? 7)) * 86400;

  const script = [
    '# yuyan:preview-orphan-assets',
    'set -eu',
    'root="$1"',
    'manifest_dir="$2"',
    'legacy_manifest_dir="$3"',
    'backup_root="$4"',
    'legacy_backup_root="$5"',
    'min_age_sec="$6"',
    'shift 6',
    ...buildPortableStatLines(),
    'if [ ! -d "$root" ]; then echo "status=root_missing"; exit 0; fi',
    'has_current=0',
    `if [ -n "$manifest_dir" ] && [ -f "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    `if [ -n "$legacy_manifest_dir" ] && [ -f "$legacy_manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    'if [ "$has_current" -eq 0 ]; then echo "status=no_manifest"; exit 0; fi',
    'tmp_white_raw=$(mktemp)',
    'tmp_white=$(mktemp)',
    'cleanup() { rm -f "$tmp_white_raw" "$tmp_white" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    'collect_manifests() {',
    '  mdir="$1"',
    '  [ -n "$mdir" ] && [ -d "$mdir" ] || return 0',
    '  find "$mdir" -maxdepth 1 -type f -name "*.txt" 2>/dev/null | while IFS= read -r mf; do',
    '    [ -f "$mf" ] && cat "$mf"',
    '  done >> "$tmp_white_raw"',
    '}',
    'collect_backup_manifests() {',
    '  broot="$1"',
    '  [ -n "$broot" ] && [ -d "$broot" ] || return 0',
    `  find "$broot" -mindepth 2 -maxdepth 2 -type f -name "${BACKUP_MANIFEST_FILE_NAME}" 2>/dev/null | while IFS= read -r bm; do`,
    '    [ -f "$bm" ] && cat "$bm"',
    '  done >> "$tmp_white_raw"',
    '}',
    'collect_manifests "$manifest_dir"',
    'if [ "$legacy_manifest_dir" != "$manifest_dir" ]; then collect_manifests "$legacy_manifest_dir"; fi',
    'collect_backup_manifests "$backup_root"',
    'if [ "$legacy_backup_root" != "$backup_root" ]; then collect_backup_manifests "$legacy_backup_root"; fi',
    'sed "/^$/d" "$tmp_white_raw" | sort -u > "$tmp_white"',
    'if [ ! -s "$tmp_white" ]; then echo "status=empty_manifest"; exit 0; fi',
    'now_epoch=$(date +%s)',
    'echo "status=ok"',
    'echo "===ORPHAN_CANDIDATES==="',
    'for hdir in "$@"; do',
    '  case "$hdir" in ""|"."|".."|.*|*/*) continue ;; esac',
    '  [ -d "$root/$hdir" ] || continue',
    '  (cd "$root" && find "$hdir" -type f) | while IFS= read -r rel; do',
    '    case "$rel" in ""|/*|*../*|../*|.*|*/.*) continue ;; esac',
    '    if grep -Fxq "$rel" "$tmp_white"; then continue; fi',
    '    full="$root/$rel"',
    '    mtime=$(yuyan_file_mtime "$full")',
    '    case "$mtime" in ""|*[!0-9]*) mtime=0 ;; esac',
    '    age=$((now_epoch - mtime))',
    '    if [ "$age" -lt 0 ]; then age=0; fi',
    '    if [ "$min_age_sec" -gt 0 ] && [ "$age" -lt "$min_age_sec" ]; then continue; fi',
    '    sz=$(yuyan_file_size "$full")',
    '    case "$sz" in ""|*[!0-9]*) sz=0 ;; esac',
    '    printf "%s\\t%s\\t%s\\n" "$rel" "$sz" "$mtime"',
    '  done',
    'done',
    'echo "===END_ORPHAN_CANDIDATES==="',
  ].join('\n');

  return buildPosixShellCommand(
    script,
    [rootPath, manifestDir || '', legacyManifestDir || '', backupRoot || '', legacyBackupRoot || '', String(minAgeSec), ...safeHashedDirs],
    useSudo
  );
}

/**
 * 解析无主历史静态资源扫描输出并按构建哈希置信度分组。
 * @param {string} stdout - 命令输出
 * @returns {{ status: string, hashedCandidates: Array, otherCandidates: Array, totalCandidateBytes: number }}
 */
export function parsePreviewOrphanAssetsOutput(stdout) {
  const text = String(stdout || '');
  const statusMatch = text.match(/^status=([^\s]+)/m);
  const status = statusMatch ? statusMatch[1] : 'unknown';
  if (status !== 'ok') {
    return { status, hashedCandidates: [], otherCandidates: [], totalCandidateBytes: 0 };
  }

  const startMarker = '===ORPHAN_CANDIDATES===\n';
  const endMarker = '===END_ORPHAN_CANDIDATES===';
  const s = text.indexOf(startMarker);
  const e = text.indexOf(endMarker);
  const body = s !== -1 ? (e === -1 ? text.slice(s + startMarker.length) : text.slice(s + startMarker.length, e)) : '';

  const hashedCandidates = [];
  const otherCandidates = [];
  let totalCandidateBytes = 0;

  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [relPath, sizeRaw, mtimeRaw] = line.split('\t');
    if (!relPath || relPath.startsWith('/') || relPath.includes('..')) continue;
    const sizeBytes = Number(sizeRaw || 0) || 0;
    const mtimeEpoch = Number(mtimeRaw || 0) || 0;
    const item = {
      relativePath: relPath,
      sizeBytes,
      mtimeEpoch,
      modifiedAt: mtimeEpoch > 0 ? new Date(mtimeEpoch * 1000).toISOString() : '',
    };
    totalCandidateBytes += sizeBytes;
    if (isLikelyHashedBuildAsset(relPath)) {
      hashedCandidates.push(item);
    } else {
      otherCandidates.push(item);
    }
  }

  hashedCandidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
  otherCandidates.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    status: 'ok',
    hashedCandidates,
    otherCandidates,
    totalCandidateBytes,
  };
}

/**
 * 预览单个部署目标的无主历史静态资源，签发 15 分钟有效的 previewToken。
 * @param {number} targetId - 部署目标 ID
 * @param {Object} [options={}] - 扫描选项（minAgeDays）
 * @returns {Promise<Object>} 预检结果
 */
export async function previewTargetOrphanAssets(targetId, options = {}) {
  purgeExpiredOrphanPreviews();
  const { target, server, nginxInstance } = await getTargetContext(Number(targetId));
  if (!target || !server) throw Object.assign(new Error('部署目标不存在'), { statusCode: 404 });
  if (target.projectType === 'backend') {
    throw Object.assign(new Error('后端部署目标不支持前端静态资源清理'), { statusCode: 400 });
  }

  const useSudo = resolveEffectiveDeploySudo(server, nginxInstance);
  const policy = resolveDeployRetentionPolicy(target);
  const minAgeDays = options.minAgeDays !== undefined && options.minAgeDays !== ''
    ? Math.max(0, Math.min(365, Number(options.minAgeDays)))
    : policy.orphanAssetMinAgeDays;

  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  const { realRoot, parsed } = await effectiveWithSsh(server, async (conn) => {
    const resolved = await batchDetectRealRoots(conn, [target.deployRoot], useSudo).catch(() => [target.deployRoot]);
    const detectedRoot = resolved[0] || target.deployRoot;
    const layout = resolveDeployStateLocation({ realRoot: detectedRoot, nginxInstance });
    const cmd = buildPreviewOrphanAssetsCommand({
      rootPath: detectedRoot,
      manifestDir: layout.manifestDir,
      legacyManifestDir: layout.legacyManifestDir,
      backupRoot: layout.backupRoot,
      legacyBackupRoot: layout.legacyBackupRoot,
      hashedDirs: policy.hashedAssetDirs,
      minAgeDays,
      useSudo,
    });
    const res = await execSsh(conn, cmd, {
      allowFailure: true,
      label: '扫描无主历史静态资源',
    });
    if (res.code !== 0) {
      throw new Error(`无主资源扫描失败（退出码 ${res.code}）：${res.stderr || res.stdout || '未知错误'}`);
    }
    return { realRoot: detectedRoot, parsed: parsePreviewOrphanAssetsOutput(res.stdout) };
  });

  if (parsed.status !== 'ok') {
    const reasonMap = {
      no_manifest: '目标目录尚未建立雨燕发布清单（current.txt），为防误删人工文件已安全中止扫描；请先通过雨燕发布一次后再治理。',
      empty_manifest: '当前发布清单为空，已安全中止扫描。',
      root_missing: '目标部署目录在服务器上不存在。',
    };
    return {
      targetId: target.id,
      projectName: target.projectName,
      realRoot,
      status: parsed.status,
      reason: reasonMap[parsed.status] || '无法完成无主资源扫描',
      minAgeDays,
      hashedAssetDirs: policy.hashedAssetDirs,
      previewToken: '',
      hashedCandidates: [],
      otherCandidates: [],
      totalCandidateBytes: 0,
      hashedCandidateBytes: 0,
      otherCandidateBytes: 0,
    };
  }

  const allowedPaths = new Set([
    ...parsed.hashedCandidates.map((i) => i.relativePath),
    ...parsed.otherCandidates.map((i) => i.relativePath),
  ]);
  const previewToken = crypto.randomBytes(18).toString('hex');
  orphanAssetPreviewStore.set(previewToken, {
    teamId: getRequestTeamId(),
    targetId: Number(target.id),
    realRoot,
    hashedAssetDirs: policy.hashedAssetDirs,
    allowedPaths,
    expiresAt: Date.now() + ORPHAN_PREVIEW_TTL_MS,
  });

  return {
    targetId: target.id,
    projectName: target.projectName,
    realRoot,
    status: 'ok',
    reason: '',
    minAgeDays,
    hashedAssetDirs: policy.hashedAssetDirs,
    previewToken,
    hashedCandidates: parsed.hashedCandidates,
    otherCandidates: parsed.otherCandidates,
    totalCandidateBytes: parsed.totalCandidateBytes,
    hashedCandidateBytes: parsed.hashedCandidates.reduce((s, i) => s + i.sizeBytes, 0),
    otherCandidateBytes: parsed.otherCandidates.reduce((s, i) => s + i.sizeBytes, 0),
  };
}

/**
 * 构建安全删除已确认无主历史静态资源的远程 Shell 命令。
 * @param {string} rootPath - 部署真实根目录
 * @param {string[]} relativePaths - 相对路径列表
 * @param {boolean} [useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildCleanOrphanAssetsCommand(rootPath, relativePaths = [], useSudo = false) {
  const safeRelPaths = [...new Set((relativePaths || []).filter((rel) => {
    if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.includes('..') || /[\r\n\x00]/.test(rel)) {
      return false;
    }
    const segs = rel.split('/');
    if (segs.length < 2) return false;
    return segs.every((s) => isValidEntryName(s) && !s.startsWith('.') && !isReservedDeployEntry(s));
  }))];

  const script = [
    '# yuyan:clean-orphan-assets',
    'set -eu',
    'root="$1"',
    'shift 1',
    ...buildPortableStatLines(),
    'deleted_count=0',
    'freed_bytes=0',
    'skipped_count=0',
    'for rel in "$@"; do',
    '  case "$rel" in ""|/*|*../*|../*|.*|*/.*) skipped_count=$((skipped_count + 1)); continue ;; esac',
    '  full="$root/$rel"',
    '  if [ -f "$full" ] && [ ! -L "$full" ]; then',
    '    sz=$(yuyan_file_size "$full")',
    '    case "$sz" in ""|*[!0-9]*) sz=0 ;; esac',
    '    if rm -f "$full"; then',
    '      deleted_count=$((deleted_count + 1))',
    '      freed_bytes=$((freed_bytes + sz))',
    '    else',
    '      skipped_count=$((skipped_count + 1))',
    '    fi',
    '  else',
    '    skipped_count=$((skipped_count + 1))',
    '  fi',
    'done',
    'echo "deleted_count=$deleted_count freed_bytes=$freed_bytes skipped_count=$skipped_count"',
  ].join('\n');

  return buildPosixShellCommand(script, [rootPath, ...safeRelPaths], useSudo);
}

/**
 * 执行经用户二次确认的无主历史静态资源清理（校验 previewToken + 持目录锁）。
 * @param {number} targetId - 部署目标 ID
 * @param {Object} payload - 清理参数
 * @param {string} payload.previewToken - 预检签发令牌
 * @param {string[]} payload.relativePaths - 用户勾选确认删除的相对路径
 * @param {string} [payload.operator=''] - 操作人
 * @returns {Promise<{ deletedCount: number, freedBytes: number, skippedCount: number }>}
 */
export async function cleanTargetOrphanAssets(targetId, payload = {}) {
  purgeExpiredOrphanPreviews();
  const token = String(payload.previewToken || '').trim();
  const preview = orphanAssetPreviewStore.get(token);
  if (!preview || preview.targetId !== Number(targetId) || preview.teamId !== getRequestTeamId()) {
    throw Object.assign(new Error('无主资源清理预览已过期或无效，请重新扫描预览后再执行'), { statusCode: 400 });
  }

  const requested = Array.isArray(payload.relativePaths) ? payload.relativePaths : [];
  if (!requested.length) {
    throw Object.assign(new Error('请至少勾选一个待清理的无主静态资源文件'), { statusCode: 400 });
  }

  const { target, server, nginxInstance } = await getTargetContext(Number(targetId));
  if (!target || !server) throw Object.assign(new Error('部署目标不存在'), { statusCode: 404 });

  const protectedDetails = await resolveProtectedEntriesWithDetails(target, { currentRealRoot: preview.realRoot });
  const protectedSet = new Set(protectedDetails.allProtected || []);
  const hashedSet = new Set(preview.hashedAssetDirs || DEFAULT_HASHED_ASSET_DIRS);

  const verifiedPaths = [];
  for (const rel of requested) {
    const clean = String(rel || '').trim();
    if (!preview.allowedPaths.has(clean)) {
      throw Object.assign(new Error(`文件不在本次预检安全清单内，已拒绝删除：${clean}`), { statusCode: 400 });
    }
    const topDir = clean.split('/')[0];
    if (protectedSet.has(topDir) || !hashedSet.has(topDir) || isReservedDeployEntry(topDir)) {
      throw Object.assign(new Error(`文件命中受保护目录或非静态资源目录，已拒绝删除：${clean}`), { statusCode: 400 });
    }
    verifiedPaths.push(clean);
  }

  const useSudo = resolveEffectiveDeploySudo(server, nginxInstance);
  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  let allHostTargets = [];
  try {
    allHostTargets = await listPhysicalServerTargets({ serverId: target.serverId });
  } catch {
    allHostTargets = await listTargets({ serverId: target.serverId }).catch(() => [target]);
  }
  const candidateRoots = [preview.realRoot, ...allHostTargets.map((t) => t.deployRoot).filter(Boolean)];
  const lockRoot = resolveTopmostLockRoot(preview.realRoot, candidateRoots);

  const outcome = await effectiveWithSsh(server, async (conn) => {
    const lock = await acquireDeployRootLocks(conn, {
      server,
      lockRoot,
      useSudo,
      recordId: 0,
      owner: {
        projectName: target.projectName,
        targetId: target.id,
        recordId: 0,
        operator: payload.operator || 'storage-governance',
        actionLabel: '清理无主静态资源',
      },
      waitTimeoutMs: 30_000,
    });
    try {
      const cmd = buildCleanOrphanAssetsCommand(preview.realRoot, verifiedPaths, useSudo);
      const res = await execSsh(conn, cmd, {
        allowFailure: true,
        label: `清理无主历史静态资源(${target.projectName})`,
      });
      if (res.code !== 0) {
        throw new Error(`清理无主资源失败（退出码 ${res.code}）：${res.stderr || res.stdout || '未知错误'}`);
      }
      const stdout = String(res.stdout || '');
      const num = (key) => {
        const m = stdout.match(new RegExp(`\\b${key}=(\\d+)`));
        return m ? Number(m[1]) : 0;
      };
      return {
        deletedCount: num('deleted_count'),
        freedBytes: num('freed_bytes'),
        skippedCount: num('skipped_count'),
      };
    } finally {
      await lock.release().catch(() => {});
    }
  });

  // 清理成功后消费掉本次令牌（防止重放）
  orphanAssetPreviewStore.delete(token);
  return outcome;
}
