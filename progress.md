# 进度日志

## 会话：2026-07-21（可信项目免审批、删除工具与稳定启动器）

### 阶段 54：可信项目策略与路径基线
- **状态：** complete
- 已重新读取 MCP Builder、Vue3 Best Practices、原型验收与文件规划 Skills，并恢复现有 AI 控制平面上下文。
- 已将截图整理为四类验收：普通操作免审批开关、破坏性动作强制审批、任务结构化执行说明、通用 stdio 稳定 command 路径。
- 当前安全决策：默认免审批仅适用于授权仍有效且绑定 workspace 的非破坏性操作；受管目标/服务器删除始终人工确认，服务器存在引用时默认拒绝级联删除。
- 已完成 operation 状态机、授权验证、客户端配置生成、部署删除 API 与测试基线核对。

### 阶段 55：策略状态机与破坏性工具
- **状态：** complete
- 已实现默认开启的可信项目自动执行策略；普通任务自动批准，实际运行前再次校验授权，删除操作不受该开关影响。
- 已新增部署目标和空闲服务器删除工具，强制名称/身份摘要、幂等键、人工审批、依赖复核和 HMAC 审计。
- 已为所有成功写任务生成统一 `executionReport`，MCP 与雨燕任务列表均可明确展示实际动作和验证结果。

### 阶段 56：稳定启动器与控制中心交互
- **状态：** complete
- 客户端配置改为应用数据目录稳定启动器；启动器原子刷新、Unix 权限 `0700`，支持空格/中文路径和已安装版兜底候选。
- AI 控制中心新增默认开启的自动执行开关、高危删除说明、同机配置限制、开发态转发提示和执行回执展示。

### 阶段 57：边界测试与交付
- **状态：** complete
- `pnpm typecheck`、MCP 5/5、服务端 51/51、`pnpm frontend:build:ci`、Rust fmt/check/test（10/10）通过；仅保留既有大 chunk 与 Objective-C cfg 警告。
- 额外覆盖授权撤销阻断、服务器引用拒删、删除名称错配、旧直连配置修复、路径含空格、启动器权限和可执行文件缺失。
- 桌面窗口自动读取连接超时，未完成新界面的自动截图；真实远程删除未执行，必须在可丢弃测试环境由用户现场确认。


## 会话：2026-07-20（雨燕 AI 控制平面与 MCP 一期）

### 阶段 48：AI 控制平面基线与契约
- **状态：** complete
- 已读取 MCP Builder、Vue3 Best Practices 与文件规划 Skills，并将一期拆分为网关安全、MCP/Tauri、UI 安装审批、测试文档和全量验证五个交付阶段。
- 已确认本轮只做增量实现，不触碰用户已暂存的 `src/components/AppSplash/style.less`，不执行 commit 或 push。
- 当前正在核对内嵌服务、部署领域函数、Tauri 子进程生命周期和设置页结构，随后落地可持久化且可审计的外部 Agent 闭环。

### 阶段 49：Agent Gateway、安全存储与异步任务
- **状态：** complete
- 新增仅在 Tauri 子进程和有效启动令牌下可用的 `/agent-api/v1`；普通部署 API 的 Loopback 免鉴权规则不会扩散到 Agent Gateway。
- 新增独立 Agent SQLite，保存真实项目授权、15 分钟配置计划、幂等 operation、阶段日志与 HMAC-SHA256 审计链；审批 30 分钟过期，应用重启会安全终止未完成任务。
- 外部 Agent 不接触凭据；执行器在雨燕内部复用现有脚手架、中央配置、前后端发布、回滚、服务和 OpenAPI HTTP 领域接口。

### 阶段 50：MCP Sidecar 与 Tauri `--mcp`
- **状态：** complete
- 使用 `@modelcontextprotocol/sdk` 1.29.0 与 Zod 3.25.76 实现 18 个严格输入工具，同时返回 `structuredContent` 与兼容 JSON 文本。
- Tauri 增加 `--mcp` 分流、内嵌 Node/Sidecar 定位、每次启动 64 字符令牌、`0600` 原子运行时描述文件和退出清理。
- Sidecar 会校验描述文件、PID、令牌与 Gateway 健康状态，雨燕未运行时自动拉起；实际 debug 二进制 `--mcp` 工具列表冒烟返回 18。

### 阶段 51：AI 集成设置、安装与审批界面
- **状态：** complete
- 平台设置新增 AI 集成模块，覆盖三客户端安装/修复/卸载、标准 stdio 配置复制、任务进度、项目授权撤销和审计链状态。
- 新增全局 Trust Gate 审批弹窗，Sidecar 请求授权或写操作时会聚焦雨燕；批准后后台执行，MCP 通过 operation ID 查询。
- 客户端配置修改前备份并原子替换；Codex 使用托管 TOML 块，Cursor/Antigravity 只合并雨燕 Server，不覆盖用户其他 MCP。

### 阶段 52：自动化测试与接入文档
- **状态：** complete
- MCP 5/5 通过：严格 Schema、幂等键、stdio 初始化、18 工具列表、stdout 纯净以及真实 Sidecar → 轮换令牌 → Loopback Gateway。
- Agent 领域测试 3/3 通过：稳定参数哈希、深度脱敏、真实 Git 根目录、客户端隔离授权、幂等任务和审计篡改检测。
- 已补充 README 与 `docs/ai-control-plane-mcp.md`；当前继续执行完整服务端、前端、Rust 与 diff 验证。
- 新增模拟领域执行回归，覆盖配置创建、发布成功、构建失败、审批负载篡改失效、取消、回滚、服务 restart 和 OpenAPI。
- 新增三客户端安装测试，确认保留已有 MCP、创建备份、修复后状态、精准卸载以及损坏 JSON 拒绝覆盖。

### 阶段 53：全量验证与交付
- **状态：** complete
- 项目脚本最终通过：`pnpm test:mcp` 5/5、`pnpm test:server` 48/48、`pnpm typecheck`、`pnpm frontend:build:ci`。
- Rust 最终通过：`cargo fmt --check`、`cargo check`、`cargo test --all-targets`，10/10；仅保留既有 Objective-C 宏 `unexpected cfg cargo-clippy` 警告。
- debug 雨燕二进制使用 `--mcp --client generic` 完成真实 stdio 初始化和工具列表冒烟，返回 18 个工具；Vite 构建完成 8023 modules，仅保留既有大 chunk 警告。
- 最终凭据审计将脚手架请求日志接入统一深度脱敏器，避免 Agent 内部注入的 GitLab Token 进入控制台；修正后服务端 48/48 与 MCP 5/5 再次全量通过。
- `git diff --check` 通过；本轮未修改、撤销或重新暂存用户已有 `src/components/AppSplash/style.less`，未 commit、未 push。
- 真实远程发布和回滚未在生产/未知服务器执行；必须由用户提供可丢弃项目和测试服务器，并在雨燕审批界面现场确认。macOS Intel、Windows 安装包的自动拉起与路径修复保留到对应 CI 产物和实机验收。


## 会话：2026-07-17（Windows 控制台闪窗治理）

### 阶段 45：Windows 控制台闪窗基线与调用面盘点
- **状态：** complete
- 已确认 release 主进程本身已配置 Windows GUI 子系统；问题来自后台启动的 Node、taskkill、Git、Java、Maven、npm 和 zip 等控制台程序。
- 启动路径会执行 Node 版本与 `node:sqlite` 检查、启动 Node 服务，系统信息查询又会重复检查；本地服务失败重试会进一步放大闪窗次数。
- 已完成 Rust 与 `server/` 运行时子进程调用点盘点，确定统一隐藏窗口且保留 stdout/stderr、退出码和现有日志。

### 阶段 46：后台子进程无窗口治理
- **状态：** complete
- Rust 层已为 Node 版本检查、`node:sqlite` 检查、内嵌服务启动和 `taskkill` 统一应用 Windows `CREATE_NO_WINDOW`，stdout/stderr 管道保持不变。
- Node 层新增统一后台进程选项，覆盖 Git、Java、Maven/构建 shell、npm/脚手架和 zip 调用；模板同步改用参数化 `execFile('git', args)`，不再隐式创建 `cmd.exe`。
- 调用点复查确认：剩余 `deploy-store` 的 `execSync` 仅在 macOS 分支调用，`explorer.exe` 属于用户主动打开的 GUI 程序，均不是 Windows 控制台闪窗来源。
- 当前工作区基线干净，分支为 `feat/github-actions-build`；本次不修改版本号、Updater 配置或发布流程。

### 阶段 47：构建验证与 Windows 验收边界
- **状态：** complete
- `cargo fmt --check`、`cargo check`、`cargo test --all-targets` 通过，Rust 10/10；仅保留既有 `objc` cfg 警告。
- 服务端测试 41/41、相关 MJS 语法检查、Vue 类型检查和 Vite 生产构建通过；构建完成 8007 modules，仅保留既有大 chunk 警告。
- Windows target 最小 Rust 编译已通过，确认 `CommandExt::creation_flags(CREATE_NO_WINDOW)` 可编译；完整 Windows 交叉检查在 macOS 上因 `ring` 缺少 MSVC `assert.h` 失败，与本次代码无关。
- `git diff --check` 与运行时子进程调用点审计通过。真实 Windows 安装/首次启动仍需用下一份 Windows 包确认：无黑色控制台闪现、内嵌服务正常启动、模板同步和构建日志仍可见。
- 本轮未修改版本号，未执行真实发布，未 commit、未 push。

## 会话：2026-07-17（yuyan-app 专用签名密钥与双分支发布）

### 阶段 41：生成 yuyan-app 专用 Updater 密钥
- **状态：** complete
- 用户已明确授权生成专用密钥并一次性完成 GitHub Secrets、CI 验签和双分支推送。
- 安全约束：私钥与密码不写入仓库、命令输出或对话；密码保存到 macOS 钥匙串，GitHub 仅通过受保护的 Actions Secrets 接收。
- 当前客户端提交 `5965417` 已推送；`yuyan-3.0` 的首版同步提交 `75b39c2` 仍只在独立 worktree，本轮会在新公钥确定后补齐并推送。
- CI #127 因缺少私钥 Secret 失败；#128 使用旧本机 VPN 私钥启动，但该私钥需要未知密码且公钥不匹配，因此不作为正式发布依据。
- 已生成 `~/.tauri/yuyan-app-updater.key` 与 `.pub`，私钥权限为 `0600`，随机密码已保存到 macOS 钥匙串服务 `cn.yuyan.ops.tauri-updater`。
- 专用公钥 key id 为 `66E369E53B493EDA`；已更新客户端配置，并对本地 `.app.tar.gz` 完成真实签名，CI 同款 Rust 校验程序返回 `Updater signature matches configured public key`。
- 首次使用 GNU 风格 `base64 --decode <file>` 被 macOS BSD base64 拒绝；已改用 `base64 -D -i` 完成公开 key id 核对。

### 阶段 42：配置 GitHub Actions Secrets 与客户端公钥
- **状态：** complete
- 已通过当前登录的 GitHub 会话更新 `TAURI_SIGNING_PRIVATE_KEY`，并新增 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；GitHub Secrets 列表确认两项均存在且保存成功。
- GitHub 在首次提交旧页面时短暂显示二次认证，重新进入后当前授权会话直接完成保存，因此无需用户额外输入账户密码。
- 已复核 CI #128：三平台均在 Tauri 打包签名阶段因旧 Secret 不是合法的 base64 私钥而失败；新专用私钥已替换该值并补齐密码 Secret。
- 客户端公钥修复提交 `3a48267` 已推送到 `github/feat/github-actions-build`，触发 GitHub Actions #129。

### 阶段 43：CI 与 Release 验证
- **状态：** complete
- GitHub Actions #129 的 prep、Windows、macOS ARM64、macOS Intel 与 release jobs 全部成功。
- 三个平台的 `Prepare Update Artifact` 均完成 CI 同款 Rust 反向验签，证明生成签名与客户端内置专用公钥匹配。
- 已发布 prerelease `v1.2.16`：保留 Windows EXE、macOS ARM/Intel DMG，并新增三平台 Updater、对应 `.sig` 与 `latest.json`。
- `latest.json` 版本为 `1.2.16`，包含 `darwin-aarch64`、`darwin-x86_64`、`windows-x86_64` 三个平台条目与非空签名。
- CI 自动版本提交 `52ae2c6` 已快进同步到本地主工作区，四处源码版本均为 `1.2.16`。

### 阶段 44：双分支发布闭环
- **状态：** complete
- 自动更新实现提交 `75b39c2` 与专用公钥修复提交 `392fe30` 已推送到 `origin/yuyan-3.0`。
- 内网分支相关更新测试 18/18 通过，`.github/workflows/build-tauri.yml` 保持不存在，GitLab 仍只承担 API/Web 部署职责。
- 最终进度记录使用 `[skip ci]` 提交同步两个分支；临时 worktree 在分支推送和远端核对后移除。

## 会话：2026-07-17（更新后自动替换与重启）

### 阶段 37：自动替换与重启基线对照
- **状态：** complete
- 已完成：
  - 读取自动更新代理、版本发布与文件规划 Skills，恢复既有更新方案和工作区上下文。
  - 确认工作区当前无未提交/暂存改动，分支为 `feat/github-actions-build`。
  - 将本次工作追加为阶段 37-40，目标是保留现有静默预下载与完整性校验，并补齐安装后自动替换、自动重启闭环。
- 初步对照：
  - `yuyan-vpn` 使用 Tauri 官方 Updater 的下载验签、覆盖安装与 `relaunch()`，而不是打开 DMG 后让用户拖拽替换。
  - 其配置已开启 updater artifacts、固定公钥、更新 endpoint 和重启权限；Windows 应用内更新目前仍被前端禁用。
  - `yuyan-app` 的 updater/process 依赖和权限已存在，但 updater plugin/config/签名产物未真正启用；CI 仍只发布 EXE/DMG。
  - `yuyan-app` Windows 当前仅静默启动 EXE 后退出，macOS 当前仅打开 DMG 后退出，后者正是用户仍需手动替换的直接根因。
  - 服务端和发布脚本已经预留签名 updater manifest/asset 结构；当前主要缺口在 GitHub Actions 没有生成签名产物、客户端没有初始化/调用官方 updater，以及静态 manifest 未形成发布闭环。
- 下一步：对照 `../yuyan-vpn` 与当前 `src-tauri`、更新胶囊和构建产物实现，形成平台级迁移决策后落地。

### 阶段 38：自动替换与重启方案设计
- **状态：** complete
- 已确定：
  - 保留现有内网预热、自研断点下载、SHA-256、状态持久化和胶囊交互。
  - 新客户端请求签名 updater 资产；安装前使用 VPN 项目稳定公钥执行 Minisign 验签，再交给 Tauri 官方 Updater 覆盖安装。
  - macOS 使用 `.app.tar.gz + .sig` 替换当前 App 后调用 `relaunch()`；Windows 使用签名 NSIS，由 Updater 追加更新与重启参数并安全退出。
  - GitHub Actions 生成并发布签名 updater 资源；内网 API 动态清单继续代理 GitHub Release，客户端不持有 GitHub Token。
- 签名核对：本机 VPN updater 公钥与仓库线上公钥不一致，已决定禁止用本机私钥做正式验证；实现固定使用线上公钥，并让 CI 在缺少匹配 Secret 时提前失败。
- 已补齐：通过 `updaterCapable=1` 保持旧客户端安装包协议；新客户端消费 Release `latest.json` 的签名 updater 资产；安装失败恢复 completed，成功后按平台自动重启。

### 阶段 39：实现更新后自动替换并重启
- **状态：** complete
- 计划修改：Tauri 配置/原生安装器、更新 API 与客户端状态、服务端签名资产解析/缓存/预热、GitHub Actions updater 产物和对应测试。
- 已完成首版：
  - Tauri 开启 updater artifacts、注册 updater plugin、配置已发布公钥与 Windows passive 安装模式。
  - 原生状态新增签名元数据；macOS 仅接受 `.app.tar.gz`，安装前验证 Minisign，并通过官方 Updater 覆盖后自动重启。
  - 服务端支持读取 GitHub Release `latest.json`、解析同版本同架构签名资产，并将 updater 包纳入单任务预热与缓存格式校验。
  - 新客户端通过 `updaterCapable=1` 与旧 DMG/EXE 客户端隔离；前端只有签名和资源身份均一致时才展示可安装状态。
  - GitHub Actions 增加签名 Secret 门禁、三平台 updater 产物收集、`latest.json` 生成与 Release 上传。
- 收口实现：动态 Tauri 清单同时支持内网静态 manifest 与 GitHub Release `latest.json` 回退；响应使用绝对下载 URL，新客户端缺签名时明确失败，不静默退回 DMG/手工安装路径。
- 安全门禁：CI 会用客户端内置公钥验证刚生成的 updater 产物，线上 Secret 与固定公钥不匹配时直接阻止 Release。
- 首轮验证：新增 Node/服务端测试 16/16 通过，Vue 类型检查通过；`cargo fmt --check` 仅报告 2 处测试排版差异，尚未进入 Rust 编译。

### 阶段 40：验证与交付
- **状态：** complete
- 最终验证：
  - 服务端全量测试 40/40 通过；updater manifest 生成测试 2/2 通过；相关 MJS 语法检查通过。
  - `vue-tsc --noEmit` 通过；Vite 生产构建完成（8007 modules），只保留既有大 chunk 警告。
  - `cargo fmt --check` 与 `cargo test --all-targets` 通过，Rust 更新模块 10/10；只保留既有 `objc` 宏 cfg 警告。
  - GitHub Actions YAML 解析和 `git diff --check` 通过；最终差异未包含构建过程产生的意外跟踪文件。
- 完整本地 `tauri build` 已成功生成 release 可执行文件、DMG 和 `.app.tar.gz`，随后因本机没有与配置公钥匹配的 `TAURI_SIGNING_PRIVATE_KEY` 在签名阶段按设计失败；没有使用不匹配的本机 VPN 私钥绕过验证。
- 真实签名安装/重启需在仓库配置匹配线上公钥的 GitHub Secrets 后，由三平台 CI 构建并执行新加的产物验签门禁；旧客户端首次迁移仍需手动安装一次新版本。
- 本轮按用户要求只完成方案与代码执行，未 commit、未 push，也未触发双分支发布。

## 会话：2026-07-16（侧栏减法与 Header 视觉统一）

### 阶段 33：侧栏减法与 Header 统一基线
- **状态：** complete
- 已完成：
  - 重新读取 frontend-design、文件规划技能和既有任务上下文，确认继续基于上一版侧栏增量精修。
  - 检查四张用户反馈图：选中态两端标记重复；折叠 Logo 与底部控件存在外卡片、内图标框和多层阴影叠加；Header 与侧栏底色断层明显。
  - 读取 `LayoutHeader.vue`，确认 Header 仍为纯容器底色，动作按钮还保留实时模糊与较重 C4D 阴影。
- 下一步：确立“单层光学表面”规则，精修侧栏并统一 Header 亮暗主题，然后截图复验接缝和折叠态。
- 设计基线完成：选中态去除两端标记；折叠态外层按钮/品牌卡透明化；展开态阴影降为短距离低透明度；Header 使用同源静态渐变并同步减轻内部控件阴影。
- 模块化决定：将 `LayoutHeader.vue` 的大段内联样式抽离到 `LayoutHeader/style.less`，不改 Header 业务结构和事件。

### 阶段 34：侧栏与 Header 精修实现
- **状态：** complete
- 已完成：
  - 删除菜单项模板中的右侧状态珠，以及样式中的左侧光条和对应选中动画；选中态仅保留浅紫面、轻边界、文字与图标变化。
  - 降低品牌卡、Logo 玻璃片、菜单选中面和底部折叠控件的描边强度、投影半径与透明度。
  - 折叠态品牌外卡片和底部按钮完全透明，只展示 Logo 玻璃片或折叠图标本体；悬浮不再恢复外层边框，键盘焦点转移到内层控件。
  - Header 改为与侧栏同源的紫灰静态渐变、细底边和轻内高光；同步减轻同步/设置按钮、用户胶囊和登录按钮的边框与阴影。
  - 将原 502 行 `LayoutHeader.vue` 的样式抽到 `LayoutHeader/style.less`，业务模板与事件保持不变。
- 静态验证通过：`LayoutHeader.vue` 已降至 138 行；`git diff --check`、`vue-tsc --noEmit` 和 Vite 生产构建均通过，构建仅保留既有大 chunk 警告。
- 亮色展开态浏览器验收通过：菜单两端标记均已移除，Header 高度 56px、侧栏 190px、页面无横向溢出；Header 与侧栏接缝视觉连续。
- 验收时开屏动画在两次检查之间自动结束，原“跳过开屏动画”定位数量变为 0；已按新 DOM 快照直接验收主界面，没有重试旧定位器。
- 首轮折叠态测量：外层背景/边框/阴影均为透明、侧栏 76px 且无溢出；基于截图继续将透明外层点击范围缩到 Logo 42px、折叠图标 32px，并禁用折叠品牌高光，彻底消除残余大圆角轮廓。

### 阶段 35：构建与多状态视觉复验
- **状态：** complete
- 最终折叠态截图通过：Logo 外层命中区 42×42px、底部控件 32×32px，视觉均只剩一层玻璃边界，无双圈或大圆角套壳。
- 暗色首轮截图发现 Header 仍偏亮；确认 scoped Less 全局祖先选择器未稳定命中后，改为 `useTheme` 驱动 `.is-dark` 类，复验时 Header、侧栏和内容区已统一为低光深紫黑表面。
- 已恢复亮色展开态完成最终截图：菜单左右标记均不存在，Header/侧栏接缝连续，未发现横向溢出或交互回归。
- 最终静态验证通过：`LayoutHeader.vue` 140 行；`git diff --check`、`vue-tsc --noEmit`、Vite 生产构建全部成功，构建仅有既有大 chunk 警告。
- 浏览器日志没有本轮新增错误；仅保留既有 Web 模式 Tauri 图标 API 调用失败和 GitLab 分组详情 404。
- 最终 diff 保留工作区内部署、OpenAPI、启动页等其他未提交改动，本轮未提交、未推送。

### 阶段 36：菜单图标与折叠按钮几何精修
- **状态：** complete
- 亮色菜单图标边界改为 `1px solid rgba(218, 226, 238, 0.56)`；hover 与选中态不再叠加主题紫描边。
- 折叠态按钮和内部图标补齐 `border-box`、固定最小/最大宽高与 1:1 比例，稳定为 32×32px、10px 圆角的单层方形。
- 浏览器计算样式与截图复验通过，并恢复为亮色展开状态；页面日志没有本轮新增错误。
- `git diff --check`、`vue-tsc --noEmit` 和 Vite 生产构建均通过，构建仅保留既有大 chunk 警告；未提交、未推送。

## 会话：2026-07-16（侧栏 C4D 玻璃拟态视觉升级）

### 阶段 30：侧栏品牌与菜单视觉基线
- **状态：** in_progress
- 已完成：
  - 使用 frontend-design 与文件规划技能恢复现有上下文，确认侧栏文件当前没有未提交改动，可在不覆盖其他工作区内容的前提下增量修改。
  - 读取 `LayoutSider`、`LogoSwift`、导航图标映射、主题变量与用户截图。
  - 确定视觉方向为“精密光学玻璃雨燕”：保留品牌紫色，但加入冷青高光、透明玻璃层、细密边缘光和克制的空间阴影。
  - 明确性能边界：不对整栏使用实时背景模糊，重点用静态渐变、伪元素、高光和局部阴影营造 C4D 材质。
- 下一步：实现 Logo、双层品牌文案、菜单图标座/文字和自定义折叠胶囊，并进行多状态截图验收。

### 阶段 31：侧栏视觉升级实现
- **状态：** in_progress（待静态验证）
- 已完成：
  - 将 `LogoSwift` 重绘为带主题色主体、冷青折射、玻璃切面、边缘高光和柔和投影的可缩放 SVG，并通过唯一 ID 隔离同页多实例渐变。
  - 品牌区升级为局部光学玻璃卡片，加入双层“雨燕平台 / YUYAN · OPS”字标、状态光点和立体 Logo 底座。
  - 菜单增加工作空间分区字标、独立图标玻璃座、精调字重/字距、选中边缘光与状态珠，并保留即时选中反馈链路。
  - 禁用 Ant Design 默认整宽折叠 trigger，改为自定义可聚焦玻璃胶囊，兼容展开/折叠和键盘操作。
  - 亮/暗主题均采用独立材质变量；整栏仍只使用静态渐变和局部阴影，没有恢复高成本实时模糊。
- 首轮 `git diff --check` 已通过；后续 `pnpm` 尚未执行项目编译即被系统 Node 12 拒绝，将切换到工作区新版 Node，避免重复同一环境失败。
- 工作区新版 pnpm 包装器随后在非 TTY 环境触发依赖状态检查并于清理前安全中止；没有改动依赖，后续改为直接执行现有 `vue-tsc` / `vite` 入口。
- 直接入口验证中 `vue-tsc --noEmit` 已通过；Vite 首次构建发现导入 Less 顶层裸 `&` 不能承载属性，已改为显式侧栏根选择器，待复验。
- 根选择器修复后 Vite 生产构建通过（8007 modules）；仅保留既有大 chunk 警告。`git diff --check` 与 `vue-tsc --noEmit` 均通过，阶段 31 完成。
- 视觉验收准备：1420 端口已有本地页面；bundled Python 仍缺少 Playwright，脚本在导入阶段退出、未启动浏览器。保持项目依赖不变，转用运行时现有浏览器自动化包。
- 应用内浏览器首轮不支持 `networkidle`，已改为等待 `load` + 侧栏可见；展开态截图通过，品牌、菜单和底部折叠胶囊与页面材质统一。
- 折叠交互验收通过：侧栏 76px，品牌/菜单/底部控件均 55px，无横向溢出，展开按钮可见且焦点反馈明确。
- 暗色展开态验收通过：190px 宽、58px 品牌卡片、44px 底部控件，无稳定态横向溢出；基于截图将暗色选中文字和图标提升为浅紫折射色，增强对比度。测试完成后已恢复亮色、展开态和关闭设置抽屉。
- 最终复验：`git diff --check`、`vue-tsc --noEmit`、Vite 生产构建均通过；最终构建 8007 modules，仅保留既有大 chunk 警告。
- 浏览器错误日志没有侧栏相关错误；仅有既有 Web 模式 Tauri 图标调用失败和 GitLab 分组 404。已释放测试页。
- 最终 diff 复核确认产品代码只涉及 3 个侧栏文件；没有覆盖工作区内部署、OpenAPI、启动页等其他未提交改动，未提交、未推送。

## 会话：2026-07-16（部署交互、构建日志与 JDK 架构）

### 阶段 20：四项问题基线与根因定位
- **状态：** complete（阶段 20-23）
- 已完成：
  - 读取文件规划与原型页面验收 Skill，并恢复既有规划上下文。
  - 从三张截图提取初步证据：构建失败直接原因是运行构建命令的环境找不到 `mvn`（退出码 127）；表单长 label 被省略号截断；发布历史当前为空态。
  - 建立本次视觉/交互验收清单，后续基于当前实现增量修复。
  - 查询本地 SQLite 与日志文件：本地没有截图中 14:59 的任务，确认该截图来自另一部署服务实例；本地任务与记录之间也存在 `deploy_tasks.log_path` 为空、完整日志落在 record JSON 的数据分层。
- 根因定位完成：本地目标 12 的依赖命令使用 `./mvnw`，构建命令使用裸 `mvn`；JDK 架构误用 `process.arch`。曾把中央历史空态判断为数据源选错，后续由用户明确纠正为“历史与详情必须始终走中央 API”。
- 已实现：全局同文案消息合并和最多 3 条限制；裸 `mvn` 自动切换仓库 Wrapper并补充 127 诊断；任务关联最终日志路径；Formily labelWidth 调整为 160；Java 架构改由 `os.arch` 检测并在管理抽屉展示说明。
- 第一轮验证：后端相关测试 14/14 通过，`pnpm typecheck` 通过。
- 完整服务端测试 37/37 与生产构建通过；构建仅保留既有大 chunk 和本机 `.npmrc` Token 警告。
- 首次视觉脚本未执行：系统 Python 和 Codex bundled Python 都没有 Playwright 模块；项目 API/Vite 两项服务均能正常启动。下一次改用 bundled Node 浏览器依赖，避免向项目安装测试包。
- 最终验证更新：`pnpm test:server` 38/38、`pnpm typecheck`、`pnpm frontend:build:ci` 均通过；构建仅保留既有大 chunk 和本机 `.npmrc` Token 警告。
- 本机与真实服务器 JDK 均通过 HTTP 检测：Temurin 8 x64 与 Oracle 8 x64 均为 available；同时修复属性解析误命中造成的 major 0、错误厂商和 unavailable 状态。
- Playwright 视觉验收通过：Formily 长 label 完整可见；Java 管理抽屉展示 x64/ARM64 与架构边界说明；后端历史展示本地 5 条记录，失败日志抽屉展示 stderr 与退出码，列表/详情请求均为 200。
- 未执行真实后端重新发布，避免在未获得用户明确发布授权时拉取、构建、上传并重启服务器服务；Wrapper 自动兜底已由单测覆盖。
- 用户纠正 API 边界后，已撤回发布历史/详情的本地 executionScope 参数与 Hook 分流；两者重新统一通过中央 `client` 请求，仅保留特殊后端构建与 OpenAPI 生成的既有本地执行路径。
- 纠正后复验：`pnpm typecheck`、`pnpm test:server`（38/38）和 `pnpm frontend:build:ci` 全部通过，仅保留既有大 chunk 与 `.npmrc` Token 警告。
- 新增 OpenAPI 同步后 JDK 自动修复：确认本地目标被测试环境 JDK ID 误绑到 `/tmp/placeholder-jdk-1`；同步确认流程现在先扫描本机 Java 版本并绑定匹配的 available JDK，生成服务也会校验真实 java 可执行文件并在失效时自动重扫。
- 自动修复验证完成：真实本地 API 扫描后目标 13 已由占位 JDK 14 改绑到 JDK 28（Temurin 8，`~/.sdkman/candidates/java/8.0.482-tem`），`requiredJdkAlias` 归一为 `8`。
- Playwright 在模拟“本地缺少 OpenAPI 配置、测试环境已有配置”的场景下完成两次生成调用；界面显示“配置同步成功，已自动绑定 Eclipse Adoptium 8”和“OpenAPI 生成完成”，全程未打开 Java 环境管理抽屉。
- 本轮没有执行真实 Maven/Git/SSH/OpenAPI 构建，避免未经授权拉取、构建或连接部署服务器；第二次生成使用浏览器拦截验证交互闭环，JDK 扫描与目标更新使用真实本地 API。
- 修复 OpenAPI 预览 JSON 高亮回归：确认原 `language="json"` 模型只有括号着色，key/value 均落为默认 `mtk1`；新增独立 `openapi-json` Monarch tokenizer，并对大文件首 1000 行主动 tokenization。用户现场确认高亮恢复，`pnpm typecheck` 与 `git diff --check` 通过。

## 会话：2026-07-15（左侧菜单切换性能优化）

### 阶段 17：左侧菜单切换性能基线与根因定位
- **状态：** complete（阶段 17-19）
- 已完成：
  - 读取 Vue3 Best Practices 与文件规划 Skill，并恢复既有规划记录。
  - 检查工作区状态，确认 LayoutSider、BasicLayout 等文件已有未提交改动，本次将基于现状增量处理。
  - 查看用户截图：侧栏固定、选中态明确，右侧目标页面属于包含 Hero、Tab 和表格的重页面。
- 下一步：审查布局/路由 diff 和页面生命周期，再通过本地运行时确认卡顿来源。
- 静态初步发现：页面按路由懒加载、切换期间存在全区域 loading mask、视图未缓存；侧栏当前还叠加了高成本毛玻璃滤镜。
- 根因确认：布局与侧栏各自创建独立 navigation Hook，菜单侧的 loading 状态没有消费者；选中态只能等待 `route.path` 更新，缺少即时点击反馈。
- 构建产物显示表格/组件共享依赖体积较大；部署页还同步引入全部 overlays。鉴于部署页存在轮询和订阅，暂不直接用 KeepAlive，以免引入隐藏页面后台任务。
- 基线测试首次未找到 `.scaffold-page`；核对后确认 1420 的辅助服务会话已失效，已清理失败会话，下一次改用显式纯 Vite 进程，避免重复相同失败。
- Playwright 基线完成：选中反馈 2.8–9.2 秒；各重页面存在 2–7 秒级长任务，返回已访问页面仍重复重挂载。决定组合使用乐观选中态、下一帧导航、顶层 KeepAlive 和滤镜降本。
- 已实现首版：共享导航 loading/待提交路径，菜单先绘制选中态再执行路由；全屏模糊遮罩改为合成层顶部进度条；四个顶层业务页使用 KeepAlive；部署页隐藏时暂停运行态与辅助服务轮询；侧栏移除整栏/选中项实时 backdrop-filter 并收窄 transition 属性。
- 部署页弹层进一步拆为异步 OverlayHost：默认关闭时不再加载并实例化服务器、Formily、Nginx、OpenAPI 等整组弹窗/抽屉，仅首次真正打开任一弹层时加载。
- 曾尝试菜单 hover/focus 路由预热；生产复测中首次选中被依赖解析拖到 2–6 秒，确认会与 click 抢主线程，已完整撤销该尝试。
- 最终生产 preview 性能回归：首次部署页菜单约 0.22 秒反馈、内容约 4.17 秒可见；缓存后平台应用/创建页约 0.15/0.23 秒可见，仓库列表约 0.62 秒，部署页约 1.04 秒。
- `pnpm typecheck`、`pnpm frontend:build:ci`、`git diff --check` 均通过；构建仅保留既有大 chunk 警告和本机 `.npmrc` 缺少 GITHUB_TOKEN 的警告。
- Playwright 功能验收通过：KeepAlive 保留表单输入；快速连点稳定落到最后一次导航；关闭状态 overlays chunk 未请求；导航结束进度条已清理；无 page error。最终截图视觉布局正常。
- 最终并发审查补充运行态 active guard：若部署目标首屏请求在页面 deactivated 后才返回，后续快照请求和定时器也不会被迟到结果重新启动。
- 最终 diff 审查通过：路由 hover 预热实验无残留，新增代码仅覆盖导航、布局缓存、侧栏合成成本、部署轮询生命周期和 overlays 延迟加载；既有 staged 更新/视觉改动未被回滚，未提交、未推送。

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

## 会话：2026-07-15（静默预下载与就绪安装交互）

### 阶段 12：静默更新状态机与验收设计
- **状态：** complete
- 已完成：
  - 重新读取自动更新代理与文件规划 Skills，并恢复既有任务上下文。
  - 确认现状是“服务器预热阶段立即展示胶囊、本机下载由用户点击触发、下载完成自动安装退出”。
  - 将本次工作拆为状态机设计、原生持久化、前端编排、异常交互和完整验证五个阶段。
  - 复核 Tauri 命令注册、Rust 依赖、服务端缓存协议和胶囊样式；确认原生管理器当前仅保存进程内状态。
  - 确认完整性校验已有大小、SHA-256、EXE/DMG 格式检查，但安装前只复核格式，尚未重新校验大小与摘要。
  - 确认服务端 manifest 资源天然为 ready，GitHub Release 资源通过 assetId 缓存并返回 preparing/ready/failed/missing 状态。
- 当前工作区：`git status --short` 与 `git diff --stat` 均为空，基线干净。

### 阶段 13：原生更新包持久化与版本绑定
- **状态：** in_progress
- 设计结论：
  - 原生状态增加版本、资源身份、文件名、大小、SHA-256 与 ETag，并通过缓存目录中的原子 JSON 文件持久化。
  - App 重启后 completed 仅在安装包仍存在时恢复；遗留 downloading 降级为 paused 并按 `.part` 文件长度续传。
  - 新版本与旧任务身份不一致时先清理旧资源；安装前重新执行大小、摘要和格式三重校验。
  - 客户端资源身份对 GitHub 使用 assetId，对静态 manifest 使用版本、目标和文件名生成的稳定标识。
- 已实现：
  - `AppUpdateStatus` 已扩展版本、资源身份、文件名、摘要与 ETag，并具备向后兼容反序列化。
  - 新增更新状态原子落盘、旧包清理、磁盘空间余量校验和首次访问恢复框架。
  - completed 状态恢复时会重新校验文件大小、SHA-256 和 DMG/EXE 格式；遗留断点恢复为 paused。
  - 原生管理器增加活动任务标记，旧版本下载未完成暂停持久化前拒绝清理，避免异步写回竞态。
- 验证结果：`cargo fmt --check`、`cargo check` 和更新模块测试 8/8 通过，仅保留既有 `objc` cfg 警告。

### 阶段 14：前端静默预下载编排
- **状态：** complete
- 已实现首版：
  - 自动检查发现新版本后保持胶囊隐藏；服务器缓存 ready 后自动启动本机原生下载。
  - 本机下载完成并匹配版本/资源/文件名后才展示胶囊，下载完成不再自动安装。
  - 用户点击已就绪胶囊后才调用原生安装；系统菜单“检查更新”不再意外触发安装。
  - 手动检查保留准备、下载、失败和已就绪反馈；自动失败仅记录并等待后续周期重试。
  - 胶囊文案改为 `v版本 已就绪，点击安装`，并补充键盘 Enter/Space 操作与语义标签。
- 增量验证：`pnpm typecheck` 通过；原生 `cargo fmt --check && cargo check` 通过，仅有既有 `objc` cfg 警告；`.npmrc` 缺少本机 GITHUB_TOKEN 仅产生既有 pnpm 警告。
- 交互补全：胶囊点击改为先展示版本、滚动更新说明、“稍后/立即安装”，降低误触退出风险；安装前重新校验远程版本有效性。
- Playwright 视觉与交互验收通过：胶囊仅显示 `v1.3.0 已就绪，点击安装`；Enter 可打开确认面板；版本、日志、“稍后/立即安装”可见；“稍后”可关闭。
- 前端设计规范影响：延续现有轻量玻璃胶囊，不引入新视觉体系；确认面板采用克制层级、限制日志高度并保持主题变量适配。
- 最终并发审查：前端缓存/下载轮询增加代次标识，丢弃新版本切换后的迟到结果；原生命令使用活动任务标记阻止暂停持久化窗口内重复启动。

### 阶段 15：交互文案与异常边界
- **状态：** complete
- 完成内容：
  - 胶囊只在本机包完整校验后显示 `v版本 已就绪，点击安装`。
  - 点击胶囊先查看更新日志和退出提示，再选择“稍后”或“立即安装”。
  - 服务端 failed/missing、10 分钟准备超时、连续 5 次状态请求失败、客户端断点恢复与连续新版本切换均有明确收敛路径。
  - 自动失败保持静默并在 15 分钟周期重试；手动检查提供即时反馈。
  - 安装前重新查询服务端：版本撤回则清理，更高版本则切换并重新静默准备。

### 阶段 16：测试与交付
- **状态：** complete
- 最终验证：
  - `pnpm typecheck` 通过。
  - `pnpm frontend:build:ci` 通过，仅保留既有大 chunk 警告。
  - `pnpm test:server` 35/35 通过。
  - `cargo fmt --check`、`cargo check` 和 `cargo test` 通过，Rust 9/9 测试通过，仅保留既有 `objc` cfg 警告。
  - Playwright 胶囊/确认面板视觉与键盘交互验收通过。
  - `git diff --check` 通过；未提交、未推送。
- 增量验证：首次 `cargo fmt --check` 仅报告 3 处自动排版差异，尚未进入 `cargo check`。
- 首次 `cargo check` 发现 opener 参数类型不匹配；已保持路径校验并转换为字符串，待复验。既有 `objc` cfg 警告与本次无关。

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
# 2026-07-21 AI 授权策略、删除能力与稳定 MCP 启动器

- 已核对 Agent SQLite、项目授权、异步任务状态机与写工具分发逻辑。
- 确认所有写操作当前默认待审批，且任务成功结果缺少统一执行回执。
- 下一步：实现持久化审批策略、双重授权校验、破坏性删除工具和稳定启动器。

# 2026-07-21 多用户、多设备与 MCP 隔离

### 阶段 58：基线与迁移契约
- **状态：** in_progress
- 已完成：
  - 读取文件规划、MCP Server 与 Vue3 项目规范。
  - 核对 GitLab 登录、Agent 运行时、Agent SQLite、中央部署库、Tauri 启动参数和整库同步实现。
  - 确认正式多人测试的五个阻断项：localStorage PAT、共享中央 Token、无 team_id、整库下发、固定部署密钥。
- 当前实施顺序：先建立设备身份和可回滚数据库迁移，再切换 Agent 上下文与中央 v2 API，最后移除旧写链和补齐产物上传。
- 已确认设备安全能力将由 Tauri 原生命令提供；Agent SQLite 采用显式 schema 版本和表重建迁移，旧授权不继承到新身份。
- 已完成设备身份/签名、账号安全状态和本机主密钥的系统钥匙串实现；桌面 Node 不再使用源码固定密钥。
- 已新增中央 GitLab 身份交换、15 分钟访问令牌、30 天设备签名刷新、设备撤销和团队成员上下文基础接口。
- Rust `cargo check` 通过；仅保留项目既有 `objc` 宏 cfg 警告。
- Agent SQLite 已升级为 v2：授权/策略按账号设备隔离，计划/操作绑定团队，旧授权进入 `legacy-disabled`，身份变化会使未执行任务过期。
- 前端登录已切到系统钥匙串 + GitLab 实时换票；GitLab PAT 不再写 localStorage，中央请求使用短期 Bearer 和团队 Header。
- 中央部署核心资源已增加 team_id 迁移、动态团队填充触发器、SQL 过滤和 RBAC/资源归属双重门禁；原始数据库下载/恢复已返回 410。
- 当前 Node 语法检查、Vue `vue-tsc --noEmit`、Rust fmt/check 均通过。
- 服务端回归 51 项中 Agent 全链路已恢复通过；迁移测试仅剩版本数量断言已按新增 v5 迁移更新，待下一轮全量复验。
- 已完成后端“设备构建、中央部署”闭环：4MB 分块断点上传、最终 SHA-256、同目标中央锁、任务取消、跨设备 operation 查询及统一 executionReport。
- 雨燕部署页不再为后端目标走本地直接 SSH；用户显式发布会创建可审计 Agent 任务，应用重开或另一台设备可从中央 operation 查看进度并请求取消。
- AI 控制中心已收敛为账号与设备模型，支持撤销其他设备；每个 GitLab 账号自动获得独立中央空间，不再暴露团队切换或 GitLab Group 绑定入口。
- 当前阶段进入自动化门禁：补双账号/双设备/RBAC/撤销/产物边界测试并运行全量 Vue、Node、MCP、Rust 与构建检查。
- 已完成团队强制审批、会话级团队切换、短期令牌主动续期、远程脚手架 v2 鉴权和删除名称二次绑定。
- 已将 OpenAPI 元数据/绝对路径按账号设备隔离，后端继续采用设备构建、中央部署，中央运行任务保留真实用户与设备回执。
- 已移除正式 Tauri 构建中的测试数据库地址和 `VITE_DEPLOY_API_TOKEN`，中央非本机启动缺少独立 `DEPLOY_SECRET_KEY` 时失败关闭；GitHub Actions 新增完整 quality job。
- macOS 安全凭据已从多个独立钥匙串项迁移为单一保险箱，并在 Rust 进程内只解锁一次；旧设备身份、主密钥和活动账号首次升级时自动迁移，Windows 保留分项存储以规避 Credential Manager 单条容量限制。
- 自动化结果：Vue 类型检查和 Vite 生产构建通过；服务端 59/59、MCP 5/5、Rust 11/11 通过；`cargo fmt --check`、`cargo check` 与 `git diff --check` 通过，仅保留既有 objc cfg 和大 chunk 警告。
- 未替代的外部发布门禁：两个真实 GitLab 用户、两台真实设备、独立测试服务器，以及 GitHub Actions 的 macOS ARM/Intel、Windows 正式签名包仍需现场闭环验证。
# 2026-07-22 免费 macOS 本地保险库与跨平台发布

### 阶段 65：设计与兼容审计
- **状态：** complete
- 已读取文件规划与版本发布 Skills，恢复现有计划和工作区差异。
- 已确认 macOS 钥匙串保险箱覆盖设备身份、本机数据库主密钥和活动账号；Windows 继续使用 Credential Manager。
- 已确认不能在不读取旧钥匙串的前提下保留旧服务器凭据解密能力；本轮采用用户批准的“升级后重新登录一次”方案，并将在文档中明确本机敏感配置需重新录入。
- 当前工作区已有一组 staged 修改及用户的 Nginx 配置修改；本轮只增量编辑相关文件，不撤销、不重新暂存。
- 设计确定：保险库采用 AES-256-GCM、随机 256 位本地密钥、固定 AAD、`0700/0600` 权限和同目录原子替换；密钥与密文同属当前用户权限边界，明确不声称能够抵御同用户恶意进程。
- 升级不读取也不删除旧钥匙串项；回滚旧版本仍可使用原项。新版本生成新设备身份和主密钥，用户重新登录并按需重新保存本机 SSH/Nacos 敏感配置。

### 阶段 66：跨平台安全存储实现
- **状态：** complete
- macOS 已使用 AES-256-GCM 本地保险库保存设备 Ed25519 私钥、本机数据库主密钥和活动账号；目录、密钥与密文权限分别收紧为 `0700/0600/0600`，使用随机 nonce、固定 AAD、1MB 上限与同目录原子替换。
- Tauri setup 在启动内嵌 Node 前初始化保险库；macOS 编译路径不调用 `keyring::Entry`，不会读取或迁移旧钥匙串。Windows 的 Credential Manager 分项逻辑保持原样。
- 首轮 `cargo fmt --check` 仅发现新增 Rust 代码的标准排版差异，运行 `cargo fmt` 后 `cargo check` 通过，安全存储定向测试 4/4 通过。
- macOS 本机完整 Windows target 交叉检查在 `ring` 构建阶段因缺少 MSVC `assert.h` 受阻；依赖树确认 Windows 保留 `keyring`，macOS 单独启用 `aes-gcm`，最终 Windows 编译由现有 GitHub Actions runner 验证。

### 阶段 67：免费发布流程回退
- **状态：** complete
- GitHub Actions 已移除 Apple Developer 证书、身份、Apple ID、Team ID 和公证 Secret 门禁，保留 Windows/macOS 双架构构建、Tauri Updater Minisign 产物签名与反向验签。
- README 与发布/更新 Skills 已同步免费 ad-hoc 方案：终端用户无需配置 Secrets；macOS 首次可能需右键打开，升级后重新登录并重新录入旧主密钥保护的本机敏感配置，Windows 继续直接安装使用。

### 阶段 68：macOS/Windows 验证与交付
- **状态：** complete
- Rust `cargo fmt --check`、`cargo check` 与全量测试 14/14 通过；保险库测试覆盖密文无敏感原文、AES-GCM 篡改拒绝、原子持久化和 `0700/0600/0600` 权限。
- Vue 类型检查、服务端 63/63、MCP 5/5、中央地址策略 4/4 和 Vite 生产构建通过；仅保留既有 `objc` cfg、大 chunk、SQLite 实验特性及本机未设置 `GITHUB_TOKEN` 的警告。
- 工作流 YAML 解析、付费 Apple Secret 静态排除与 `git diff --check` 通过。Cargo feature 检查确认已禁用 keyring 的 `apple-native` 后端，Windows 仍启用 `windows-native`。
- 完整 Windows target 交叉编译受本机缺少 MSVC 头文件限制，没有重复尝试；GitHub Actions 的 Windows runner 是正式 EXE 编译门禁。现有 staged 修改与 Nginx 配置改动均未回滚、未重新暂存，本轮未 commit、未 push。
