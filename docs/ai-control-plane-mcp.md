# 雨燕 AI 控制平面与 MCP

## 定位

Codex、Cursor、Antigravity 负责理解当前代码仓库、选择雨燕工具和规划操作；雨燕负责凭据、配置、审批、执行、进度、验证和审计。MCP Sidecar 不保存 GitLab Token、SSH 密码、私钥、Nacos 凭据或中央 API Token，也不内置模型。

## 运行链路

```text
Codex / Cursor / Antigravity
          │ stdio MCP
          ▼
雨燕可执行文件 --mcp
          │ 运行时描述文件 + 每次启动令牌
          ▼
127.0.0.1:<dynamic>/agent-api/v1
          │
          ├─ 项目真实路径与精确授权
          ├─ 中央配置 / 本机执行分流
          ├─ 短期计划、审批、幂等和任务状态机
          ├─ 既有脚手架 / 部署 / SSH / Nginx / OpenAPI
          └─ SQLite + HMAC 审计链
```

Tauri 启动内嵌 Node 服务后，在应用数据目录原子写入 `agent-runtime.json`，Unix 权限为 `0600`。字段包含 `schemaVersion、appVersion、pid、port、sessionToken、startedAt`；会话令牌每次桌面端启动轮换，退出时删除描述文件。Sidecar 会同时校验 PID、描述结构、令牌和 Gateway 健康状态，过期文件不会继续使用。

## 客户端安装

点击顶部平台设置图标旁的“AI 控制中心”，可对以下客户端执行安装、修复或卸载：

- Codex：`~/.codex/config.toml`
- Cursor：`~/.cursor/mcp.json`
- Antigravity：`~/.gemini/config/mcp_config.json`

修改前会创建时间戳备份。Codex 使用雨燕托管标记块，JSON 客户端只合并 `mcpServers.yuyan-mcp-server`，不会覆盖其他 MCP。三端配置均指向应用数据目录内权限为 `0700` 的稳定启动器，再传入 `--mcp --client <client>`；雨燕开发、升级或安装路径变化时只原子刷新启动器目标，不再把 `src-tauri/target/debug/yuyan-app` 固化到客户端配置。

其他客户端可在 AI 控制中心复制标准 stdio 配置。该配置只适用于同一台电脑；其他电脑必须先在当地安装雨燕。旧版直接指向可执行文件的配置会显示“需要修复”，重装后迁移到稳定启动器。

## 一期工具

| 能力 | 工具 |
| --- | --- |
| 状态与项目 | `yuyan_get_status`、`yuyan_inspect_workspace`、`yuyan_search_projects` |
| 配置查询 | `yuyan_list_deploy_servers`、`yuyan_list_deploy_targets`、`yuyan_get_deploy_history` |
| 项目配置 | `yuyan_plan_project_config`、`yuyan_apply_project_config` |
| 脚手架 | `yuyan_create_microapp` |
| 发布闭环 | `yuyan_preflight_deploy_target`、`yuyan_deploy_target`、`yuyan_rollback_deployment` |
| 运行维护 | `yuyan_get_service_status`、`yuyan_read_service_logs`、`yuyan_control_service` |
| OpenAPI | `yuyan_generate_openapi` |
| 高危删除 | `yuyan_delete_deploy_target`、`yuyan_delete_deploy_server` |
| 任务控制 | `yuyan_get_operation`、`yuyan_cancel_operation` |

所有输入都是严格 Zod Schema，未知字段会被拒绝；写工具必须提供 `idempotencyKey`。列表工具支持 `cursor、limit、responseLength`，结果同时提供 `structuredContent` 和 JSON 文本。

MCP Server 固定 instructions：先识别项目、先规划再写入、不得索取凭据、普通写操作服从雨燕自动执行策略、破坏性操作始终等待审批、长任务轮询到终态，并依据 `executionReport` 明确复述实际动作与验证结果。

## 授权与审批

首次从某客户端访问项目时，`yuyan_inspect_workspace` 会创建授权任务并聚焦雨燕。授权绑定：

- 规范化后的真实 Git 根目录；
- 脱敏后的远程仓库标识；
- MCP 客户端类型。

磁盘根目录、整个用户目录、非 Git 路径和软链接逃逸路径不能被授权。授权可随时在 AI 集成面板撤销。

风险分级：

- 查询自动执行；
- 配置写入必须先生成短期 `planId` 和差异；
- 已授权项目默认自动执行配置、建仓、发布、回滚、服务启停和 OpenAPI，也可在 AI 控制中心关闭开关并恢复逐次审批；
- 设备自动执行策略按 `accountId + deviceId` 保存，不会同步给同一账号的另一台电脑；账号可配置跨设备强制审批工具，且优先级高于设备开关；
- 删除部署目标和空闲服务器已开放，但始终人工审批，普通自动执行开关不能绕过；服务器仍被目标引用时拒绝删除，不执行隐式级联；
- 数据库恢复、任意 SSH/文件删除和读取明文凭据不向 MCP 开放。

写操作状态为 `pending_approval → queued → running → succeeded/failed/rejected/cancelled/expired`；可信项目普通操作可从创建后直接进入 `queued`。执行前会再次复核项目授权，授权撤销或仓库变化会让任务过期。审批绑定参数 SHA-256；配置计划、Commit、删除对象身份或负载变化后旧审批不能执行。等待审批超过 30 分钟会过期。任务成功结果包含统一 `executionReport`，MCP 断开或 Sidecar 重启后仍可用 operation ID 查询。

## 中央与本机分流

采用账号、设备两层身份：

- `accountId = 规范化 GitLab Host + 数字用户 ID`，不使用可改名的 username；
- `deviceId + Ed25519` 密钥对由每台设备首次启动生成，私钥、PAT、雨燕刷新令牌和本机主密钥只进入系统安全凭据库；macOS 将这些数据合并为单一钥匙串保险箱并在进程内复用，避免一次启动反复要求授权；
- 每个 GitLab 账号自动获得独立中央数据空间，不要求额外绑定 GitLab Group；
- 同一账号多设备共享中央配置、目标与历史，但绝对目录、项目授权、构建缓存、OpenAPI 产物索引和自动执行开关按设备隔离；
- 同一系统账号切换 GitLab 用户时，授权、计划、任务、策略和本机审计按账号完全隔离。

AI 集成面板只把短期会话、当前身份和账号审批策略同步到内嵌服务内存：

- 服务器、目标、环境、发布历史与中央操作均按账号隔离空间过滤；数据库继续复用 `team_id` 列以兼容旧库，但不再暴露团队产品概念；
- 前端发布在中央服务执行；
- 后端在设备使用当地 JDK/Maven 构建，上传 Jar 分块并校验 SHA-256，再由中央读取账号空间内的 SSH/Nacos 凭据完成部署、健康检查和回滚；
- OpenAPI 在设备生成，中央不接收绝对路径和本机 JDK 目录；
- 两台设备对同一部署目标的活动任务由中央唯一锁串行化；
- 中央会话或账号审批策略不可验证时失败关闭，只允许项目识别、本地授权/任务查询和安全取消，不执行离线写入或发布。

中央只保存访问/刷新令牌摘要，不保存 GitLab PAT；PAT 仅在登录换票时用于验证 GitLab 账号。SSH、Nacos 和私钥不下发设备。MCP 请求、operation payload、结果、阶段日志和审计正文均进行深度脱敏。

中央身份与部署接口包括：

- `POST /api/v2/auth/gitlab/exchange`、`/auth/refresh`、`/auth/logout`；
- `GET /api/v2/me`、`GET /api/v2/me/devices`、`DELETE /api/v2/me/devices/:deviceId`；
- `GET|PUT /api/v2/me/approval-policy`、`GET /api/v2/me/audit`；
- `POST /deploy-api/v2/artifact-jobs`、分块上传、finalize、operation 查询与取消。

旧中央 SQLite 整库下载/恢复能力已禁用。首次 v5 迁移会保留 `.pre-multitenant-v5-*.bak`，旧本机授权进入 `legacy-disabled`；旧中央数据自动归入首个账号的兼容隔离空间并保持可写，后续账号自动创建各自独立空间。

## 审计

审计记录包含客户端、项目、工具、风险、参数摘要哈希、审批人、执行位置、结果、错误和时间。每条记录使用上一条哈希与稳定 JSON 正文计算 HMAC-SHA256，AI 集成面板实时显示审计链完整性；检测到篡改时应停止外部 Agent 操作并保留数据库用于调查。

## 开发与验证

```bash
pnpm mcp:build
pnpm test:mcp
pnpm test:server
pnpm test:central-url
pnpm typecheck
pnpm frontend:build:ci
cd src-tauri && cargo fmt --check && cargo check && cargo test --all-targets
```

`mcp:build` 会先 TypeScript 编译，再由 `scripts/bundle-mcp.mjs` 将 `@modelcontextprotocol/sdk` 等依赖打进单个 `mcp/dist/index.js`，确保安装包不依赖额外 `node_modules`。CI 在 macOS 产物上会执行 `scripts/verify-packaged-mcp.mjs` 冒烟。

`test:mcp` 覆盖 20 个严格 Schema、破坏性标注、写操作幂等键、stdio 初始化/工具列表/stdout 纯净，以及真实 Sidecar → 轮换令牌 → Loopback Gateway 调用。服务端测试覆盖脱敏、稳定参数哈希、真实 Git 根目录、客户端隔离授权、授权撤销阻断、自动执行、破坏性强制审批、稳定启动器、旧配置修复和 HMAC 审计篡改检测。

正式远程验收必须使用可丢弃微应用与测试服务器，按“识别 → 授权 → 规划配置 → 自动应用 → 预检 → 自动发布 → 健康/日志 → 回滚 → 人工审批删除”执行。真实删除必须由用户现场确认。

GitHub Actions 桌面包要求 `VITE_APP_SERVER_URL` 使用 HTTPS；仅回环地址与 RFC1918 私网地址允许 HTTP，公网 HTTP 或无效地址会直接终止构建。私网 HTTP 只适用于可信公司局域网或 VPN，账号换票期间的传输安全由该网络边界承担。正式包不再注入 `VITE_DEPLOY_API_TOKEN` 或测试数据库地址。中央容器必须显式提供持久的随机 `DEPLOY_SECRET_KEY`、允许来源和旧只读更新代理所需的兼容令牌。

## 一期边界

- 仅本机 stdio MCP，不提供远程多用户 Streamable HTTP；
- 不内置 LLM、RAG、长期会话记忆或自动修复；
- 只开放受管部署目标和空闲服务器删除，不开放数据库恢复、任意文件删除或任意远程命令；
- macOS ARM/Intel 与 Windows 安装包仍需在对应 CI 产物和实机上验证自动拉起及路径修复。
