# 雨燕（Yuyan）桌面端

> 雨燕平台桌面端 —— 面向前端团队的一站式「微应用脚手架 + 运维部署」工具。

雨燕是一款基于 **Tauri 2 + Vue 3 + 内嵌 Node.js（Express）服务** 构建的跨平台桌面应用。它把「创建微应用」「管理 GitLab 仓库」「向独立服务器发布静态站点 / 管理 Nginx」这些日常前端工程化与运维动作整合到一个本地客户端中，无需在浏览器、终端、SSH 工具之间来回切换。

---

## ✨ 核心功能

| 模块 | 路由 | 说明 |
| --- | --- | --- |
| 🚀 创建微应用 | `/scaffold` | 基于远程模板仓库一键生成标准化微应用（Vue3 / React），自动完成变量替换、初始化 Git、推送并在 GitLab 创建仓库，全程流式进度展示。 |
| 📋 平台应用列表 | `/ops-projects` | 查看由雨燕创建并打了 `yuyan-ops` 标签的平台微应用，支持查看代码、配置等运维信息。 |
| 🌐 独立服务器部署 | `/nginx-deploy` | 通过 SSH 将前端产物发布到独立服务器，内置构建、上传、Nginx 站点配置管理、版本备份与一键回滚，并支持「托管式 Nginx 运行时」自动下发。 |
| 📦 GitLab 仓库列表 | `/projects` | 浏览、搜索 GitLab 仓库，进行仓库相关的批量运维操作。 |

### 功能亮点

- **脚手架流式创建**：通过 NDJSON 流实时回传创建进度（拉取模板 → 变量替换 → Git 初始化 → 推送 → GitLab 建仓），失败可定位到具体阶段。
- **一键发布到独立服务器**：本地构建 → SSH 上传 → 写入/更新 Nginx 配置 → 测试并 reload，支持 `cleanReplace` / `overlayKeepAssets` 两种上传策略与依赖缓存加速。
- **版本备份与回滚**：每次发布在远端保留历史版本，支持回滚与「撤销回滚」，回滚记录可追溯。
- **托管式 Nginx 运行时**：内置多平台 Nginx 运行时资源（`server/assets/nginx-runtime`），可在目标服务器上自动初始化、启动 / 停止 / 重载，无需服务器预装 Nginx。
- **凭据加密存储**：服务器 SSH 密码 / 私钥使用密钥加密后存入本地 SQLite，数据库支持备份与恢复同步。
- **明暗主题**：内置主题切换，macOS 下同步切换 Dock 图标。

---

## 🏗️ 技术架构

雨燕采用「Tauri 外壳 + 前端 SPA + 内嵌 Node 服务」三层结构：

```
┌─────────────────────────────────────────────────────────┐
│  Tauri (Rust, src-tauri/)                                 │
│  · 创建窗口、托盘、主题图标                                  │
│  · 启动时拉起内嵌 Node 二进制，运行 Express 服务            │
│  · 退出时回收 Node 子进程                                   │
└───────────────┬──────────────────────────┬───────────────┘
                │ WebView                   │ spawn child process
                ▼                           ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│  前端 SPA (Vue 3, src/)    │   │  Node 服务 (Express, server/) │
│  · Vue Router / 组件        │──▶│  · /scaffold-api  脚手架      │
│  · Ant Design Vue / vxe-ui │HTTP│  · /deploy-api    部署        │
│  · @ycwang-dev/*  业务组件  │   │  · /health        健康检查    │
└───────────────────────────┘   │  · SQLite 持久化 / SSH 操作   │
                                 └───────────────────────────┘
```

- 前端构建产物（`dist/`）由 Express 静态托管；桌面端由 Tauri 注入本地服务端口，优先使用 `127.0.0.1:3101`，冲突时动态分配。
- 打包时通过 `scripts/copy-node.js` 将本机 Node 二进制复制进 Tauri 资源目录（macOS 会执行 ad-hoc 签名），保证用户机器无需另装 Node 即可运行（开发模式直接使用系统 Node）。

### 技术栈

**前端**
- Vue 3.5（`<script setup>` + TypeScript）
- Vite 7 + vue-tsc
- Vue Router 4（Hash 模式）
- Ant Design Vue 4 / vxe-pc-ui 4
- `@ycwang-dev/components`、`@ycwang-dev/hooks`、`@ycwang-dev/utils`（私有业务组件库）
- Less

**桌面端**
- Tauri 2（Rust 2021）
- `tauri-plugin-opener`、`tauri-plugin-dialog`

**内嵌服务**
- Node.js（ESM）+ Express 5
- `ssh2`（SSH / SFTP）、SQLite（部署数据持久化）
- `compression`、`cors`、`connect-history-api-fallback`

---

## 📁 目录结构

```
yuyan-app/
├── src/                     # 前端 SPA
│   ├── api/                 # 后端接口封装（scaffold / deploy / gitlab）
│   ├── views/               # 业务页面
│   │   ├── ProjectList/Scaffold/   # 创建微应用
│   │   ├── OpsProjects/            # 平台应用列表
│   │   ├── NginxDeploy/            # 独立服务器部署
│   │   └── ProjectList/            # GitLab 仓库列表
│   ├── components/          # 通用组件
│   ├── composables/ hooks/  # 组合式逻辑、主题、鉴权
│   └── router/              # 路由表
├── server/                  # 内嵌 Express 服务
│   ├── index.mjs            # 服务入口（中间件 / 路由 / 启动）
│   ├── config/constants.mjs # 配置与环境变量
│   ├── routes/              # scaffold / deploy / health 路由
│   ├── controllers/         # 控制器
│   ├── services/            # Git / GitLab / SSH / 部署 / 模板 等服务
│   ├── assets/nginx-runtime/# 内置多平台 Nginx 运行时
│   └── utils/               # 文件、清理、错误解析等工具
├── src-tauri/               # Tauri（Rust）外壳
│   ├── src/lib.rs           # 启动内嵌 Node、托盘图标、生命周期
│   ├── tauri.conf.json      # Tauri 配置（窗口 / 打包资源）
│   └── Cargo.toml
├── scripts/copy-node.js     # 打包前复制本机 Node 二进制
├── .github/workflows/       # GitHub Actions（Windows / macOS 构建）
└── package.json
```

---

## 🚀 快速开始

### 环境要求

- **Node.js** ≥ 20（推荐 22 LTS）
- **pnpm** ≥ 9
- **Rust** 稳定版工具链（含 Cargo）
- 各平台 Tauri 系统依赖（参考 [Tauri 官方前置条件](https://tauri.app/start/prerequisites/)）

### 安装依赖

项目使用了私有 npm 包 `@ycwang-dev/*`（托管在 GitHub Packages），安装前需配置可访问的 Token：

```bash
# 设置 GitHub Packages 访问 Token（用于 @ycwang-dev 私有包）
export GITHUB_TOKEN=<your_github_token>

pnpm install
```

> `.npmrc` 已将默认源指向 npmmirror 镜像，并把 `@ycwang-dev` 作用域指向 `npm.pkg.github.com`，因此必须提供 `GITHUB_TOKEN`。

### 开发调试

```bash
pnpm dev
```

该命令会：先执行 `copy-node.js --dev`（开发模式跳过二进制拷贝），再启动 `tauri dev`，前端运行在 `127.0.0.1:1420`，内嵌服务优先运行在 `:3101`，端口冲突时由 Tauri 动态分配。

仅调试前端（不启动桌面外壳）：

```bash
pnpm frontend:dev
```

如需在纯浏览器调试本地-only接口（例如数据库恢复到本机服务），显式配置 `VITE_LOCAL_SERVER_URL=http://127.0.0.1:<port>`；桌面端运行时不需要该配置。

类型检查：

```bash
pnpm typecheck
```

### 打包构建

```bash
pnpm build
```

将依次复制本机 Node 二进制 → 构建前端 → 执行 `tauri build`，产物位于 `src-tauri/target/release/bundle/`（macOS `.dmg`/`.app`、Windows `.exe`/`.msi`）。

---

## ⚙️ 配置说明

服务端配置集中在 `server/config/constants.mjs`，支持通过系统环境变量或项目根目录的 `.env` / `.env.local` 覆盖（系统环境变量优先级最高）。常用项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3100` | 独立启动 Node 服务时的默认端口；桌面端由 Tauri 注入实际端口 |
| `TEMPLATE_REPO_URL` | 内网模板仓库 | 脚手架模板仓库地址 |
| `TEMPLATE_BRANCH` | `template` | 模板分支 |
| `TEMPLATE_REPO_PATH` | `/opt/template` | 模板本地缓存路径（打包后由 Tauri 指向 appData） |
| `GITLAB_HOST` | 内网 GitLab | GitLab 服务地址 |
| `GITLAB_TOKEN` | 空 | GitLab 访问 Token（创建仓库 / 推送所需） |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | `yuyan-ops` / … | Git 提交身份 |
| `DEPLOY_DATA_DIR` | `.yuyan-deploy` | 部署数据目录（SQLite / 日志 / 备份） |
| `APP_UPDATE_CACHE_DIR` | `${DEPLOY_DATA_DIR}/app-update-cache` | GitHub Release 安装包的内网缓存目录 |
| `APP_UPDATE_PRELOAD_INTERVAL_MS` | `300000` | 中央 API 主动检查并预热最新安装包的间隔（最低 60 秒） |
| `APP_UPDATE_PRELOAD_INITIAL_DELAY_MS` | `2000` | 中央 API 启动后首次预热的延迟 |
| `DEPLOY_SECRET_KEY` | 本地默认值 | **部署凭据加密密钥，生产务必显式配置** |
| `DEPLOY_RECORD_KEEP_PER_PROJECT` | `20` | 每个项目保留的发布记录数 |
| `DEPLOY_BACKUP_KEEP_PER_TARGET` | `8` | 每个目标保留的远端备份版本数 |

> 打包运行时，Tauri 会自动把部署数据目录与模板缓存目录指向应用数据目录（appData），并注入 `DEPLOY_SECRET_KEY`、动态 `PORT` 等环境变量（见 `src-tauri/src/lib.rs`）。本地服务启动以 `/health` 作为健康检查，不依赖固定 sleep。

---

## 🔌 内嵌服务 API 概览

独立 Node 服务默认以 `http://localhost:3100` 暴露；桌面端实际地址由 Tauri 命令返回。主要路由：

- `GET  /health` —— 健康检查
- `POST /scaffold-api/create` —— 创建微应用（`?stream=1` 走 NDJSON 流式进度）
- `GET  /scaffold-api/download/:appName/:timestamp` —— 下载生成的项目压缩包
- `POST /scaffold-api/ops/backfill-topics` —— 批量补打 `yuyan-ops` 标签
- `/deploy-api/servers` · `/targets` · `/records` · `/nginx-instances` · `/nginx-runtime` 等 —— 服务器、部署目标、发布记录、Nginx 实例 / 运行时的增删改查与发布、回滚、Nginx 测试、数据库备份恢复等
- `/deploy-api/app-update/check`、`/deploy-api/app-update/tauri/:target/:arch/:currentVersion`、`/deploy-api/app-update/cache-status`、`/deploy-api/app-update/download-asset`、`/app-updates/*` —— 桌面端更新检测、Tauri 签名清单、缓存准备状态和内网 Range 下载

中央 API 会在启动后主动预热 macOS ARM、macOS Intel 和 Windows 安装包及签名 Updater 资源。同一 GitHub Asset 只允许一个回源任务，失败可从稳定 `.part` 文件续传，校验大小、SHA-256 与安装包格式后原子落盘。新客户端携带 `updaterCapable=1`，下载 `.app.tar.gz` 或签名 NSIS，安装前再次执行 Minisign 验签，再由 Tauri Updater 覆盖当前应用并自动重启；旧客户端仍获得 DMG/EXE 并保留原协议。中央 API 必须配置只读 `GITHUB_TOKEN`，缓存目录应挂载到持久卷。

---

## 🤖 持续集成

`.github/workflows/build-tauri.yml` 在指定分支推送或手动触发时，于 Windows、macOS ARM 与 macOS Intel runner 完成 Rust / Node 环境准备、依赖安装与 `pnpm run build`，发布 DMG/EXE、签名 Updater 资源和 `latest.json`。CI 通过 `PERSONAL_ACCESS_TOKEN` 拉取私有包；正式构建还必须配置与客户端内置公钥匹配的 `TAURI_SIGNING_PRIVATE_KEY`（可选密码使用 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）。流水线会用生成的产物反向验证公私钥匹配，错误密钥会阻止 Release。

更新能力发布时必须先把服务端签名清单与缓存逻辑部署到 `yuyan-3.0`，再发布包含新客户端逻辑的桌面版本。首次从旧客户端迁移到该版本可能仍需按旧流程安装一次；此后版本即可在应用内完成覆盖并自动重启。

---

## ❓ 常见问题

- **启动提示「未检测到本地 Node.js 环境」**：开发模式下应用使用系统 Node，请确保 `node` 在 PATH 中；打包版本会内置 Node 二进制，一般无需额外安装。
- **`pnpm install` 报 401 / 找不到 `@ycwang-dev/*`**：未配置 `GITHUB_TOKEN`，或 Token 无 `read:packages` 权限。
- **创建微应用失败**：检查 `GITLAB_TOKEN`、模板仓库地址与网络连通性（启动日志会给出对应提示）。

---

## 📄 许可

私有项目，仅供内部使用。
