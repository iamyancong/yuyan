# 进度日志

## 会话：2026-07-10

### 阶段 1：基线保护与详细设计
- **状态：** complete
- 执行的操作：
  - 读取项目 AGENTS.md、YSS UI/表格/Formily/原型/Vue3 与文件规划 Skills。
  - 审查现有部署数据库、服务、控制器、API、页面 hooks 和 Java 8 样本项目。
  - 运行现有 typecheck、服务端测试和 Node 语法检查，均通过；git diff 仅发现既有尾随空格警告。
- 创建/修改的文件：
  - task_plan.md
  - findings.md
  - progress.md

- 兼容结论：保留现有 project_type/jdk_id 等列并扩展；未暂存的依赖和 Vite 改动不覆盖。

### 阶段 2：数据迁移、类型与通用服务
- **状态：** in_progress
- 已完成：
  - 新增 backend-domain 纯领域规则：Java major、路径/端口、健康路径、服务名、日志脱敏、OpenAPI JSON 校验。
  - 新增 schema_migrations、升级前备份、backend_target_configs、server_java_runtimes、deploy_environments、backend_releases、openapi_artifacts、deploy_tasks。
  - 迁移历史后端目标，自定义命令标记为 legacy/needsReview；移除不存在的默认 JDK 占位项。
  - DeployTarget 查询已合并后端配置，新增 JDK 检测、服务状态、任务、版本和 OpenAPI 元数据存储函数。
- 创建/修改的文件：
  - server/services/backend-domain.mjs
  - server/services/deploy-store.mjs
  - server/config/constants.mjs
  - server/services/backend-project-service.mjs
  - server/services/backend-toolchain-service.mjs
  - server/controllers/deploy-controller.mjs
  - server/routes/deploy.mjs

### 阶段 3：后端发布与运行时
- **状态：** in_progress
- 已完成首版：
  - 后端发布从 deploy-service 分流到独立 runtime service，后端目标不再要求 Nginx。
  - release/current/shared/bin 目录、远程 SHA-256、PID/systemd、远程健康检查、Nacos TCP 检查、Gateway 探测、失败恢复和版本回滚。
  - 同一服务器激活队列、远程原子锁、本地构建并发上限和版本保留策略。
  - 服务 status/start/stop/restart/logs 与持久化任务接口。
- 创建/修改的文件：
  - server/services/backend-runtime-service.mjs
  - server/services/deploy-service.mjs

### 阶段 4：OpenAPI 与前端交互
- **状态：** complete
- 已完成：
  - 后端操作列新增生成 OpenAPI；前端继续显示 Nginx，后端隐藏 Nginx 操作。
  - OpenAPI 抽屉支持缓存读取、自动生成、进度日志、YMonaco JSON 只读预览、复制/全屏、取消和下载。
  - 后端配置表单补齐构建/运行 JDK、端口、PID/systemd、健康检查、Nacos、Gateway 和 OpenAPI 字段，移除任意启停命令入口。
  - 后端列表展示真实在线/离线/异常状态、直连/Gateway/Nacos 地址，并支持启停、重启和服务日志。
  - 增加 Java 环境管理抽屉，可新增/检测本机构建 JDK，扫描/检测服务器运行 JDK，并直接回填目标配置。
  - 本机 JDK 扫描扩展到 SDKMAN、jEnv、macOS 用户/系统 JavaVirtualMachines 与 JAVA_HOME；当前机器实测发现 Temurin 8 和 Oracle/OpenJDK 24 均可直接执行。
  - v3 migration 将后端目标关联到已检测的服务器 Java 运行时记录，切换服务器会清空旧运行时选择，避免只保存一段可能失效的路径。
  - 服务默认仅监听本机；非本机绑定强制 DEPLOY_API_TOKEN、非默认 DEPLOY_SECRET_KEY 和 CORS 白名单，前端请求统一携带部署令牌。

### 阶段 5：测试与验收
- **状态：** complete（本地可验证范围）
- 最终结果：
  - `pnpm typecheck` 通过。
  - `pnpm test:server` 17/17 通过。
  - `pnpm frontend:build:ci` 通过（仅保留既有大 chunk 警告）。
  - 远程模式 API 鉴权冒烟：未授权 401、允许来源 200、恶意来源 403。
  - 本机 JDK HTTP 扫描：Temurin 8 与 OpenJDK 24 均为 available。
  - Java 8 样本项目检测与用户给定 POM/bootstrap/smart-doc 配置一致。
  - 未对真实 SSH 服务器执行发布/停止/回滚；未获得可调用的内置浏览器会话，未做最终截图验收。

## 测试结果
| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| vue-tsc | 当前工作区 | 无类型错误 | 通过 | 通过 |
| server tests | 当前 7 项 | 全部通过 | 7/7 通过 | 通过 |
| node --check | 部署相关 mjs | 语法正确 | 通过 | 通过 |
| backend schema smoke | 临时 SQLite | 新表和 migration 可创建 | 6 个核心表创建成功 | 通过 |

## 错误日志
| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-07-10 | deploy-store 目标查询大补丁上下文不匹配 | 1 | 拆分为 map/list/get 三个小补丁，避免模板字符串缩进干扰 |
| 2026-07-10 | backend-runtime PID 脚本的 `${1:-status}` 被当作 JS 插值 | 1 | 转义 shell 参数，并同时修正服务器队列尾部清理比较 |
| 2026-07-10 | src/api/deploy.ts JDK 补丁未匹配实际 delete 函数 | 1 | 改为先读取尾部，再按接口和方法分别补丁 |
| 2026-07-10 | 扩展任务结果联合类型后发布进度 Hook 仍假设结果一定有 DeployRecord.id | 1 | 使用完整结果去重，并在旧发布进度 UI 中显式收窄 deploy/rollback/undoRollback |
| 2026-07-10 | PID 参数防注入测试用“文本中不出现 $()”判断，误报已被单引号安全包裹的参数 | 1 | 改为验证危险参数被逐项 shellQuote，并补齐测试 paths.root |

## 五问重启检查
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 阶段 1：基线保护与详细设计 |
| 我要去哪里？ | 完成数据/服务、运行时、OpenAPI、UI 和测试 |
| 目标是什么？ | 可安全发布并管理 Java 后端，同时生成预览下载 OpenAPI |
| 我学到了什么？ | 见 findings.md |
| 我做了什么？ | 见上方记录 |

## 会话：2026-07-13（自动更新加速）

### 阶段 7：自动更新基线与详细设计
- **状态：** complete
- 已完成：
  - 读取自动更新代理、双分支工作流和文件规划 Skills。
  - 审查现有 Vue 更新胶囊、Rust 原生下载器、内网代理缓存与 GitHub Actions。
  - 验证本机 Codex 使用 Sparkle 和 `.delta`，并核对 Sparkle/Tauri 官方能力边界。
  - 确认 Tauri 更新包验签免费，系统代码签名费用不纳入本次方案。
- 当前结论：
  - 先实施内网主动预热、单任务回源、服务端断点续传、缓存状态和客户端等待就绪。
  - 免费 Tauri Updater 只在密钥与兼容迁移条件可安全闭环时启用，不创建明文或不受控私钥。
  - 已确定新增独立缓存服务，并由服务器 bootstrap/shutdown 管理中央预热调度器；Tauri 内嵌服务不启动调度器。

### 阶段 8：服务端主动预热与单任务缓存
- **状态：** complete
- 已完成：
  - 新增 `app-update-cache-service.mjs`，实现单任务 Map、稳定断点文件、Range/If-Range、重试、进度、校验和原子落盘。
  - 新增 `app-update-release-service.mjs`，中央 API 定时查询最新 Release 并预热三个受支持平台。
  - 更新 check 响应，返回缓存状态和状态查询地址；新客户端使用 `cacheAware=1` 能力参数。
  - 下载接口优先发送缓存；缓存未就绪时新客户端收到 202，旧客户端等待短时间后保留实时代理兼容。
  - 将主动预热调度器接入服务器 bootstrap/shutdown，Tauri 内嵌服务不启动。
  - 新增缓存服务单测，覆盖资源规范化、Content-Range、EXE/DMG 格式、单任务并发、服务端断点续传和损坏缓存回源。

### 阶段 9：客户端缓存就绪交互
- **状态：** complete
- 已完成：
  - 更新检查请求声明 `cacheAware=1`，接收缓存状态、进度、速度、剩余时间与状态地址。
  - 更新胶囊增加 `preparing` 状态并独立轮询服务器；ready 后恢复可点击下载。
  - 保留原生 Rust 下载器的客户端 Range、If-Range、暂停恢复、重试、大小/SHA-256、格式校验和安装退出链路。
  - 补齐组件卸载时首次检查延时器与缓存轮询清理。

### 阶段 10：免费验签更新评估
- **状态：** complete（安全可实施范围）
- 结论：
  - Tauri Updater 的资源验签不收费，但必须长期保管稳定私钥，并在构建端配置 `TAURI_SIGNING_PRIVATE_KEY`；该校验不能关闭。
  - 仓库已有 Updater 依赖、权限、动态清单接口和签名资源整理脚本，但当前无稳定公私钥、无签名环境变量，也无可操作 GitHub Secrets 的 `gh` 工具。
  - 未生成无人托管私钥、未写入占位公钥、未开启会导致 CI 失败的 `createUpdaterArtifacts`；不影响本次免费缓存加速落地。

### 阶段 11：验证与交付
- **状态：** complete
- 最终结果：
  - 服务端全量测试 35/35 通过，包含缓存准备 `202` 与缓存就绪 Range 文件响应测试。
  - `vue-tsc --noEmit` 通过。
  - Vite 生产构建通过，仅有既有大 chunk 提示。
  - Rust 原生层测试 7/7 通过，仅有既有 `objc` 宏 cfg 警告。
  - `git diff --check` 通过；未修改 GitHub Actions 发布职责，未提交或推送。
