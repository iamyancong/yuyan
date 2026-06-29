#!/usr/bin/env bash
# =============================================================================
# build.sh — Yuyan Nginx 多版本运行时构建编排脚本
# =============================================================================
# 描述：自动化构建 Nginx 静态/动态两种变体，完成以下流程：
#   1. Docker 镜像构建
#   2. 从容器中提取编译产物
#   3. 打包为 nginx-runtime.tar.gz
#   4. 计算 SHA-256 校验和
#   5. 生成 manifest.json
#   6. 更新 registry.json
#
# 用法：
#   ./build.sh                       # 构建所有变体（默认）
#   ./build.sh --variant static      # 仅构建静态变体
#   ./build.sh --variant dynamic     # 仅构建动态变体
#   ./build.sh --variant all         # 构建所有变体
# =============================================================================

set -euo pipefail

# =============================================================================
# 全局常量
# =============================================================================

# Nginx 版本号
NGINX_VERSION="1.24.0"

# 当前脚本所在目录（build/）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 资源根目录（server/assets/nginx-runtime/）
ASSET_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Docker 镜像名前缀
IMAGE_PREFIX="yuyan-nginx-build"

# 构建摘要数组（用于最终打印）
declare -a BUILD_SUMMARY=()

# =============================================================================
# 工具函数
# =============================================================================

##
# 打印带时间戳的日志信息
# @param $1 日志内容
##
log_info() {
    echo -e "\033[32m[$(date '+%H:%M:%S')] ✓ $1\033[0m"
}

##
# 打印带时间戳的警告信息
# @param $1 警告内容
##
log_warn() {
    echo -e "\033[33m[$(date '+%H:%M:%S')] ⚠ $1\033[0m"
}

##
# 打印带时间戳的错误信息并退出
# @param $1 错误内容
##
log_error() {
    echo -e "\033[31m[$(date '+%H:%M:%S')] ✗ $1\033[0m" >&2
    exit 1
}

##
# 计算文件的 SHA-256 校验和
# @param $1 文件路径
# @return 输出 SHA-256 十六进制字符串
##
calc_sha256() {
    local file="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        log_error "未找到 sha256sum 或 shasum 命令"
    fi
}

##
# 获取文件的人类可读大小
# @param $1 文件路径
# @return 输出格式化的文件大小
##
get_file_size() {
    local file="$1"
    if command -v du &>/dev/null; then
        du -h "$file" | awk '{print $1}'
    else
        wc -c < "$file" | awk '{printf "%.1fK", $1/1024}'
    fi
}

##
# 清理指定名称的临时 Docker 容器
# @param $1 容器名称
##
cleanup_container() {
    local container_name="$1"
    if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
        docker rm -f "$container_name" &>/dev/null || true
        log_info "已清理临时容器: ${container_name}"
    fi
}

# =============================================================================
# 核心构建逻辑
# =============================================================================

##
# 构建单个变体（静态或动态）
# @param $1 variant - 变体标识（static | dynamic）
##
build_variant() {
    local variant="$1"
    local dockerfile=""
    local output_dir=""
    local image_name=""
    local container_name=""
    local min_glibc=""
    local require_xcrypt=""

    # 根据变体类型设置参数
    case "$variant" in
        static)
            dockerfile="Dockerfile.static"
            output_dir="${ASSET_DIR}/linux-x64-static"
            image_name="${IMAGE_PREFIX}-static"
            container_name="${IMAGE_PREFIX}-static-tmp"
            min_glibc="0"
            require_xcrypt="false"
            ;;
        dynamic)
            dockerfile="Dockerfile.dynamic"
            output_dir="${ASSET_DIR}/linux-x64"
            image_name="${IMAGE_PREFIX}-dynamic"
            container_name="${IMAGE_PREFIX}-dynamic-tmp"
            min_glibc="2.28"
            require_xcrypt="true"
            ;;
        *)
            log_error "未知的变体类型: ${variant}（仅支持 static / dynamic）"
            ;;
    esac

    echo ""
    echo "================================================================="
    echo "  构建变体: ${variant}"
    echo "  Dockerfile: ${dockerfile}"
    echo "  输出目录: ${output_dir}"
    echo "================================================================="
    echo ""

    # -----------------------------------------------------------------------
    # 步骤 1：Docker 镜像构建
    # -----------------------------------------------------------------------
    log_info "开始构建 Docker 镜像: ${image_name}"
    docker build \
        --platform linux/amd64 \
        -f "${SCRIPT_DIR}/${dockerfile}" \
        -t "${image_name}" \
        "${SCRIPT_DIR}"
    log_info "Docker 镜像构建完成: ${image_name}"

    # -----------------------------------------------------------------------
    # 步骤 2：从容器中提取编译产物
    # -----------------------------------------------------------------------
    log_info "创建临时容器并提取产物..."

    # 清理可能残留的同名容器
    cleanup_container "$container_name"

    # 创建临时容器（不启动）
    docker create --name "$container_name" "$image_name" /bin/true

    # 准备输出目录
    rm -rf "$output_dir"
    mkdir -p "$output_dir"

    # 从容器复制产物
    docker cp "${container_name}:/output/sbin"  "${output_dir}/"
    docker cp "${container_name}:/output/conf"  "${output_dir}/"
    docker cp "${container_name}:/output/html"  "${output_dir}/"

    log_info "产物提取完成 → ${output_dir}"

    # 清理临时容器
    cleanup_container "$container_name"

    # -----------------------------------------------------------------------
    # 步骤 3：打包为 tar.gz（内部不包含顶层目录）
    # -----------------------------------------------------------------------
    local tarball="${output_dir}/nginx-runtime.tar.gz"
    log_info "打包产物: ${tarball}"

    tar -czf "$tarball" \
        -C "$output_dir" \
        sbin conf html

    log_info "打包完成"

    # -----------------------------------------------------------------------
    # 步骤 4：计算 SHA-256 校验和
    # -----------------------------------------------------------------------
    local sha256
    sha256="$(calc_sha256 "$tarball")"
    log_info "SHA-256: ${sha256}"

    # -----------------------------------------------------------------------
    # 步骤 5：生成 manifest.json
    # -----------------------------------------------------------------------
    local manifest_file="${output_dir}/manifest.json"
    log_info "生成清单文件: ${manifest_file}"

    cat > "$manifest_file" <<EOF
{
  "name": "yuyan-nginx-runtime",
  "version": "${NGINX_VERSION}",
  "platform": "linux",
  "arch": "x64",
  "variant": "${variant}",
  "minGlibc": "${min_glibc}",
  "requireXcrypt": ${require_xcrypt},
  "packageFile": "nginx-runtime.tar.gz",
  "sha256": "${sha256}"
}
EOF

    log_info "清单文件生成完成"

    # -----------------------------------------------------------------------
    # 记录构建摘要
    # -----------------------------------------------------------------------
    local file_size
    file_size="$(get_file_size "$tarball")"
    BUILD_SUMMARY+=("  ${variant}  |  ${file_size}  |  ${sha256}")
}

##
# 更新 registry.json 注册表
# 在所有变体构建完成后调用，确保注册表与实际产物一致
##
update_registry() {
    local registry_file="${ASSET_DIR}/registry.json"
    log_info "更新变体注册表: ${registry_file}"

    cat > "$registry_file" <<'EOF'
{
  "defaultVariant": "linux-x64-static",
  "variants": [
    {
      "id": "linux-x64",
      "label": "动态链接 (glibc ≥ 2.28)",
      "dir": "linux-x64",
      "minGlibc": "2.28",
      "requireXcrypt": true,
      "priority": 10
    },
    {
      "id": "linux-x64-static",
      "label": "静态链接 (通用)",
      "dir": "linux-x64-static",
      "minGlibc": "0",
      "requireXcrypt": false,
      "priority": 1
    }
  ]
}
EOF

    log_info "注册表更新完成"
}

##
# 打印最终构建摘要
##
print_summary() {
    echo ""
    echo "================================================================="
    echo "  Yuyan Nginx 运行时构建摘要"
    echo "================================================================="
    echo "  Nginx 版本: ${NGINX_VERSION}"
    echo "  产物目录:   ${ASSET_DIR}"
    echo "-----------------------------------------------------------------"
    printf "  %-10s |  %-8s |  %-64s\n" "变体" "大小" "SHA-256"
    echo "-----------------------------------------------------------------"
    for line in "${BUILD_SUMMARY[@]}"; do
        echo "$line"
    done
    echo "================================================================="
    echo ""
}

# =============================================================================
# 参数解析
# =============================================================================

##
# 解析命令行参数
# @param --variant static|dynamic|all 指定构建变体（默认 all）
##
VARIANT="all"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --variant)
            if [[ -z "${2:-}" ]]; then
                log_error "--variant 参数需要一个值（static / dynamic / all）"
            fi
            VARIANT="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法: $0 [--variant static|dynamic|all]"
            echo ""
            echo "参数:"
            echo "  --variant    指定构建变体（默认: all）"
            echo "               static   - 仅构建静态链接版本"
            echo "               dynamic  - 仅构建动态链接版本"
            echo "               all      - 构建所有版本"
            exit 0
            ;;
        *)
            log_error "未知参数: $1（使用 --help 查看帮助）"
            ;;
    esac
done

# 校验参数合法性
case "$VARIANT" in
    static|dynamic|all) ;;
    *) log_error "无效的变体: ${VARIANT}（仅支持 static / dynamic / all）" ;;
esac

# =============================================================================
# 主流程
# =============================================================================

log_info "Yuyan Nginx 运行时构建开始"
log_info "Nginx 版本: ${NGINX_VERSION}"
log_info "目标变体: ${VARIANT}"

# 检查 Docker 是否可用
if ! command -v docker &>/dev/null; then
    log_error "未检测到 Docker，请先安装 Docker"
fi

if ! docker info &>/dev/null; then
    log_error "Docker 守护进程未运行，请先启动 Docker"
fi

# 按变体执行构建
case "$VARIANT" in
    static)
        build_variant "static"
        ;;
    dynamic)
        build_variant "dynamic"
        ;;
    all)
        build_variant "static"
        build_variant "dynamic"
        ;;
esac

# 更新注册表
update_registry

# 打印构建摘要
print_summary

log_info "所有构建任务已完成 ✓"
