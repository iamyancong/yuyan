# syntax=docker/dockerfile:1.6
# 使用内网 Harbor 的 Node 基础镜像，避免访问 Docker Hub
ARG NODE_IMAGE=harbor.dm.com/yss-datamiddle/yss-node:22.19.0

# build stage
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./.npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
# 适配新项目的 Vue3 前端构建脚本 (frontend:build)
RUN pnpm run frontend:build
RUN pnpm prune --prod && rm -f .npmrc

# runtime stage（需要 git 以便后端执行 git 初始化与推送）
FROM ${NODE_IMAGE}
# 兼容多种基础镜像（alpine/debian/centos），安装 git、zip 与证书
RUN set -e; \
  if command -v apk >/dev/null 2>&1; then \
  apk add --no-cache git zip ca-certificates; \
  elif command -v apt-get >/dev/null 2>&1; then \
  apt-get update && apt-get install -y git zip ca-certificates && rm -rf /var/lib/apt/lists/*; \
  elif command -v yum >/dev/null 2>&1; then \
  yum install -y git zip ca-certificates; \
  elif command -v microdnf >/dev/null 2>&1; then \
  microdnf install -y git zip ca-certificates; \
  else \
  echo "No supported package manager found to install git and zip" && exit 1; \
  fi
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist
ENV PORT=3100
EXPOSE 3100
ENTRYPOINT ["node","server/index.mjs"]
