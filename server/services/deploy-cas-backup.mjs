/**
 * CAS 内容寻址去重备份、三维裁剪与对象池 GC 引擎
 * @description 为前端微应用平级外置状态仓（.yuyan-state）提供：
 * 1. 外置仓远程可写性与哈希工具探测（无权限自动降级）；
 * 2. CAS 内容寻址去重快照写入（只读 0444 对象池，免疫 SFTP/cp 原地覆写污染）；
 * 3. CAS 回滚前完整性预检与三段式原子恢复；
 * 4. Count + 去重物理容量 + TTL 三维备份裁剪（硬保底留最新 1 份，返回精确删/留路径）；
 * 5. 带 10 分钟安全宽限期与并发锁的 Mark-and-Sweep 对象池 GC。
 */

import path from 'node:path';
import { shellQuote } from './ssh-service.mjs';
import { isValidEntryName, RESERVED_DEPLOY_ENTRIES } from './deploy-cleanup-policy.mjs';
import {
  DEFAULT_HASHED_ASSET_DIRS,
  LEGACY_MANIFEST_DIR_NAME,
  STATE_GC_LOCK_NAME,
  STATE_META_FILE_NAME,
  STATE_OBJECTS_DIR_NAME,
  STATE_TARGETS_DIR_NAME,
  TARGET_META_FILE_NAME,
  TARGET_RETIRED_MARKER_NAME,
} from './deploy-state-layout.mjs';

/** 备份类型常量（兼容历史 full/entry-only 与新 CAS 类型） */
export const CAS_BACKUP_KINDS = Object.freeze({
  casFull: 'cas-full',
  casEntryOnly: 'cas-entry-only',
  full: 'full',
  entryOnly: 'entry-only',
});

/** 备份元数据文件名常量 */
export const BACKUP_KIND_FILE_NAME = '.backup-kind';
export const BACKUP_NAMES_FILE_NAME = '.backup-names';
export const BACKUP_MANIFEST_FILE_NAME = '.manifest.txt';
export const CAS_INDEX_FILE_NAME = '.cas-index.tsv';
export const BACKUP_META_FILE_NAME = '.backup-meta.json';
export const DEPLOY_CURRENT_MANIFEST_NAME = 'current.txt';

/** 对象池 GC 默认并发安全宽限期（分钟） */
export const DEFAULT_CAS_GC_GRACE_MINUTES = 10;

/**
 * 判断备份类型是否为 CAS 类型。
 * @param {string} kind - 备份类型
 * @returns {boolean}
 */
export function isCasBackupKind(kind) {
  return kind === CAS_BACKUP_KINDS.casFull || kind === CAS_BACKUP_KINDS.casEntryOnly;
}

/**
 * 判断备份类型是否为 entry-only 语义（含历史 entry-only 与 cas-entry-only）。
 * @param {string} kind - 备份类型
 * @returns {boolean}
 */
export function isEntryOnlyBackupKind(kind) {
  return kind === CAS_BACKUP_KINDS.entryOnly || kind === CAS_BACKUP_KINDS.casEntryOnly;
}

/**
 * 封装带参数的 POSIX sh 远程执行命令。
 * @param {string} script - sh 脚本
 * @param {string[]} [args=[]] - 位置参数
 * @param {boolean} [useSudo=false] - 是否 sudo
 * @returns {string} 完整命令
 */
export function buildPosixShellCommand(script, args = [], useSudo = false) {
  const quotedArgs = args.map((arg) => shellQuote(String(arg ?? ''))).join(' ');
  const prefix = useSudo ? 'sudo -n sh -c' : 'sh -c';
  return quotedArgs ? `${prefix} ${shellQuote(script)} sh ${quotedArgs}` : `${prefix} ${shellQuote(script)} sh`;
}

/**
 * 返回跨 GNU Linux / BusyBox / BSD(macOS) 的基础文件属性和 SHA-256 Shell 函数定义片段。
 * @returns {string[]} Shell 行数组
 */
function buildPortableHelperLines() {
  return [
    'if stat -c "%s" / >/dev/null 2>&1; then',
    '  yuyan_file_size() { stat -c "%s" "$1" 2>/dev/null || echo 0; }',
    '  yuyan_file_mode() { stat -c "%a" "$1" 2>/dev/null || echo 644; }',
    '  yuyan_file_mtime() { stat -c "%Y" "$1" 2>/dev/null || echo 0; }',
    '  yuyan_file_dev() { stat -c "%d" "$1" 2>/dev/null || echo ""; }',
    'else',
    '  yuyan_file_size() { stat -f "%z" "$1" 2>/dev/null || echo 0; }',
    '  yuyan_file_mode() { stat -f "%Lp" "$1" 2>/dev/null || echo 644; }',
    '  yuyan_file_mtime() { stat -f "%m" "$1" 2>/dev/null || echo 0; }',
    '  yuyan_file_dev() { stat -f "%d" "$1" 2>/dev/null || echo ""; }',
    'fi',
    'if command -v sha256sum >/dev/null 2>&1; then',
    '  yuyan_hash_tool="sha256sum"',
    '  yuyan_hash_file() { sha256sum "$1" | awk \'{print $1}\'; }',
    'elif command -v shasum >/dev/null 2>&1; then',
    '  yuyan_hash_tool="shasum"',
    '  yuyan_hash_file() { shasum -a 256 "$1" | awk \'{print $1}\'; }',
    'elif command -v openssl >/dev/null 2>&1; then',
    '  yuyan_hash_tool="openssl"',
    '  yuyan_hash_file() { openssl dgst -sha256 "$1" | awk \'{print $NF}\'; }',
    'else',
    '  yuyan_hash_tool="none"',
    '  yuyan_hash_file() { return 1; }',
    'fi',
  ];
}

/**
 * 构建远程探测外置状态仓可写性、同文件系统标志及哈希工具的命令。
 * @param {Object} layout - deploy-state-layout 生成的外置布局
 * @param {boolean} [useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildProbeStateRootCommand(layout, useSudo = false) {
  const script = [
    'set -u',
    'state_root="$1"',
    'target_dir="$2"',
    'objects_dir="$3"',
    'real_root="$4"',
    ...buildPortableHelperLines(),
    'if [ -z "$state_root" ]; then',
    '  echo "writable=0 cas_supported=0 same_fs=0 hash_tool=$yuyan_hash_tool reason=empty_state_root"',
    '  exit 0',
    'fi',
    'if ! mkdir -p "$target_dir/backups" "$target_dir/manifests" "$objects_dir" 2>/dev/null; then',
    '  echo "writable=0 cas_supported=0 same_fs=0 hash_tool=$yuyan_hash_tool reason=mkdir_denied"',
    '  exit 0',
    'fi',
    'probe_file="$target_dir/.yuyan-probe.$$"',
    'if ! (printf "ok\\n" > "$probe_file" 2>/dev/null && rm -f "$probe_file" 2>/dev/null); then',
    '  echo "writable=0 cas_supported=0 same_fs=0 hash_tool=$yuyan_hash_tool reason=write_denied"',
    '  exit 0',
    'fi',
    `meta_file="$state_root/${STATE_META_FILE_NAME}"`,
    'if [ ! -f "$meta_file" ]; then',
    '  printf \'{"schemaVersion":1,"createdAt":"%s"}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")" > "$meta_file" 2>/dev/null || true',
    'fi',
    'same_fs=0',
    'if [ -d "$real_root" ]; then',
    '  d1=$(yuyan_file_dev "$real_root")',
    '  d2=$(yuyan_file_dev "$state_root")',
    '  if [ -n "$d1" ] && [ "$d1" = "$d2" ]; then same_fs=1; fi',
    'fi',
    'cas_ok=0',
    'if [ "$yuyan_hash_tool" != "none" ]; then cas_ok=1; fi',
    'echo "writable=1 cas_supported=$cas_ok same_fs=$same_fs hash_tool=$yuyan_hash_tool reason=ok"',
  ].join('\n');

  return buildPosixShellCommand(
    script,
    [layout?.stateRoot || '', layout?.targetStateDir || '', layout?.objectsDir || '', layout?.realRoot || ''],
    useSudo
  );
}

/**
 * 解析外置仓可写性探测结果。
 * @param {string} stdout - 探测输出
 * @returns {{ writable: boolean, casSupported: boolean, sameFs: boolean, hashTool: string, reason: string }}
 */
export function parseProbeStateRootOutput(stdout) {
  const text = String(stdout || '');
  const getVal = (key, fallback = '') => {
    const match = text.match(new RegExp(`\\b${key}=([^\\s]+)`));
    return match ? match[1] : fallback;
  };
  return {
    writable: getVal('writable') === '1',
    casSupported: getVal('cas_supported') === '1',
    sameFs: getVal('same_fs') === '1',
    hashTool: getVal('hash_tool', 'none'),
    reason: getVal('reason', 'unknown'),
  };
}

/**
 * 构建写入 target.json 归属元信息的远程命令（便于运维排查、目标级定时策略与孤儿识别）。
 * @param {Object} layout - 外置仓布局
 * @param {Object} meta - 目标元数据（可含 retention 保留策略）
 * @param {boolean} [useSudo=false] - 是否 sudo
 * @param {{ onlyIfExists?: boolean }} [options] - 仅当 target.json 已存在时更新（用于目标配置编辑同步）
 * @returns {string} 远程命令
 */
export function buildWriteTargetStateMetaCommand(layout, meta = {}, useSudo = false, options = {}) {
  const onlyIfExists = Boolean(options?.onlyIfExists);
  const retention = normalizeTargetMetaRetention(meta.retention);
  const payload = JSON.stringify(
    {
      realRoot: layout.realRoot,
      slug: layout.slug,
      projectName: String(meta.projectName || ''),
      targetId: Number(meta.targetId || 0),
      envName: String(meta.envName || ''),
      uploadStrategy: String(meta.uploadStrategy || ''),
      updatedAt: new Date().toISOString(),
      updatedAtEpoch: Math.floor(Date.now() / 1000),
      // 目标级保留策略：服务器 gc-backups 定时任务优先按此执行（扁平数字字段，便于 sed 解析）
      ...(retention
        ? {
            retentionKeepCount: retention.keepCount,
            retentionMaxSizeMb: retention.maxSizeMb,
            retentionTtlDays: retention.ttlDays,
          }
        : {}),
    },
    null,
    2
  );
  const script = [
    'set -eu',
    'meta_path="$1"',
    'content="$2"',
    'legacy_root="$3"',
    'only_if_exists="$4"',
    'dir=$(dirname "$meta_path")',
    'if [ "$only_if_exists" = "1" ] && [ ! -f "$meta_path" ]; then',
    '  echo "target_meta_skipped=not_exists"',
    '  exit 0',
    'fi',
    'mkdir -p "$dir"',
    'tmp="${meta_path}.tmp.$$"',
    'printf "%s\\n" "$content" > "$tmp"',
    'mv "$tmp" "$meta_path"',
    '# 重新发布或更新配置即表示目标仍在使用：清除可能残留的退役标记，避免被定时任务整份回收',
    `rm -f "$dir/${TARGET_RETIRED_MARKER_NAME}" 2>/dev/null || true`,
    `if [ -n "$legacy_root" ] && [ -f "$legacy_root/${TARGET_RETIRED_MARKER_NAME}" ]; then rm -f "$legacy_root/${TARGET_RETIRED_MARKER_NAME}" 2>/dev/null || true; fi`,
    'echo "target_meta_written=1"',
  ].join('\n');
  return buildPosixShellCommand(
    script,
    [layout.targetMetaFilePath, payload, layout.legacyBackupRoot || '', onlyIfExists ? '1' : '0'],
    useSudo
  );
}

/**
 * 规范化写入 target.json 的目标级保留策略（非法值返回 null，表示不写入、由定时任务使用全局默认）。
 * @param {{ backupKeepCount?: number, backupMaxSizeMb?: number, backupTtlDays?: number }|null|undefined} retention - 解析后的保留策略
 * @returns {{ keepCount: number, maxSizeMb: number, ttlDays: number } | null}
 */
export function normalizeTargetMetaRetention(retention) {
  if (!retention || typeof retention !== 'object') return null;
  const keepCount = Number(retention.backupKeepCount);
  const maxSizeMb = Number(retention.backupMaxSizeMb);
  const ttlDays = Number(retention.backupTtlDays);
  if (!Number.isInteger(keepCount) || keepCount < 1) return null;
  if (!Number.isInteger(maxSizeMb) || maxSizeMb < 0) return null;
  if (!Number.isInteger(ttlDays) || ttlDays < 0) return null;
  return { keepCount, maxSizeMb, ttlDays };
}

/**
 * 构建清除内嵌模式退役标记的远程命令（降级内嵌模式下重新发布时调用）。
 * @param {string} backupRoot - 内嵌 .yuyan-backups 目录
 * @param {boolean} [useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildClearRetiredMarkerCommand(backupRoot, useSudo = false) {
  const script = [
    'set -eu',
    'broot="$1"',
    `if [ -n "$broot" ] && [ -f "$broot/${TARGET_RETIRED_MARKER_NAME}" ]; then rm -f "$broot/${TARGET_RETIRED_MARKER_NAME}"; fi`,
  ].join('\n');
  return buildPosixShellCommand(script, [backupRoot || ''], useSudo);
}

/**
 * 构建为已删除 / 已改路径的部署目标写入退役标记的远程命令。
 * @description 仅写标记不删数据：服务器端 gc-backups 在宽限期过后才整份回收，期间重新发布会自动清除标记。
 * @param {Object} params - 参数
 * @param {string} params.targetStateDir - 外置仓 targets/<slug> 目录（可为空）
 * @param {string} params.legacyBackupRoot - 内嵌 .yuyan-backups 目录（可为空）
 * @param {string} params.realRoot - 目标真实部署目录（写入标记便于排查）
 * @param {string} [params.reason='target-deleted'] - 退役原因
 * @param {boolean} [params.useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildMarkTargetRetiredCommand({
  targetStateDir = '',
  legacyBackupRoot = '',
  realRoot = '',
  reason = 'target-deleted',
  useSudo = false,
}) {
  const safeReason = String(reason || 'target-deleted').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'target-deleted';
  const script = [
    'set -eu',
    'state_dir="$1"',
    'legacy_root="$2"',
    'real_root="$3"',
    'reason="$4"',
    'now_epoch=$(date +%s)',
    'marked=0',
    'write_marker() {',
    '  mfile="$1"',
    '  [ -f "$mfile" ] && return 0',
    '  mtmp="$mfile.tmp.$$"',
    '  printf "retired_at=%s\\nreason=%s\\nreal_root=%s\\n" "$now_epoch" "$reason" "$real_root" > "$mtmp"',
    '  mv "$mtmp" "$mfile"',
    '  marked=$((marked + 1))',
    '}',
    `if [ -n "$state_dir" ] && [ -d "$state_dir" ]; then write_marker "$state_dir/${TARGET_RETIRED_MARKER_NAME}"; fi`,
    `if [ -n "$legacy_root" ] && [ -d "$legacy_root" ]; then write_marker "$legacy_root/${TARGET_RETIRED_MARKER_NAME}"; fi`,
    'echo "retired_marked=$marked"',
  ].join('\n');
  return buildPosixShellCommand(script, [targetStateDir || '', legacyBackupRoot || '', realRoot || '', safeReason], useSudo);
}

/**
 * 生成 CAS 去重备份部署目录的远程 Shell 命令。
 * @description
 * 1. 只备份白名单内的顶层条目，排除受保护子目录、系统保留项及 cas-entry-only 下的 hashedDirs；
 * 2. 普通文件写入只读(0444)共享对象池 objects/<aa>/<sha256>，跨版本与跨微应用自动去重；
 * 3. 空目录与符号链接完整记录于 .cas-index.tsv，回滚时可 100% 还原结构；
 * 4. 先写 .cas-index.tsv.tmp 再原子 mv，避免中途失败留下半截快照。
 * @param {Object} params - 备份参数
 * @param {string} params.rootPath - 部署真实根目录
 * @param {string} params.backupPath - 本次备份目录绝对路径
 * @param {string} params.objectsDir - 共享 CAS 对象池目录
 * @param {string} params.manifestDir - 当前有效清单目录（优先外置仓）
 * @param {string} [params.legacyManifestDir=''] - 历史内嵌清单目录（兜底读取）
 * @param {'cas-full'|'cas-entry-only'} params.kind - CAS 备份类型
 * @param {string[]} [params.protectedSubDirs=[]] - 受保护顶层子目录
 * @param {string[]} [params.namesToBackup=[]] - 待备份顶层条目白名单
 * @param {string[]} [params.hashedDirs=DEFAULT_HASHED_ASSET_DIRS] - 带哈希静态目录列表
 * @param {Object} [params.meta={}] - 写入 .backup-meta.json 的附加元信息
 * @param {boolean} [params.useSudo=false] - 是否使用 sudo
 * @returns {string} 远程命令
 */
export function buildCasBackupDeployRootCommand({
  rootPath,
  backupPath,
  objectsDir,
  manifestDir,
  legacyManifestDir = '',
  kind = CAS_BACKUP_KINDS.casEntryOnly,
  protectedSubDirs = [],
  namesToBackup = [],
  hashedDirs = DEFAULT_HASHED_ASSET_DIRS,
  meta = {},
  useSudo = false,
}) {
  const reservedSet = new Set(RESERVED_DEPLOY_ENTRIES);
  const protectedSet = new Set(protectedSubDirs.filter(isValidEntryName));
  const hashedSet = new Set(hashedDirs.filter(isValidEntryName));
  const entryOnly = isEntryOnlyBackupKind(kind);

  const safeNames = [...new Set((namesToBackup || []).filter(isValidEntryName))]
    .filter((n) => !reservedSet.has(n) && !protectedSet.has(n))
    .filter((n) => (entryOnly ? !hashedSet.has(n) : true));

  const protectedListStr = '\n' + protectedSubDirs.filter(isValidEntryName).join('\n') + '\n';
  const hashedListStr = '\n' + hashedDirs.filter(isValidEntryName).join('\n') + '\n';

  const safeReleaseName = String(meta.releaseName || path.posix.basename(backupPath)).replace(/["\\\r\n]/g, '');
  const safeBranch = String(meta.branch || '').replace(/["\\\r\n]/g, '');
  const safeCommit = String(meta.commitSha || '').replace(/["\\\r\n]/g, '');

  const script = [
    '# yuyan:cas-backup',
    'set -eu',
    'root="$1"',
    'backup="$2"',
    'objects_dir="$3"',
    'manifest_dir="$4"',
    'legacy_manifest_dir="$5"',
    'kind="$6"',
    'protected_list="$7"',
    'hashed_list="$8"',
    'release_name="$9"',
    'shift 9',
    'branch_name="$1"',
    'commit_sha="$2"',
    'shift 2',
    ...buildPortableHelperLines(),
    'if [ "$yuyan_hash_tool" = "none" ]; then',
    '  echo "远程服务器缺少 sha256sum/shasum/openssl，无法执行 CAS 备份" >&2',
    '  exit 1',
    'fi',
    'nl=\'',
    '\'',
    'TAB=$(printf \'\\t\')',
    'mkdir -p "$backup" "$objects_dir"',
    `tmp_index="$backup/${CAS_INDEX_FILE_NAME}.tmp.$$"`,
    `final_index="$backup/${CAS_INDEX_FILE_NAME}"`,
    `tmp_names="$backup/${BACKUP_NAMES_FILE_NAME}.tmp.$$"`,
    ': > "$tmp_index"',
    ': > "$tmp_names"',
    'cleanup_tmp() { rm -f "$tmp_index" "$tmp_names" 2>/dev/null || true; }',
    'trap cleanup_tmp EXIT',
    '',
    '# 1. 磁盘空间预检（按最坏全量新增粗算，外加 10MB 安全冗余）',
    'needed_kb=0',
    'for name in "$@"; do',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests"|".yuyan-state") continue ;; esac',
    '  case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '  if [ "$kind" = "cas-entry-only" ]; then',
    '    case "$hashed_list" in *"$nl$name$nl"*) continue ;; esac',
    '  fi',
    '  if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '    sz=$(du -sk "$root/$name" 2>/dev/null | awk \'{print $1}\')',
    '    case "$sz" in ""|*[!0-9]*) sz=0 ;; esac',
    '    needed_kb=$((needed_kb + sz))',
    '  fi',
    'done',
    'required_kb=$((needed_kb + 10240))',
    'avail_kb=$(df -Pk "$objects_dir" 2>/dev/null | awk \'NR==2 {print $4}\')',
    'case "$avail_kb" in ""|*[!0-9]*) avail_kb=0 ;; esac',
    'if [ "$avail_kb" -gt 0 ] && [ "$avail_kb" -lt "$required_kb" ]; then',
    '  echo "磁盘空间不足：外置备份仓需预留约 $((required_kb / 1024))MB，当前磁盘剩余 $((avail_kb / 1024))MB" >&2',
    '  exit 1',
    'fi',
    '',
    '# 2. 遍历顶层白名单条目写入 CAS 对象池',
    'logical_bytes=0',
    'new_object_bytes=0',
    'file_count=0',
    'dedup_hits=0',
    'seq=0',
    'store_one_entry() {',
    '  rel="$1"',
    '  full="$root/$rel"',
    '  case "$rel" in',
    '    *"$TAB"*|*"$nl"*|""|/*|*../*|../*|..) echo "跳过包含非法字符的路径: $rel" >&2; return 0 ;;',
    '  esac',
    '  if [ -L "$full" ]; then',
    '    link_target=$(readlink "$full")',
    '    case "$link_target" in *"$TAB"*|*"$nl"*) echo "符号链接目标含非法字符: $rel" >&2; exit 1 ;; esac',
    '    printf "l\\t777\\t0\\t-\\t%s\\t%s\\n" "$rel" "$link_target" >> "$tmp_index"',
    '  elif [ -d "$full" ]; then',
    '    d_mode=$(yuyan_file_mode "$full")',
    '    printf "d\\t%s\\t0\\t-\\t%s\\n" "$d_mode" "$rel" >> "$tmp_index"',
    '  elif [ -f "$full" ]; then',
    '    f_size=$(yuyan_file_size "$full")',
    '    case "$f_size" in ""|*[!0-9]*) f_size=0 ;; esac',
    '    f_mode=$(yuyan_file_mode "$full")',
    '    f_hash=$(yuyan_hash_file "$full")',
    '    case "$f_hash" in [0-9a-fA-F]*) ;; *) echo "计算文件摘要失败：$rel" >&2; exit 1 ;; esac',
    '    shard_name=$(printf "%s" "$f_hash" | cut -c1-2)',
    '    shard_dir="$objects_dir/$shard_name"',
    '    obj_path="$shard_dir/$f_hash"',
    '    if [ -f "$obj_path" ]; then',
    '      dedup_hits=$((dedup_hits + 1))',
    '    else',
    '      mkdir -p "$shard_dir"',
    '      seq=$((seq + 1))',
    '      tmp_obj="$shard_dir/.tmp.$$.$seq"',
    '      if ! cp "$full" "$tmp_obj"; then',
    '        rm -f "$tmp_obj" 2>/dev/null || true',
    '        echo "写入对象池失败：$rel" >&2',
    '        exit 1',
    '      fi',
    '      chmod 444 "$tmp_obj" 2>/dev/null || true',
    '      if [ ! -f "$obj_path" ]; then',
    '        mv "$tmp_obj" "$obj_path" 2>/dev/null || true',
    '      fi',
    '      rm -f "$tmp_obj" 2>/dev/null || true',
    '      if [ ! -f "$obj_path" ]; then',
    '        echo "校验对象池落盘失败：$rel" >&2',
    '        exit 1',
    '      fi',
    '      new_object_bytes=$((new_object_bytes + f_size))',
    '    fi',
    '    logical_bytes=$((logical_bytes + f_size))',
    '    file_count=$((file_count + 1))',
    '    printf "f\\t%s\\t%s\\t%s\\t%s\\n" "$f_mode" "$f_size" "$f_hash" "$rel" >> "$tmp_index"',
    '  fi',
    '}',
    '',
    'for name in "$@"; do',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests"|".yuyan-state") continue ;; esac',
    '  case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '  if [ "$kind" = "cas-entry-only" ]; then',
    '    case "$hashed_list" in *"$nl$name$nl"*) continue ;; esac',
    '  fi',
    '  if [ -L "$root/$name" ] || [ -f "$root/$name" ]; then',
    '    store_one_entry "$name"',
    '    printf "%s\\n" "$name" >> "$tmp_names"',
    '  elif [ -d "$root/$name" ]; then',
    '    printf "%s\\n" "$name" >> "$tmp_names"',
    '    tmp_list=$(mktemp)',
    '    (cd "$root" && find "$name" -print) > "$tmp_list"',
    '    while IFS= read -r rel_entry; do',
    '      [ -n "$rel_entry" ] || continue',
    '      store_one_entry "$rel_entry"',
    '    done < "$tmp_list"',
    '    rm -f "$tmp_list"',
    '  fi',
    'done',
    '',
    '# 3. 写入备份元信息与当时的发布清单快照（优先读外置仓，回退读历史内嵌）',
    'current_manifest=""',
    `if [ -n "$manifest_dir" ] && [ -f "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then`,
    `  current_manifest="$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}"`,
    'elif [ -n "$manifest_dir" ] && [ -d "$manifest_dir" ]; then',
    `  latest=$(ls -1 "$manifest_dir"/*.txt 2>/dev/null | grep -v "/${DEPLOY_CURRENT_MANIFEST_NAME}$" | sort | tail -n 1 || true)`,
    '  if [ -n "$latest" ] && [ -f "$latest" ]; then current_manifest="$latest"; fi',
    'fi',
    'if [ -z "$current_manifest" ] && [ -n "$legacy_manifest_dir" ]; then',
    `  if [ -f "$legacy_manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}" ]; then`,
    `    current_manifest="$legacy_manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}"`,
    '  elif [ -d "$legacy_manifest_dir" ]; then',
    `    latest=$(ls -1 "$legacy_manifest_dir"/*.txt 2>/dev/null | grep -v "/${DEPLOY_CURRENT_MANIFEST_NAME}$" | sort | tail -n 1 || true)`,
    '    if [ -n "$latest" ] && [ -f "$latest" ]; then current_manifest="$latest"; fi',
    '  fi',
    'fi',
    'if [ -n "$current_manifest" ] && [ -f "$current_manifest" ]; then',
    `  cp "$current_manifest" "$backup/${BACKUP_MANIFEST_FILE_NAME}"`,
    'fi',
    '',
    '# 4. 原子提交快照索引与元数据',
    `mv "$tmp_index" "$final_index"`,
    `mv "$tmp_names" "$backup/${BACKUP_NAMES_FILE_NAME}"`,
    `printf "%s\\n" "$kind" > "$backup/${BACKUP_KIND_FILE_NAME}"`,
    'now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")',
    'now_epoch=$(date +%s 2>/dev/null || echo 0)',
    'dedup_saved=$((logical_bytes - new_object_bytes))',
    'if [ "$dedup_saved" -lt 0 ]; then dedup_saved=0; fi',
    `printf '{"releaseName":"%s","kind":"%s","createdAt":"%s","createdAtEpoch":%s,"logicalBytes":%s,"newObjectBytes":%s,"dedupSavedBytes":%s,"fileCount":%s,"dedupHits":%s,"branch":"%s","commitSha":"%s"}\\n' "$release_name" "$kind" "$now_iso" "$now_epoch" "$logical_bytes" "$new_object_bytes" "$dedup_saved" "$file_count" "$dedup_hits" "$branch_name" "$commit_sha" > "$backup/${BACKUP_META_FILE_NAME}"`,
    'trap - EXIT',
    'echo "cas_backup_ok=1 logical_bytes=$logical_bytes new_object_bytes=$new_object_bytes dedup_saved_bytes=$dedup_saved file_count=$file_count dedup_hits=$dedup_hits"',
  ].join('\n');

  return buildPosixShellCommand(
    script,
    [
      rootPath,
      backupPath,
      objectsDir,
      manifestDir || '',
      legacyManifestDir || '',
      kind,
      protectedListStr,
      hashedListStr,
      safeReleaseName,
      safeBranch,
      safeCommit,
      ...safeNames,
    ],
    useSudo
  );
}

/**
 * 解析 CAS 备份命令的输出统计。
 * @param {string} stdout - 命令输出
 * @returns {{ ok: boolean, logicalBytes: number, newObjectBytes: number, dedupSavedBytes: number, fileCount: number, dedupHits: number }}
 */
export function parseCasBackupOutput(stdout) {
  const text = String(stdout || '');
  const num = (key) => {
    const m = text.match(new RegExp(`\\b${key}=(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  return {
    ok: /\bcas_backup_ok=1\b/.test(text),
    logicalBytes: num('logical_bytes'),
    newObjectBytes: num('new_object_bytes'),
    dedupSavedBytes: num('dedup_saved_bytes'),
    fileCount: num('file_count'),
    dedupHits: num('dedup_hits'),
  };
}

/**
 * 生成 CAS 备份回滚前完整性预检命令。
 * 同时检查：
 * 1. .cas-index.tsv 中所有文件对象是否存在于 objects/<aa>/<hash>；
 * 2. 若为 cas-entry-only，额外检查 .manifest.txt 中 hashedDirs 静态资源是否完好存在于部署根目录。
 * @param {Object} params - 预检参数
 * @param {string} params.rootPath - 部署根目录
 * @param {string} params.backupPath - 备份目录
 * @param {string} params.objectsDir - CAS 对象池目录
 * @param {string[]} [params.hashedDirs=DEFAULT_HASHED_ASSET_DIRS] - 带哈希目录
 * @param {boolean} [params.useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildCasPreflightCheckRollbackCommand({
  rootPath,
  backupPath,
  objectsDir,
  hashedDirs = DEFAULT_HASHED_ASSET_DIRS,
  useSudo = false,
}) {
  const dirCasePatterns = (hashedDirs.length ? hashedDirs : DEFAULT_HASHED_ASSET_DIRS)
    .map((dir) => `${dir}/*|${dir}`)
    .join('|');
  const script = [
    'set -eu',
    'root="$1"',
    'backup="$2"',
    'objects_dir="$3"',
    'TAB=$(printf \'\\t\')',
    `kind_file="$backup/${BACKUP_KIND_FILE_NAME}"`,
    'if [ ! -f "$kind_file" ]; then echo "kind=full missing_count=0 missing_objects=0"; exit 0; fi',
    'kind=$(cat "$kind_file" | tr -d "[:space:]")',
    `if [ "$kind" != "${CAS_BACKUP_KINDS.casFull}" ] && [ "$kind" != "${CAS_BACKUP_KINDS.casEntryOnly}" ]; then`,
    '  echo "kind=$kind missing_count=0 missing_objects=0"',
    '  exit 0',
    'fi',
    `index_file="$backup/${CAS_INDEX_FILE_NAME}"`,
    'if [ ! -f "$index_file" ]; then',
    '  echo "kind=$kind missing_count=-1 missing_objects=-1 error=missing_cas_index"',
    '  exit 0',
    'fi',
    'tmp_missing_obj=$(mktemp)',
    'tmp_missing_assets=$(mktemp)',
    'cleanup() { rm -f "$tmp_missing_obj" "$tmp_missing_assets"; }',
    'trap cleanup EXIT',
    'while IFS="$TAB" read -r etype emode esize ehash erel elink; do',
    '  [ "$etype" = "f" ] || continue',
    '  shard=$(printf "%s" "$ehash" | cut -c1-2)',
    '  obj="$objects_dir/$shard/$ehash"',
    '  if [ ! -f "$obj" ]; then',
    '    printf "%s (sha256:%s)\\n" "$erel" "$ehash" >> "$tmp_missing_obj"',
    '  fi',
    'done < "$index_file"',
    'missing_obj=$(wc -l < "$tmp_missing_obj" | tr -d " ")',
    'missing_assets=0',
    `if [ "$kind" = "${CAS_BACKUP_KINDS.casEntryOnly}" ]; then`,
    `  manifest_file="$backup/${BACKUP_MANIFEST_FILE_NAME}"`,
    '  if [ ! -f "$manifest_file" ]; then',
    '    echo "kind=$kind missing_count=-1 missing_objects=$missing_obj error=missing_manifest"',
    '    exit 0',
    '  fi',
    '  while IFS= read -r rel; do',
    '    case "$rel" in ""|/*|*../*|../*|.*|*/.*) continue ;; esac',
    `    case "$rel" in ${dirCasePatterns})`,
    '      if [ ! -f "$root/$rel" ] && [ ! -d "$root/$rel" ]; then',
    '        echo "$rel" >> "$tmp_missing_assets"',
    '      fi',
    '      ;;',
    '    esac',
    '  done < "$manifest_file"',
    '  missing_assets=$(wc -l < "$tmp_missing_assets" | tr -d " ")',
    'fi',
    'total_missing=$((missing_obj + missing_assets))',
    'echo "kind=$kind missing_count=$total_missing missing_objects=$missing_obj missing_assets=$missing_assets"',
    'if [ "$total_missing" -gt 0 ]; then',
    '  echo "===MISSING_FILES==="',
    '  head -n 15 "$tmp_missing_obj"',
    '  head -n 15 "$tmp_missing_assets"',
    'fi',
  ].join('\n');

  return buildPosixShellCommand(script, [rootPath, backupPath, objectsDir], useSudo);
}

/**
 * 生成从 CAS 快照恢复部署根目录的远程 Shell 命令。
 * 遵循与传统恢复一致的三段式协议：
 * 1. 全量预检（确认冲突项与所有待恢复对象完整存在）；
 * 2. 精确移除 validRemove 中的旧条目；
 * 3. 从只读对象池拷贝恢复普通文件（独立 inode，不硬链接对象池）、重建目录与符号链接、写回 current.txt。
 * @param {Object} params - 恢复参数
 * @returns {string} 远程命令
 */
export function buildCasRestoreDeployRootCommand({
  rootPath,
  backupPath,
  objectsDir,
  manifestDir,
  protectedSubDirs = [],
  restoreNames = [],
  removeNames = [],
  useSudo = false,
}) {
  const reservedSet = new Set(RESERVED_DEPLOY_ENTRIES);
  const protectedSet = new Set(protectedSubDirs.filter(isValidEntryName));
  const validRemove = (removeNames || [])
    .filter(isValidEntryName)
    .filter((n) => !reservedSet.has(n) && !protectedSet.has(n));
  const validRestore = (restoreNames || [])
    .filter(isValidEntryName)
    .filter((n) => !reservedSet.has(n) && !protectedSet.has(n));

  const protectedListStr = '\n' + protectedSubDirs.filter(isValidEntryName).join('\n') + '\n';
  const removeListStr = '\n' + validRemove.join('\n') + '\n';
  const restoreListStr = '\n' + validRestore.join('\n') + '\n';

  const script = [
    '# yuyan:cas-restore',
    'set -eu',
    'root="$1"',
    'backup="$2"',
    'objects_dir="$3"',
    'manifest_dir="$4"',
    'remove_count="$5"',
    'protected_list="$6"',
    'remove_list="$7"',
    'restore_list="$8"',
    'shift 8',
    'nl=\'',
    '\'',
    'TAB=$(printf \'\\t\')',
    `index_file="$backup/${CAS_INDEX_FILE_NAME}"`,
    'if [ ! -f "$index_file" ]; then',
    '  echo "CAS 备份缺少索引文件，已停止恢复，部署目录未改动" >&2',
    '  exit 1',
    'fi',
    '',
    '# 1. 恢复前严格预检：目标冲突检测 + 所有待恢复顶层条目的对象池存在性校验',
    'idx=0',
    'for name in "$@"; do',
    '  idx=$((idx + 1))',
    '  if [ "$idx" -le "$remove_count" ]; then continue; fi',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests"|".yuyan-state") continue ;; esac',
    '  case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '  case "$remove_list" in *"$nl$name$nl"*) in_remove=1 ;; *) in_remove=0 ;; esac',
    '  if [ "$in_remove" = "0" ] && { [ -e "$root/$name" ] || [ -L "$root/$name" ]; }; then',
    '    echo "恢复前目标仍存在：$name" >&2',
    '    exit 1',
    '  fi',
    'done',
    '',
    'while IFS="$TAB" read -r etype emode esize ehash erel elink; do',
    '  [ -n "$etype" ] || continue',
    '  case "$erel" in ""|/*|*../*|../*|..) echo "索引含非法路径：$erel" >&2; exit 1 ;; esac',
    '  top="${erel%%/*}"',
    '  case "$restore_list" in *"$nl$top$nl"*) ;; *) continue ;; esac',
    '  case "$protected_list" in *"$nl$top$nl"*) continue ;; esac',
    '  if [ "$etype" = "f" ]; then',
    '    shard=$(printf "%s" "$ehash" | cut -c1-2)',
    '    obj="$objects_dir/$shard/$ehash"',
    '    if [ ! -f "$obj" ]; then',
    '      echo "对象池缺少回滚所需对象：${erel} (${ehash})，已停止恢复，部署目录未改动" >&2',
    '      exit 1',
    '    fi',
    '  fi',
    'done < "$index_file"',
    '',
    '# 2. 预检全部通过后，仅移除 validRemove 名单中的旧条目',
    'idx=0',
    'for name in "$@"; do',
    '  idx=$((idx + 1))',
    '  if [ "$idx" -gt "$remove_count" ]; then break; fi',
    '  case "$name" in ""|"."|".."|"*"|".*"|*/*|".yuyan-backups"|".yuyan-manifests"|".yuyan-state") continue ;; esac',
    '  case "$protected_list" in *"$nl$name$nl"*) continue ;; esac',
    '  if [ -e "$root/$name" ] || [ -L "$root/$name" ]; then',
    '    if ! rm -rf "$root/$name"; then',
    '      echo "移除旧条目失败：$name" >&2',
    '      exit 1',
    '    fi',
    '  fi',
    'done',
    '',
    '# 3. 按索引从只读对象池还原目录、普通文件与符号链接（写新 inode，不修改对象池）',
    'while IFS="$TAB" read -r etype emode esize ehash erel elink; do',
    '  [ -n "$etype" ] || continue',
    '  top="${erel%%/*}"',
    '  case "$restore_list" in *"$nl$top$nl"*) ;; *) continue ;; esac',
    '  case "$protected_list" in *"$nl$top$nl"*) continue ;; esac',
    '  dest="$root/$erel"',
    '  if [ "$etype" = "d" ]; then',
    '    mkdir -p "$dest"',
    '    chmod "$emode" "$dest" 2>/dev/null || true',
    '    chmod u+rwx "$dest" 2>/dev/null || true',
    '  elif [ "$etype" = "f" ]; then',
    '    parent_dir=$(dirname "$dest")',
    '    mkdir -p "$parent_dir"',
    '    shard=$(printf "%s" "$ehash" | cut -c1-2)',
    '    obj="$objects_dir/$shard/$ehash"',
    '    if ! cp "$obj" "$dest"; then',
    '      echo "恢复文件失败：$erel" >&2',
    '      exit 1',
    '    fi',
    '    chmod u+w "$dest" 2>/dev/null || true',
    '    chmod "$emode" "$dest" 2>/dev/null || chmod 644 "$dest" 2>/dev/null || true',
    '    chmod u+rw "$dest" 2>/dev/null || true',
    '  elif [ "$etype" = "l" ]; then',
    '    parent_dir=$(dirname "$dest")',
    '    mkdir -p "$parent_dir"',
    '    ln -s "$elink" "$dest"',
    '  fi',
    'done < "$index_file"',
    '',
    '# 4. 恢复当时发布清单到有效清单目录',
    `if [ -f "$backup/${BACKUP_MANIFEST_FILE_NAME}" ] && [ -n "$manifest_dir" ]; then`,
    '  mkdir -p "$manifest_dir"',
    `  cp "$backup/${BACKUP_MANIFEST_FILE_NAME}" "$manifest_dir/${DEPLOY_CURRENT_MANIFEST_NAME}"`,
    'fi',
  ].join('\n');

  return buildPosixShellCommand(
    script,
    [
      rootPath,
      backupPath,
      objectsDir,
      manifestDir || path.posix.join(rootPath, LEGACY_MANIFEST_DIR_NAME),
      String(validRemove.length),
      protectedListStr,
      removeListStr,
      restoreListStr,
      ...validRemove,
      ...validRestore,
    ],
    useSudo
  );
}

/**
 * 构建三维备份保留策略裁剪命令（份数上限 + 去重后物理空间上限 + TTL 天数，硬保底留最新 1 份）。
 * 支持同时纳入外置仓备份目录与历史内嵌 .yuyan-backups 目录统一排序淘汰。
 * @param {Object} params - 裁剪参数
 * @param {string} params.primaryBackupRoot - 主备份目录（外置仓 backups/ 或内嵌 .yuyan-backups/）
 * @param {string} [params.legacyBackupRoot=''] - 历史内嵌 .yuyan-backups 目录（外置模式下可一并参与淘汰）
 * @param {number} params.keepCount - 最多保留份数（>=1）
 * @param {number} params.maxSizeMb - 空间上限 MB（0 表示不限）
 * @param {number} params.ttlDays - 保留天数 TTL（0 表示不限）
 * @param {number} [params.minKeepCount=1] - 硬保底保留份数（默认 1）
 * @param {boolean} [params.useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildPruneBackupsCommand({
  primaryBackupRoot,
  legacyBackupRoot = '',
  keepCount = 6,
  maxSizeMb = 200,
  ttlDays = 14,
  minKeepCount = 1,
  useSudo = false,
}) {
  const safeKeep = Math.max(1, Number(keepCount || 6));
  const safeMinKeep = Math.max(0, Math.min(safeKeep, Number(minKeepCount ?? 1)));
  const safeMaxBytes = Math.max(0, Number(maxSizeMb || 0)) * 1024 * 1024;
  const safeTtlSeconds = Math.max(0, Number(ttlDays || 0)) * 86400;

  const script = [
    '# yuyan:prune-backups-3d',
    'set -eu',
    'primary_root="$1"',
    'legacy_root="$2"',
    'keep_count="$3"',
    'max_bytes="$4"',
    'ttl_seconds="$5"',
    'min_keep="$6"',
    ...buildPortableHelperLines(),
    'TAB=$(printf \'\\t\')',
    'now_epoch=$(date +%s)',
    'tmp_candidates=$(mktemp)',
    'tmp_sorted=$(mktemp)',
    'tmp_seen_hashes=$(mktemp)',
    'tmp_deleted=$(mktemp)',
    'tmp_surviving=$(mktemp)',
    'cleanup() { rm -f "$tmp_candidates" "$tmp_sorted" "$tmp_seen_hashes" "$tmp_deleted" "$tmp_surviving"; }',
    'trap cleanup EXIT',
    '',
    'collect_dir() {',
    '  broot="$1"',
    '  [ -n "$broot" ] && [ -d "$broot" ] || return 0',
    '  for item in "$broot"/*; do',
    '    [ -d "$item" ] || continue',
    '    bname=$(basename "$item")',
    '    case "$bname" in ""|"."|".."|"*"|.*) continue ;; esac',
    '    ts=0',
    `    if [ -f "$item/${BACKUP_META_FILE_NAME}" ]; then`,
    `      ts=$(sed -n 's/.*"createdAtEpoch":\\([0-9][0-9]*\\).*/\\1/p' "$item/${BACKUP_META_FILE_NAME}" | head -n 1 || true)`,
    '    fi',
    '    case "$ts" in ""|*[!0-9]*|0) ts=$(yuyan_file_mtime "$item") ;; esac',
    '    case "$ts" in ""|*[!0-9]*) ts=0 ;; esac',
    '    printf "%s\\t%s\\t%s\\n" "$ts" "$bname" "$item" >> "$tmp_candidates"',
    '  done',
    '}',
    '',
    'collect_dir "$primary_root"',
    'if [ -n "$legacy_root" ] && [ "$legacy_root" != "$primary_root" ]; then',
    '  collect_dir "$legacy_root"',
    'fi',
    '',
    'if [ ! -s "$tmp_candidates" ]; then',
    '  echo "===PRUNE_SUMMARY==="',
    '  echo "deleted_count=0"',
    '  echo "surviving_count=0"',
    '  echo "effective_bytes=0"',
    '  echo "===DELETED_BACKUPS==="',
    '  echo "===END_DELETED_BACKUPS==="',
    '  echo "===SURVIVING_BACKUPS==="',
    '  echo "===END_SURVIVING_BACKUPS==="',
    '  exit 0',
    'fi',
    '',
    '# 按时间戳倒序，同秒按目录名倒序',
    'sort -t "$TAB" -k1,1nr -k2,2r "$tmp_candidates" > "$tmp_sorted"',
    '',
    'rank=0',
    'surviving_count=0',
    'deleted_count=0',
    'effective_bytes=0',
    '',
    'while IFS="$TAB" read -r ts bname bdir; do',
    '  [ -n "$bdir" ] || continue',
    '  rank=$((rank + 1))',
    '  age=$((now_epoch - ts))',
    '  if [ "$age" -lt 0 ]; then age=0; fi',
    '',
    '  # 计算引入该快照带来的去重增量物理字节',
    '  inc_bytes=0',
    '  tmp_new_hashes=$(mktemp)',
    `  if [ -f "$bdir/${CAS_INDEX_FILE_NAME}" ]; then`,
    '    tmp_snap_hashes=$(mktemp)',
    `    awk -F"\\t" '$1=="f" && $4!="" { if (!seen[$4]++) print $4 "\\t" $3 }' "$bdir/${CAS_INDEX_FILE_NAME}" > "$tmp_snap_hashes"`,
    '    if [ -s "$tmp_seen_hashes" ]; then',
    '      awk -F"\\t" \'NR==FNR { seen[$1]=1; next } !($1 in seen) { print $1 "\\t" $2 }\' "$tmp_seen_hashes" "$tmp_snap_hashes" > "$tmp_new_hashes"',
    '    else',
    '      cp "$tmp_snap_hashes" "$tmp_new_hashes"',
    '    fi',
    '    inc_bytes=$(awk -F"\\t" \'{ s += $2 } END { printf "%.0f", s + 0 }\' "$tmp_new_hashes")',
    '    rm -f "$tmp_snap_hashes"',
    '  else',
    '    kb=$(du -sk "$bdir" 2>/dev/null | awk \'{print $1}\')',
    '    case "$kb" in ""|*[!0-9]*) kb=0 ;; esac',
    '    inc_bytes=$((kb * 1024))',
    '  fi',
    '',
    '  should_delete=0',
    '  if [ "$surviving_count" -ge "$min_keep" ]; then',
    '    if [ "$surviving_count" -ge "$keep_count" ]; then',
    '      should_delete=1',
    '    elif [ "$ttl_seconds" -gt 0 ] && [ "$age" -gt "$ttl_seconds" ]; then',
    '      should_delete=1',
    '    elif [ "$max_bytes" -gt 0 ] && [ $((effective_bytes + inc_bytes)) -gt "$max_bytes" ]; then',
    '      should_delete=1',
    '    fi',
    '  fi',
    '',
    '  if [ "$should_delete" = "1" ]; then',
    '    rm -f "$tmp_new_hashes"',
    '    if rm -rf "$bdir"; then',
    '      deleted_count=$((deleted_count + 1))',
    '      printf "%s\\n" "$bdir" >> "$tmp_deleted"',
    '    else',
    '      # 删除失败按存活处理，避免 DB 误清',
    '      surviving_count=$((surviving_count + 1))',
    '      printf "%s\\n" "$bdir" >> "$tmp_surviving"',
    '    fi',
    '  else',
    '    surviving_count=$((surviving_count + 1))',
    '    effective_bytes=$((effective_bytes + inc_bytes))',
    '    if [ -s "$tmp_new_hashes" ]; then',
    '      awk -F"\\t" \'{ print $1 }\' "$tmp_new_hashes" >> "$tmp_seen_hashes"',
    '    fi',
    '    rm -f "$tmp_new_hashes"',
    '    printf "%s\\n" "$bdir" >> "$tmp_surviving"',
    '  fi',
    'done < "$tmp_sorted"',
    '',
    '# 若历史内嵌 .yuyan-backups 已被完全清空且当前主仓在外置，清理空壳目录保持 html/ 纯净',
    'if [ -n "$legacy_root" ] && [ "$legacy_root" != "$primary_root" ] && [ -d "$legacy_root" ]; then',
    '  rmdir "$legacy_root" 2>/dev/null || true',
    'fi',
    '',
    'echo "===PRUNE_SUMMARY==="',
    'echo "deleted_count=$deleted_count"',
    'echo "surviving_count=$surviving_count"',
    'echo "effective_bytes=$effective_bytes"',
    'echo "===DELETED_BACKUPS==="',
    'cat "$tmp_deleted"',
    'echo "===END_DELETED_BACKUPS==="',
    'echo "===SURVIVING_BACKUPS==="',
    'cat "$tmp_surviving"',
    'echo "===END_SURVIVING_BACKUPS==="',
  ].join('\n');

  return buildPosixShellCommand(
    script,
    [
      primaryBackupRoot,
      legacyBackupRoot || '',
      String(safeKeep),
      String(safeMaxBytes),
      String(safeTtlSeconds),
      String(safeMinKeep),
    ],
    useSudo
  );
}

/**
 * 解析三维备份裁剪脚本输出。
 * @param {string} stdout - 脚本输出
 * @returns {{ deletedCount: number, survivingCount: number, effectiveBytes: number, deletedPaths: string[], survivingPaths: string[] }}
 */
export function parsePruneBackupsOutput(stdout) {
  const text = String(stdout || '');
  const extractBlock = (start, end) => {
    const s = text.indexOf(start);
    if (s === -1) return [];
    const from = s + start.length;
    const e = text.indexOf(end, from);
    const body = e === -1 ? text.slice(from) : text.slice(from, e);
    return body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  };
  const num = (key) => {
    const m = text.match(new RegExp(`^${key}=(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  const deletedPaths = extractBlock('===DELETED_BACKUPS===\n', '===END_DELETED_BACKUPS===');
  const survivingPaths = extractBlock('===SURVIVING_BACKUPS===\n', '===END_SURVIVING_BACKUPS===');
  return {
    deletedCount: num('deleted_count') || deletedPaths.length,
    survivingCount: num('surviving_count') || survivingPaths.length,
    effectiveBytes: num('effective_bytes'),
    deletedPaths,
    survivingPaths,
  };
}

/**
 * 生成外置仓 CAS 对象池 Mark-and-Sweep GC 远程命令。
 * @description
 * 1. 使用 stateRoot/.gc.lock 原子防并发，抢不到锁时平滑跳过不报错；
 * 2. Mark 扫描 targets/<slug>/backups/<ts>/.cas-index.tsv 与 .cas-index.tsv.tmp；
 * 3. Sweep 仅删除不在活跃集且 mtime 超过 graceMinutes 的孤儿对象，并清理超过 60 分钟的孤儿 .tmp.* 文件。
 * @param {string} stateRoot - 外置状态仓根路径（如 /home/app/frontend/.yuyan-state）
 * @param {Object} [options={}] - GC 选项
 * @param {number} [options.graceMinutes=10] - 并发安全宽限期（分钟）
 * @param {boolean} [options.useSudo=false] - 是否 sudo
 * @returns {string} 远程命令
 */
export function buildCasObjectPoolGcCommand(stateRoot, options = {}) {
  const graceMinutes = Math.max(0, Number(options.graceMinutes ?? DEFAULT_CAS_GC_GRACE_MINUTES));
  const useSudo = Boolean(options.useSudo);
  const script = [
    '# yuyan:cas-gc',
    'set -eu',
    'state_root="$1"',
    'grace_seconds="$2"',
    ...buildPortableHelperLines(),
    `objects_dir="$state_root/${STATE_OBJECTS_DIR_NAME}"`,
    `targets_dir="$state_root/${STATE_TARGETS_DIR_NAME}"`,
    `gc_lock="$state_root/${STATE_GC_LOCK_NAME}"`,
    'if [ ! -d "$objects_dir" ]; then',
    '  echo "gc_status=skipped_empty scanned_objects=0 live_objects=0 deleted_objects=0 freed_bytes=0 skipped_grace=0"',
    '  exit 0',
    'fi',
    'now_epoch=$(date +%s)',
    '# 清理超过 30 分钟的僵死 GC 锁',
    'if [ -d "$gc_lock" ]; then',
    '  lock_mtime=$(yuyan_file_mtime "$gc_lock")',
    '  case "$lock_mtime" in ""|*[!0-9]*) lock_mtime=0 ;; esac',
    '  if [ "$lock_mtime" -gt 0 ] && [ $((now_epoch - lock_mtime)) -gt 1800 ]; then',
    '    rm -f "$gc_lock/owner" 2>/dev/null || true',
    '    rmdir "$gc_lock" 2>/dev/null || true',
    '  fi',
    'fi',
    'if ! mkdir "$gc_lock" 2>/dev/null; then',
    '  echo "gc_status=skipped_locked scanned_objects=0 live_objects=0 deleted_objects=0 freed_bytes=0 skipped_grace=0"',
    '  exit 0',
    'fi',
    'tmp_live_raw=$(mktemp)',
    'tmp_live=$(mktemp)',
    'tmp_obj_list=$(mktemp)',
    'tmp_candidates=$(mktemp)',
    'cleanup() {',
    '  rm -f "$tmp_live_raw" "$tmp_live" "$tmp_obj_list" "$tmp_candidates" "$gc_lock/owner" 2>/dev/null || true',
    '  rmdir "$gc_lock" 2>/dev/null || true',
    '}',
    'trap cleanup EXIT',
    'printf "pid=%s at=%s\\n" "$$" "$now_epoch" > "$gc_lock/owner" 2>/dev/null || true',
    '',
    '# 1. Mark：扫描全部活跃及写入中索引文件',
    'if [ -d "$targets_dir" ]; then',
    `  find "$targets_dir" -type f \\( -name "${CAS_INDEX_FILE_NAME}" -o -name "${CAS_INDEX_FILE_NAME}.tmp.*" \\) 2>/dev/null | while IFS= read -r idx_file; do`,
    '    awk -F"\\t" \'$1=="f" && $4!="" { print $4 }\' "$idx_file" >> "$tmp_live_raw" 2>/dev/null || true',
    '  done',
    'fi',
    'if [ -s "$tmp_live_raw" ]; then',
    '  sort -u "$tmp_live_raw" > "$tmp_live"',
    'else',
    '  : > "$tmp_live"',
    'fi',
    'live_count=$(wc -l < "$tmp_live" | tr -d " ")',
    '',
    '# 2. Sweep：一次性 awk 哈希过滤活跃对象（O(N+M)），仅对孤儿候选与临时文件执行 stat 与清理',
    'scanned=0',
    'deleted=0',
    'freed_bytes=0',
    'skipped_grace=0',
    'TAB=$(printf \'\\t\')',
    'find "$objects_dir" -mindepth 2 -maxdepth 2 -type f 2>/dev/null > "$tmp_obj_list" || true',
    'awk -v live_file="$tmp_live" \'FILENAME == live_file { live[$0] = 1; next } { n = split($0, p, "/"); b = p[n]; if (substr(b, 1, 5) == ".tmp.") { print "TMP\\t" $0; next } if (length(b) == 64 && b ~ /^[0-9a-fA-F]+$/) { sc++; if (!(b in live)) { print "ORPHAN\\t" $0 } } } END { print "SCANNED\\t" (sc + 0) }\' "$tmp_live" "$tmp_obj_list" > "$tmp_candidates"',
    'while IFS="$TAB" read -r kind obj_file; do',
    '  if [ "$kind" = "SCANNED" ]; then',
    '    scanned="$obj_file"',
    '    continue',
    '  fi',
    '  [ -n "$obj_file" ] || continue',
    '  obj_mtime=$(yuyan_file_mtime "$obj_file")',
    '  case "$obj_mtime" in ""|*[!0-9]*) obj_mtime=0 ;; esac',
    '  age=$((now_epoch - obj_mtime))',
    '  if [ "$age" -lt 0 ]; then age=0; fi',
    '  if [ "$kind" = "TMP" ]; then',
    '    if [ "$age" -gt 3600 ]; then',
    '      sz=$(yuyan_file_size "$obj_file")',
    '      case "$sz" in ""|*[!0-9]*) sz=0 ;; esac',
    '      if rm -f "$obj_file" 2>/dev/null; then',
    '        freed_bytes=$((freed_bytes + sz))',
    '      fi',
    '    fi',
    '    continue',
    '  fi',
    '  if [ "$grace_seconds" -gt 0 ] && [ "$age" -lt "$grace_seconds" ]; then',
    '    skipped_grace=$((skipped_grace + 1))',
    '    continue',
    '  fi',
    '  sz=$(yuyan_file_size "$obj_file")',
    '  case "$sz" in ""|*[!0-9]*) sz=0 ;; esac',
    '  chmod u+w "$obj_file" 2>/dev/null || true',
    '  if rm -f "$obj_file" 2>/dev/null; then',
    '    deleted=$((deleted + 1))',
    '    freed_bytes=$((freed_bytes + sz))',
    '  fi',
    'done < "$tmp_candidates"',
    'find "$objects_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while IFS= read -r sdir; do rmdir "$sdir" 2>/dev/null || true; done',
    'echo "gc_status=ok scanned_objects=$scanned live_objects=$live_count deleted_objects=$deleted freed_bytes=$freed_bytes skipped_grace=$skipped_grace"',
  ].join('\n');

  return buildPosixShellCommand(script, [stateRoot, String(graceMinutes * 60)], useSudo);
}

/**
 * 解析 CAS 对象池 GC 输出。
 * @param {string} stdout - GC 脚本输出
 * @returns {{ status: string, scannedObjects: number, liveObjects: number, deletedObjects: number, freedBytes: number, skippedGrace: number }}
 */
export function parseCasGcOutput(stdout) {
  const text = String(stdout || '');
  const statusMatch = text.match(/\bgc_status=([^\s]+)/);
  const num = (key) => {
    const m = text.match(new RegExp(`\\b${key}=(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  return {
    status: statusMatch ? statusMatch[1] : 'unknown',
    scannedObjects: num('scanned_objects'),
    liveObjects: num('live_objects'),
    deletedObjects: num('deleted_objects'),
    freedBytes: num('freed_bytes'),
    skippedGrace: num('skipped_grace'),
  };
}
