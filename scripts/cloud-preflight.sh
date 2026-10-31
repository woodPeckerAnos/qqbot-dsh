#!/usr/bin/env bash
# ============================================================================
# 云主机上线前自检（只读，不改任何东西，不输出密钥值）
#
# 用法：
#   bash scripts/cloud-preflight.sh
#   bash scripts/cloud-preflight.sh --with-napcat
#   bash scripts/cloud-preflight.sh --env-file .env --napcat-env napcat.env
#
# 退出码：0 = 没有阻断项；1 = 有 FAIL（阻断上线）；只有 WARN 时仍为 0。
#
# 覆盖的是"换一台 Linux 云主机后最容易踩"的项：Docker/Compose 版本、
# 资源、出网、沙箱内核支持、端口占用、.env / napcat.env 权限与必填项。
# --with-napcat 额外按"bot + NapCat 同机"的门槛检查内存/swap/CPU/磁盘。
# 不做的事：不构建镜像、不启动容器、不读密钥内容、不触碰生产。
# ============================================================================

set -uo pipefail

ENV_FILE=".env"
NAPCAT_ENV_FILE="napcat.env"
WITH_NAPCAT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      if [ -z "${2:-}" ]; then
        printf '错误：--env-file 需要一个路径\n' >&2
        exit 2
      fi
      ENV_FILE="$2"
      shift 2
      ;;
    --env-file=*)
      ENV_FILE="${1#*=}"
      shift
      ;;
    --napcat-env)
      if [ -z "${2:-}" ]; then
        printf '错误：--napcat-env 需要一个路径\n' >&2
        exit 2
      fi
      NAPCAT_ENV_FILE="$2"
      shift 2
      ;;
    --napcat-env=*)
      NAPCAT_ENV_FILE="${1#*=}"
      shift
      ;;
    --with-napcat)
      WITH_NAPCAT=1
      shift
      ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '错误：未知参数 %s（用 --help 查看用法）\n' "$1" >&2
      exit 2
      ;;
  esac
done

FAIL=0
WARN=0
PASS=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); say "[PASS] $*"; }
warn() { WARN=$((WARN + 1)); say "[WARN] $*"; }
bad()  { FAIL=$((FAIL + 1)); say "[FAIL] $*"; }
head_() { printf '\n== %s ==\n' "$*"; }

# --- 1. 系统与资源 -----------------------------------------------------------
head_ "系统与资源"

OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" = "Linux" ]; then
  ok "操作系统：Linux/$ARCH"
else
  warn "操作系统：$OS/${ARCH}（云主机应为 Linux；本脚本部分检查不适用）"
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker 可用：$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  else
    bad "Docker 已安装但守护进程不可用（当前用户无权限或 daemon 未启动）"
  fi
  if docker compose version >/dev/null 2>&1; then
    ok "Docker Compose：$(docker compose version --short 2>/dev/null)"
  else
    bad "缺少 docker compose 子命令（需要 Docker 24+）"
  fi
else
  bad "未安装 docker"
fi

CPU_N=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
MEM_MB=0
MIN_MEM=1900
REC_MEM=3800
if [ "$WITH_NAPCAT" -eq 1 ]; then
  # 云主机标称 4GB，MemTotal 通常约 3.8–3.9GB（内核保留），不能用 4096 硬卡
  MIN_MEM=3700
  REC_MEM=7600
fi

if [ -r /proc/meminfo ]; then
  MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
  if [ "$MEM_MB" -ge "$MIN_MEM" ]; then
    ok "内存总量：${MEM_MB}MB（要求 ≥${MIN_MEM}MB）"
  else
    bad "内存总量：${MEM_MB}MB，低于 ${MIN_MEM}MB"
  fi
  if [ "$MEM_MB" -lt "$REC_MEM" ]; then
    if [ "$WITH_NAPCAT" -eq 1 ]; then
      warn "内存 <${REC_MEM}MB：bot(2GB) + NapCat(1GB) + 系统，4GB 主机建议配 2GB swap 并保持默认并发"
    else
      warn "内存 <${REC_MEM}MB：每活跃会话一个 DSH 子进程，建议 4GB 或调小 QQ_MAX_RUNTIMES"
    fi
  fi
  if [ "$WITH_NAPCAT" -eq 1 ]; then
    SWAP_MB=$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo)
    if [ "${SWAP_MB:-0}" -ge 1024 ]; then
      ok "swap：${SWAP_MB}MB"
    else
      warn "swap 仅 ${SWAP_MB:-0}MB：4GB 内存跑 NapCat 建议配 2GB swap 兜底"
    fi
  fi
fi

if [ "${CPU_N:-0}" -gt 0 ]; then
  if [ "$WITH_NAPCAT" -eq 1 ] && [ "$CPU_N" -lt 2 ]; then
    bad "CPU 核数：$CPU_N，bot + NapCat 至少需要 2 核"
  elif [ "$WITH_NAPCAT" -eq 1 ] && [ "$CPU_N" -lt 4 ]; then
    warn "CPU 核数：$CPU_N，构建镜像时会与运行抢 CPU；建议先 build 再 up"
  else
    ok "CPU 核数：$CPU_N"
  fi
fi

DISK_MIN=5
DISK_REC=10
if [ "$WITH_NAPCAT" -eq 1 ]; then
  DISK_MIN=10
  DISK_REC=20
fi
DISK_GB=$(df -Pk . 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}')
if [ -n "${DISK_GB:-}" ]; then
  if [ "$DISK_GB" -ge "$DISK_MIN" ]; then
    ok "当前目录可用磁盘：${DISK_GB}GB（要求 ≥${DISK_MIN}GB）"
  else
    bad "当前目录可用磁盘：${DISK_GB}GB，低于 ${DISK_MIN}GB"
  fi
  if [ "$DISK_GB" -lt "$DISK_REC" ]; then
    warn "可用磁盘 <${DISK_REC}GB：镜像、QQ 缓存、工作区与会话日志会持续增长"
  fi
fi

# --- 2. 密钥文件 -------------------------------------------------------------
head_ "密钥文件（只检查存在性与是否为空，不打印值）"

if [ -f "$ENV_FILE" ]; then
  ok "存在 $ENV_FILE"
  PERM=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '')
  if [ -n "$PERM" ] && [ "$PERM" != "600" ] && [ "$PERM" != "400" ]; then
    warn "$ENV_FILE 权限为 ${PERM}，建议 chmod 600（容器以 uid 10001 读取，600 仍可读）"
  else
    ok "$ENV_FILE 权限正常（${PERM:-未知}）"
  fi

  # 只判断"是否为空"，绝不回显内容
  for name in QQ_APP_ID QQ_APP_SECRET DEEPSEEK_API_KEY ONEBOT_ACCESS_TOKEN; do
    value=$(grep -E "^[[:space:]]*${name}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
    if [ -n "$value" ]; then
      ok "$name 已设置"
    else
      say "[INFO] $name 未设置（按启用的接入与模型路由判断是否必需）"
    fi
  done

  if [ "$WITH_NAPCAT" -eq 1 ]; then
    value=$(grep -E "^[[:space:]]*ONEBOT_ACCESS_TOKEN=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
    if [ -n "$value" ]; then
      ok "ONEBOT_ACCESS_TOKEN 已设置（NapCat 反向 WS 必需）"
    else
      bad "ONEBOT_ACCESS_TOKEN 为空：叠加 docker-compose.napcat.yml 时必须设置"
    fi
    if grep -Eq '^[[:space:]]*WEBUI_TOKEN=' "$ENV_FILE" 2>/dev/null; then
      bad "WEBUI_TOKEN 不应放在 ${ENV_FILE}：它会随整份 .env 进入 qqbot 和 agent 子进程；请移到 ${NAPCAT_ENV_FILE}"
    fi
  fi

  # DSH 对项目 .env 里的代理名是 fail-loud 的
  if grep -Eq '^[[:space:]]*(HTTPS?_PROXY|ALL_PROXY|NO_PROXY)=' "$ENV_FILE" 2>/dev/null; then
    bad "$ENV_FILE 含代理变量：DSH 会拒绝启动。代理请放 compose 覆盖层或 \$DSH_HOME/.env"
  else
    ok "$ENV_FILE 未含代理变量"
  fi
else
  bad "缺少 ${ENV_FILE}（cp .env.example $ENV_FILE 后填写）"
fi

# NapCat 的 WebUI token 单独成文件，只由 NapCat env_file 读取。
if [ "$WITH_NAPCAT" -eq 1 ]; then
  if [ -f "$NAPCAT_ENV_FILE" ]; then
    ok "存在 ${NAPCAT_ENV_FILE}"
    NPERM=$(stat -c '%a' "$NAPCAT_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$NAPCAT_ENV_FILE" 2>/dev/null || echo '')
    if [ -n "$NPERM" ] && [ "$NPERM" != "600" ] && [ "$NPERM" != "400" ]; then
      warn "${NAPCAT_ENV_FILE} 权限为 ${NPERM}，建议 chmod 600"
    else
      ok "${NAPCAT_ENV_FILE} 权限正常（${NPERM:-未知}）"
    fi
    NTOKEN=$(grep -E "^[[:space:]]*WEBUI_TOKEN=" "$NAPCAT_ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
    if [ -n "$NTOKEN" ]; then
      ok "WEBUI_TOKEN 已设置（${NAPCAT_ENV_FILE}）"
    else
      bad "WEBUI_TOKEN 为空：${NAPCAT_ENV_FILE} 必须设置（cp napcat.env.example）"
    fi
  else
    bad "缺少 ${NAPCAT_ENV_FILE}（cp napcat.env.example ${NAPCAT_ENV_FILE} 后填写，chmod 600）"
  fi
fi

# --- 3. 出网 -----------------------------------------------------------------
head_ "出网（QQ 网关与模型 API 是主动出网，不需要公网入站）"

check_host() {
  local host="$1"
  if command -v getent >/dev/null 2>&1; then
    if getent hosts "$host" >/dev/null 2>&1; then
      ok "DNS 解析：$host"
    else
      bad "DNS 解析失败：$host"
      return
    fi
  elif command -v nslookup >/dev/null 2>&1; then
    if nslookup "$host" >/dev/null 2>&1; then
      ok "DNS 解析：$host"
    else
      bad "DNS 解析失败：$host"
      return
    fi
  else
    warn "无 DNS 工具，跳过 $host 解析检查"
    return
  fi

  if command -v curl >/dev/null 2>&1; then
    # 任何 HTTP 状态码都说明 TCP+TLS 通了；0 才是连不上
    local code
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$host/" 2>/dev/null)
    if [ "$code" != "000" ] && [ -n "$code" ]; then
      ok "HTTPS 可达：${host}（HTTP ${code}）"
    else
      bad "HTTPS 不可达：${host}（检查安全组/防火墙出站规则）"
    fi
  else
    warn "无 curl，跳过 $host 连通性检查"
  fi
}

check_host api.bot.qq.com
check_host api.deepseek.com

if [ -n "${HTTPS_PROXY:-}" ] || [ -n "${HTTP_PROXY:-}" ]; then
  warn "当前 shell 设置了代理：web_fetch 走代理时才能抓正文；compose 内是否生效以容器 env 为准"
fi

# --- 4. 沙箱内核支持 ---------------------------------------------------------
head_ "沙箱内核支持（workspace-write 是否是真闸）"

if command -v bwrap >/dev/null 2>&1; then
  ok "bubblewrap 已安装"
else
  warn "宿主机无 bubblewrap（容器内自带；本项只作参考）"
fi

if [ -d /sys/kernel/security/landlock ]; then
  ok "内核支持 Landlock"
else
  warn "未见 Landlock 安全目录；容器内可能退化为无沙箱后端"
fi

if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  v=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)
  if [ "$v" = "1" ]; then
    warn "apparmor_restrict_unprivileged_userns=1：bwrap 可能无法创建命名空间（Landlock 可兜底）"
  else
    ok "非特权 user namespace 未被 AppArmor 限制"
  fi
fi

# --- 5. 端口 -----------------------------------------------------------------
head_ "端口占用（基础 compose 只绑回环）"

check_port() {
  local port="$1"
  if ! command -v ss >/dev/null 2>&1; then
    warn "无 ss 命令，跳过端口 $port 检查"
    return
  fi
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then
    warn "端口 $port 已被占用，叠加 cloud 覆盖层前先确认冲突"
  else
    ok "端口 $port 空闲"
  fi
}

check_port 6700
check_port 8080
if [ "$WITH_NAPCAT" -eq 1 ]; then
  check_port 6099
fi

# --- 汇总 --------------------------------------------------------------------
head_ "汇总"
say "PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
  say "存在阻断项，先修复再上线。"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  say "没有阻断项；WARN 项请按实际云环境确认。"
else
  say "全部通过。"
fi
exit 0
