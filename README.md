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
| 🤖 AI 控制平面 | 顶部 AI 控制中心 | Codex、Cursor、Antigravity 通过本地 stdio MCP 调用雨燕，支持可信项目自动执行、配置差异、发布、回滚、服务控制、受审批删除、任务进度与审计。 |

### 功能亮点

- **脚手架流式创建**：通过 NDJSON 流实时回传创建进度（拉取模板 → 变量替换 → Git 初始化 → 推送 → GitLab 建仓），失败可定位到具体阶段。
- **一键发布到独立服务器**：本地构建 → SSH 上传 → 写入/更新 Nginx 配置 → 测试并 reload，支持 `cleanReplace` / `overlayKeepAssets` 两种上传策略与依赖缓存加速。
- **版本备份与回滚**：每次发布在远端保留历史版本，支持回滚与「撤销回滚」，回滚记录可追溯。
- **托管式 Nginx 运行时**：内置多平台 Nginx 运行时资源（`server/assets/nginx-runtime`），可在目标服务器上自动初始化、启动 / 停止 / 重载，无需服务器预装 Nginx。
- **中央部署数据**：服务器 SSH 密码 / 私钥在中央 SQLite 加密保存；服务器、目标、环境和发布历史以中央共享工作区为准，不再通过整库备份/恢复同步到客户端。
- **明暗主题**：内置主题切换，macOS 下同步切换 Dock 图标。
- **MCP 安全执行闭环**：外部 Agent 负责理解和规划；雨燕保管凭据并执行受控动作，写操作使用差异预览、参数哈希审批、幂等任务和 HMAC 审计链。

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
│  · @yss-ui/*      业务组件  │   │  · /health        健康检查    │
└───────────────────────────┘   │  · SQLite 持久化 / SSH 操作   │
                                 └───────────────────────────┘
```

安装后的雨燕可执行文件同时支持 `--mcp` stdio 模式。Sidecar 根据运行时描述文件连接仅监听 `127.0.0.1` 的 `/agent-api/v1`，雨燕未运行时会自动拉起桌面端。详细架构、工具目录、安全边界和验收方法见 [AI 控制平面与 MCP 文档](docs/ai-control-plane-mcp.md)。

- 前端构建产物（`dist/`）由 Express 静态托管；桌面端由 Tauri 注入本地服务端口，优先使用 `127.0.0.1:3101`，冲突时动态分配。
- 打包时通过 `scripts/copy-node.js` 将本机 Node 二进制复制进 Tauri 资源目录，保证用户机器无需另装 Node 即可运行（开发模式直接使用系统 Node）。macOS 免费发布采用 ad-hoc 签名，不依赖 Apple Developer 付费证书；首次打开时可能需要右键选择“打开”。

### 技术栈

**前端**
- Vue 3.5（`<script setup>` + TypeScript）
- Vite 7 + vue-tsc
- Vue Router 4（Hash 模式）
- Ant Design Vue 4 / vxe-pc-ui 4
- `@yss-ui/components`、`@yss-ui/hooks`、`@yss-ui/utils`、`@yss-ui/theme`（企业级通用组件库）
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
├── mcp/                     # TypeScript stdio MCP Sidecar、严格 Schema 与协议测试
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

```bash
pnpm install
```

### 开发调试

```bash
pnpm dev
```

该命令会：先执行 `copy-node.js --dev`（开发模式跳过二进制拷贝），再启动 `tauri dev`，前端运行在 `127.0.0.1:1420`，内嵌服务优先运行在 `:3101`，端口冲突时由 Tauri 动态分配。

仅调试前端（不启动桌面外壳）：

```bash
pnpm frontend:dev
```

如需在纯浏览器调试设备专属接口（例如本机 JDK、设备构建/OpenAPI 缓存或文件另存），显式配置 `VITE_LOCAL_SERVER_URL=http://127.0.0.1:<port>`；桌面端运行时不需要该配置。

类型检查：

```bash
pnpm typecheck
```

MCP 构建与协议测试：

```bash
pnpm mcp:build
pnpm test:mcp
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
| `DEPLOY_SECRET_KEY` | 本机随机生成 | macOS 从应用本地加密保险库读取，Windows 从 Credential Manager 读取；非本机中央服务必须显式配置独立随机密钥，否则拒绝启动 |
| `DEPLOY_RECORD_KEEP_PER_PROJECT` | `20` | 每个项目保留的发布记录数 |
| `DEPLOY_BACKUP_KEEP_PER_TARGET` | `8` | 每个目标保留的远端备份版本数 |

> 打包运行时，Tauri 会自动把部署数据目录与模板缓存目录指向应用数据目录（appData），从平台安全存储读取每设备主密钥并注入 `DEPLOY_SECRET_KEY`，同时注入动态 `PORT`（见 `src-tauri/src/lib.rs`）。macOS 使用 AES-256-GCM 加密的应用本地保险库，Windows 继续使用 Credential Manager；源码和正式桌面包不包含共享默认密钥。

---

## 🔌 内嵌服务 API 概览

独立 Node 服务默认以 `http://localhost:3100` 暴露；桌面端实际地址由 Tauri 命令返回。主要路由：

- `GET  /health` —— 健康检查
- `POST /scaffold-api/create` —— 创建微应用（`?stream=1` 走 NDJSON 流式进度）
- `GET  /scaffold-api/download/:appName/:timestamp` —— 下载生成的项目压缩包
- `POST /scaffold-api/ops/backfill-topics` —— 批量补打 `yuyan-ops` 标签
- `/api/v2/*` —— GitLab 身份换票、设备签名刷新、设备撤销、账号跨设备审批策略与集中审计
- `/deploy-api/v2/*` —— 使用短期雨燕令牌和账号隔离上下文的中央部署接口；后端产物支持分块断点上传与中央部署
- `/deploy-api/servers` · `/targets` · `/records` 等 —— 本机领域接口；远程旧共享 Token 接口仅保留只读兼容，数据库备份/恢复已禁用
- `/deploy-api/app-update/check`、`/deploy-api/app-update/tauri/:target/:arch/:currentVersion`、`/deploy-api/app-update/cache-status`、`/deploy-api/app-update/download-asset`、`/app-updates/*` —— 桌面端更新检测、Tauri 签名清单、缓存准备状态和内网 Range 下载
- `/agent-api/v1/*` —— 仅雨燕桌面端启用的 Loopback Agent Gateway；必须使用本次启动会话令牌，禁止作为普通 HTTP API 或远程多用户接口暴露

中央 API 会在启动后主动预热 macOS ARM、macOS Intel 和 Windows 安装包及签名 Updater 资源。同一 GitHub Asset 只允许一个回源任务，失败可从稳定 `.part` 文件续传，校验大小、SHA-256 与安装包格式后原子落盘。新客户端携带 `updaterCapable=1`，下载 `.app.tar.gz` 或签名 NSIS，安装前再次执行 Minisign 验签，再由 Tauri Updater 覆盖当前应用并自动重启；旧客户端仍获得 DMG/EXE 并保留原协议。中央 API 必须配置只读 `GITHUB_TOKEN`，缓存目录应挂载到持久卷。

---

## 🤖 持续集成

`.github/workflows/build-tauri.yml` 在指定分支推送或手动触发时，于 Windows、macOS ARM 与 macOS Intel runner 完成 Rust / Node 环境准备、依赖安装与 `pnpm run build`，发布 DMG/EXE、签名 Updater 资源和 `latest.json`。CI 通过 `PERSONAL_ACCESS_TOKEN` 拉取私有包；正式构建必须配置与客户端内置公钥匹配的 `TAURI_SIGNING_PRIVATE_KEY`（可选密码使用 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）。该密钥只用于免费的 Tauri Updater 产物验签，不需要 Apple Developer 或 Windows 商业代码签名证书。流水线会用生成的产物反向验证公私钥匹配，错误密钥会阻止 Release。

更新能力发布时必须先把服务端签名清单与缓存逻辑部署到 `yuyan-3.0`，再发布包含新客户端逻辑的桌面版本。首次从旧客户端迁移到该版本可能仍需按旧流程安装一次；此后版本即可在应用内完成覆盖并自动重启。

---

## ❓ 常见问题

- **启动提示「未检测到本地 Node.js 环境」**：开发模式下应用使用系统 Node，请确保 `node` 在 PATH 中；打包版本会内置 Node 二进制，一般无需额外安装。
- **macOS 每次启动都要求授权钥匙串**：新版本不再访问 macOS 钥匙串，账号、设备私钥和本机数据库密钥改存应用数据目录中的 AES-256-GCM 加密保险库，因此不会再出现该授权弹窗。首次从旧版升级需要重新登录一次；已保存的 SSH、Nacos 等本机敏感配置因旧主密钥无法在不触发钥匙串的前提下恢复，需要重新录入。旧钥匙串项目不会被自动读取或删除，便于必要时回退旧版本。
- **免费 macOS 包首次无法直接打开**：由于采用 ad-hoc 签名且不做 Apple 公证，首次安装可能被 Gatekeeper 拦截。请在 Finder 中右键应用选择“打开”并确认；之后普通启动即可。Windows 用户仍直接安装 EXE，无需配置任何 GitHub Secret。
- **本地保险库的安全边界**：保险库密文、随机密钥和目录分别限制为当前系统用户可访问；它能避免明文落盘和普通误读，但不能抵御已经取得同一系统用户权限的恶意程序。高安全环境仍建议使用付费系统代码签名与企业设备管理。
- **创建微应用失败**：检查 `GITLAB_TOKEN`、模板仓库地址与网络连通性（启动日志会给出对应提示）。

---

## 📄 许可

私有项目，仅供内部使用。
