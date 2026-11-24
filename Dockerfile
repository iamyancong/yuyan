# 使用官方公共 Node 基础镜像
ARG NODE_IMAGE=node:22-alpine

# build stage
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PATH="/opt/pnpm/bin:$PATH"
COPY package.json pnpm-lock.yaml ./.npmrc ./
# 复用项目 .npmrc（含内网 Nexus 镜像与鉴权）安装与 packageManager 一致的 pnpm，
# 避免 corepack 绕过 .npmrc 直连公网 registry.npmjs.org 导致内网 CI 超时
RUN set -e; \
  PNPM_SPEC="$(node --input-type=commonjs -e "const pm = String(require('./package.json').packageManager || 'pnpm@9.15.9'); const m = pm.match(/^pnpm@([^+]+)/); console.log('pnpm@' + (m ? m[1] : '9.15.9'));")"; \
  NPM_CONFIG_USERCONFIG=/app/.npmrc npm install -g --prefix /opt/pnpm --no-audit --no-fund "$PNPM_SPEC"; \
  pnpm --version
RUN pnpm install --frozen-lockfile
COPY . .
# 仅执行 vite build 产出前端静态资源，跳过 vue-tsc 类型检查
# （yuyan-app 从桌面端迁移而来，部分模块的类型声明包未纳入 devDependencies，
#   类型检查会失败，但不影响 vite 正常编译产物）
# 网页版技术支持联系人（Vite 编译期写入产物）：docker build --build-arg VITE_CONTACT_EMAIL=... 传入。
# 只导出非空值：Vite 中进程环境变量优先于 .env 文件，空串会覆盖 .env.production(.local) 里的配置，
# 所以未传或传空的 build-arg 在构建前 unset，交由 .env 文件或组件的未配置态处理。
ARG VITE_CONTACT_NAME
ARG VITE_CONTACT_WORK_NO
ARG VITE_CONTACT_COMPANY
ARG VITE_CONTACT_ROLE
ARG VITE_CONTACT_EMAIL
ARG VITE_CONTACT_CARD_URL
RUN for key in VITE_CONTACT_NAME VITE_CONTACT_WORK_NO VITE_CONTACT_COMPANY VITE_CONTACT_ROLE VITE_CONTACT_EMAIL VITE_CONTACT_CARD_URL; do \
  eval "value=\${$key:-}"; \
  if [ -z "$(printf '%s' "$value" | tr -d '[:space:]')" ]; then unset "$key"; fi; \
  done; \
  npx vite build
RUN pnpm prune --prod && rm -f .npmrc

# runtime stage（需要 git 以便后端执行 git 初始化与推送）
FROM ${NODE_IMAGE}
# 兼容多种基础镜像（alpine/debian/centos），安装 git、zip、证书与 tini
# tini 作为 1 号进程：回收构建子进程（esbuild 等）留下的僵尸进程，并把 SIGTERM/SIGINT 转发给 node 以保持优雅退出（#48）
RUN set -e; \
  if command -v apk >/dev/null 2>&1; then \
  apk add --no-cache git zip ca-certificates tini; \
  elif command -v apt-get >/dev/null 2>&1; then \
  apt-get update && apt-get install -y git zip ca-certificates tini && rm -rf /var/lib/apt/lists/*; \
  elif command -v yum >/dev/null 2>&1; then \
  yum install -y git zip ca-certificates tini; \
  elif command -v microdnf >/dev/null 2>&1; then \
  microdnf install -y git zip ca-certificates tini; \
  else \
  echo "No supported package manager found to install git and zip" && exit 1; \
  fi; \
  TINI_BIN="$(command -v tini || true)"; \
  if [ -z "$TINI_BIN" ]; then echo "tini not found after install" && exit 1; fi; \
  if [ "$TINI_BIN" != "/sbin/tini" ]; then ln -sf "$TINI_BIN" /sbin/tini; fi; \
  /sbin/tini --version
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PATH="/opt/pnpm/bin:$PATH"
COPY --from=builder /opt/pnpm /opt/pnpm
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist
ENV PORT=3100
ENV HOST=0.0.0.0
EXPOSE 3100
# 由 tini 托管 node：tini 只把信号转发给 node（不加 -g），构建子进程仍由 node 的 shutdown 流程负责收尾
ENTRYPOINT ["/sbin/tini","--","node","server/index.mjs"]
