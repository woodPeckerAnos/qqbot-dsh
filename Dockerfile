# --- 构建阶段 ---------------------------------------------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app

# 先只拷贝清单，最大化利用层缓存
COPY package.json ./
COPY scripts/docker-install.mjs ./scripts/docker-install.mjs
# 1) 安装全部依赖（含 devDependencies，编译需要 typescript）
RUN node scripts/docker-install.mjs install

COPY tsconfig.json ./
COPY src ./src
# 2) 编译。注意必须在剪枝之前——typescript 属于 devDependencies。
RUN ./node_modules/.bin/tsc -p tsconfig.json

# 3) 剪枝：剔除 devDependencies 与不匹配本平台的可选依赖，
#    否则 typescript/vitest 以及 macOS 平台的 .node 二进制都会被带进运行镜像。
RUN node scripts/docker-install.mjs prune

# --- 运行阶段 ---------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# bubblewrap 是关键：DSH 的 workspace-write 沙箱在 Linux 上依赖它。
# 缺了它，bash 工具在 workspace-write 下无法执行，DSH 会请求提权到
# danger-full-access，A 方案的"工作区边界"就名存实亡。
# 见 docs/DESIGN.md 第 6 节与 scripts/verify-sandbox.mjs。
#
# poppler-utils 提供 pdftotext：用户发来的 PDF 要抽正文（见 dsh/document.ts）。
# 刻意走系统包而不是 npm 的纯 JS PDF 库——部署形态只有 Docker，且 poppler 对
# 中文/畸形/加密 PDF 的健壮性远好于纯 JS 方案；缺失时机器人自动降级为
# 「只把原文落进 inbox/ 并告知路径」，不会让这一轮失败。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      ca-certificates \
      bubblewrap \
      git \
      ripgrep \
      python3 \
      poppler-utils \
      procps \
      curl \
 && rm -rf /var/lib/apt/lists/*

# 非 root 运行。uid/gid 固定，便于宿主侧 volume 权限对齐。
RUN groupadd --gid 10001 qqbot \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash qqbot

WORKDIR /app

COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root dsh-profile ./dsh-profile
COPY --chown=root:root scripts ./scripts

# 显式归一化权限。
# 必须做：宿主上的 umask 可能让源文件是 0600，COPY 会原样保留，
# 于是非 root 的 qqbot 用户读不到自己的脚本（表现为 EACCES，很难一眼看出原因）。
RUN chmod -R a+rX /app \
 && chmod a+rx /app/scripts/entrypoint.sh

# 数据根：DSH_HOME（会话日志/settings）、每群工作区、机器人自身状态
RUN mkdir -p /data/dsh /data/workspaces /data/bot \
 && chown -R qqbot:qqbot /data

ENV NODE_ENV=production \
    DSH_HOME=/data/dsh \
    QQ_DSH_PROFILE_PATCH=/app/dsh-profile/cordis.patch.yml \
    QQ_WORKSPACES_ROOT=/data/workspaces \
    QQ_STATE_DIR=/data/bot \
    NODE_OPTIONS=--no-warnings

# 必须把本地安装的 bin 目录加进 PATH：DSH runtime 是以子进程方式用 "dsh"
# 启动的（见 src/dsh/process.ts），找不到它会直接 ENOENT 启动失败。
ENV PATH=/app/node_modules/.bin:$PATH

USER qqbot

# 入口脚本负责幂等初始化 profile 与目录权限
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]
CMD ["node", "dist/main.js"]

# 健康检查不依赖 curl 之外的东西；也可用 node dist/health-probe.js
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node dist/health-probe.js
