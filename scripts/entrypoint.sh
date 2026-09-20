#!/usr/bin/env bash
# 容器入口：幂等准备运行环境，然后把进程交给 CMD。
# 设计要求：可以反复重启，不依赖任何一次性手工步骤。
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }

: "${DSH_HOME:=/data/dsh}"
: "${QQ_WORKSPACES_ROOT:=/data/workspaces}"
: "${QQ_STATE_DIR:=/data/bot}"
: "${QQ_DSH_PROFILE_PATCH:=/app/dsh-profile/cordis.patch.yml}"

export DSH_HOME QQ_WORKSPACES_ROOT QQ_STATE_DIR QQ_DSH_PROFILE_PATCH

log "[entrypoint] DSH_HOME=$DSH_HOME"
log "[entrypoint] 工作区根=$QQ_WORKSPACES_ROOT"
log "[entrypoint] 状态目录=$QQ_STATE_DIR"

# --- 1. 目录与权限 -----------------------------------------------------------
# 具名卷首次挂载时会由 Docker 用镜像里的目录内容初始化，属主通常是对的；
# 但绑定挂载（bind mount）到宿主目录时属主可能是 root，这里兜底修正。
for dir in "$DSH_HOME" "$QQ_WORKSPACES_ROOT" "$QQ_STATE_DIR"; do
  mkdir -p "$dir"
  if [ ! -w "$dir" ]; then
    log "[entrypoint] 错误：$dir 不可写（当前 uid=$(id -u)）。"
    log "[entrypoint] 绑定挂载请先执行：sudo chown -R 10001:10001 <宿主目录>"
    exit 1
  fi
done

# --- 2. 幂等初始化 DSH profile ----------------------------------------------
# `dsh --profile sdk` 首次运行会自动从 shipped 模板初始化 $DSH_HOME/profiles/sdk。
# 这里只做"探针式"预热：dump 一次配置即完成初始化，不启动任何常驻进程。
if [ ! -f "$QQ_DSH_PROFILE_PATCH" ]; then
  log "[entrypoint] 错误：profile patch 不存在：$QQ_DSH_PROFILE_PATCH"
  exit 1
fi

if [ ! -d "$DSH_HOME/profiles/sdk" ]; then
  log "[entrypoint] 首次运行：初始化 DSH profile 'sdk'"
  dsh --profile sdk --patch "$QQ_DSH_PROFILE_PATCH" --dump-config >/dev/null
  log "[entrypoint] profile 初始化完成"
else
  # 复用已有 profile 目录。这里刻意不再校验 patch：profile 是
  # patchReload=startup 的，每个 DSH runtime 进程启动时按传入的 --patch
  # 自行组合。所以改了 patch 后 `docker compose restart qqbot` 即生效，
  # 不需要重建镜像（详见 docs/DEPLOY.md 第 8 节）。
  log "[entrypoint] 复用已有 profile：$DSH_HOME/profiles/sdk"
fi

# --- 3. 沙箱后端可用性检查 ---------------------------------------------------
# 非致命，但必须显式告警：没有可用沙箱后端时，workspace-write 会退化成提权，
# 实际权限等于完全访问。
# 必须用权威判定，不能只看二进制是否存在。
# 实测教训：bwrap 装上了也可能因内核禁止非特权 user namespace 而无法创建
# 命名空间；而 DSH 在 Linux 上的后端链是 ["bwrap", "landlock"]，Landlock
# 照样能让 workspace-write 真正生效。只看 `command -v bwrap` 会给出错误结论。
SANDBOX_VERDICT="unknown"
if [ -f /app/scripts/verify-sandbox-capability.mjs ]; then
  if node /app/scripts/verify-sandbox-capability.mjs >/tmp/sandbox-check.log 2>&1; then
    SANDBOX_VERDICT="effective"
  else
    SANDBOX_VERDICT="degraded"
  fi
fi

case "$SANDBOX_VERDICT" in
  effective)
    BACKEND=$(grep -o 'VERDICT: SANDBOX-EFFECTIVE.*' /tmp/sandbox-check.log | head -1)
    log "[entrypoint] 沙箱后端有效：${BACKEND#VERDICT: }"
    log "[entrypoint]          workspace-write 是一道真闸"
    ;;
  degraded)
    log "[entrypoint] 警告：没有可用的沙箱后端！"
    log "[entrypoint]        workspace-write 下 DSH 会请求提权到 danger-full-access，"
    log "[entrypoint]        审批桩会放行，因此实际权限等于完全访问。"
    log "[entrypoint]        修复方式见 docs/DEPLOY.md 第 5 节。"
    ;;
  *)
    log "[entrypoint] 注意：沙箱自检脚本不可用，无法判定沙箱后端状态"
    ;;
esac

# --- 4. 关键环境变量自检 -----------------------------------------------------
missing=()
[ -n "${QQ_APP_ID:-}" ] || missing+=("QQ_APP_ID")
[ -n "${QQ_APP_SECRET:-}" ] || missing+=("QQ_APP_SECRET")
[ -n "${DEEPSEEK_API_KEY:-}" ] || missing+=("DEEPSEEK_API_KEY")
if [ ${#missing[@]} -gt 0 ]; then
  log "[entrypoint] 错误：缺少必需环境变量：${missing[*]}"
  log "[entrypoint] 请复制 .env.example 为 .env 并填写后重试。"
  exit 1
fi

log "[entrypoint] 启动：$*"
exec "$@"
