#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
雨燕中央部署数据库恢复脚本

用法:
  restore-central-db.sh --file <备份文件.sqlite.gz> --data-dir <DEPLOY_DATA_DIR> [选项]

选项:
  --file <path>         必填，备份的 .sqlite.gz 文件路径
  --data-dir <dir>      必填，中央服务的 DEPLOY_DATA_DIR 目录
  --sha256-file <path>  可选，SHA-256 校验文件路径（默认 <file>.sha256）
  --yes                 跳过交互确认
  --help, -h            显示帮助信息

说明:
  1. 恢复前请务必先停止雨燕中央服务，本脚本不会自动停服。
  2. 备份文件不包含 DEPLOY_SECRET_KEY，恢复后必须使用原 DEPLOY_SECRET_KEY 启动服务，
     否则库中加密保存的服务器 SSH 密码与私钥将无法解密。
EOF
}

BACKUP_FILE=""
DATA_DIR=""
SHA256_FILE=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      BACKUP_FILE="${2:-}"
      shift 2
      ;;
    --file=*)
      BACKUP_FILE="${1#*=}"
      shift
      ;;
    --data-dir)
      DATA_DIR="${2:-}"
      shift 2
      ;;
    --data-dir=*)
      DATA_DIR="${1#*=}"
      shift
      ;;
    --sha256-file)
      SHA256_FILE="${2:-}"
      shift 2
      ;;
    --sha256-file=*)
      SHA256_FILE="${1#*=}"
      shift
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BACKUP_FILE" || -z "$DATA_DIR" ]]; then
  echo "错误：必须指定 --file 和 --data-dir" >&2
  usage >&2
  exit 2
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "错误：备份文件不存在：$BACKUP_FILE" >&2
  exit 1
fi

if [[ -z "$SHA256_FILE" ]]; then
  SHA256_FILE="${BACKUP_FILE}.sha256"
fi

if [[ ! -f "$SHA256_FILE" ]]; then
  echo "错误：SHA-256 校验文件不存在：$SHA256_FILE" >&2
  exit 1
fi

compute_sha256() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$target" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$target" | awk '{print tolower($1)}'
  elif command -v node >/dev/null 2>&1; then
    node --input-type=module -e '
      import crypto from "node:crypto";
      import fs from "node:fs";
      const h = crypto.createHash("sha256");
      h.update(fs.readFileSync(process.argv[1]));
      process.stdout.write(h.digest("hex") + "\n");
    ' "$target"
  else
    echo "错误：缺少 sha256sum / shasum / node，无法校验 SHA-256" >&2
    return 1
  fi
}

EXPECTED_SHA=$(awk 'NF {print tolower($1); exit}' "$SHA256_FILE")
if [[ ! "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]]; then
  echo "错误：SHA-256 文件格式无效：$SHA256_FILE" >&2
  exit 1
fi

ACTUAL_SHA=$(compute_sha256 "$BACKUP_FILE")
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "错误：SHA-256 校验失败！" >&2
  echo "  期望：$EXPECTED_SHA" >&2
  echo "  实际：$ACTUAL_SHA" >&2
  exit 1
fi
echo "✅ SHA-256 校验通过：$ACTUAL_SHA"

mkdir -p "$DATA_DIR"
TMP_DB=$(mktemp "${DATA_DIR%/}/.deploy.sqlite.restore.XXXXXX")
cleanup() {
  rm -f "$TMP_DB"
}
trap cleanup EXIT

gzip -dc -- "$BACKUP_FILE" > "$TMP_DB"
chmod 600 "$TMP_DB" || true

# 完整性校验：优先 sqlite3，其次 node:sqlite
if command -v sqlite3 >/dev/null 2>&1; then
  CHECK_RESULT=$(sqlite3 "$TMP_DB" "PRAGMA integrity_check;" | tr -d '\r')
  if [[ "$CHECK_RESULT" != "ok" ]]; then
    echo "错误：sqlite3 PRAGMA integrity_check 失败：$CHECK_RESULT" >&2
    exit 1
  fi
  echo "✅ SQLite 完整性校验通过（sqlite3）"
elif command -v node >/dev/null 2>&1; then
  node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    try {
      const rows = db.prepare("PRAGMA integrity_check").all();
      const ok = rows.length === 1 && String(rows[0]?.integrity_check || "").toLowerCase() === "ok";
      if (!ok) {
        console.error("PRAGMA integrity_check failed:", rows);
        process.exit(1);
      }
    } finally {
      db.close();
    }
  ' "$TMP_DB"
  echo "✅ SQLite 完整性校验通过（node:sqlite）"
else
  echo "⚠️ 警告：未找到 sqlite3 或 node，跳过 PRAGMA integrity_check" >&2
fi

echo "⚠️ 重要提醒：恢复前必须先停止雨燕中央服务（本脚本不会自动停服）。"
if [[ -e "${DATA_DIR%/}/deploy.sqlite-wal" ]]; then
  echo "⚠️ 警告：检测到 ${DATA_DIR%/}/deploy.sqlite-wal 存在！如果中央服务仍在运行，请立即 Ctrl+C 取消并先停服。" >&2
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "确认将 $BACKUP_FILE 恢复到 ${DATA_DIR%/}/deploy.sqlite？[y/N] " CONFIRM
  case "$CONFIRM" in
    y|Y|yes|YES)
      ;;
    *)
      echo "已取消恢复。"
      exit 1
      ;;
  esac
fi

RESTORE_STAMP=$(date +%Y%m%d-%H%M%S)
TARGET_DB="${DATA_DIR%/}/deploy.sqlite"

for suffix in "" "-wal" "-shm"; do
  src="${TARGET_DB}${suffix}"
  if [[ -e "$src" ]]; then
    backup_existing="${src}.before-restore-${RESTORE_STAMP}"
    mv -- "$src" "$backup_existing"
    echo "已备份现有文件：$src -> $backup_existing"
  fi
done

mv -- "$TMP_DB" "$TARGET_DB"
trap - EXIT

echo "✅ 中央数据库恢复完成：$TARGET_DB"
echo "🔑 请务必使用原来的 DEPLOY_SECRET_KEY 启动雨燕中央服务，否则服务器 SSH 凭据无法解密。"
