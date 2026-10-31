#!/usr/bin/env bash
# ============================================================================
# 六组数据卷的备份 / 校验 / 恢复（云平台无关）
#
# 用法：
#   bash scripts/volume-bundle.sh backup  --project qqbot-dsh --out backups
#   bash scripts/volume-bundle.sh verify  --bundle backups/20261030-220000
#   bash scripts/volume-bundle.sh restore --bundle backups/20261030-220000 --yes
#
# 约定：
#   - backup/restore 都要求同一 compose 项目已经 stop；任一容器在运行就拒绝，
#     防止双跑或备份到写了一半的卷。
#   - restore 是**覆盖恢复**：校验通过且 --yes 后，先清空目标卷再解包，
#     不会留下旧卷里多出来的文件。回滚前确认目标卷可以被覆盖。
#   - 一个 bundle = 一次完整批次，包含六组卷 + manifest.txt + SHA256SUMS。
#     加密传输在脚本外做（age/gpg 加密整个目录或打包后的文件），脚本本身
#     不处理口令，避免把密钥写进日志或进程参数。
#   - verify 不需要 Docker；backup/restore 需要 Docker daemon。
#   - backup/restore 的 --dry-run 只打印计划，不写卷；verify 仍会真实校验。
#     dry-run 不能代替真实 Docker 操作。
#
# 退出码：0 成功；1 失败；2 用法错误。
# ============================================================================

set -euo pipefail

# 备份含 DSH 凭证、QQ 登录态与 OneBot token：宿主侧默认只允许 owner 读写。
umask 077

DEFAULT_VOLUMES=(dsh-home workspaces bot-state napcat-qq napcat-config napcat-plugins)
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)
BUNDLE_TOOL_VERSION="1"

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

# 相对路径直接传给 docker run -v 会被当成命名卷，必须转成宿主绝对路径。
abspath() {
  local path="$1"
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$PWD" "$path" ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    die "找不到 sha256sum / shasum，无法生成或校验 SHA-256"
  fi
}

check_sha256_manifest() {
  local bundle="$1"
  [ -f "${bundle}/SHA256SUMS" ] || die "${bundle} 缺少 SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$bundle" && sha256sum -c SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$bundle" && shasum -a 256 -c SHA256SUMS)
  else
    die "找不到 sha256sum / shasum，无法校验"
  fi
}

manifest_get() {
  local file="$1" key="$2"
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

# 整批预检：在任何清卷/解包之前，核对项目名、卷集合、每个必需归档及其清单条目。
# 只校验 SHA256SUMS 里"恰好存在"的文件是不够的——缺卷可能不在清单里。
validate_bundle() {
  local bundle="$1"
  local manifest="${bundle}/manifest.txt"
  local sums="${bundle}/SHA256SUMS"
  [ -f "$manifest" ] || die "整批预检失败：缺少 manifest.txt"
  [ -f "$sums" ] || die "整批预检失败：缺少 SHA256SUMS"

  local m_project
  m_project=$(manifest_get "$manifest" project)
  [ "$m_project" = "$PROJECT" ] || die "整批预检失败：manifest 项目名 ${m_project:-<空>} 与 --project ${PROJECT} 不一致"

  local m_volumes_line
  m_volumes_line=$(manifest_get "$manifest" volumes)
  [ -n "$m_volumes_line" ] || die "整批预检失败：manifest 缺少 volumes"

  local -a m_volumes
  read -r -a m_volumes <<< "$m_volumes_line"
  local expected_sorted actual_sorted
  expected_sorted=$(printf '%s\n' "${VOLUMES[@]}" | LC_ALL=C sort)
  actual_sorted=$(printf '%s\n' "${m_volumes[@]}" | LC_ALL=C sort)
  [ "$expected_sorted" = "$actual_sorted" ] || die "整批预检失败：请求卷集合 [${VOLUMES[*]}] 与 manifest [${m_volumes[*]}] 不一致"

  local listed volume archive
  listed=$(awk '{print $NF}' "$sums" | sed 's#^\./##')
  for volume in "${VOLUMES[@]}"; do
    archive="${bundle}/${volume}.tgz"
    [ -f "$archive" ] || die "整批预检失败：缺少 ${volume}.tgz"
    printf '%s\n' "$listed" | grep -Fxq "${volume}.tgz" || die "整批预检失败：${volume}.tgz 未列入 SHA256SUMS"
  done
  printf '%s\n' "$listed" | grep -Fxq "manifest.txt" || die "整批预检失败：manifest.txt 未列入 SHA256SUMS"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "未安装 docker"
  docker info >/dev/null 2>&1 || die "Docker daemon 不可用"
}

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

compose_running_containers() {
  local project="$1"
  docker ps --filter "label=com.docker.compose.project=${project}" --format '{{.Names}}'
}

# --- 参数 --------------------------------------------------------------------
COMMAND="${1:-}"
[ -n "$COMMAND" ] || { usage; exit 2; }
shift || true

PROJECT="qqbot-dsh"
OUT_DIR="backups"
BUNDLE=""
BUNDLE_ID=""
DRY_RUN=0
ASSUME_YES=0
VOLUMES=("${DEFAULT_VOLUMES[@]}")

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project 需要值}"; shift 2 ;;
    --project=*) PROJECT="${1#*=}"; shift ;;
    --out) OUT_DIR="${2:?--out 需要值}"; shift 2 ;;
    --out=*) OUT_DIR="${1#*=}"; shift ;;
    --bundle) BUNDLE="${2:?--bundle 需要值}"; shift 2 ;;
    --bundle=*) BUNDLE="${1#*=}"; shift ;;
    --bundle-id) BUNDLE_ID="${2:?--bundle-id 需要值}"; shift 2 ;;
    --volumes) read -r -a VOLUMES <<< "${2:?--volumes 需要值}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "project 名不合法：$PROJECT"
[ "${#VOLUMES[@]}" -gt 0 ] || die "卷列表为空"
for volume in "${VOLUMES[@]}"; do
  [[ "$volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "卷名不合法：$volume"
done

require_project_stopped() {
  local running
  running=$(compose_running_containers "$PROJECT")
  if [ -n "$running" ]; then
    die "项目 $PROJECT 还有运行中的容器，先 stop（禁止双跑/防止写到一半）：$(echo "$running" | tr '\n' ' ')"
  fi
}


run_backup() {
  local id="${BUNDLE_ID:-$(date +%Y%m%d-%H%M%S)}"
  local bundle="${OUT_DIR}/${id}"
  [ ! -e "$bundle" ] || die "bundle 已存在，拒绝覆盖：$bundle"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] 将创建 $(abspath "$bundle") 并备份：${VOLUMES[*]}"
    info "[dry-run] 真实执行前必须先 stop 项目 ${PROJECT} 的容器"
    return 0
  fi

  require_docker
  require_project_stopped
  mkdir -p "$bundle"
  bundle=$(cd "$bundle" && pwd -P)
  local created_at
  created_at=$(date '+%Y-%m-%d %H:%M:%S %z')
  local commit="unknown"
  if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
    commit=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
  fi

  {
    printf 'bundle_id=%s\n' "$id"
    printf 'created_at=%s\n' "$created_at"
    printf 'host=%s\n' "$(hostname 2>/dev/null || echo unknown)"
    printf 'project=%s\n' "$PROJECT"
    printf 'git_commit=%s\n' "$commit"
    printf 'qqbot_image_tag=%s\n' "${QQBOT_IMAGE_TAG:-}"
    printf 'napcat_image_tag=%s\n' "${NAPCAT_IMAGE_TAG:-}"
    printf 'tool_version=%s\n' "$BUNDLE_TOOL_VERSION"
    printf 'volumes=%s\n' "${VOLUMES[*]}"
  } > "${bundle}/manifest.txt"

  local volume full size
  for volume in "${VOLUMES[@]}"; do
    full="${PROJECT}_${volume}"
    volume_exists "$full" || die "卷不存在：$full（服务是否已创建/启动过？）"
    info "备份 ${full} ..."
    # 容器内也要 umask 077：宿主 umask 不会传进 docker run。
    docker run --rm \
      -v "${full}:/src:ro" \
      -v "${bundle}:/backup" \
      alpine:3.20 sh -c "umask 077; tar -C /src -czf /backup/${volume}.tgz ." \
      || die "备份 ${volume} 失败"
    chmod 600 "${bundle}/${volume}.tgz"
    size=$(du -h "${bundle}/${volume}.tgz" | awk '{print $1}')
    printf 'size_%s=%s\n' "$volume" "$size" >> "${bundle}/manifest.txt"
  done

  chmod 700 "$bundle"
  chmod 600 "${bundle}"/manifest.txt
  (cd "$bundle" && sha256_file ./*.tgz manifest.txt > SHA256SUMS)
  chmod 600 "${bundle}/SHA256SUMS"
  info "完成：$bundle（目录 700，文件 600，已 umask 077）"
  info "下一步：加密整包后再传输（见 docs/CLOUD-DEPLOY.md 第 5 节）"
}

run_verify() {
  [ -n "$BUNDLE" ] || die "verify 需要 --bundle <目录>"
  [ -d "$BUNDLE" ] || die "bundle 目录不存在：$BUNDLE"
  BUNDLE=$(cd "$BUNDLE" && pwd -P)
  [ -f "${BUNDLE}/manifest.txt" ] || die "${BUNDLE} 缺少 manifest.txt"
  check_sha256_manifest "$BUNDLE"
  validate_bundle "$BUNDLE"
  info "校验通过：$BUNDLE"
  info "--- manifest ---"
  sed -n '1,40p' "${BUNDLE}/manifest.txt"
}

run_restore() {
  [ -n "$BUNDLE" ] || die "restore 需要 --bundle <目录>"
  [ -d "$BUNDLE" ] || die "bundle 目录不存在：$BUNDLE"
  [ "$ASSUME_YES" -eq 1 ] || die "restore 是覆盖恢复，会先清空目标卷；确认后加 --yes"

  BUNDLE=$(cd "$BUNDLE" && pwd -P)
  check_sha256_manifest "$BUNDLE"
  validate_bundle "$BUNDLE"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "[dry-run] bundle=${BUNDLE}；校验通过；将覆盖恢复 ${VOLUMES[*]} 到项目 ${PROJECT}（先清空目标卷）"
    return 0
  fi

  require_docker
  require_project_stopped

  local volume full archive
  for volume in "${VOLUMES[@]}"; do
    full="${PROJECT}_${volume}"
    archive="${BUNDLE}/${volume}.tgz"
    [ -f "$archive" ] || die "bundle 缺少 ${volume}.tgz"
    if ! volume_exists "$full"; then
      docker volume create "$full" >/dev/null || die "恢复中断：创建卷 ${full} 失败；禁止启动，修复原因后从头执行整批恢复"
    fi
    info "覆盖恢复 ${full}（先清空再解包）..."
    docker run --rm \
      -v "${full}:/dst" \
      -v "${BUNDLE}:/backup:ro" \
      alpine:3.20 sh -c "set -e; find /dst -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -C /dst -xzf /backup/${volume}.tgz; chown -R 10001:10001 /dst" \
      || die "恢复中断：${volume} 清空/解包失败；禁止启动，修复原因后从头执行整批恢复（整批卷非原子）"
  done

  info "恢复完成。数据就位后再启动："
  info "  docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.napcat.yml up -d"
}

case "$COMMAND" in
  backup) run_backup ;;
  verify) run_verify ;;
  restore) run_restore ;;
  *) usage; exit 2 ;;
esac
