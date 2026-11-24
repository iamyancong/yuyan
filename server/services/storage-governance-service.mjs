/**
 * 部署存储诊断与垃圾回收治理服务
 * @description 提供托管 Nginx 实例 / 部署目标维度的存储占用透视、存量内嵌 .yuyan-backups 清理、
 * 三维备份瘦身、CAS 对象池 GC 以及两段式（预览→确认）无主历史静态资源清理能力。
 */

import crypto from 'node:crypto';
import path from 'node:path';
import {
  clearRetiredRootBackupReferences,
  clearTargetBackupReferencesByPaths,
  getNginxInstanceContext,
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
  parseExternalBackupPath,
  resolveCandidateDeployStateLocations,
  resolveDeployRetentionPolicy,
  resolveDeployStateLocation,
  resolveNginxInstanceStatePaths,
  STATE_OBJECTS_DIR_NAME,
  STATE_ROOT_DIR_NAME,
  STATE_TARGETS_DIR_NAME,
  TARGET_META_FILE_NAME,
  TARGET_RETIRED_MARKER_NAME,
} from './deploy-state-layout.mjs';
import {
  BACKUP_KIND_FILE_NAME,
  BACKUP_MANIFEST_FILE_NAME,
  BACKUP_META_FILE_NAME,
  buildCasObjectPoolGcCommand,
  buildMarkTargetRetiredCommand,
  buildPosixShellCommand,
  buildPruneBackupsCommand,
  buildWriteTargetStateMetaCommand,
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
  resolveActiveDeployStateLayout,
  resolveEffectiveDeploySudo,
  resolveProtectedEntriesWithDetails,
  resolveServerLockRoot,
} from './deploy-service.mjs';

/** 批量删除备份单次 SSH 命令最大路径数（防 ARG_MAX 并提升取消响应粒度） */
const DELETE_BACKUP_BATCH_SIZE = 25;

/** 批量删除无主静态资源单次 SSH 命令最大路径数（防 ARG_MAX 超长） */
const CLEAN_ORPHAN_BATCH_SIZE = 200;

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
 * @param {string[]} [params.candidateTargetStateDirs=[]] - 额外状态仓下的候选 targets/<slug> 目录
 * @param {string[]} [params.targetRoots=[]] - 已纳管前端目标的 deployRoot 列表
 * @param {boolean} [params.scopedOnly=false] - 仅定向扫描传入的 targetRoots（跳过全 htmlRoot 遍历与总大小统计）
 * @param {boolean} [params.useSudo=false] - 是否 sudo
 * @returns {string} 远程只读命令
 */
export function buildInspectNginxStorageCommand({
  htmlRoot = '',
  stateRoot = '',
  candidateTargetStateDirs = [],
  targetRoots = [],
  scopedOnly = false,
  useSudo = false,
} = {}) {
  const safeRoots = [...new Set((targetRoots || []).map(normalizePosixAbsPath).filter((p) => p && p.startsWith('/')))];
  const primaryStateRoot = normalizePosixAbsPath(stateRoot || '');
  const safeCandidateDirs = [
    ...new Set(
      (candidateTargetStateDirs || [])
        .map(normalizePosixAbsPath)
        .filter((p) => p.startsWith('/'))
    ),
  ];

  const script = [
    '# yuyan:inspect-storage',
    'set -u',
    'html_root="$1"',
    'state_root="$2"',
    'scoped_only="$3"',
    'candidate_count="$4"',
    'shift 4',
    ...buildPortableStatLines(),
    'tmp_app_roots=$(mktemp)',
    'tmp_state_roots=$(mktemp)',
    'cleanup() { rm -f "$tmp_app_roots" "$tmp_state_roots" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    '',
    '# 仅将包含本次目标 slug 的额外仓纳入统计和后续 GC',
    'if [ -n "$state_root" ]; then',
    '  printf "%s\\n" "$state_root" >> "$tmp_state_roots"',
    'fi',
    'e_idx=0',
    'for arg in "$@"; do',
    '  if [ "$e_idx" -lt "$candidate_count" ]; then',
    '    e_idx=$((e_idx + 1))',
    '    if [ -d "$arg" ] && [ ! -L "$arg" ]; then',
    '      cand_sr="${arg%/*/*}"',
    '      grep -Fxq "$cand_sr" "$tmp_state_roots" || printf "%s\\n" "$cand_sr" >> "$tmp_state_roots"',
    '    fi',
    '  else',
    '    [ -n "$arg" ] && printf "%s\\n" "$arg" >> "$tmp_app_roots"',
    '  fi',
    'done',
    '',
    '# 1. 输出 htmlRoot 总体积（定向扫描仅探测是否存在，避免全量 du）',
    'html_exists=0',
    'html_total_bytes=0',
    'if [ -n "$html_root" ] && [ -d "$html_root" ]; then',
    '  html_exists=1',
    '  if [ "$scoped_only" != "1" ]; then',
    '    html_total_bytes=$(yuyan_dir_bytes "$html_root")',
    '  fi',
    'fi',
    'printf "HTML_ROOT\\t%s\\t%s\\t%s\\n" "$html_root" "$html_exists" "$html_total_bytes"',
    '',
    '# 2. 识别实际存在的外置状态仓（兼容托管 Nginx 与原有 Nginx 接入启发式平级外置仓）',
    'effective_state_root="$state_root"',
    'state_exists=0',
    'state_total_bytes=0',
    'objects_bytes=0',
    'objects_count=0',
    'if [ -s "$tmp_state_roots" ]; then',
    '  while IFS= read -r cand_sr; do',
    '    [ -n "$cand_sr" ] || continue',
    '    if [ -d "$cand_sr" ]; then',
    '      sr_total=0',
    '      sr_obj_b=0',
    '      sr_obj_c=0',
    '      if [ "$scoped_only" != "1" ]; then',
    '        sr_total=$(yuyan_dir_bytes "$cand_sr")',
    '      fi',
    `      if [ -d "$cand_sr/${STATE_OBJECTS_DIR_NAME}" ]; then`,
    '        if [ "$scoped_only" != "1" ]; then',
    `          sr_obj_b=$(yuyan_dir_bytes "$cand_sr/${STATE_OBJECTS_DIR_NAME}")`,
    '        fi',
    `        sr_obj_c=$(find "$cand_sr/${STATE_OBJECTS_DIR_NAME}" -mindepth 2 -maxdepth 2 -type f 2>/dev/null | wc -l | tr -d " ")`,
    '      fi',
    '      printf "EXTRA_STATE_ROOT\\t%s\\t1\\t%s\\t%s\\t%s\\n" "$cand_sr" "$sr_total" "$sr_obj_b" "$sr_obj_c"',
    '      if [ "$state_exists" = "0" ]; then',
    '        effective_state_root="$cand_sr"',
    '        state_exists=1',
    '      fi',
    '      state_total_bytes=$((state_total_bytes + sr_total))',
    '      objects_bytes=$((objects_bytes + sr_obj_b))',
    '      objects_count=$((objects_count + sr_obj_c))',
    '    fi',
    '  done < "$tmp_state_roots"',
    'fi',
    'printf "STATE_ROOT\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$effective_state_root" "$state_exists" "$state_total_bytes" "$objects_bytes" "$objects_count"',
    '',
    '# 3. 全量扫描模式下补充 htmlRoot 及其子目录',
    'if [ "$scoped_only" != "1" ] && [ -n "$html_root" ] && [ -d "$html_root" ]; then',
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
    '# 4. 遍历全部存在的外置仓 targets/<slug> 读取归属元信息与外置快照明细',
    'if [ -s "$tmp_state_roots" ]; then',
    '  while IFS= read -r sr_item; do',
    `    [ -n "$sr_item" ] && [ -d "$sr_item/${STATE_TARGETS_DIR_NAME}" ] || continue`,
    `    for tdir in "$sr_item/${STATE_TARGETS_DIR_NAME}"/*; do`,
    '      [ -d "$tdir" ] || continue',
    '      slug=$(basename "$tdir")',
    '      case "$slug" in ""|"."|".."|.*) continue ;; esac',
    '      mapped_root=""',
    `      if [ -f "$tdir/${TARGET_META_FILE_NAME}" ]; then`,
    `        mapped_root=$(sed -n 's/.*"realRoot"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$tdir/${TARGET_META_FILE_NAME}" | head -n 1 || true)`,
    '      fi',
    '      # 定向扫描模式下跳过与本次目标无关的外置仓记录，避免把其他目录拖进扫描',
    '      if [ "$scoped_only" = "1" ]; then',
    '        matched_scope=0',
    '        if [ -n "$mapped_root" ] && grep -Fxq "$mapped_root" "$tmp_app_roots" 2>/dev/null; then',
    '          matched_scope=1',
    '        fi',
    '        if [ "$matched_scope" = "0" ]; then continue; fi',
    '      fi',
    '      has_ext_manifest=0',
    `      if [ -f "$tdir/manifests/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_ext_manifest=1; fi`,
    '      printf "EXT_TARGET\\t%s\\t%s\\t%s\\t%s\\n" "$slug" "$mapped_root" "$tdir" "$has_ext_manifest"',
    '      if [ "$scoped_only" != "1" ] && [ -n "$mapped_root" ]; then printf "%s\\n" "$mapped_root" >> "$tmp_app_roots"; fi',
    '      if [ -d "$tdir/backups" ]; then',
    '        for bdir in "$tdir/backups"/*; do',
    '          [ -d "$bdir" ] && [ ! -L "$bdir" ] || continue',
    '          bname=$(basename "$bdir")',
    '          case "$bname" in ""|"."|".."|.*) continue ;; esac',
    '          bkind="full"',
    `          if [ -f "$bdir/${BACKUP_KIND_FILE_NAME}" ]; then bkind=$(tr -d "[:space:]" < "$bdir/${BACKUP_KIND_FILE_NAME}"); fi`,
    '          bts=0',
    '          blogical=0',
    `          if [ -f "$bdir/${BACKUP_META_FILE_NAME}" ]; then`,
    `            bts=$(sed -n 's/.*"createdAtEpoch"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$bdir/${BACKUP_META_FILE_NAME}" | head -n 1 || true)`,
    `            blogical=$(sed -n 's/.*"logicalBytes"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$bdir/${BACKUP_META_FILE_NAME}" | head -n 1 || true)`,
    '          fi',
    '          case "$bts" in ""|*[!0-9]*|0) bts=$(yuyan_file_mtime "$bdir") ;; esac',
    '          bphys=$(yuyan_dir_bytes "$bdir")',
    '          case "$blogical" in ""|*[!0-9]*|0) blogical="$bphys" ;; esac',
    '          printf "BACKUP\\texternal\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$slug" "$mapped_root" "$bdir" "$bkind" "$bts" "$bphys" "$blogical"',
    '        done',
    '      fi',
    '    done',
    '  done < "$tmp_state_roots"',
    'fi',
    '',
    '# 5. 对去重后的每个应用目录统计运行态、内嵌备份、内嵌清单、暂存垃圾及 assets 体积',
    'sort -u "$tmp_app_roots" | while IFS= read -r app_dir; do',
    '  [ -n "$app_dir" ] || continue',
    '  if [ ! -d "$app_dir" ]; then',
    '    printf "APP\\t%s\\t0\\t0\\t0\\t0\\t0\\t0\\t0\\t0\\n" "$app_dir"',
    '    continue',
    '  fi',
    '  total_b=0',
    '  if [ "$scoped_only" != "1" ]; then',
    '    total_b=$(yuyan_dir_bytes "$app_dir")',
    '  fi',
    `  ib_dir="$app_dir/${LEGACY_BACKUP_DIR_NAME}"`,
    `  im_dir="$app_dir/${LEGACY_MANIFEST_DIR_NAME}"`,
    '  ib_bytes=0',
    '  ib_count=0',
    '  if [ -d "$ib_dir" ]; then',
    '    for bdir in "$ib_dir"/*; do',
    '      [ -d "$bdir" ] && [ ! -L "$bdir" ] || continue',
    '      bname=$(basename "$bdir")',
    '      case "$bname" in ""|"."|".."|.*) continue ;; esac',
    '      ib_count=$((ib_count + 1))',
    '      bkind="full"',
    `      if [ -f "$bdir/${BACKUP_KIND_FILE_NAME}" ]; then bkind=$(tr -d "[:space:]" < "$bdir/${BACKUP_KIND_FILE_NAME}"); fi`,
    '      bts=$(yuyan_file_mtime "$bdir")',
    '      bphys=$(yuyan_dir_bytes "$bdir")',
    '      ib_bytes=$((ib_bytes + bphys))',
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
    '  assets_bytes=0',
    '  if [ "$scoped_only" != "1" ]; then',
    '    for sdir in "$app_dir"/.yuyan-retiring-* "$app_dir"/.yuyan-trash-*; do',
    '      [ -e "$sdir" ] || continue',
    '      sb=$(yuyan_dir_bytes "$sdir")',
    '      staging_bytes=$((staging_bytes + sb))',
    '    done',
    '    if [ -d "$app_dir/assets" ]; then',
    '      assets_bytes=$(yuyan_dir_bytes "$app_dir/assets")',
    '    fi',
    '  fi',
    '  printf "APP\\t%s\\t1\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$app_dir" "$total_b" "$ib_bytes" "$ib_count" "$im_bytes" "$staging_bytes" "$has_im_current" "$assets_bytes"',
    'done',
  ].join('\n');

  return buildPosixShellCommand(
    script,
    [
      htmlRoot || '',
      primaryStateRoot,
      scopedOnly ? '1' : '0',
      String(safeCandidateDirs.length),
      ...safeCandidateDirs,
      ...safeRoots,
    ],
    useSudo
  );
}

/**
 * 解析远程存储扫描输出并与部署目标、DB 回滚记录关联聚合。
 * @param {string} stdout - 远程扫描输出
 * @param {Object} [context={}] - 上下文（targets、backupReferences、nginxInstance）
 * @returns {Object} 结构化存储诊断报告
 */
export function parseInspectNginxStorageOutput(stdout, context = {}) {
  const {
    targets = [],
    otherTeamTargets = [],
    backupReferences = [],
    nginxInstance = null,
  } = context;
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);

  const htmlRootInfo = { path: '', exists: false, totalBytes: 0 };
  const stateRootInfo = { path: '', exists: false, totalBytes: 0, objectsBytes: 0, objectsCount: 0 };
  const existingStateRoots = [];
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
    } else if (tag === 'EXTRA_STATE_ROOT') {
      const srPath = normalizePosixAbsPath(cols[1] || '');
      if (srPath && cols[2] === '1' && !existingStateRoots.some((s) => s.path === srPath)) {
        existingStateRoots.push({
          path: srPath,
          totalBytes: Number(cols[3] || 0) || 0,
          objectsBytes: Number(cols[4] || 0) || 0,
          objectsCount: Number(cols[5] || 0) || 0,
        });
      }
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

  // 构建 DB 目标与回滚引用索引（兼容软链穿透后的 realRoot 与原始 deployRoot）
  const targetByRoot = new Map();
  const targetBySlug = new Map();
  for (const t of targets) {
    const roots = [t?.realRoot, t?.deployRoot].filter(Boolean);
    for (const r of roots) {
      const normRoot = normalizePosixAbsPath(r);
      if (!normRoot) continue;
      targetByRoot.set(normRoot, t);
      targetBySlug.set(buildTargetStateSlug(normRoot), t);
    }
  }
  const otherTeamRootSet = new Set();
  const otherTeamSlugSet = new Set();
  for (const ot of otherTeamTargets || []) {
    const roots = [ot?.realRoot, ot?.deployRoot].filter(Boolean);
    for (const r of roots) {
      const normRoot = normalizePosixAbsPath(r);
      if (!normRoot) continue;
      otherTeamRootSet.add(normRoot);
      otherTeamSlugSet.add(buildTargetStateSlug(normRoot));
    }
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
    const resolvedRoot =
      b.appRoot ||
      extTargetsBySlug.get(b.slug)?.mappedRoot ||
      targetBySlug.get(b.slug)?.realRoot ||
      targetBySlug.get(b.slug)?.deployRoot ||
      '';
    const normResolvedRoot = resolvedRoot ? normalizePosixAbsPath(resolvedRoot) : '';
    const appKey = normResolvedRoot || `external:${b.slug}`;
    const isSelfManagedBackup = Boolean(
      (normResolvedRoot && targetByRoot.has(normResolvedRoot)) ||
      (b.slug && targetBySlug.has(b.slug))
    );
    const isOtherTeamBackup =
      !isSelfManagedBackup &&
      Boolean(
        (normResolvedRoot && otherTeamRootSet.has(normResolvedRoot)) ||
        (b.slug && otherTeamSlugSet.has(b.slug))
      );

    const enriched = {
      ...b,
      referencedByDb: Boolean(dbRef),
      recordId: dbRef?.id || 0,
      branch: dbRef?.branch || '',
      commitSha: dbRef?.commitSha || '',
    };

    if (!backupsByAppKey.has(appKey)) backupsByAppKey.set(appKey, []);
    backupsByAppKey.get(appKey).push(enriched);

    if (b.storageMode === 'inline') {
      inlineBackupTotalBytes += b.physicalBytes;
      inlineBackupTotalCount += 1;
    } else {
      externalBackupTotalCount += 1;
      externalLogicalTotalBytes += b.logicalBytes;
    }

    // 其他团队纳管目标的备份绝不计入本团队「孤儿备份」指标，避免误导清理
    if (!enriched.referencedByDb && !isOtherTeamBackup) {
      unreferencedBackupCount += 1;
      unreferencedBackupBytes += b.storageMode === 'inline' ? b.physicalBytes : b.logicalBytes;
    }
  }

  // 汇总每个应用条目（含孤儿目录与其他团队目录脱敏标识）
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
    const slug = stat.path ? buildTargetStateSlug(stat.path) : key.replace(/^external:/, '');
    const target = (stat.path && targetByRoot.get(stat.path)) || targetBySlug.get(slug) || null;
    const otherTeamManaged =
      !target &&
      Boolean((stat.path && otherTeamRootSet.has(stat.path)) || (slug && otherTeamSlugSet.has(slug)));
    const ownership = target ? 'managed_self' : otherTeamManaged ? 'managed_other_team' : 'unmanaged';
    const extMeta = (stat.path && extTargetsByRoot.get(stat.path)) || extTargetsBySlug.get(slug) || null;

    const inlineBackups = appBackups.filter((b) => b.storageMode === 'inline');
    const externalBackups = appBackups.filter((b) => b.storageMode === 'external');
    const externalLogicalBytes = externalBackups.reduce((sum, b) => sum + b.logicalBytes, 0);
    const referencedInlineBackupCount = inlineBackups.filter((b) => b.referencedByDb).length;
    const referencedExternalBackupCount = externalBackups.filter((b) => b.referencedByDb).length;
    const referencedBackupCount = referencedInlineBackupCount + referencedExternalBackupCount;
    const unreferencedCount = otherTeamManaged ? 0 : appBackups.filter((b) => !b.referencedByDb).length;

    // 跳过 htmlRoot 下既未纳管又无任何备份/清单/暂存的纯静态杂项目录（减少噪音）
    const isHtmlRootSelf = htmlRootInfo.path && stat.path === normalizePosixAbsPath(htmlRootInfo.path);
    const hasGovernanceSignal =
      Boolean(target) ||
      otherTeamManaged ||
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

    const displayName = target
      ? target.projectName
      : otherTeamManaged
        ? `其他团队目录 (${path.posix.basename(stat.path || slug)})`
        : isHtmlRootSelf
          ? '站点根目录 (html)'
          : path.posix.basename(stat.path || slug);

    apps.push({
      key,
      deployRoot: stat.path,
      slug,
      displayName,
      targetId: target?.id || 0,
      envName: target?.envName || '',
      uploadStrategy: target?.uploadStrategy || '',
      managed: Boolean(target),
      otherTeamManaged,
      ownership,
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
      referencedInlineBackupCount,
      referencedExternalBackupCount,
      referencedBackupCount,
      unreferencedBackupCount: unreferencedCount,
      retentionPolicy: policy,
      backups: otherTeamManaged ? [] : appBackups,
    });
  }

  // 按「内嵌遗留备份体积」+「外置逻辑备份体积」倒序，最该治理的排最前
  apps.sort((a, b) => {
    const scoreA = a.inlineBackupBytes * 2 + a.externalLogicalBytes + a.stagingBytes;
    const scoreB = b.inlineBackupBytes * 2 + b.externalLogicalBytes + b.stagingBytes;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.displayName.localeCompare(b.displayName);
  });

  // 原有 Nginx 接入实例常见场景：instance.htmlRoot 未配置或指向不存在的默认路径（如 /opt/yuyan/html），
  // 此时用已扫描到的真实存在顶层不重叠应用目录汇总总占用，避免卡片恒显 0 B
  let effectiveHtmlTotalBytes = htmlRootInfo.totalBytes;
  if (!htmlRootInfo.exists && apps.length > 0) {
    const existingAppDirs = apps
      .filter((a) => a.exists && a.deployRoot && a.totalBytes > 0)
      .sort((a, b) => a.deployRoot.length - b.deployRoot.length);
    const topLevelDirs = [];
    for (const app of existingAppDirs) {
      if (topLevelDirs.some((parent) => isSameOrSubPath(app.deployRoot, parent.deployRoot))) {
        continue;
      }
      topLevelDirs.push(app);
    }
    effectiveHtmlTotalBytes = topLevelDirs.reduce((sum, app) => sum + app.totalBytes, 0);
  }

  const htmlOverheadBytes = inlineBackupTotalBytes + inlineManifestTotalBytes + inlineStagingTotalBytes;
  const htmlRuntimeBytes = Math.max(0, effectiveHtmlTotalBytes - htmlOverheadBytes);
  const dedupSavedBytes = Math.max(0, externalLogicalTotalBytes - stateRootInfo.objectsBytes);
  const dedupSavedPercent = externalLogicalTotalBytes > 0
    ? Math.min(99, Math.round((dedupSavedBytes / externalLogicalTotalBytes) * 100))
    : 0;

  return {
    scannedAt: new Date().toISOString(),
    htmlRoot: htmlRootInfo,
    stateRoot: stateRootInfo,
    existingStateRoots,
    summary: {
      htmlTotalBytes: effectiveHtmlTotalBytes,
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
 * 汇总 Nginx 实例主仓及前端目标在额外状态仓中的待验证目录。
 * @param {Object} instance - Nginx 实例
 * @param {Array<Object>} [targets=[]] - 实例关联的前端部署目标列表
 * @param {string[]} [otherTargetRoots=[]] - 同物理服务器上的其他真实部署根目录
 * @returns {{ primaryStateRoot: string, candidateTargetStateDirs: string[] }}
 */
export function collectInstanceStateRoots(instance, targets = [], otherTargetRoots = []) {
  const statePaths = resolveNginxInstanceStatePaths(instance);
  const primaryStateRoot = normalizePosixAbsPath(statePaths?.stateRoot || '');
  const candidateDirs = new Set();

  const allKnownRoots = [
    ...new Set([
      ...(targets || []).map((t) => normalizePosixAbsPath(t?.realRoot || t?.deployRoot || '')),
      ...(otherTargetRoots || []).map((r) => normalizePosixAbsPath(r)),
    ].filter(Boolean)),
  ];

  for (const target of targets || []) {
    const root = normalizePosixAbsPath(target?.realRoot || target?.deployRoot || '');
    if (!root) continue;
    const { allExternal } = resolveCandidateDeployStateLocations({
      realRoot: root,
      nginxInstance: instance,
      otherTargetRoots: allKnownRoots.filter((r) => r !== root),
      pinnedStateRoot: target?.stateRoot || '',
    });
    for (const layout of allExternal) {
      if (layout.stateRoot !== primaryStateRoot) {
        candidateDirs.add(layout.targetStateDir);
      }
    }
  }

  return { primaryStateRoot, candidateTargetStateDirs: [...candidateDirs] };
}

/**
 * 解析存储清理需要获取的真实存在部署目录锁根（与发布/回滚保持 100% 同一锁根规则，#63）。
 * @description
 * 1. 严格排除服务器上不存在的目录，杜绝误锁不存在目录导致死等；
 * 2. 仅基于「同物理机已纳管部署目标的真实目录（含其他团队）∪ 待清理应用自身目录」调用 `resolveTopmostLockRoot`，
 *    不再把非部署目标的 `htmlRoot` 硬塞进锁候选——保证与发布/回滚锁根完全一致，彻底消除治理与发布并发不互斥的问题；
 * 3. 若 `htmlRoot` 本身也是已纳管的主应用部署目标，它自然在候选集合内，子目录会自动收敛到 `htmlRoot`；
 * 4. 按锁根字典序排序输出，保证多锁顺序一致、零死锁风险。
 * @param {Object} params - 参数
 * @param {Object} params.inspection - 存储扫描结果
 * @param {Array<Object>} [params.selectedApps=[]] - 待清理应用列表
 * @param {string[]} [params.verifiedExistingRoots=[]] - 额外已确认存在的同物理机纳管目标祖先目录
 * @param {string[]} [params.managedTargetRoots=[]] - 同物理机已确认存在的全部纳管目标真实目录
 * @returns {{
 *   lockRoots: string[],
 *   groups: Array<{ lockRoot: string, apps: Array<Object> }>,
 *   locklessApps: Array<Object>
 * }}
 */
export function resolveGovernanceLockRoots({
  inspection,
  selectedApps = [],
  verifiedExistingRoots = [],
  managedTargetRoots = [],
} = {}) {
  const existingCandidates = new Set();
  for (const app of inspection?.apps || []) {
    if (app?.exists && app.deployRoot) {
      // 若 inspection.apps 中显式带有 managed/otherTeamManaged 标志，仅纳管目标可作为其他目录的祖先锁根
      // （未带该字段的旧测试输入保持向后兼容，按有效候选处理）
      const isManagedCandidate =
        app.managed === true ||
        app.otherTeamManaged === true ||
        (app.managed === undefined && app.otherTeamManaged === undefined);
      if (isManagedCandidate) {
        const normRoot = normalizePosixAbsPath(app.deployRoot);
        if (normRoot) existingCandidates.add(normRoot);
      }
    }
  }
  for (const root of verifiedExistingRoots || []) {
    const normRoot = normalizePosixAbsPath(root);
    if (normRoot) existingCandidates.add(normRoot);
  }
  for (const root of managedTargetRoots || []) {
    const normRoot = normalizePosixAbsPath(root);
    if (normRoot) existingCandidates.add(normRoot);
  }

  const existingList = [...existingCandidates];
  const groupMap = new Map();
  const locklessApps = [];

  for (const app of selectedApps || []) {
    const normAppRoot = app?.deployRoot ? normalizePosixAbsPath(app.deployRoot) : '';
    if (!normAppRoot || app.exists === false) {
      locklessApps.push(app);
      continue;
    }
    const lockRoot = resolveTopmostLockRoot(normAppRoot, existingList);
    if (!lockRoot) {
      locklessApps.push(app);
      continue;
    }
    if (!groupMap.has(lockRoot)) {
      groupMap.set(lockRoot, []);
    }
    groupMap.get(lockRoot).push(app);
  }

  const lockRoots = [...groupMap.keys()].sort((a, b) => a.localeCompare(b));
  const groups = lockRoots.map((lockRoot) => ({ lockRoot, apps: groupMap.get(lockRoot) || [] }));
  return { lockRoots, groups, locklessApps };
}

/**
 * 扫描指定 Nginx 实例的存储占用情况（只读）。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} [options={}] - 扫描选项
 * @param {string[]} [options.targetRoots=[]] - 仅扫描指定应用目录（用于单笔清理提速）
 * @param {boolean} [options.scopedOnly=false] - 是否启用轻量定向扫描（跳过无关目录和全 htmlRoot du）
 * @param {AbortSignal} [options.signal] - 中止信号
 * @returns {Promise<Object>} 存储诊断报告
 */
export async function inspectNginxInstanceStorage(instanceId, options = {}) {
  const { instance, server } = await getNginxInstanceContext(Number(instanceId));
  if (!instance || !server) {
    throw Object.assign(new Error('Nginx 实例或关联服务器不存在'), { statusCode: 404 });
  }

  const currentTeamId = getRequestTeamId();
  const useSudo = resolveEffectiveDeploySudo(server, instance);
  const allTargets = await listTargets({ serverId: server.id });
  let physicalTargets = [];
  try {
    physicalTargets = await listPhysicalServerTargets({ serverId: server.id });
  } catch {
    physicalTargets = allTargets.map((t) => ({
      id: t.id,
      serverId: t.serverId,
      teamId: currentTeamId,
      deployRoot: t.deployRoot,
      projectName: t.projectName,
      projectType: t.projectType || 'frontend',
    }));
  }
  const otherTeamPhysicalTargets = physicalTargets.filter(
    (t) =>
      t?.deployRoot &&
      t.projectType !== 'backend' &&
      String(t.teamId || '') !== String(currentTeamId || '')
  );

  const requestedRoots = Array.isArray(options.targetRoots)
    ? [...new Set(options.targetRoots.map(normalizePosixAbsPath).filter((p) => p && p.startsWith('/')))]
    : [];
  const scopedOnly = Boolean(options.scopedOnly && requestedRoots.length > 0);

  // 先查当前团队在本服务器上的 DB 回滚引用快照（位于 SSH 扫描前，避免竞态），且 GET 只读接口绝不写库（#63）
  const preFetchedBackupReferences = await listBackupReferencesByTargetIds(
    allTargets.filter((t) => t.projectType !== 'backend').map((t) => t.id)
  );

  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  const {
    stdout,
    effectiveInstance,
    resolvedInstanceTargets,
    resolvedOtherTeamTargets,
    resolvedRequestedRoots,
    resolvedAllPhysicalRoots,
  } = await effectiveWithSsh(server, async (conn) => {
    // 统一穿透软链接（与发布/回滚保持完全一致的 realRoot/slug/lockRoot，#63）
    const pathsToResolve = [];
    const registerPath = (p) => {
      const norm = normalizePosixAbsPath(p || '');
      if (!norm || !norm.startsWith('/')) return -1;
      const existingIdx = pathsToResolve.indexOf(norm);
      if (existingIdx !== -1) return existingIdx;
      pathsToResolve.push(norm);
      return pathsToResolve.length - 1;
    };

    const baseRootIdx = registerPath(instance.baseRoot);
    const htmlRootIdx = registerPath(instance.htmlRoot);
    const targetIdxMap = new Map();
    for (const t of allTargets) {
      if (t.projectType === 'backend' || !t.deployRoot) continue;
      targetIdxMap.set(Number(t.id), registerPath(t.deployRoot));
    }
    const otherIdxMap = new Map();
    for (const ot of otherTeamPhysicalTargets) {
      otherIdxMap.set(Number(ot.id), registerPath(ot.deployRoot));
    }
    const reqIdxList = requestedRoots.map((r) => registerPath(r));

    let resolvedPaths = pathsToResolve;
    if (pathsToResolve.length > 0) {
      resolvedPaths = await batchDetectRealRoots(conn, pathsToResolve, useSudo, {
        signal: options.signal,
      }).catch(() => pathsToResolve);
    }
    const getResolved = (idx, fallback) =>
      idx >= 0 && resolvedPaths[idx] ? normalizePosixAbsPath(resolvedPaths[idx]) : normalizePosixAbsPath(fallback || '');

    const realBaseRoot = getResolved(baseRootIdx, instance.baseRoot);
    const realHtmlRoot = getResolved(htmlRootIdx, instance.htmlRoot);
    const nextInstance = {
      ...instance,
      ...(realBaseRoot ? { baseRoot: realBaseRoot } : {}),
      ...(realHtmlRoot ? { htmlRoot: realHtmlRoot } : {}),
    };
    const effectiveStatePaths = resolveNginxInstanceStatePaths(nextInstance);

    const enrichedAllTargets = allTargets
      .filter((t) => t.projectType !== 'backend')
      .map((t) => ({
        ...t,
        realRoot: getResolved(targetIdxMap.get(Number(t.id)) ?? -1, t.deployRoot),
      }));
    const enrichedOtherTeamTargets = otherTeamPhysicalTargets.map((ot) => ({
      ...ot,
      realRoot: getResolved(otherIdxMap.get(Number(ot.id)) ?? -1, ot.deployRoot),
    }));

    const instTargets = enrichedAllTargets.filter(
      (t) =>
        Number(t.nginxInstanceId) === Number(instance.id) ||
        (effectiveStatePaths?.htmlRoot &&
          (isSameOrSubPath(t.realRoot, effectiveStatePaths.htmlRoot) ||
            isSameOrSubPath(t.deployRoot, instance.htmlRoot || effectiveStatePaths.htmlRoot)))
    );

    const resolvedReq = [...new Set(reqIdxList.map((idx, i) => getResolved(idx, requestedRoots[i])).filter(Boolean))];
    const targetsForScope = scopedOnly
      ? instTargets.filter((t) =>
          resolvedReq.some((r) => r === t.realRoot || r === normalizePosixAbsPath(t.deployRoot))
        )
      : instTargets;

    const allPhysicalRealRoots = [
      ...new Set([
        ...enrichedAllTargets.map((t) => t.realRoot),
        ...enrichedOtherTeamTargets.map((t) => t.realRoot),
      ].filter(Boolean)),
    ];

    const { primaryStateRoot, candidateTargetStateDirs } = collectInstanceStateRoots(
      nextInstance,
      targetsForScope,
      allPhysicalRealRoots
    );
    const scanRoots = scopedOnly
      ? resolvedReq
      : instTargets.map((t) => t.realRoot || t.deployRoot);

    const cmd = buildInspectNginxStorageCommand({
      htmlRoot: effectiveStatePaths?.htmlRoot || nextInstance.htmlRoot || '',
      stateRoot: primaryStateRoot,
      candidateTargetStateDirs,
      targetRoots: scanRoots,
      scopedOnly,
      useSudo,
    });
    const res = await execSsh(conn, cmd, {
      allowFailure: true,
      signal: options.signal,
      label: scopedOnly ? '定向扫描目标存储占用' : '扫描 Nginx 实例存储占用',
    });
    if (res.code !== 0) {
      throw new Error(`存储扫描失败（退出码 ${res.code}）：${res.stderr || res.stdout || '未知错误'}`);
    }
    return {
      stdout: String(res.stdout || ''),
      effectiveInstance: nextInstance,
      resolvedInstanceTargets: instTargets,
      resolvedOtherTeamTargets: enrichedOtherTeamTargets,
      resolvedRequestedRoots: resolvedReq,
      resolvedAllPhysicalRoots: allPhysicalRealRoots,
    };
  });

  const scopedTargetIdSet = new Set(
    (scopedOnly
      ? resolvedInstanceTargets.filter((t) =>
          resolvedRequestedRoots.some((r) => r === t.realRoot || r === normalizePosixAbsPath(t.deployRoot))
        )
      : resolvedInstanceTargets
    ).map((t) => Number(t.id))
  );

  const backupReferences = preFetchedBackupReferences.filter((ref) => scopedTargetIdSet.has(Number(ref.targetId)));
  const parsed = parseInspectNginxStorageOutput(stdout, {
    targets: resolvedInstanceTargets,
    otherTeamTargets: resolvedOtherTeamTargets,
    backupReferences,
    nginxInstance: effectiveInstance,
  });

  return {
    instanceId: instance.id,
    instanceName: instance.name,
    serverId: server.id,
    serverName: server.name,
    resolvedRequestedRoots,
    resolvedOtherTeamRoots: resolvedOtherTeamTargets.map((t) => t.realRoot || normalizePosixAbsPath(t.deployRoot)).filter(Boolean),
    ...parsed,
  };
}

/**
 * 生成安全删除指定备份目录列表（及可选清理空壳内嵌目录）的远程 Shell 命令。
 * @param {Object} params - 删除参数
 * @param {string[]} params.backupPaths - 经校验的待删备份绝对路径
 * @param {string[]} [params.cleanupEmptyInlineRoots=[]] - 允许清理空壳 .yuyan-backups 的应用目录
 * @param {string[]} [params.cleanupLegacyManifestRoots=[]] - 已有外置清单、可移除历史内嵌 .yuyan-manifests 的应用目录
 * @param {boolean} [params.skipMeasure=false] - 跳过 rm -rf 前的 du -sk（调用方已有扫描体积时可显著提速）
 * @param {boolean} [params.useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildDeleteBackupEntriesCommand({
  backupPaths = [],
  cleanupEmptyInlineRoots = [],
  cleanupLegacyManifestRoots = [],
  skipMeasure = false,
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
    'skip_measure="$4"',
    'shift 4',
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
    '    if [ -d "$arg" ] && [ ! -L "$arg" ]; then',
    '      sz=0',
    '      if [ "$skip_measure" != "1" ]; then sz=$(yuyan_dir_bytes "$arg"); fi',
    '      if rm -rf "$arg"; then',
    '        deleted_count=$((deleted_count + 1))',
    '        freed_bytes=$((freed_bytes + sz))',
    '        printf "%s\\n" "$arg" >> "$tmp_deleted"',
    '        printf "DELETED_PATH\\t%s\\n" "$arg"',
    '      fi',
    '    fi',
    '  elif [ "$idx" -le $((b_count + i_count)) ]; then',
    `    if [ -d "$arg/${LEGACY_BACKUP_DIR_NAME}" ]; then`,
    `      has_rem=0`,
    `      for rem in "$arg/${LEGACY_BACKUP_DIR_NAME}"/*; do [ -e "$rem" ] && { has_rem=1; break; }; done`,
    `      if [ "$has_rem" = "0" ]; then`,
    `        rm -f "$arg/${LEGACY_BACKUP_DIR_NAME}/${TARGET_RETIRED_MARKER_NAME}" 2>/dev/null || true`,
    `        rmdir "$arg/${LEGACY_BACKUP_DIR_NAME}" 2>/dev/null || true`,
    `      fi`,
    `    fi`,
    '  else',
    `    if [ -d "$arg/${LEGACY_MANIFEST_DIR_NAME}" ]; then`,
    '      sz=0',
    `      if [ "$skip_measure" != "1" ]; then sz=$(yuyan_dir_bytes "$arg/${LEGACY_MANIFEST_DIR_NAME}"); fi`,
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
      skipMeasure ? '1' : '0',
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
 * 创建带取消语义的标准错误。
 * @param {AbortSignal} signal - 中止信号
 * @returns {Error}
 */
function createStorageAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' && reason ? reason : '存储清理任务已取消');
  err.name = 'AbortError';
  err.code = 'ERR_CANCELED';
  return err;
}

/**
 * 检查中止信号，已取消时抛出错误。
 * @param {AbortSignal} [signal] - 中止信号
 */
function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw createStorageAbortError(signal);
  }
}

/**
 * 规划单个应用需要删除的存量内嵌备份、空壳目录与已知字节映射。
 * @param {Object} app - 扫描得到的应用条目
 * @param {'none'|'keep_latest_1'|'purge_unreferenced'|'purge_all'} inlineAction - 存量内嵌策略
 * @returns {{
 *   inlinePathsToDelete: string[],
 *   cleanupEmptyInlineRoots: string[],
 *   cleanupLegacyManifestRoots: string[],
 *   knownBytesByPath: Map<string, number>,
 *   manifestBytes: number
 * }}
 */
function planAppInlineDeletion(app, inlineAction) {
  const inlinePathsToDelete = [];
  const cleanupEmptyInlineRoots = [];
  const cleanupLegacyManifestRoots = [];
  const knownBytesByPath = new Map();
  let manifestBytes = 0;

  const inlineBackups = (app.backups || [])
    .filter((b) => b.storageMode === 'inline')
    .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch);

  if (inlineBackups.length > 0 && inlineAction !== 'none') {
    if (inlineAction === 'purge_all') {
      inlineBackups.forEach((b) => {
        inlinePathsToDelete.push(b.backupPath);
        knownBytesByPath.set(normalizePosixAbsPath(b.backupPath), Number(b.physicalBytes || 0));
      });
      if (app.deployRoot) cleanupEmptyInlineRoots.push(app.deployRoot);
      if (app.deployRoot && app.hasExternalManifest && app.hasInlineManifest) {
        cleanupLegacyManifestRoots.push(app.deployRoot);
        manifestBytes = Number(app.inlineManifestBytes || 0);
      }
    } else if (inlineAction === 'keep_latest_1') {
      const startIdx = app.externalBackupCount > 0 ? 0 : 1;
      inlineBackups.slice(startIdx).forEach((b) => {
        inlinePathsToDelete.push(b.backupPath);
        knownBytesByPath.set(normalizePosixAbsPath(b.backupPath), Number(b.physicalBytes || 0));
      });
      if (startIdx === 0 && app.deployRoot) {
        cleanupEmptyInlineRoots.push(app.deployRoot);
        if (app.hasExternalManifest && app.hasInlineManifest) {
          cleanupLegacyManifestRoots.push(app.deployRoot);
          manifestBytes = Number(app.inlineManifestBytes || 0);
        }
      }
    } else if (inlineAction === 'purge_unreferenced') {
      inlineBackups
        .filter((b) => !b.referencedByDb)
        .forEach((b) => {
          inlinePathsToDelete.push(b.backupPath);
          knownBytesByPath.set(normalizePosixAbsPath(b.backupPath), Number(b.physicalBytes || 0));
        });
      if (app.deployRoot) cleanupEmptyInlineRoots.push(app.deployRoot);
    }
  } else if (
    app.deployRoot &&
    inlineBackups.length === 0 &&
    app.hasExternalManifest &&
    app.hasInlineManifest &&
    inlineAction !== 'none'
  ) {
    cleanupEmptyInlineRoots.push(app.deployRoot);
    cleanupLegacyManifestRoots.push(app.deployRoot);
    manifestBytes = Number(app.inlineManifestBytes || 0);
  }

  return {
    inlinePathsToDelete,
    cleanupEmptyInlineRoots,
    cleanupLegacyManifestRoots,
    knownBytesByPath,
    manifestBytes,
  };
}

/**
 * 构建轻量探活命令，批量校验指定候选目录在远程是否真实存在（用于定向清理时准确解析共享父目录锁）。
 * @param {string[]} dirs - 候选绝对目录
 * @param {boolean} [useSudo=false] - 是否 sudo
 * @returns {string}
 */
function buildProbeExistingDirsCommand(dirs = [], useSudo = false) {
  const safeDirs = [...new Set(dirs.map(normalizePosixAbsPath).filter((p) => p && p.startsWith('/')))];
  const script = [
    '# yuyan:probe-existing-dirs',
    'set -u',
    'for d in "$@"; do',
    '  [ -n "$d" ] && [ -d "$d" ] && printf "%s\\n" "$d"',
    'done',
  ].join('\n');
  return buildPosixShellCommand(script, safeDirs, useSudo);
}

/**
 * 创建基于 stdout 流式输出的已删路径实时收集器（确保中途取消或部分失败时仍能精确同步 DB，#63）。
 * @param {Set<string>} targetSet - 目标路径集合
 * @returns {(chunk: string) => void} onStdout 回调
 */
function createDeletedPathStreamCollector(targetSet) {
  let buffer = '';
  return (chunk) => {
    buffer += String(chunk || '');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('DELETED_PATH\t')) {
        const p = normalizePosixAbsPath(line.slice('DELETED_PATH\t'.length).trim());
        if (p) targetSet.add(p);
      }
    }
  };
}

/**
 * 将数组切分为固定大小的批次（防止单条远程命令触发 ARG_MAX 上限并缩短取消响应窗口）。
 * @template T
 * @param {T[]} items - 原始列表
 * @param {number} batchSize - 单批大小
 * @returns {T[][]}
 */
function chunkArray(items, batchSize) {
  const size = Math.max(1, Number(batchSize || 1));
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * 执行 Nginx 实例级（或指定目录级）备份清理与对象池 GC。
 * 兼容雨燕托管 Nginx 与原有 Nginx 接入实例（#63 加固）：
 * - 全量清理仅处理本团队已纳管目标（managed_self），严格隔离其他团队与未纳管目录；
 * - 统一基于跨团队物理机目标 + 软链穿透真实路径计算锁根，与发布/回滚保持 100% 同锁互斥；
 * - 分批删除 + 实时 stdout 采集已删路径，支持 AbortSignal 批次边界即时停止并完整回写 DB。
 * @param {number} instanceId - Nginx 实例 ID
 * @param {Object} [options={}] - 清理选项
 * @param {'none'|'keep_latest_1'|'purge_unreferenced'|'purge_all'} [options.inlineAction='keep_latest_1'] - 存量内嵌备份清理策略
 * @param {boolean} [options.applyRetentionPolicy=true] - 是否按三维策略裁剪纳管目标备份
 * @param {boolean} [options.runCasGc=true] - 是否运行外置仓 CAS 对象池 GC
 * @param {number} [options.gcGraceMinutes=10] - 对象池 GC 宽限期（分钟）
 * @param {string[]} [options.targetRoots=[]] - 限定处理的应用目录（为空表示实例下全部本团队纳管目标）
 * @param {string} [options.operator=''] - 操作人
 * @param {AbortSignal} [options.signal] - 中止信号（客户端断连或用户手动取消）
 * @param {(progress: Object) => void} [options.onProgress] - 实时进度回调
 * @returns {Promise<Object>} 清理统计结果
 */
export async function pruneNginxInstanceBackups(instanceId, options = {}) {
  const inlineAction = ['none', 'keep_latest_1', 'purge_unreferenced', 'purge_all'].includes(options.inlineAction)
    ? options.inlineAction
    : 'keep_latest_1';
  const applyRetentionPolicy = options.applyRetentionPolicy !== false;
  const runCasGc = options.runCasGc !== false;
  // 服务入口强制对象池 GC 宽限期下限为 5 分钟，防止误传 0 破坏在途写入保护（#63）
  const gcGraceMinutes = Math.max(5, Math.min(1440, Number(options.gcGraceMinutes ?? DEFAULT_CAS_GC_GRACE_MINUTES)));
  const requestedRoots = Array.isArray(options.targetRoots)
    ? [...new Set(options.targetRoots.map(normalizePosixAbsPath).filter(Boolean))]
    : [];
  const rootFilterSet = requestedRoots.length > 0 ? new Set(requestedRoots) : null;
  const signal = options.signal;
  const emitProgress = (patch) => {
    try {
      options.onProgress?.(patch);
    } catch {}
  };

  assertNotAborted(signal);
  emitProgress({
    phase: 'scanning',
    phaseLabel: rootFilterSet ? '正在定向扫描待清理目录…' : '正在扫描实例备份目录…',
    percent: 5,
    totalApps: rootFilterSet ? rootFilterSet.size : 0,
    completedApps: 0,
    currentAppName: '',
    deletedBackups: 0,
    freedBytes: 0,
    clearedDbRecords: 0,
  });

  const inspection = await inspectNginxInstanceStorage(instanceId, {
    targetRoots: requestedRoots,
    scopedOnly: Boolean(rootFilterSet),
    syncStaleDbReferences: false,
    signal,
  });
  assertNotAborted(signal);

  // 合并软链穿透后的目标目录，确保调用方传配置路径（软链）时能与扫描出的 realRoot 100% 匹配（#63）
  const effectiveRootFilterSet = rootFilterSet
    ? new Set([...rootFilterSet, ...(inspection.resolvedRequestedRoots || [])])
    : null;

  const { instance, server } = await getNginxInstanceContext(Number(instanceId));
  const useSudo = resolveEffectiveDeploySudo(server, instance);
  const allTargets = await listTargets({ serverId: server.id });
  const targetById = new Map(allTargets.map((t) => [Number(t.id), t]));
  let physicalTargets = [];
  try {
    physicalTargets = await listPhysicalServerTargets({ serverId: server.id });
  } catch {
    physicalTargets = allTargets;
  }

  let selectedApps = [];
  if (!effectiveRootFilterSet) {
    // 全量清理严格仅处理本团队已纳管目标，绝不误删未纳管目录与其他团队项目（P1-1）
    selectedApps = inspection.apps.filter((app) => app.ownership === 'managed_self' || app.managed === true);
  } else {
    const matched = inspection.apps.filter(
      (app) =>
        (app.deployRoot && effectiveRootFilterSet.has(normalizePosixAbsPath(app.deployRoot))) ||
        effectiveRootFilterSet.has(app.key)
    );
    const forbiddenOtherTeam = matched.find((app) => app.ownership === 'managed_other_team' || app.otherTeamManaged);
    if (forbiddenOtherTeam) {
      throw Object.assign(
        new Error(`禁止清理其他团队纳管的部署目录：${forbiddenOtherTeam.deployRoot || forbiddenOtherTeam.slug}`),
        { statusCode: 403 }
      );
    }
    const otherTeamRoots = Array.isArray(inspection.resolvedOtherTeamRoots) ? inspection.resolvedOtherTeamRoots : [];
    const nestedInOtherTeam = matched.find(
      (app) =>
        !app.managed &&
        app.deployRoot &&
        otherTeamRoots.some((otRoot) => isSameOrSubPath(app.deployRoot, otRoot))
    );
    if (nestedInOtherTeam) {
      throw Object.assign(
        new Error(`目录「${nestedInOtherTeam.deployRoot}」位于其他团队纳管目录内部，已禁止清理`),
        { statusCode: 403 }
      );
    }
    const unmanagedUnref = matched.find(
      (app) => !app.managed && inlineAction === 'purge_unreferenced'
    );
    if (unmanagedUnref) {
      throw Object.assign(
        new Error(`未纳管目录「${unmanagedUnref.deployRoot || unmanagedUnref.slug}」无本团队发布记录，禁止按「孤儿备份」全清；请先纳管或选择明确策略`),
        { statusCode: 400 }
      );
    }
    selectedApps = matched;
  }

  // 预先为每个应用计算删除计划与是否需要三维裁剪，避免无意义 SSH 往返
  const appWorkItems = selectedApps.map((app) => {
    const plan = planAppInlineDeletion(app, inlineAction);
    const remainingInlineCount = Math.max(0, (app.inlineBackupCount || 0) - plan.inlinePathsToDelete.length);
    const totalRemainingBackups = remainingInlineCount + (app.externalBackupCount || 0);
    const target = app.targetId ? targetById.get(Number(app.targetId)) || null : null;
    const policy = target ? resolveDeployRetentionPolicy(target) : null;
    // 只有存在剩余备份（且超过保底份数）时才需要执行远程三维裁剪
    const needRetentionPrune = Boolean(
      applyRetentionPolicy &&
      target &&
      app.deployRoot &&
      policy &&
      totalRemainingBackups > policy.minKeepCount
    );
    const hasInlineWork =
      plan.inlinePathsToDelete.length > 0 ||
      plan.cleanupEmptyInlineRoots.length > 0 ||
      plan.cleanupLegacyManifestRoots.length > 0;
    return {
      app,
      target,
      policy,
      plan,
      hasInlineWork,
      needRetentionPrune,
      hasAnyWork: hasInlineWork || needRetentionPrune,
    };
  });

  const activeWorkItems = appWorkItems.filter((item) => item.hasAnyWork);
  const totalApps = activeWorkItems.length;

  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  let totalDeletedBackups = 0;
  let totalFreedBytes = 0;
  let totalDbCleared = 0;
  const allDeletedPathsSet = new Set();
  let deletedExternalCount = 0;
  let casGcResult = null;
  let completedApps = 0;

  const candidateStateRoots = (inspection.existingStateRoots || [])
    .filter((sr) => sr?.path)
    .map((sr) => sr);
  if (candidateStateRoots.length === 0 && inspection.stateRoot?.exists && inspection.stateRoot.path) {
    candidateStateRoots.push({
      path: normalizePosixAbsPath(inspection.stateRoot.path),
      objectsCount: Number(inspection.stateRoot.objectsCount || 0),
    });
  }

  const needAnyRemoteAction =
    activeWorkItems.length > 0 ||
    (runCasGc && candidateStateRoots.some((sr) => sr.objectsCount > 0));

  let executionError = null;
  if (needAnyRemoteAction) {
    try {
      await effectiveWithSsh(server, async (conn) => {
      assertNotAborted(signal);

      // 统一基于跨团队物理机全部前端目标 + 软链穿透计算真实存在锁候选（与发布/回滚 100% 一致，#63）
      const physicalFrontendPaths = [
        ...new Set(
          physicalTargets
            .filter((t) => t?.deployRoot && t.projectType !== 'backend')
            .map((t) => normalizePosixAbsPath(t.deployRoot))
            .filter(Boolean)
        ),
      ];
      let realBaseRoot = '';
      let realHtmlRoot = '';
      const extraResolve = [instance.baseRoot, instance.htmlRoot].filter(Boolean);
      const allToResolve = [...extraResolve, ...physicalFrontendPaths];
      let resolvedPhysicalRoots = physicalFrontendPaths;
      if (allToResolve.length > 0) {
        const resolved = await batchDetectRealRoots(conn, allToResolve, useSudo, { signal }).catch(() => allToResolve);
        let cursor = 0;
        if (instance.baseRoot) {
          realBaseRoot = normalizePosixAbsPath(resolved[cursor] || instance.baseRoot);
          cursor += 1;
        }
        if (instance.htmlRoot) {
          realHtmlRoot = normalizePosixAbsPath(resolved[cursor] || instance.htmlRoot);
          cursor += 1;
        }
        resolvedPhysicalRoots = [
          ...new Set(resolved.slice(cursor).map((p) => normalizePosixAbsPath(p)).filter(Boolean)),
        ];
      }

      let verifiedManagedRoots = [];
      if (resolvedPhysicalRoots.length > 0) {
        const probeRes = await execSsh(conn, buildProbeExistingDirsCommand(resolvedPhysicalRoots, useSudo), {
          allowFailure: true,
          signal,
          label: '探测物理机纳管目标锁路径',
        });
        if (probeRes.code === 0) {
          verifiedManagedRoots = String(probeRes.stdout || '')
            .split(/\r?\n/)
            .map((line) => normalizePosixAbsPath(line))
            .filter(Boolean);
        }
      }

      const workByKey = new Map(activeWorkItems.map((item) => [item.app.key, item]));
      const { groups, locklessApps } = resolveGovernanceLockRoots({
        inspection,
        selectedApps: activeWorkItems.map((item) => item.app),
        managedTargetRoots: verifiedManagedRoots,
      });

      const executionBuckets = [
        ...groups.map((g) => ({ lockRoot: g.lockRoot, apps: g.apps })),
        ...(locklessApps.length > 0 ? [{ lockRoot: '', apps: locklessApps }] : []),
      ];

      /**
       * 执行单个应用的内嵌清理（分批）与三维策略裁剪，实时采集已删路径并更新聚合统计与进度。
       * @param {Object} work - 单个应用工作项
       */
      const processSingleAppWork = async (work) => {
        assertNotAborted(signal);
        const { app, target, policy, plan, hasInlineWork, needRetentionPrune } = work;
        const appLabel = app.displayName || app.deployRoot || app.slug || '未知应用';
        const progressBase = totalApps > 0 ? Math.round(15 + (completedApps / totalApps) * 70) : 50;

        if (hasInlineWork) {
          emitProgress({
            phase: 'deleting_inline',
            phaseLabel: `正在清理内嵌备份 (${completedApps + 1}/${totalApps})：${appLabel}`,
            percent: progressBase,
            totalApps,
            completedApps,
            currentAppName: appLabel,
            deletedBackups: totalDeletedBackups,
            freedBytes: totalFreedBytes,
            clearedDbRecords: totalDbCleared,
          });
          const batches = plan.inlinePathsToDelete.length > 0
            ? chunkArray(plan.inlinePathsToDelete, DELETE_BACKUP_BATCH_SIZE)
            : [[]];
          for (let bIdx = 0; bIdx < batches.length; bIdx += 1) {
            assertNotAborted(signal);
            const isLastBatch = bIdx === batches.length - 1;
            const batchPaths = batches[bIdx];
            const batchStreamDeleted = new Set();
            const delCmd = buildDeleteBackupEntriesCommand({
              backupPaths: batchPaths,
              cleanupEmptyInlineRoots: isLastBatch ? plan.cleanupEmptyInlineRoots : [],
              cleanupLegacyManifestRoots: isLastBatch ? plan.cleanupLegacyManifestRoots : [],
              skipMeasure: true,
              useSudo,
            });
            try {
              const delRes = await execSsh(conn, delCmd, {
                allowFailure: true,
                signal,
                onStdout: createDeletedPathStreamCollector(batchStreamDeleted),
                label: `清理存量内嵌部署备份(${appLabel})`,
              });
              const parsedDel = parseDeleteBackupEntriesOutput(delRes.stdout);
              for (const dp of parsedDel.deletedPaths) {
                const norm = normalizePosixAbsPath(dp);
                if (norm) batchStreamDeleted.add(norm);
              }
              const confirmedDeleted = [...batchStreamDeleted];
              totalDeletedBackups += Math.max(parsedDel.deletedCount, confirmedDeleted.length);
              let appFreed = parsedDel.freedBytes;
              if (appFreed <= 0 && confirmedDeleted.length > 0) {
                for (const deletedPath of confirmedDeleted) {
                  appFreed += plan.knownBytesByPath.get(deletedPath) || 0;
                }
              }
              if (isLastBatch && delRes.code === 0 && plan.cleanupLegacyManifestRoots.length > 0 && plan.manifestBytes > 0) {
                appFreed += plan.manifestBytes;
              }
              totalFreedBytes += appFreed;
              confirmedDeleted.forEach((p) => allDeletedPathsSet.add(p));
              if (delRes.code !== 0) {
                throw new Error(`清理内嵌备份失败（退出码 ${delRes.code}）：${delRes.stderr || delRes.stdout || '未知错误'}`);
              }
            } catch (batchError) {
              // 即便中途取消或异常，也把本批已通过 stdout 确认删除的路径并入 DB 同步集合
              if (batchStreamDeleted.size > 0) {
                for (const dp of batchStreamDeleted) {
                  if (!allDeletedPathsSet.has(dp)) {
                    allDeletedPathsSet.add(dp);
                    totalDeletedBackups += 1;
                    totalFreedBytes += plan.knownBytesByPath.get(dp) || 0;
                  }
                }
              }
              throw batchError;
            }
          }
        }

        if (needRetentionPrune && target && policy) {
          assertNotAborted(signal);
          emitProgress({
            phase: 'pruning_policy',
            phaseLabel: `正在按三维策略裁剪 (${completedApps + 1}/${totalApps})：${appLabel}`,
            percent: Math.min(85, progressBase + Math.max(1, Math.round(35 / Math.max(1, totalApps)))),
            totalApps,
            completedApps,
            currentAppName: appLabel,
            deletedBackups: totalDeletedBackups,
            freedBytes: totalFreedBytes,
            clearedDbRecords: totalDbCleared,
          });
          // 优先沿用该应用实际已有外置快照所在的状态仓（粘性一致），避免新建父目标后裁剪到空仓（#63）
          const existingExtBackup = (app.backups || []).find((b) => b.storageMode === 'external' && b.backupPath);
          const parsedExtInfo = existingExtBackup ? parseExternalBackupPath(existingExtBackup.backupPath) : null;
          const layout = resolveDeployStateLocation({
            realRoot: app.deployRoot,
            nginxInstance: instance,
            realBaseRoot,
            realHtmlRoot,
            otherTargetRoots: resolvedPhysicalRoots.filter((r) => r !== app.deployRoot),
            pinnedStateRoot: target.stateRoot || '',
          });
          const effectivePrimaryBackupRoot = parsedExtInfo?.isExternal
            ? path.posix.join(parsedExtInfo.targetStateDir, 'backups')
            : (layout.mode === 'external' ? layout.backupRoot : layout.legacyBackupRoot);
          const effectiveLegacyBackupRoot =
            parsedExtInfo?.isExternal || layout.mode === 'external' ? layout.legacyBackupRoot : '';
          const pruneCmd = buildPruneBackupsCommand({
            primaryBackupRoot: effectivePrimaryBackupRoot,
            legacyBackupRoot: effectiveLegacyBackupRoot,
            keepCount: policy.backupKeepCount,
            maxSizeMb: policy.backupMaxSizeMb,
            ttlDays: policy.backupTtlDays,
            minKeepCount: policy.minKeepCount,
            useSudo,
          });
          const pruneStreamDeleted = new Set();
          try {
            const pruneRes = await execSsh(conn, pruneCmd, {
              allowFailure: true,
              signal,
              onStdout: createDeletedPathStreamCollector(pruneStreamDeleted),
              label: `按保留策略裁剪备份(${target.projectName})`,
            });
            const knownMap = new Map(
              (app.backups || []).map((b) => [normalizePosixAbsPath(b.backupPath), b])
            );
            const parsed = pruneRes.code === 0 ? parsePruneBackupsOutput(pruneRes.stdout) : { deletedCount: 0, deletedPaths: [], survivingPaths: [] };
            for (const dp of parsed.deletedPaths) {
              const norm = normalizePosixAbsPath(dp);
              if (norm) pruneStreamDeleted.add(norm);
            }
            const confirmedPruneDeleted = [...pruneStreamDeleted];
            totalDeletedBackups += Math.max(parsed.deletedCount, confirmedPruneDeleted.length);
            for (const normDp of confirmedPruneDeleted) {
              const meta = knownMap.get(normDp);
              if (meta?.storageMode === 'external') {
                deletedExternalCount += 1;
              } else if (meta?.physicalBytes) {
                totalFreedBytes += Number(meta.physicalBytes || 0);
              }
              allDeletedPathsSet.add(normDp);
            }
            if (confirmedPruneDeleted.length > 0) {
              // 按精确删除路径同步 DB，避免历史跨仓迁移场景下全集对齐误清仍存在的旧备份引用
              const syncRes = await clearTargetBackupReferencesByPaths(target.id, confirmedPruneDeleted);
              totalDbCleared += syncRes.clearedRecords;
            }
          } catch (pruneError) {
            if (pruneStreamDeleted.size > 0) {
              for (const dp of pruneStreamDeleted) {
                if (!allDeletedPathsSet.has(dp)) {
                  allDeletedPathsSet.add(dp);
                  totalDeletedBackups += 1;
                }
              }
            }
            throw pruneError;
          }
        }

        completedApps += 1;
        emitProgress({
          phase: hasInlineWork ? 'deleting_inline' : 'pruning_policy',
          phaseLabel: `已完成 (${completedApps}/${totalApps})：${appLabel}`,
          percent: totalApps > 0 ? Math.round(15 + (completedApps / totalApps) * 70) : 85,
          totalApps,
          completedApps,
          currentAppName: appLabel,
          deletedBackups: totalDeletedBackups,
          freedBytes: totalFreedBytes,
          clearedDbRecords: totalDbCleared,
        });
      };

      // 按锁根分组依次持锁执行（与发布/回滚完全同一套锁根，按字典序防死锁）
      for (const bucket of executionBuckets) {
        assertNotAborted(signal);
        let lockHandle = null;
        if (bucket.lockRoot) {
          emitProgress({
            phase: 'locking',
            phaseLabel: `正在获取目录锁：${bucket.lockRoot}`,
            percent: Math.max(10, totalApps > 0 ? Math.round(15 + (completedApps / totalApps) * 70) : 15),
            totalApps,
            completedApps,
            currentAppName: bucket.lockRoot,
            deletedBackups: totalDeletedBackups,
            freedBytes: totalFreedBytes,
            clearedDbRecords: totalDbCleared,
          });
          lockHandle = await acquireDeployRootLocks(conn, {
            server,
            lockRoot: bucket.lockRoot,
            useSudo,
            recordId: 0,
            owner: {
              projectName: `存储治理(${instance.name})`,
              targetId: 0,
              recordId: 0,
              operator: options.operator || 'storage-governance',
              actionLabel: '存储清理',
            },
            signal,
            waitTimeoutMs: 30_000,
            onWait: (wait) => {
              emitProgress({
                phase: 'locking',
                phaseLabel: wait?.message || `正在等待目录锁释放：${bucket.lockRoot}`,
                percent: Math.max(10, totalApps > 0 ? Math.round(15 + (completedApps / totalApps) * 70) : 15),
                totalApps,
                completedApps,
                currentAppName: bucket.lockRoot,
                deletedBackups: totalDeletedBackups,
                freedBytes: totalFreedBytes,
                clearedDbRecords: totalDbCleared,
              });
            },
          });
        }

        try {
          for (const app of bucket.apps) {
            const work = workByKey.get(app.key);
            if (!work) continue;
            await processSingleAppWork(work);
          }
        } finally {
          if (lockHandle) {
            await lockHandle.release().catch(() => {});
          }
        }
      }

      // 3. 同步外置仓 CAS 对象池 GC（空对象池且未删外置快照时自动跳过，避免无效远程遍历）
      const gcTargets = runCasGc
        ? candidateStateRoots.filter((sr) => sr.objectsCount > 0 || deletedExternalCount > 0)
        : [];
      if (gcTargets.length > 0) {
        assertNotAborted(signal);
        emitProgress({
          phase: 'cas_gc',
          phaseLabel: '正在回收外置仓 CAS 孤儿对象…',
          percent: 88,
          totalApps,
          completedApps,
          currentAppName: gcTargets[0].path,
          deletedBackups: totalDeletedBackups,
          freedBytes: totalFreedBytes,
          clearedDbRecords: totalDbCleared,
        });
        const aggregatedGc = {
          status: 'ok',
          scannedObjects: 0,
          liveObjects: 0,
          deletedObjects: 0,
          freedBytes: 0,
          skippedGrace: 0,
        };
        for (const sr of gcTargets) {
          assertNotAborted(signal);
          const gcRes = await execSsh(
            conn,
            buildCasObjectPoolGcCommand(sr.path, { graceMinutes: gcGraceMinutes, useSudo }),
            { allowFailure: true, signal, label: `回收外置仓 CAS 孤儿对象(${sr.path})` }
          );
          if (gcRes.code === 0) {
            const parsedGc = parseCasGcOutput(gcRes.stdout);
            aggregatedGc.scannedObjects += parsedGc.scannedObjects;
            aggregatedGc.liveObjects += parsedGc.liveObjects;
            aggregatedGc.deletedObjects += parsedGc.deletedObjects;
            aggregatedGc.freedBytes += parsedGc.freedBytes;
            aggregatedGc.skippedGrace += parsedGc.skippedGrace;
            if (parsedGc.status !== 'ok' && aggregatedGc.scannedObjects === 0) {
              aggregatedGc.status = parsedGc.status;
            }
            totalFreedBytes += parsedGc.freedBytes;
          }
        }
        casGcResult = aggregatedGc;
      } else if (runCasGc && candidateStateRoots.length > 0) {
        casGcResult = {
          status: 'skipped_empty',
          scannedObjects: 0,
          liveObjects: 0,
          deletedObjects: 0,
          freedBytes: 0,
          skippedGrace: 0,
        };
      }
    });
    } catch (error) {
      executionError = error;
    }
  }

  // 4. 精确清空已删除备份对应的 DB 回滚引用（即使中途取消/异常，也把实时采集到的已物理删除记录全部同步干净）
  const allDeletedPaths = [...allDeletedPathsSet];
  if (allDeletedPaths.length > 0) {
    if (!executionError) {
      emitProgress({
        phase: 'syncing_db',
        phaseLabel: '正在同步发布历史回滚引用…',
        percent: 95,
        totalApps,
        completedApps,
        currentAppName: '',
        deletedBackups: totalDeletedBackups,
        freedBytes: totalFreedBytes,
        clearedDbRecords: totalDbCleared,
      });
    }
    const dbClearRes = await clearTargetBackupReferencesByPaths(0, allDeletedPaths).catch(() => ({ clearedRecords: 0 }));
    totalDbCleared += dbClearRes.clearedRecords;
  }

  if (executionError) {
    throw executionError;
  }

  const finalResult = {
    deletedBackups: totalDeletedBackups,
    freedBytes: totalFreedBytes,
    clearedDbRecords: totalDbCleared,
    deletedPaths: allDeletedPaths,
    casGc: casGcResult,
  };

  emitProgress({
    phase: 'done',
    phaseLabel: '清理完成',
    percent: 100,
    totalApps,
    completedApps: totalApps,
    currentAppName: '',
    deletedBackups: finalResult.deletedBackups,
    freedBytes: finalResult.freedBytes,
    clearedDbRecords: finalResult.clearedDbRecords,
  });

  return finalResult;
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
  extraManifestDirs = [],
  backupRoot = '',
  legacyBackupRoot = '',
  extraBackupRoots = [],
  hashedDirs = DEFAULT_HASHED_ASSET_DIRS,
  minAgeDays = 7,
  useSudo = false,
}) {
  const safeHashedDirs = [...new Set((hashedDirs || DEFAULT_HASHED_ASSET_DIRS).filter(isValidEntryName).filter((d) => !isReservedDeployEntry(d)))];
  const minAgeSec = Math.max(0, Number(minAgeDays ?? 7)) * 86400;
  const normMainManifest = normalizePosixAbsPath(manifestDir);
  const normLegacyManifest = normalizePosixAbsPath(legacyManifestDir);
  const cleanExtraManifestDirs = [...new Set((extraManifestDirs || []).map((d) => normalizePosixAbsPath(d)).filter(Boolean))]
    .filter((d) => d !== normMainManifest && d !== normLegacyManifest);
  const normMainBackup = normalizePosixAbsPath(backupRoot);
  const normLegacyBackup = normalizePosixAbsPath(legacyBackupRoot);
  const cleanExtraBackupRoots = [...new Set((extraBackupRoots || []).map((d) => normalizePosixAbsPath(d)).filter(Boolean))]
    .filter((d) => d !== normMainBackup && d !== normLegacyBackup);

  const script = [
    '# yuyan:preview-orphan-assets',
    'set -eu',
    'root="$1"',
    'manifest_dir="$2"',
    'legacy_manifest_dir="$3"',
    'backup_root="$4"',
    'legacy_backup_root="$5"',
    'min_age_sec="$6"',
    'extra_manifest_count="$7"',
    'extra_backup_count="$8"',
    'shift 8',
    ...buildPortableStatLines(),
    'if [ ! -d "$root" ]; then echo "status=root_missing"; exit 0; fi',
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
    'has_current=0',
    `if [ -n "$manifest_dir" ] && [ -f "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    `if [ -n "$legacy_manifest_dir" ] && [ -f "$legacy_manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    'collect_manifests "$manifest_dir"',
    'if [ "$legacy_manifest_dir" != "$manifest_dir" ]; then collect_manifests "$legacy_manifest_dir"; fi',
    'i=0',
    'while [ "$i" -lt "$extra_manifest_count" ]; do',
    '  emd="$1"; shift; i=$((i + 1))',
    `  if [ -n "$emd" ] && [ -f "$emd/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    '  collect_manifests "$emd"',
    'done',
    'collect_backup_manifests "$backup_root"',
    'if [ "$legacy_backup_root" != "$backup_root" ]; then collect_backup_manifests "$legacy_backup_root"; fi',
    'i=0',
    'while [ "$i" -lt "$extra_backup_count" ]; do',
    '  ebr="$1"; shift; i=$((i + 1))',
    '  collect_backup_manifests "$ebr"',
    'done',
    'if [ "$has_current" -eq 0 ]; then echo "status=no_manifest"; exit 0; fi',
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
    [
      rootPath,
      manifestDir || '',
      legacyManifestDir || '',
      backupRoot || '',
      legacyBackupRoot || '',
      String(minAgeSec),
      String(cleanExtraManifestDirs.length),
      String(cleanExtraBackupRoots.length),
      ...cleanExtraManifestDirs,
      ...cleanExtraBackupRoots,
      ...safeHashedDirs,
    ],
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
  // 最小安全宽限强制下限为 1 天（P1-2 防误删在途或刚发布资源）
  const minAgeDays = options.minAgeDays !== undefined && options.minAgeDays !== ''
    ? Math.max(1, Math.min(365, Math.floor(Number(options.minAgeDays) || 1)))
    : Math.max(1, policy.orphanAssetMinAgeDays);

  let physicalTargets = [];
  try {
    physicalTargets = await listPhysicalServerTargets({ serverId: target.serverId });
  } catch {
    physicalTargets = await listTargets({ serverId: target.serverId }).catch(() => [target]);
  }
  const otherFrontendTargets = physicalTargets.filter(
    (t) => t?.deployRoot && Number(t.id) !== Number(target.id) && t.projectType !== 'backend'
  );

  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  const { realRoot, parsed, layout, sharedBlockedReason } = await effectiveWithSsh(server, async (conn) => {
    const extraInstRoots = [nginxInstance?.baseRoot, nginxInstance?.htmlRoot].filter(Boolean);
    const toResolve = [
      target.deployRoot,
      ...extraInstRoots,
      ...otherFrontendTargets.map((t) => t.deployRoot),
    ];
    const resolved = await batchDetectRealRoots(conn, toResolve, useSudo).catch(() => toResolve);
    const detectedRoot = normalizePosixAbsPath(resolved[0] || target.deployRoot);
    let cursor = 1;
    let realBaseRoot = '';
    let realHtmlRoot = '';
    if (nginxInstance?.baseRoot) {
      realBaseRoot = normalizePosixAbsPath(resolved[cursor] || nginxInstance.baseRoot);
      cursor += 1;
    }
    if (nginxInstance?.htmlRoot) {
      realHtmlRoot = normalizePosixAbsPath(resolved[cursor] || nginxInstance.htmlRoot);
      cursor += 1;
    }
    const otherRealRoots = resolved.slice(cursor).map((r) => normalizePosixAbsPath(r)).filter(Boolean);

    // 共享根目录或同目录多目标防误删拦截（#63）：多个应用共用同一部署根时，单目标清单无法代表其他应用资产
    const sameRootOther = otherRealRoots.some((r) => r === detectedRoot);
    const sharedByRule = isSharedDeployRoot({
      target: { ...target, deployRoot: detectedRoot },
      allServerTargets: [
        { ...target, deployRoot: detectedRoot },
        ...otherFrontendTargets.map((t, i) => ({ ...t, deployRoot: otherRealRoots[i] || t.deployRoot })),
      ],
      nginxInstance: nginxInstance
        ? { ...nginxInstance, ...(realHtmlRoot ? { htmlRoot: realHtmlRoot } : {}) }
        : null,
    });
    if (sameRootOther || sharedByRule) {
      return {
        realRoot: detectedRoot,
        layout: null,
        parsed: { status: 'shared_root_blocked', hashedCandidates: [], otherCandidates: [], totalCandidateBytes: 0 },
        sharedBlockedReason: sameRootOther
          ? '检测到同一服务器有多个部署目标共用该根目录，为防止误删其他应用的静态资源，已安全中止无主资源清理。'
          : '该目标为共享站点根目录（主应用或含嵌套子应用），为防止误删同目录其他应用资产，已安全中止无主资源扫描。',
      };
    }

    // 统一走只读粘性 + 持久化 stateRoot 解析（绝不 mkdir 写远端），并将全部候选外置仓并入孤儿保护白名单（防粘性旧仓漏读误删线上 chunk，#63）
    const activeState = await resolveActiveDeployStateLayout(conn, {
      realRoot: detectedRoot,
      nginxInstance,
      realBaseRoot,
      realHtmlRoot,
      useSudo,
      otherTargetRoots: otherRealRoots,
      target,
      pinnedStateRoot: target.stateRoot || '',
      persistStateRoot: false,
      readOnly: true,
    });
    const resolvedLayout = activeState.layout;
    const allExternalCandidates = Array.isArray(activeState.allExternalCandidates)
      ? activeState.allExternalCandidates
      : [];
    const extraManifestDirs = [...new Set(allExternalCandidates.map((loc) => loc?.manifestDir).filter(Boolean))];
    const extraBackupRoots = [...new Set(allExternalCandidates.map((loc) => loc?.backupRoot).filter(Boolean))];
    const cmd = buildPreviewOrphanAssetsCommand({
      rootPath: detectedRoot,
      manifestDir: resolvedLayout.manifestDir,
      legacyManifestDir: resolvedLayout.legacyManifestDir,
      extraManifestDirs,
      backupRoot: resolvedLayout.backupRoot,
      legacyBackupRoot: resolvedLayout.legacyBackupRoot,
      extraBackupRoots,
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
    return {
      realRoot: detectedRoot,
      layout: { ...resolvedLayout, extraManifestDirs, extraBackupRoots },
      parsed: parsePreviewOrphanAssetsOutput(res.stdout),
      sharedBlockedReason: '',
    };
  });

  if (parsed.status !== 'ok') {
    const reasonMap = {
      no_manifest: '目标目录尚未建立雨燕发布清单（current.txt），为防误删人工文件已安全中止扫描；请先通过雨燕发布一次后再治理。',
      empty_manifest: '当前发布清单为空，已安全中止扫描。',
      root_missing: '目标部署目录在服务器上不存在。',
      shared_root_blocked: sharedBlockedReason || '共享根目录暂不支持无主静态资源自动清理，以防误删其他应用资产。',
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
    minAgeDays,
    manifestDir: layout?.manifestDir || '',
    legacyManifestDir: layout?.legacyManifestDir || '',
    extraManifestDirs: Array.isArray(layout?.extraManifestDirs) ? layout.extraManifestDirs : [],
    backupRoot: layout?.backupRoot || '',
    legacyBackupRoot: layout?.legacyBackupRoot || '',
    extraBackupRoots: Array.isArray(layout?.extraBackupRoots) ? layout.extraBackupRoots : [],
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
 * 当传入 reverifyOptions（包含清单与备份目录）时，在目录锁内删除每个文件前实时复核：
 * 1. 对照 current.txt、全部 manifests/*.txt 及所有存活备份 .manifest.txt，命中任一清单即跳过；
 * 2. 复核文件当前 mtime 是否仍超过 minAgeDays（防预览后被新发布覆写）。
 * @param {string} rootPath - 部署真实根目录
 * @param {string[]} relativePaths - 相对路径列表
 * @param {boolean} [useSudo=false] - 是否 sudo
 * @param {Object|null} [reverifyOptions=null] - 锁内实时复核选项
 * @returns {string} 远程命令
 */
export function buildCleanOrphanAssetsCommand(rootPath, relativePaths = [], useSudo = false, reverifyOptions = null) {
  const safeRelPaths = [...new Set((relativePaths || []).filter((rel) => {
    if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.includes('..') || /[\r\n\x00]/.test(rel)) {
      return false;
    }
    const segs = rel.split('/');
    if (segs.length < 2) return false;
    return segs.every((s) => isValidEntryName(s) && !s.startsWith('.') && !isReservedDeployEntry(s));
  }))];

  const enableReverify = Boolean(
    reverifyOptions &&
    (reverifyOptions.manifestDir ||
      reverifyOptions.legacyManifestDir ||
      (Array.isArray(reverifyOptions.extraManifestDirs) && reverifyOptions.extraManifestDirs.length > 0) ||
      reverifyOptions.backupRoot ||
      reverifyOptions.legacyBackupRoot ||
      (Array.isArray(reverifyOptions.extraBackupRoots) && reverifyOptions.extraBackupRoots.length > 0))
  );
  const reverifyMinAgeSec = enableReverify
    ? Math.max(1, Number(reverifyOptions.minAgeDays ?? 1)) * 86400
    : 0;
  const normMainManifest = enableReverify ? normalizePosixAbsPath(reverifyOptions.manifestDir) : '';
  const normLegacyManifest = enableReverify ? normalizePosixAbsPath(reverifyOptions.legacyManifestDir) : '';
  const cleanExtraManifestDirs = enableReverify
    ? [...new Set((reverifyOptions.extraManifestDirs || []).map((d) => normalizePosixAbsPath(d)).filter(Boolean))]
      .filter((d) => d !== normMainManifest && d !== normLegacyManifest)
    : [];
  const normMainBackup = enableReverify ? normalizePosixAbsPath(reverifyOptions.backupRoot) : '';
  const normLegacyBackup = enableReverify ? normalizePosixAbsPath(reverifyOptions.legacyBackupRoot) : '';
  const cleanExtraBackupRoots = enableReverify
    ? [...new Set((reverifyOptions.extraBackupRoots || []).map((d) => normalizePosixAbsPath(d)).filter(Boolean))]
      .filter((d) => d !== normMainBackup && d !== normLegacyBackup)
    : [];

  const script = [
    '# yuyan:clean-orphan-assets',
    'set -eu',
    'root="$1"',
    'reverify_mode="$2"',
    'manifest_dir="$3"',
    'legacy_manifest_dir="$4"',
    'backup_root="$5"',
    'legacy_backup_root="$6"',
    'min_age_sec="$7"',
    'extra_manifest_count="$8"',
    'extra_backup_count="$9"',
    'shift 9',
    ...buildPortableStatLines(),
    'tmp_white_raw=""',
    'tmp_white=""',
    'cleanup() { [ -n "$tmp_white_raw" ] && rm -f "$tmp_white_raw" 2>/dev/null || true; [ -n "$tmp_white" ] && rm -f "$tmp_white" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    'if [ "$reverify_mode" = "1" ]; then',
    '  tmp_white_raw=$(mktemp)',
    '  tmp_white=$(mktemp)',
    '  collect_manifests() {',
    '    mdir="$1"',
    '    [ -n "$mdir" ] && [ -d "$mdir" ] || return 0',
    '    find "$mdir" -maxdepth 1 -type f -name "*.txt" 2>/dev/null | while IFS= read -r mf; do',
    '      [ -f "$mf" ] && cat "$mf"',
    '    done >> "$tmp_white_raw"',
    '  }',
    '  collect_backup_manifests() {',
    '    broot="$1"',
    '    [ -n "$broot" ] && [ -d "$broot" ] || return 0',
    `    find "$broot" -mindepth 2 -maxdepth 2 -type f -name "${BACKUP_MANIFEST_FILE_NAME}" 2>/dev/null | while IFS= read -r bm; do`,
    '      [ -f "$bm" ] && cat "$bm"',
    '    done >> "$tmp_white_raw"',
    '  }',
    '  has_current=0',
    `  if [ -n "$manifest_dir" ] && [ -f "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    `  if [ -n "$legacy_manifest_dir" ] && [ -f "$legacy_manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    '  collect_manifests "$manifest_dir"',
    '  if [ "$legacy_manifest_dir" != "$manifest_dir" ]; then collect_manifests "$legacy_manifest_dir"; fi',
    '  i=0',
    '  while [ "$i" -lt "$extra_manifest_count" ]; do',
    '    emd="$1"; shift; i=$((i + 1))',
    `    if [ -n "$emd" ] && [ -f "$emd/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then has_current=1; fi`,
    '    collect_manifests "$emd"',
    '  done',
    '  collect_backup_manifests "$backup_root"',
    '  if [ "$legacy_backup_root" != "$backup_root" ]; then collect_backup_manifests "$legacy_backup_root"; fi',
    '  i=0',
    '  while [ "$i" -lt "$extra_backup_count" ]; do',
    '    ebr="$1"; shift; i=$((i + 1))',
    '    collect_backup_manifests "$ebr"',
    '  done',
    '  if [ "$has_current" -eq 0 ]; then',
    '    echo "清理复核失败：目标目录缺少 current.txt 清单，已安全中止" >&2',
    '    exit 1',
    '  fi',
    '  sed "/^$/d" "$tmp_white_raw" | sort -u > "$tmp_white"',
    '  if [ ! -s "$tmp_white" ]; then',
    '    echo "清理复核失败：活跃清单白名单为空，已安全中止" >&2',
    '    exit 1',
    '  fi',
    'else',
    '  i=0',
    '  while [ "$i" -lt "$extra_manifest_count" ]; do shift; i=$((i + 1)); done',
    '  i=0',
    '  while [ "$i" -lt "$extra_backup_count" ]; do shift; i=$((i + 1)); done',
    'fi',
    'now_epoch=$(date +%s)',
    'deleted_count=0',
    'freed_bytes=0',
    'skipped_count=0',
    'for rel in "$@"; do',
    '  case "$rel" in ""|/*|*../*|../*|.*|*/.*) skipped_count=$((skipped_count + 1)); continue ;; esac',
    '  if [ "$reverify_mode" = "1" ] && grep -Fxq "$rel" "$tmp_white"; then',
    '    skipped_count=$((skipped_count + 1))',
    '    continue',
    '  fi',
    '  full="$root/$rel"',
    '  if [ -f "$full" ] && [ ! -L "$full" ]; then',
    '    if [ "$reverify_mode" = "1" ] && [ "$min_age_sec" -gt 0 ]; then',
    '      mtime=$(yuyan_file_mtime "$full")',
    '      case "$mtime" in ""|*[!0-9]*) mtime=0 ;; esac',
    '      age=$((now_epoch - mtime))',
    '      if [ "$age" -lt 0 ]; then age=0; fi',
    '      if [ "$age" -lt "$min_age_sec" ]; then',
    '        skipped_count=$((skipped_count + 1))',
    '        continue',
    '      fi',
    '    fi',
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

  return buildPosixShellCommand(
    script,
    [
      rootPath,
      enableReverify ? '1' : '0',
      enableReverify ? (reverifyOptions.manifestDir || '') : '',
      enableReverify ? (reverifyOptions.legacyManifestDir || '') : '',
      enableReverify ? (reverifyOptions.backupRoot || '') : '',
      enableReverify ? (reverifyOptions.legacyBackupRoot || '') : '',
      String(reverifyMinAgeSec),
      String(cleanExtraManifestDirs.length),
      String(cleanExtraBackupRoots.length),
      ...cleanExtraManifestDirs,
      ...cleanExtraBackupRoots,
      ...safeRelPaths,
    ],
    useSudo
  );
}

/**
 * 执行经用户二次确认的无主历史静态资源清理（校验 previewToken + 统一锁根 + 锁内二次复核 + 分批防 ARG_MAX）。
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

  const outcome = await effectiveWithSsh(server, async (conn) => {
    // 统一通过 resolveServerLockRoot 计算跨团队 + 软链穿透锁根（#63）
    const { realRoot: currentRealRoot, lockRoot } = await resolveServerLockRoot(conn, {
      currentRoot: target.deployRoot,
      serverId: target.serverId,
      currentTargetId: target.id,
      useSudo,
      logStage: 'cleanup',
    });
    if (normalizePosixAbsPath(currentRealRoot) !== normalizePosixAbsPath(preview.realRoot)) {
      throw Object.assign(
        new Error('目标部署目录真实路径相对预览时已发生变化，已安全中止清理，请重新扫描预览'),
        { statusCode: 409 }
      );
    }

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
      const reverifyOptions = {
        manifestDir: preview.manifestDir,
        legacyManifestDir: preview.legacyManifestDir,
        extraManifestDirs: preview.extraManifestDirs || [],
        backupRoot: preview.backupRoot,
        legacyBackupRoot: preview.legacyBackupRoot,
        extraBackupRoots: preview.extraBackupRoots || [],
        minAgeDays: Math.max(1, Number(preview.minAgeDays || 1)),
      };
      const batches = chunkArray(verifiedPaths, CLEAN_ORPHAN_BATCH_SIZE);
      let deletedCount = 0;
      let freedBytes = 0;
      let skippedCount = 0;
      for (const batch of batches) {
        const cmd = buildCleanOrphanAssetsCommand(preview.realRoot, batch, useSudo, reverifyOptions);
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
        deletedCount += num('deleted_count');
        freedBytes += num('freed_bytes');
        skippedCount += num('skipped_count');
      }
      return { deletedCount, freedBytes, skippedCount };
    } finally {
      await lock.release().catch(() => {});
    }
  });

  // 清理成功后消费掉本次令牌（防止重放）
  orphanAssetPreviewStore.delete(token);
  return outcome;
}

/**
 * 为已删除 / 已改部署目录的前端目标写入退役标记（尽力而为，不阻断主流程）。
 * @description
 * 1. 只写 `.retired` 标记不删数据，服务器 gc-backups 定时任务在宽限期（默认 TTL 天数）后整份回收外置快照与内嵌备份；
 * 2. 若同一台物理服务器上仍有其他部署目标指向同一真实目录（穿透软链后比较），则跳过，避免误伤；
 * 3. 期间该目录再次通过雨燕发布会自动清除标记。
 * @param {{ target: Object, server: Object, nginxInstance?: Object|null }} context - 删除/修改前捕获的目标上下文
 * @param {{ reason?: string }} [options] - 退役原因（target-deleted | root-changed）
 * @returns {Promise<{ skipped: boolean, reason?: string, marked?: number, realRoot?: string }>}
 */
export async function retireTargetBackupState(context, options = {}) {
  const { target, server, nginxInstance = null } = context || {};
  if (!target || !server || !target.deployRoot) return { skipped: true, reason: 'no-context' };
  if (target.projectType === 'backend') return { skipped: true, reason: 'backend-target' };

  const reason = options.reason || 'target-deleted';
  const useSudo = resolveEffectiveDeploySudo(server, nginxInstance);
  const siblings = (await listPhysicalServerTargets({ serverId: target.serverId }).catch(() => []))
    .filter((item) => Number(item.id) !== Number(target.id) && item.deployRoot);

  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  return effectiveWithSsh(server, async (conn) => {
    const nextDeployRoot = normalizePosixAbsPath(options.nextDeployRoot || '');
    const extraRoots = [nginxInstance?.baseRoot, nginxInstance?.htmlRoot].filter(Boolean);
    const toResolve = [
      target.deployRoot,
      ...(nextDeployRoot ? [nextDeployRoot] : []),
      ...siblings.map((item) => item.deployRoot),
      ...extraRoots,
    ];
    const resolved = await batchDetectRealRoots(conn, toResolve, useSudo).catch(() => toResolve);
    const realRoot = normalizePosixAbsPath(resolved[0] || target.deployRoot);
    let cursor = 1;
    let realNextRoot = '';
    if (nextDeployRoot) {
      realNextRoot = normalizePosixAbsPath(resolved[cursor] || nextDeployRoot);
      cursor += 1;
    }
    if (reason === 'root-changed' && realNextRoot && realNextRoot === realRoot) {
      return { skipped: true, reason: 'same-real-root', realRoot };
    }
    if (reason === 'root-changed' && realNextRoot && options.nextTargetId) {
      await clearRetiredRootBackupReferences(options.nextTargetId, {
        realRoot,
        previousDeployRoot: target.deployRoot,
        nextDeployRoot,
        serverId: target.serverId,
      }).catch((error) => {
        console.warn(`[storage-governance] 清理目标 ${options.nextTargetId} 旧目录回滚引用失败：${error.message}`);
      });
    }

    const siblingRoots = resolved.slice(cursor, cursor + siblings.length).map((item) => normalizePosixAbsPath(item));
    cursor += siblings.length;
    if (siblingRoots.includes(realRoot)) {
      return { skipped: true, reason: 'shared-by-other-target', realRoot };
    }

    let realBaseRoot = '';
    let realHtmlRoot = '';
    if (nginxInstance?.baseRoot) {
      realBaseRoot = resolved[cursor] || nginxInstance.baseRoot;
      cursor += 1;
    }
    if (nginxInstance?.htmlRoot) {
      realHtmlRoot = resolved[cursor] || nginxInstance.htmlRoot;
    }

    const { primary: layout, allExternal } = resolveCandidateDeployStateLocations({
      realRoot,
      nginxInstance,
      realBaseRoot,
      realHtmlRoot,
      otherTargetRoots: siblingRoots,
      pinnedStateRoot: target.stateRoot || '',
    });

    // 若目录真实存在，必须拿到目录锁才写入 .retired；拿不到锁则跳过绝不在锁外裸写（#63）
    const lockRoot = resolveTopmostLockRoot(realRoot, [realRoot, ...siblingRoots]);
    let lockHandle = null;
    if (lockRoot) {
      const dirProbe = await execSsh(conn, buildProbeExistingDirsCommand([lockRoot], useSudo), {
        allowFailure: true,
        label: '探测退役目标锁目录是否存在',
      }).catch(() => ({ code: 1, stdout: '' }));
      const lockDirExists = String(dirProbe.stdout || '')
        .split(/\r?\n/)
        .map((l) => normalizePosixAbsPath(l))
        .includes(normalizePosixAbsPath(lockRoot));
      if (lockDirExists) {
        try {
          lockHandle = await acquireDeployRootLocks(conn, {
            server,
            lockRoot,
            useSudo,
            recordId: 0,
            owner: {
              projectName: target.projectName || '退役标记',
              targetId: target.id,
              recordId: 0,
              operator: 'storage-governance',
              actionLabel: '标记备份退役',
            },
            waitTimeoutMs: 10_000,
          });
        } catch {
          return { skipped: true, reason: 'lock-busy', realRoot };
        }
      }
    }
    try {
      const latestSiblings = (await listPhysicalServerTargets({ serverId: target.serverId }).catch(() => []))
        .filter((item) => item.deployRoot && item.projectType !== 'backend');
      if (latestSiblings.length > 0) {
        const latestResolved = await batchDetectRealRoots(
          conn,
          latestSiblings.map((item) => item.deployRoot),
          useSudo
        ).catch(() => latestSiblings.map((item) => item.deployRoot));
        if (latestResolved.map((item) => normalizePosixAbsPath(item)).includes(realRoot)) {
          return { skipped: true, reason: 'shared-by-other-target', realRoot };
        }
      }
      let totalMarked = 0;
      const extTargetDirs = allExternal.map((item) => item.targetStateDir).filter(Boolean);
      if (extTargetDirs.length > 0) {
        for (let i = 0; i < extTargetDirs.length; i += 1) {
          const cmd = buildMarkTargetRetiredCommand({
            targetStateDir: extTargetDirs[i],
            legacyBackupRoot: i === 0 ? layout.legacyBackupRoot : '',
            realRoot,
            reason,
            useSudo,
          });
          const res = await execSsh(conn, cmd, { allowFailure: true, label: '标记部署目标备份退役' });
          const matched = String(res.stdout || '').match(/retired_marked=(\d+)/);
          totalMarked += matched ? Number(matched[1]) : 0;
        }
      } else {
        const cmd = buildMarkTargetRetiredCommand({
          targetStateDir: '',
          legacyBackupRoot: layout.legacyBackupRoot,
          realRoot,
          reason,
          useSudo,
        });
        const res = await execSsh(conn, cmd, { allowFailure: true, label: '标记部署目标备份退役' });
        const matched = String(res.stdout || '').match(/retired_marked=(\d+)/);
        totalMarked += matched ? Number(matched[1]) : 0;
      }
      return { skipped: false, marked: totalMarked, realRoot };
    } finally {
      if (lockHandle) {
        await lockHandle.release().catch(() => {});
      }
    }
  }, { persist: false });
}

/** 退役打标遇目录锁繁忙时的延迟退避重试间隔（毫秒） */
const DEFAULT_RETIRE_RETRY_DELAYS_MS = [15_000, 45_000, 90_000];

/**
 * 以「发后即忘」方式执行退役标记，失败只记录日志，不影响删除/更新接口响应；
 * 若因并发发布占用目录锁返回 `lock-busy`，按退避策略最多延迟重试 3 次（#63）。
 * @param {{ target: Object, server: Object, nginxInstance?: Object|null }} context - 目标上下文
 * @param {{ reason?: string, nextDeployRoot?: string, nextTargetId?: number, retryDelaysMs?: number[] }} [options] - 退役选项
 */
export function scheduleRetireTargetBackupState(context, options = {}) {
  if (!context?.target || !context?.server) return;
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : DEFAULT_RETIRE_RETRY_DELAYS_MS;
  const attemptRun = (attemptIndex) => {
    Promise.resolve()
      .then(() => retireTargetBackupState(context, options))
      .then((res) => {
        if (res?.skipped && res.reason === 'lock-busy' && attemptIndex < retryDelays.length) {
          const delayMs = Math.max(0, Number(retryDelays[attemptIndex] || 0));
          const timer = setTimeout(() => {
            attemptRun(attemptIndex + 1);
          }, delayMs);
          timer.unref?.();
        }
      })
      .catch((error) => {
        console.warn(`[storage-governance] 标记目标 ${context.target?.id} 备份退役失败：${error?.message || error}`);
      });
  };
  attemptRun(0);
}

/**
 * 将前端目标更新后的保留策略同步回服务器外置仓 target.json（仅当 target.json 已存在时更新）。
 * @param {{ target: Object, server: Object, nginxInstance?: Object|null }} context - 最新目标上下文
 * @returns {Promise<{ skipped: boolean, reason?: string, written?: boolean, realRoot?: string }>}
 */
export async function syncTargetRetentionMeta(context) {
  const { target, server, nginxInstance = null } = context || {};
  if (!target || !server || !target.deployRoot) return { skipped: true, reason: 'no-context' };
  if (target.projectType === 'backend') return { skipped: true, reason: 'backend-target' };

  const useSudo = resolveEffectiveDeploySudo(server, nginxInstance);
  const siblings = (await listPhysicalServerTargets({ serverId: target.serverId }).catch(() => []))
    .filter((item) => Number(item.id) !== Number(target.id) && item.deployRoot && item.projectType !== 'backend');
  const testHooks = getTestHooks();
  const effectiveWithSsh = testHooks?.withSsh || withSsh;

  return effectiveWithSsh(server, async (conn) => {
    const extraRoots = [nginxInstance?.baseRoot, nginxInstance?.htmlRoot].filter(Boolean);
    const toResolve = [target.deployRoot, ...siblings.map((item) => item.deployRoot), ...extraRoots];
    const resolved = await batchDetectRealRoots(conn, toResolve, useSudo).catch(() => toResolve);
    const realRoot = normalizePosixAbsPath(resolved[0] || target.deployRoot);
    const siblingRoots = resolved
      .slice(1, 1 + siblings.length)
      .map((item) => normalizePosixAbsPath(item))
      .filter(Boolean);

    let realBaseRoot = '';
    let realHtmlRoot = '';
    let cursor = 1 + siblings.length;
    if (nginxInstance?.baseRoot) {
      realBaseRoot = resolved[cursor] || nginxInstance.baseRoot;
      cursor += 1;
    }
    if (nginxInstance?.htmlRoot) {
      realHtmlRoot = resolved[cursor] || nginxInstance.htmlRoot;
    }

    const { allExternal } = resolveCandidateDeployStateLocations({
      realRoot,
      nginxInstance,
      realBaseRoot,
      realHtmlRoot,
      otherTargetRoots: siblingRoots,
      pinnedStateRoot: target.stateRoot || '',
    });
    if (allExternal.length === 0) {
      return { skipped: true, reason: 'inline-layout', realRoot };
    }
    const retention = resolveDeployRetentionPolicy(target);
    let writtenAny = false;
    for (const candidateLayout of allExternal) {
      const cmd = buildWriteTargetStateMetaCommand(
        candidateLayout,
        {
          projectName: target.projectName,
          targetId: target.id,
          envName: target.envName,
          uploadStrategy: target.uploadStrategy,
          retention,
        },
        useSudo,
        { onlyIfExists: true }
      );
      const res = await execSsh(conn, cmd, { allowFailure: true, label: '同步目标保留策略到外置仓' });
      if (/target_meta_written=1/.test(String(res.stdout || ''))) {
        writtenAny = true;
      }
    }
    return { skipped: !writtenAny, written: writtenAny, realRoot };
  }, { persist: false });
}

/**
 * 以「发后即忘」方式同步目标级保留策略到远端 target.json，失败仅记日志。
 * @param {{ target: Object, server: Object, nginxInstance?: Object|null }} context - 最新目标上下文
 */
export function scheduleSyncTargetRetentionMeta(context) {
  if (!context?.target || !context?.server) return;
  Promise.resolve()
    .then(() => syncTargetRetentionMeta(context))
    .catch((error) => {
      console.warn(`[storage-governance] 同步目标 ${context.target?.id} 保留策略到 target.json 失败：${error?.message || error}`);
    });
}
