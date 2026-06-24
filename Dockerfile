# 使用内网 Harbor 的 Node 基础镜像，避免访问 Docker Hub
ARG NODE_IMAGE=harbor.dm.com/yss-datamiddle/yss-node:22.19.0

FROM ${NODE_IMAGE}

# 兼容安装 git、zip 等运行时依赖包
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

# 复制依赖定义和内网源配置
COPY package.json pnpm-lock.yaml ./.npmrc ./

# 仅安装生产环境依赖，避免安装并构建前端开发期依赖 (如 vue-tsc, vite)
RUN pnpm install --prod --frozen-lockfile && rm -f .npmrc

# 复制后端核心代码和已打包的前端静态资源目录
COPY server ./server
COPY dist ./dist

ENV PORT=3100
EXPOSE 3100

ENTRYPOINT ["node", "server/index.mjs"]
