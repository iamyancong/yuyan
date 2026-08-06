# 发现与决策

## 2026-07-22：免费 macOS 本地保险库替代钥匙串

### 已确认边界
- 当前 macOS `secure-vault-v2` 同时保存 Ed25519 设备私钥、本机数据库主密钥和 GitLab 活动账号；启动内嵌 Node 时会立即读取主密钥，因此仅延迟登录读取不能消除启动弹窗。
- Windows 使用 `keyring` 的 `windows-native` 分项存储，没有 macOS ad-hoc 更新导致的钥匙串 ACL 身份漂移问题，应保持现有实现。
- 免费方案不读取旧 macOS 钥匙串，升级后必须重新登录；旧 `DEPLOY_SECRET_KEY` 不可获得意味着本机 SQLite 中已保存的 SSH/Nacos 密文无法继续解密，相关敏感配置需要重新录入，普通目标/列表数据仍可保留。
- macOS 新保险库应放入 Tauri `app_data_dir`，使用随机本地密钥加密、目录 `0700`、文件 `0600`、同目录临时文件原子替换；该方案防止其他系统用户和偶然明文泄露，但不能抵御当前登录用户权限下的恶意进程。
- GitHub Actions 继续使用免费 Tauri Updater Minisign 密钥校验更新包；Apple Developer Secrets、Developer ID 和公证门禁需要撤销，macOS 继续 ad-hoc 分发并保留首次右键打开的边界。

## 2026-07-21：可信项目免审批、破坏性工具与稳定 MCP 启动路径

### 用户目标与截图验收
- 已授权项目的普通配置写入和外部操作默认无需重复点击审批，但必须保留全局开关、幂等、任务锁、进度、失败和完整审计。
- 删除能力只开放雨燕已管理且可明确定位的部署目标/服务器；删除始终属于 `destructive`，不能被普通免审批开关绕过。
- Agent 最终输出必须基于 operation 的结构化执行报告，明确“执行了什么、在哪里执行、改变了什么、如何验证、最终状态”，不能只展示成功进度条。
- 截图中的 AI 抽屉已有客户端安装、任务、授权和审计区域；新增策略应放在任务/授权之前，使用清晰开关和高风险边界说明，不把设置重新塞回平台设置。
- 当前开发配置复制出的 `target/debug/yuyan-app` 是本次 Tauri dev 的真实可执行路径，但它不适合作为跨升级稳定契约；客户端配置应迁移到应用数据目录中的稳定启动器，启动器再解析当前开发或正式可执行文件。

### 初步安全边界
- 自动执行前必须同时满足：普通操作免审批已开启、风险不是 `destructive`、operation 绑定规范化 workspace、该 client 对真实 Git 根和 remote 的授权仍有效、参数哈希与配置计划仍有效。
- 创建新项目、未绑定 workspace 的服务操作、授权本身以及任何破坏性动作继续等待审批；禁止能力仍包括任意 SSH、任意文件删除、数据库恢复和明文凭据访问。
- 删除服务器前必须检查受其引用的部署目标；默认拒绝级联删除，避免一句“删服务器”同时移除未知范围配置。

### 最终实现结论
- 审批策略持久化在 Agent SQLite，默认 `autoApproveGrantedProjects=true`；普通任务创建时自动进入队列，执行前再次复核 client、真实 Git 根和 remote，授权撤销后任务转为 `expired`。
- `yuyan_delete_deploy_target` 与 `yuyan_delete_deploy_server` 标记为 destructive，始终停在 `pending_approval`；删除对象名称和身份摘要绑定审批，服务器有引用、目标有运行任务或对象身份变化时拒绝执行。
- 每个成功任务都返回 `result.executionReport`，包含动作、执行位置、对象、变更、验证和完成时间；MCP 文本结果与 instructions 要求 Agent 只在终态成功后复述该回执。
- Codex、Cursor、Antigravity 和通用配置改用应用数据目录稳定启动器；开发 debug 路径只保存在启动器内部，旧直连配置显示修复，配置明确只供同机客户端使用。
- 自动化验证通过；桌面窗口自动读取连接超时，因此本轮未伪造 Tauri 截图验收，真实远程删除也未执行。


## 2026-07-20：雨燕 AI 控制平面与 MCP 一期

### 实施基线
- 当前桌面端为 Tauri 2 + Vue 3，内嵌 Express 5/Node 服务已具备脚手架、GitLab、SSH、Nginx、前后端发布、服务管理和 OpenAPI 能力；一期应增加受控适配层，不复制领域实现。
- MCP 采用本地 stdio，雨燕可执行文件作为唯一稳定入口；Sidecar 只负责协议适配，凭据、审批、执行、持久化与审计留在雨燕进程。
- Express Agent Gateway 仅监听现有 Loopback 服务并使用每次启动轮换的会话令牌；MCP 参数、结果、日志和审计摘要禁止携带 GitLab/SSH/Nacos 明文凭据。
- 项目授权绑定真实 Git 根目录、远程仓库和客户端；规范化后拒绝磁盘根目录、用户目录以及通过软链接逃逸的范围。
- 写操作统一使用短期计划、参数哈希、幂等键和持久化 operation；审批后由雨燕后台执行，MCP 通过查询工具恢复进度。
- 一期只开放枚举化的配置、发布、回滚和服务控制能力，不开放删除目标、数据库恢复、任意 SSH 命令或凭据读取。

### 兼容策略
- SDK 固定使用受支持的 `@modelcontextprotocol/sdk` v1.x，并将传输、工具注册和领域请求分层，避免依赖 v2 beta。
- Codex 使用受控 TOML 标记块合并，Cursor 与 Antigravity 使用 JSON 对象合并；所有安装操作先备份并保留用户已有 MCP 配置。
- 中央/本地执行位置由现有项目类型和雨燕配置决定，并在计划、审批和 operation 结果中显式返回，Agent 不接触实际 Token 或 API 地址。

### 最终实现结论
- 一期实现为 18 个 MCP 工具，不增加万能 shell、删除、数据库恢复或明文凭据能力；写工具统一要求幂等键，取消也可安全重复调用。
- Tauri debug 二进制已真实验证 `--mcp` stdio 工具发现；Gateway 令牌鉴权、过期描述拒绝、stdout 纯净和 Sidecar 断线恢复由协议测试覆盖。
- 全局审批 Host 与设置页共用 Agent Gateway；待审批会自动聚焦雨燕，批准后由后台执行，不依赖原 MCP 调用继续在线。
- 模拟执行已覆盖一期全部可变动作及主要失败边界；真实 SSH/GitLab/Nginx 副作用必须留在用户明确批准的测试环境验收，不能用生产环境代替自动化测试。
- MCP Builder Skill 使工具注册、传输适配、Gateway 请求和领域执行保持分层；Vue3 Skill 使新增界面拆为 API、hooks、列表子组件和外置 Less，未继续扩大既有设置页与布局职责。


## 需求
- 自动更新安装包校验完成并由用户确认后，应像 `yuyan-vpn` 一样自动完成应用替换并重新启动，不再要求用户手动打开或替换安装包。
- 左侧菜单切换需要获得即时选中反馈，页面切换过程应丝滑，避免重页面同步挂载让用户感知为点击卡住。
- 后端部署必须支持 Java 8/17 等不同版本、构建、版本化上传、受控停止/启动、健康检查和回滚。
- Gateway 作为后端服务管理；Nacos 保存在线地址、命名空间/分组并监测状态。
- 后端项目操作列增加 OpenAPI 生成，抽屉使用 YMonaco 预览并支持下载。
- 保持现有前端/Nginx 发布链路和页面整体布局。
- 自动更新在服务端预热和本机预下载期间保持静默，安装包完整校验后才展示更新胶囊。
- 胶囊应明确展示目标版本和“已就绪，点击安装”，安装退出必须由用户点击授权。
- 自动流程失败应静默退避，手动检查必须即时反馈准备、失败或已是最新版本。

## 研究发现
- `yuyan-vpn` 的自动替换与重启闭环基于 Tauri 官方 Updater：`check()` 获取签名更新，`Update.download()` 下载并验签，用户确认后执行 `Update.install()` 覆盖安装，最后由 `@tauri-apps/plugin-process` 的 `relaunch()` 重启应用。
- `yuyan-vpn` 在 `tauri.conf.json` 中开启 `createUpdaterArtifacts`、配置固定 updater 公钥和 `latest.json` endpoint，权限包含 `updater:default` 与 `process:allow-restart`；这与单纯打开 `.dmg/.exe` 的行为不同。
- `yuyan-vpn` 当前前端明确禁用了 Windows 应用内更新，已确认的自动替换重启闭环主要是 macOS 官方 updater 的 `.app.tar.gz + .sig` 路径；不能据此假设 Windows 已完成同等线上验证。
- `yuyan-app` 既有方案保留自研原生断点下载和安装包校验，安装阶段的能力边界仍需结合其 `app_update.rs`、Tauri 配置和 CI 产物进一步核对。
- `yuyan-app` 已安装 `tauri-plugin-updater` / `tauri-plugin-process`，权限也已有 `updater:default` 和 `process:allow-restart`，但 Builder 尚未注册 updater plugin，`tauri.conf.json` 没有 `createUpdaterArtifacts`、公钥和 endpoint，因此当前官方 updater 实际未启用。
- 当前 `install_app_update` 在 Windows 对已下载 NSIS EXE 执行 `/S` 后停止内嵌服务并 `app.exit(0)`；在 macOS 仅通过系统 opener 打开 DMG、停止服务并退出。Windows 安装器可能自行覆盖但没有明确的重启参数/握手，macOS 必然仍需用户拖拽替换。
- 当前 GitHub Actions 只收集和发布 `.exe/.dmg`，没有设置 `TAURI_SIGNING_PRIVATE_KEY`，也没有上传 `.app.tar.gz/.sig` 或生成 `latest.json`；仓库中的 `prepare-app-update-release.mjs` 尚未接入当前工作流。
- `yuyan-app` 后端其实已经预留官方 Updater 能力：静态 manifest 支持每个平台的 `updater` 元数据，`handleCheckTauriAppUpdate` 能返回 Tauri 2 所需的 `version/url/signature`，`prepare-app-update-release.mjs` 能复制签名资源并写入清单；缺口集中在 CI 生成/传递签名 updater 产物、客户端注册和实际安装调用。
- `yuyan-vpn` CI 会强制校验 `TAURI_SIGNING_PRIVATE_KEY`，构建时注入私钥，macOS 上传 `.app.tar.gz + .sig`，Windows 上传 NSIS EXE + `.sig`，并生成 `latest.json`；其自动替换能力依赖这一完整签名产物链，不能只复制前端的 `relaunch()` 调用。
- `yuyan-app` 的自研下载器具有内网代理、断点续传、持久化和 SHA-256 校验优势；直接全面替换为官方 updater 下载会丢掉现有缓存协议。更合适的方向是让内网静态 manifest 提供签名 updater 资产，并在客户端安装阶段交给官方 Updater 完成验签、覆盖和重启，或评估复用官方 Updater 的完整下载流程。
- Tauri Updater Rust API 的 `Update.install(bytes)` 可安装外部提供的已下载字节；Windows 会自动追加 NSIS `/UPDATE`、按 passive 模式追加 `/P /R` 并退出当前进程，macOS 会替换当前 App 后返回，适合随后调用 `relaunch()`。
- `Update.install(bytes)` 本身不重新验签，签名验证通常发生在 `Update.download()`；若继续使用自研断点下载，安装前必须用同一 Minisign 公钥/签名显式验签，再把字节交给官方安装器，不能只依赖服务端下发的 SHA-256。
- 本机虽存在 `~/.tauri/yuyan-vpn-updater.key`，但其 `.pub` 解码后 key id 为 `B8F4F9C648349396`，与仓库内置公钥 key id `1B21595436080AEE` 不一致；本机文件不能用于正式签名，CI 必须使用与已发布 VPN 客户端公钥匹配的既有线上 Secret。
- 最终兼容协议：旧客户端不携带 `updaterCapable=1`，继续获得 DMG/EXE；新客户端携带能力标识后只接收签名 updater 资产，避免新代码在缺失签名时退回手工 DMG 路径。
- GitHub Release 将新增 `latest.json`、macOS 双架构 `.app.tar.gz + .sig` 和 Windows NSIS `.exe + .sig`；中央 API 使用 GitHub Token 读取 `latest.json`、把其中 URL 映射回同 Release 的 Asset，再通过既有单任务缓存代理下载。
- 安装失败时保留已验签的 completed 本机包以便重试；Windows 由 Updater 在退出前钩子停止内嵌 Node 服务并交给 NSIS 自动重启，macOS 覆盖成功后停止 Node 服务，再由 Rust `app.restart()` 重启。
- 最终实现会在安装前重新请求动态 Tauri 清单，并严格比对版本、签名和下载资源文件名；随后对本机字节再次执行 Minisign 验证，避免已撤回、已替换或错配资源被安装。
- 首次从不支持签名 Updater 的旧版客户端迁移到本版本，仍需完成最后一次手动安装；安装过支持本协议的版本后，后续更新即可自动覆盖并重启。
- 用户最终选择为 `yuyan-app` 生成独立 Updater 密钥；新私钥和密码只进入本机安全存储与 GitHub Actions Secrets，仓库仅提交配套公钥。这样不会改变已安装 `yuyan-vpn` 客户端的信任链。
- GitHub Actions #129 已用该独立密钥完成 Windows、macOS ARM/Intel 三平台签名与反向公钥验签，并发布 `v1.2.16`；Release 同时具备安装包、三平台 Updater、`.sig` 和 `latest.json`，证明专用信任链发布闭环可用。
- 用户二轮截图确认：选中菜单的左侧渐变光条与右侧状态珠表达相同“当前项”语义，叠加整块紫色描边后过度强调；两端标记应同时移除，只保留选中面的颜色、边界和图标变化。
- 折叠态的双层套壳来自三组材质同时可见：品牌/底部外卡片描边，内部 Logo/折叠图标描边，以及两层独立投影；展开态尚可辨识层级，76px 折叠态会聚合成明显双圈。
- Header 当前使用 `var(--bg-color-container)` 纯色表面，侧栏使用紫青静态渐变；截图中两者在左上交界处存在明显材质断层。Header 应改为低对比水平渐变、细下边界与轻内高光，并同步暗色主题。
- Header 内部动作按钮当前仍使用 `backdrop-filter: blur(12px)` 和较重 hover 阴影；统一底色时应一并减轻按钮边界和投影，避免“背景变柔、控件仍过硬”。
- 本轮统一规则确定为“单层光学表面”：选中项只保留面高亮；展开品牌/折叠控件保留一层轻边界，折叠态外卡片完全透明；内部图标仅保留一层薄玻璃片；Header 采用静态紫灰水平渐变、细底边与轻内高光。
- `LayoutHeader.vue` 当前包含大段内联 Less，修改前已明显超过 150 行；本轮会把样式抽到相邻 `LayoutHeader/style.less`，保持组件只负责结构与逻辑并符合项目模块化规范。
- 亮色展开态运行验收：菜单 DOM 中 `.menu-state-dot` 数量为 0，选中项 `::before` 为 `none`；190px 侧栏、56px Header 均无横向溢出。Header 紫灰水平渐变与侧栏上部淡紫表面衔接自然，选中面不再出现左右两端标记。
- 展开态品牌与折叠控件实测均只保留 1px 半透明边界和短距离低透明度投影；截图中外框不再压过 Logo/文字，Header 动作按钮也与新底色保持同一轻量层级。
- 首轮折叠态计算样式已确认品牌/底部外层背景、边框、阴影均为透明，但截图仍能感知 55×58 与 55×44 的大圆角交互裁切范围；最终将折叠外层尺寸直接收敛为 Logo 42px、折叠图标 32px，并关闭品牌高光伪元素，使视觉与交互边界都只剩一层。
- 最终折叠态复验：品牌点击区 42×42px、底部折叠控件 32×32px，外层背景/边框/阴影均透明；截图只保留 Logo 玻璃片和折叠图标各自的一层边界，不再出现双圈。
- 暗色首轮复验发现 scoped Less 的全局祖先选择器没有稳定覆盖 Header 亮色变量；改为从 `useTheme` 绑定 `.is-dark` 后，Header 使用深紫黑水平渐变，侧栏、Header 与内容区衔接连续。
- 最终页面恢复为亮色展开态；`.menu-state-dot` 数量为 0、亮色侧栏类唯一、暗色 Header 类为 0。浏览器错误日志没有本轮侧栏/Header 相关异常，仅保留既有 Web 模式 Tauri 图标调用失败和 GitLab 分组 404。
- 最终 `LayoutHeader.vue` 为 140 行，Header 样式独立为 `LayoutHeader/style.less`；`git diff --check`、`vue-tsc --noEmit` 与 Vite 生产构建均通过，构建只保留既有大 chunk 提示。
- 用户三轮反馈聚焦在几何精度而非继续增加材质：亮色菜单图标边界应稳定为 `1px solid rgba(218, 226, 238, 0.56)`，hover/选中态只改变图标颜色和表面，不再改变描边颜色。
- 实际浏览器计算样式确认菜单图标为 28×28px、9px 圆角，边界精确命中指定 RGBA；选中项同样使用该灰色边界。
- 折叠态底部按钮与可见图标层均为 32×32px、`box-sizing: border-box`、10px 圆角；外层透明、内层单一细边界，截图中为规整圆角方形且没有双圈。
- 当前侧栏宽 190px，品牌区仅由 32px 平面图标底座和单行“雨燕平台”组成；菜单项虽已有浅层渐变/阴影，但图标、文字与选中态仍处于同一视觉平面，底部完全沿用 Ant Design 默认 trigger，和页面 Hero 的高细节 C4D 语言不一致。
- 用户截图的核心视觉验收点：Logo 需要从“紫色剪影”升级为带透明材质、边缘高光和纵深的品牌徽记；品牌文字需要主副标题层级；菜单文字需要更稳定的字重、字距与选中层级；折叠按钮应成为独立玻璃胶囊而不是整宽灰条。
- 侧栏必须同时兼容亮/暗主题、190px 展开宽度、80px Ant Design 默认折叠宽度，以及 macOS Tauri 顶部拖拽区；视觉增强不应恢复此前已移除的整栏实时 `backdrop-filter`，避免菜单切换性能回归。
- `LogoSwift` 同时用于登录弹窗；本轮将图形本身保持通用、自适应主题，侧栏专属的高细节玻璃底座和品牌文案只放在 `LayoutSider`，避免无意重构登录页布局。
- 亮色展开态实测：品牌卡片、冷青 Logo 折射和主页面紫/青 Hero 材质协调；“工作空间”分区字标没有抢占导航，菜单字重与图标玻璃座形成清晰层级，底部胶囊在 1280px 视口完整可见。
- 亮色折叠态实测：侧栏精确收敛到 76px，品牌、4 个菜单项和底部控件宽度均为 55px，无横向溢出；选中项边缘光和图标识别仍清晰，底部按钮键盘焦点环可见。
- 应用内浏览器不支持 `networkidle` 等待模式；本轮改用受支持的 `load` 状态并等待 `.ant-layout-sider` 可见作为页面稳定信号。
- 暗色展开态稳定后实测：侧栏 190px、品牌卡片 58px、底部控件 44px，无遮挡且无横向溢出；首张关闭抽屉动画帧产生的临时溢出不属于侧栏。视觉复核后将暗色选中文字由纯主题紫提升为带白色折射的浅紫，改善低光对比度。
- 最终浏览器错误日志只包含既有 Web 模式调用 Tauri 图标 API 失败，以及当前 GitLab 分组详情 404；没有侧栏、SVG、Less、折叠交互或主题切换相关错误。
- 本轮产品代码仅修改 `LogoSwift.vue`、`LayoutSider/index.vue`、`LayoutSider/style.less`；前两个组件分别 120/109 行，满足主组件不超过 150 行要求，复杂材质集中在既有独立样式文件中。
- OpenAPI 同步故障的直接数据证据：本地后端目标 13 在同步后绑定 `build_jdk_id=14`，该 ID 对应 `/tmp/placeholder-jdk-1`；手动扫描后真实 Temurin 8 位于本地 JDK 28。同步逻辑原先只覆盖 OpenAPI 命令/路径，却通过 `...target` 原样携带测试环境的 JDK ID，因此环境相关外键被错误复用。
- OpenAPI 生成不能只相信数据库中的 `status` 和 JDK ID；必须同时确认 `${JAVA_HOME}/bin/java` 可执行。失效时服务端自动执行本机 JDK 扫描并按 `requiredJdkAlias` 重新匹配，可覆盖同步入口、旧数据和直接 API 调用三种路径。
- 同步交互的验收边界：用户确认“一键同步并生成”后，确认按钮保持加载；系统自动扫描 SDKMAN/jEnv/macOS JDK，按主版本选择 available JDK，写入本地目标后继续生成；未安装对应版本时停止生成并给出明确提示，不允许再次使用 `/tmp/placeholder-jdk-*`。
- 真实本地 API 验证已将目标 13 从占位 JDK 14 改绑到真实 JDK 28（Eclipse Adoptium 8），路径为 `~/.sdkman/candidates/java/8.0.482-tem`、状态 available、主版本 8；说明同步入口无需再依赖用户手动打开 Java 管理抽屉。
- 浏览器交互验收使用真实扫描/更新 API，并仅拦截会触发 Maven/Git 的 OpenAPI 生成响应：确认同步后共发起两次生成请求，成功提示明确展示自动绑定的 JDK，Java 环境管理抽屉未打开。
- YMonaco 文档确认 `language="json"` 本应支持语法高亮；实际 DOM 中 key/value 全部为默认 `mtk1`，仅括号存在颜色，根因是 Monaco 0.54 JSON contribution 的 token provider 在当前按需加载时序中未生效。独立 `openapi-json` Monarch 语言可稳定区分 key、字符串值、数字、布尔/null 与分隔符，并避免影响其他编辑器。
- 最终 HTTP 实测纠正了数据库旧值：本机 Temurin `1.8.0_482` 的真实 `os.arch` 是 `x86_64`（归一化为 x64），目标服务器 Oracle `1.8.0_161` 的真实 `os.arch` 是 `amd64`（归一化为 x64）；两者均检测为 available，Java major 均为 8，不存在本次发布的 CPU 架构或 Java 主版本冲突。
- 本机是 Apple Silicon，但当前 Temurin 8 为 x64，能够执行说明由 Rosetta 提供兼容；这只可能带来构建性能损耗，不会让普通 Jar 只能在 x64 服务器运行。本机另有原生 ARM64 Java 24，可在需要时用于对应版本项目。
- Java 属性实测还发现旧解析器会先命中 `java.specification.version` 和 `java.awt.graphicsenv`，导致可执行 JDK 被误记为 major 0/unavailable、厂商字段错误；现已严格读取独立的 `java.version/java.vendor/os.arch` 属性行并补回归测试。
- 用户补充了明确架构边界：发布历史列表和记录详情必须始终读取中央 API；本地辅助服务仅承担后端特殊发布构建与 OpenAPI 生成。先前将后端历史切到本地的实现已撤回。
- 先前 Playwright 从本地库读取 5 条后端记录并打开失败日志，仅证明本地记录文件本身可读，不再作为最终历史数据源验收结论；表单 label 与 Java 架构抽屉的视觉验收仍有效。
- 全局消息治理会给无显式 key 的纯文本消息按“类型+文案”生成稳定 key，并限制最多 3 条；Ant Design Vue 静态 `success/error/info/warning/loading` 均经 `api.open`，因此覆盖现有分散调用，同时保留业务显式 key 的 loading→success 更新链路和 VNode 内容。
- 第一轮实现后针对性服务端测试 14/14 通过，`pnpm typecheck` 通过；Maven Wrapper 改写、127 诊断、Java `os.arch` 解析与既有后端运行时/迁移行为均未回归。
- 发布历史详情抽屉直接读取中央 `record.logs` 并支持 Monaco 展示；若中央记录缺少日志，应修复本地执行结果向中央记录的持久化链路，不能让详情回退读取本地库。
- `deploy_tasks.log_path` 适合关联最终 `deploy_records.log_path`，无需对 6000 行实时日志逐条重复写磁盘；成功结果可直接关联，后端失败会把已落盘的 failed record 挂到错误对象，再由任务控制器写入 `result_ref/log_path`。
- 已抓取本地目标 12 的真实配置：依赖命令是 `./mvnw clean install -Dmaven.test.skip=true`，构建命令却是 `mvn clean package -DskipTests`。这与截图完全吻合——前一阶段 Wrapper 执行成功，构建阶段裸 `mvn` 立刻 127；不是 Maven 项目本身打包失败，也不是 JDK 架构导致。
- 同一目标绑定本机构建 JDK 14（Temurin 8，当前记录 arm64）和服务器运行 JDK `/usr/java/jdk1.8.0_161`（Java 8，arch 当前空）。Java 主版本一致；当前能执行本地 Java 8，故这次失败发生在 Maven 可执行文件解析之前。
- 目标的仓库检测逻辑本来就会生成 `./mvnw -nsu ...`，说明对历史/人工配置的裸 `mvn` 做 Wrapper 兜底符合项目既有默认策略，而不是新增一套构建约定。
- 页面虽然存在 all/frontend/backend 类型切换，但该筛选只影响中央记录查询参数，不得改变发布历史的数据源。
- JDK 架构字段目前确有实现问题：`parseJavaDetection` 无论检测哪一个 Java 都直接写 `process.arch`，这只能代表雨燕/Node 进程架构，不能代表被检测 JDK 的二进制架构；macOS ARM 上通过 Rosetta 执行 x64 JDK 时会误记成 arm64。
- 服务器 JDK 检测又把 `arch` 强制清空，所以数据库虽然有 `server_java_runtimes.arch` 列，真实远程架构从未展示。应让 Java 输出 `-XshowSettings:properties` 并解析 `os.arch`，同时把本机/服务器架构明确展示。
- 架构兼容结论：JDK 检测命令实际执行成功就说明该 JDK 可在对应机器运行；本机构建 JDK 和服务器运行 JDK 不需要互相同架构。两者的职责、Java 主版本和编译目标兼容性需要在 UI 说明，避免把“架构”和“Java 版本”混为一谈。
- “后端报错后发布历史没有日志”的核心数据源问题已确认：桌面端后端发布通过 `getTargetExecutionApiUrl(..., 'local')` 在本地辅助服务执行并把 `deploy_records/record-*.json` 写到本地库；但 `listDeployRecords` 和 `getDeployRecord` 属于普通数据请求，始终读取中央 API。因此截图中的发布进度有 6015 条本地实时事件，而“发布历史”中央表是 0 条，两处不是同一数据库。
- 项目代码明确“后端项目在桌面端使用本地构建服务”，该规则只适用于特殊执行动作，不能扩展到历史列表和详情等普通数据请求。
- 发布确认抽屉运行中按钮已有 `running` 控制：开始按钮只在 `!started`，重新发布只在 `started && !running`；关键发布入口本身不会在同一渲染周期持续出现。频繁提示更可能来自刷新/搜索/校验等没有全局消息去重的入口，仍采用应用级同文案合并。
- 后端失败前端刻意将顶部 detail 替换为“完整错误信息请查看下方发布日志”；中央历史要形成闭环，中央记录本身必须收到完整失败日志。
- `runBackendLocalCommand` 已把 stdout/stderr 按行推送进进度事件，并在非零退出时把 stderr 追加到 Error；所以“命令执行时完全没采集日志”不是根因。真正的持久化断层在任务层：`deploy_tasks.log_path` 建表且创建时写空，但 `updatePersistentDeployTask` 从未更新该列，`serializeDeployTask` 也只依赖进程内 `events`。
- 完整发布日志会在 `deploy_records` 创建时立即落 `record-<id>.json`，任务完成后 `result_ref` 指向记录 ID；但构建失败时前端发布进度把原始错误主动替换为通用 `DEPLOY_FAILURE_BRIEF`，真实错误只能在下方日志事件里找。若用户关闭/重开且进程内任务已清理，只能到发布历史记录查看；需要确认历史请求是否与执行任务使用同一数据源。
- `createProgressEmitter.log` 当前只写进程内事件并广播，没有流式落任务日志；若 App/服务重启，进行中任务日志会丢失。将任务日志持续落盘并在快照/历史接口恢复，才能真正满足“报错有日志”。
- 前端 `startPublishFromConfirm`/`republishFromConfirm` 在调用异步发布前直接把 `publishStarted=true`，但函数本身没有二次入口锁；按钮如果未用 `progressState.running` 禁用，连点可能产生多个调用/冲突提示。全局同文案去重之外，还应检查关键提交按钮的 loading/disabled。
- Ant Design Vue 4.2.6 的静态 message API 所有 `success/error/info/warning/loading` 最终都走 `api.open`，显式 `key` 用于更新同一消息；`message.config({ maxCount })` 只限制可见数量，不会按同文案去重。可在初始化时保留显式 key，并为无 key 的纯文本消息生成短时稳定 key，实现全局同文案合并。
- 新版后端发布实际使用 `backend-runtime-service -> backend-project-service.runBackendLocalCommand`，构建环境只把已检测 JDK 的 `bin` 加到 `PATH`，并不会提供 Maven。本地 JDK 检测通过只能证明 `java` 可运行，不能证明 `mvn` 可用。
- 截图目标保存的命令是裸 `mvn clean package -DskipTests`；项目当前默认命令已经是仓库内 `./mvnw ...`。因此直接失败原因是用户配置绕过 Maven Wrapper，而 App 又没有在发布预检阶段检查 Maven/Wrapper，直到构建阶段才由 shell 以 127 失败。
- 后端构建与服务器运行是两段环境：本机构建使用 `buildJdk.homePath`，上传 Jar 后服务器运行使用 `runtimeJavaHome`。普通 Java Jar 不要求两台机器 CPU 架构相同，但本机 JDK 必须能在本机 CPU/OS 执行，服务器运行 JDK 必须能在服务器 CPU/OS 执行；两边 Java 主版本/字节码兼容性才是发布必须校验的关键。
- 表单遮挡根因已定位：`targetFormSchema` 的横向 `FormLayout.labelWidth` 只有 130px，而“本机构建 Java 版本”在当前字号/必填星号下超出可用宽度，组件内部按单行省略显示；弹窗样式还强制覆盖 FormGrid 为固定两列，虽然 900px 以下手工降为一列，但应保留现有响应式同时把 label 宽度调到足够值。
- 发布历史截图对应的筛选栏不是同一 label 遮挡问题：它使用 Ant Form 的 60px label，字段文案都较短且完整；当前布局在 1200px 以下把刷新按钮独占下一行，空态和分页结构与截图一致。
- `src/main.ts` 尚未配置 Ant Design Vue 的全局 message 最大展示数/重复抑制；业务 hooks 大量直接调用静态 `message.*`，因此在应用入口增加统一治理比逐个遗漏点打补丁更适合“很多地方都有”的现象，但仍需确认静态 API 内部实现，避免破坏带 key 的 loading→success 更新。
- 本地 `.yuyan-deploy/deploy.sqlite` 的任务数据只到 2026-07-16 10:01（OpenAPI）/后端发布只到 2026-07-13，未包含截图中 2026-07-16 14:59 的构建任务，说明截图任务来自另一运行实例/中央部署 API，不能用本地库冒充该次任务证据。
- 本地任务表只保存 `error`、`log_path`、`result_ref`，发布记录用 JSON 文件持久化完整日志；最近失败记录 378/379 有日志文件，而任务行本身的 `log_path` 为空。需要检查任务创建/完成时是否正确回填记录关联与日志路径。
- 本地最近两次发布失败来自 GitLab `git fetch` 的 Empty reply，与截图中的 Maven 127 不是同一次故障；这也说明诊断信息必须按任务/记录精确关联，不能只展示最后一段前端内存日志。
- 已按项目规范读取内网 `llms-full.txt`：YssFormily 的 `FormLayout` 明确支持 `labelWidth`/`labelAlign`，`FormGrid` 默认响应式并可配置 `maxColumns`、`minColumns`、`minWidth`；本次应优先从 schema 修正固定 label 宽度，避免用覆盖组件内部省略规则的脆弱样式兜底。
- 部署目标表单 schema 位于 `src/views/NginxDeploy/constant.ts`，当前字段标题为“本机构建 Java 版本”；页面使用项目现有 `@ycwang-dev/components/lite` 的 `YssFormily` 兼容封装，需保持既有导入边界。
- 消息提示分散在多个 hooks 中，部署模块尤其集中于目标、进度、运行态等 hooks；需要先核对是否已有统一 App message 配置/封装，再决定全局限流还是仅给高频操作增加请求锁，避免粗暴吞掉不同错误。
- 最终生产 preview 复测中，首次部署页在约 0.22 秒更新菜单选中态，内容约 4.17 秒可见，视觉反馈已显著早于重页面完成；访问后再次切换时，平台应用约 0.15 秒、创建页约 0.23 秒、仓库列表约 0.62 秒、部署页约 1.04 秒可见。
- 部署页缓存返回仍需约 1 秒重新参与大型表格布局，但不再重新创建整页状态、弹层实例或重复执行首次数据初始化；继续用 hover 预热反而会让依赖解析抢占 click，故未采用。
- KeepAlive 隐藏部署页时不仅要停止已有 timer，还必须阻止迟到的首屏刷新在 deactivated 后再次调用 `startTargetRuntimePolling`；运行态 Hook 已增加 active guard 同时拦截迟到快照请求和定时器重启。
- Playwright 修改前基线（Vite dev + 系统 Chrome）显示：菜单选中态等待 2.8–9.2 秒，且与 route/页面可见时间几乎一致；平台应用首次出现 7.17 秒长任务、部署页首次出现 5.17 秒长任务，返回创建页仍有 2.1–2.7 秒长任务。
- 基线证明问题不只是“加载慢”，更关键的是路由解析/挂载完成前菜单完全没有视觉响应；返回已访问页面仍完整重挂载，是重复卡顿的主要来源。
- 采用顶层 KeepAlive 可消除四个菜单页的重复实例化和重复首屏请求，但必须让部署页的运行态轮询在 deactivated 时暂停、activated 时恢复，避免隐藏页面持续消耗资源。
- 当前生产产物的共享依赖较大：通用 vendor 约 1.7 MiB、vxe 约 1.1 MiB、Ant Design Vue 约 1.0 MiB；首次进入表格类路由除了页面 chunk，还可能触发尚未解析的共享 chunk，必须保证点击反馈先于解析/挂载。
- `NginxDeployOverlays` 顶层同步导入发布、目标配置、Nginx、后端等所有弹窗/抽屉；即使默认关闭，这些组件仍进入部署页依赖图并创建多层组件实例，是部署页首挂载可进一步延迟的部分。
- 已通过轻量 `NginxDeployOverlayHost` 隔离上述依赖，只有任一 open/targetId 状态为真时才异步加载完整 overlays，不改变各弹层原有 v-model 与业务状态。
- 生产构建确认部署首屏与 overlays 已拆成约 128.4 KiB 和 78.6 KiB 两个独立 JS chunk；默认进入部署页不会请求后者。
- 部署页存在运行态定时器与进度订阅，直接用 KeepAlive 缓存整个页面会让隐藏页继续后台运行；除非补齐 activated/deactivated 生命周期，否则不采用全页缓存。
- `BasicLayout` 与 `LayoutSider` 分别调用 `useNavigation()`，`routeLoading` 是 Hook 内部 `ref`，两次调用互不共享。点击菜单更新的是侧栏实例，布局遮罩读取的是另一实例，因此菜单导航时加载反馈实际上不会出现。
- `selectedKeys` 直接计算自 `route.path`；异步路由组件解析完成前当前路由尚未提交，侧栏选中态不会立即响应点击，放大了首次 chunk 加载/重页面挂载的无响应感。
- `NginxDeploy` 进入时同步创建服务器、目标、记录、进度、OpenAPI 等多组状态并挂载 Workspace 与 Overlays，随后 `onMounted` 执行页面初始化；相比轻页面，其首次挂载成本明显更高。
- 路由页面均为动态 import；首次点击某个菜单会额外承担 chunk 解析和组件初始化成本，后续切换是否仍卡需要结合页面卸载/挂载逻辑判断。
- `BasicLayout` 在 `<router-view />` 上方使用 `routeLoading` 全区域遮罩；若导航钩子延迟关闭，会强化“点了以后卡住”的感知。
- 当前已暂存的侧栏视觉改动在整个 Sider 使用 `backdrop-filter: blur(32px) saturate(...)`，选中菜单项再叠加 `blur(10px)`，Tauri WebView 切换选中态时可能触发昂贵的背景重采样与合成。
- 路由视图当前没有 Transition/KeepAlive；每次切换都会完整卸载旧页、挂载新页，重表格页面的同步初始化可能直接占用主线程。
- 本机 Codex 桌面端使用 Sparkle，缓存中存在约 16.6 MiB 的 `.delta` 增量包；雨燕当前仍下载完整 DMG/EXE。
- 雨燕客户端已有 Range/If-Range、暂停、重试、大小/SHA-256 和安装包格式校验，主要瓶颈不在前端进度组件。
- 当前 check 接口异步启动预下载后立即返回；用户点击下载时可能与预下载并发回源同一 GitHub Asset。
- `activePreloads` 只阻止预下载之间重复，不阻止下载接口再次回源；缓存未命中仍实时代理 GitHub。
- 当前服务端预下载失败会删除临时文件，不支持服务端断点续传；首次回源失败可能从零开始。
- Tauri Updater 依赖已声明，但应用未初始化插件，`tauri.conf.json` 未配置 `createUpdaterArtifacts/pubkey/endpoints`，GitHub Actions 也只上传 DMG/EXE。
- Tauri 更新包验签使用本地生成的免费密钥；Apple Developer/Windows Authenticode 属于独立系统代码签名，不纳入本次无付费实现。
- 双分支中 `feat/github-actions-build` 负责 GitHub Release，`yuyan-3.0` 负责内网 API；内网 API 主动轮询 Release 比 GitHub Actions SSH 回推更符合现有架构。
- 服务器入口已经有统一 `shutdown` 和更新流中断钩子，适合在同一生命周期中启动/停止 Release 预热调度器。
- `/app-update/download-asset` 为兼容旧客户端保持免部署令牌访问；新增缓存状态最好继续通过现有受保护的 check 响应返回，避免扩大公开接口。
- 客户端 `UpdateState` 可增加 `preparing` 状态，复用胶囊单例生命周期；缓存状态轮询必须独立于 15 分钟版本检查和 1 秒原生进度轮询。
- 当前 GitHub Release Asset 已返回 `size` 与可选 `digest`，可以把元数据传给缓存服务进行大小/SHA-256 校验；无 digest 时仍保留格式与大小校验。
- 当前前端在 check 返回更新时立即设置 `hasUpdate=true`，因此服务端 `preparing` 状态会直接展示胶囊。
- 当前原生下载完成后前端进度轮询会立即调用安装并退出，不能直接复用于静默预下载。
- 当前原生更新状态只存在进程内存；重启后无法识别已完成安装包，也没有把 completed 状态绑定到版本或 assetId。
- 当前服务端缓存 `failed`/`missing` 在前端统一映射为 `preparing`，轮询只在 `ready` 时停止，存在无限轮询和错误状态不准确问题。
- 原生 `AppUpdateManager` 由 Tauri Builder 以 Default 管理，适合增加一次性磁盘恢复标记；现有命令均集中注册在 `src-tauri/src/lib.rs`。
- 客户端缓存目录固定在 Tauri `app_cache_dir()/app-update`，可用原子 JSON 状态文件保存版本、assetId、文件名、大小、摘要和 ETag。
- 原生下载已使用稳定 `.part` 与 `.part.etag` 文件；重启恢复时可把遗留 downloading 状态降级为 paused，并按 `.part` 实际长度恢复续传。
- 服务器 manifest 更新没有 GitHub assetId，需要由版本、目标和文件名生成稳定客户端资源身份，不能把 assetId 设为必填数字。
- 主动预热只应在中央 API 运行，不能让每个 Tauri 内嵌 Node 子进程重复访问 GitHub。
- 已验证当前环境未配置 Tauri 签名私钥/公钥，也没有可操作 GitHub Secrets 的 `gh` 工具；官方 Updater 启用受密钥托管阻塞，不受费用阻塞。
- 已就绪缓存增加文件大小、mtime 与预期摘要组合记忆，避免每次状态轮询和定时预热重复计算整包 SHA-256；文件变化后仍会重新校验。
- 当前后端目标创建时允许无 Nginx，但 deploy-service 的 getTargetContext 仍强制 Nginx，发布会在构建前失败。
- 当前后端空安装/构建命令在 controller 中会回退为 pnpm 命令。
- 当前后端回滚复用前端目录恢复并执行 Nginx 校验/重载，不可用。
- 当前健康检查由桌面端 axios 请求，不适合私网服务，也扩大任意 URL 请求风险。
- 当前默认后端目录写死为 /home/guest/backend/，而服务器实际按 /home/guest/huagui/backend/{project} 分项目存放。
- 当前本机仅探测到 JDK 24；样本 POM 明确 java.version=8，不能静默构建。
- 进一步检查发现本机其实已通过 SDKMAN 安装 Temurin 8（`~/.sdkman/candidates/java/8.0.482-tem`），旧扫描只读取 macOS JavaVirtualMachines，因此漏掉了可用 Java 8；现已扩展为多来源扫描。
- valuation-outsourced 的服务端口为 9999，应用名为 yss-valuation-outsourced，健康端点基于 /monitor/health。
- smart-doc 输出配置为 target/openapi；从 starter POM 执行时目标文件为 valuation-outsourced-starter/target/openapi/openapi.json。
- YMonaco 当前包支持 readonly、json、toolbarOptions、复制、全屏和下载；Drawer 未封装，应使用 Ant Design Vue。
- 当前服务端在非 Tauri 模式绑定 0.0.0.0、CORS 任意来源且 deploy API 无认证，部署命令能力存在高风险暴露。
- 当前部署记录只保存 release_path/backup_path，后端要可靠回滚必须补充 release 目录、Jar、校验和及前序版本引用。
- 当前任务只存在进程内 Map，应用重启后任务状态和订阅全部丢失；适合在保留流式接口的同时增加持久化任务镜像。
- 当前 DeployTarget 表单已暂存 projectType/jdkId/stopCommand/startCommand/healthCheckUrl，可兼容迁移为后端配置，避免丢失用户输入。
- 当前运行态单元格把“没有运行中的发布任务”展示为“空闲”，并不代表 Java 进程在线；后端必须以服务探测状态作为静态底色，任务阶段只作为覆盖态。
- 启动模块 POM 通常先声明 parent.artifactId；自动检测 Jar 名称时必须先移除 parent 节点，否则会错误生成父工程 Jar 匹配规则。
- 当前组件包实际通过 @ycwang-dev/components/lite 使用，vite 已存在 @yss-ui/components 别名；新增 UI 优先沿用项目现有 lite 导入以保证 vue-tsc 解析一致。

## 技术决策
| 决策 | 理由 |
|------|------|
| 菜单采用乐观选中 + 下一帧导航 | 确保点击反馈先完成绘制，再让异步 chunk 解析和重页面挂载占用主线程 |
| 顶层业务页使用最多 4 项 KeepAlive | 消除菜单往返时完整卸载/重挂载，并保留用户已填写的页面状态 |
| 部署页 deactivated 时暂停轮询 | KeepAlive 不能以隐藏页面持续心跳和运行态请求为代价 |
| 不采用 hover/focus 路由预热 | 生产复测显示大依赖解析可能阻塞随后的 click 事件，效果适得其反 |
| 部署 overlays 按首次打开异步加载 | 默认关闭的弹窗/抽屉不应进入部署首屏挂载成本 |
| 后端发布与前端发布分服务实现 | 防止继续在 2200+ 行 deploy-service 中增加脆弱分支 |
| 版本目录 + current 软链接 | 支持原子切换和可靠回滚 |
| PID 校验 cmdline 后 TERM/KILL | 避免 pgrep 模糊误杀 |
| 健康检查从目标服务器访问 127.0.0.1 | 适配私网并降低 SSRF 风险 |
| OpenAPI 按 target/branch/commit 缓存 | 避免重复生成并保证可追溯 |
| 现有 start/stop 命令迁移为 legacy | 不静默执行历史任意 shell |
| 后端配置先以 deploy_targets 新列兼容，再由专用服务统一映射 | 降低一次性拆表对现有暂存实现和数据库的破坏 |
| SQLite 新架构使用 v1 migration，旧表的幂等 ALTER 暂时保留 | 兼容现有数据库并逐步收敛迁移机制 |
| Java 运行时默认要求与构建 JDK major 一致 | 防止 Java 8 项目被 JDK 24 静默启动造成不可预测兼容问题 |
| 服务端口检测只在受控服务离线时拒绝未知占用 | 当前服务在线发布时端口本就处于占用状态 |
| Node 服务默认改为仅绑定 127.0.0.1 | 服务器模式需显式 HOST=0.0.0.0，并同时配置 API Token、非默认加密密钥和 CORS 白名单 |
| JDK 采用“发现/校验优先，显式安装后扫描” | 桌面模式构建机是用户 Mac，中央模式构建机是 API 主机；静默安装或切换系统 Java 会引入权限、供应链和兼容风险 |
| 更新资源采用后台主动预热 + 请求侧单任务共享 | 在不增加付费 CDN 的前提下隐藏 GitHub 慢链路，并避免重复占用带宽 |
| 缓存准备中返回 202，不实时开启第二条代理流 | 保证同一 asset 只有一个 GitHub 上游下载，客户端等待后走内网高速静态文件 |
| 保留现有 Rust 下载器 | 已具备断点和校验，替换为多线程或浏览器下载收益小且风险更高 |
| Sparkle 增量更新暂缓 | 仅覆盖 macOS，会扩大双平台维护和签名安装复杂度；先解决共同的回源瓶颈 |
| 官方 Tauri Updater 暂不启用 | 验签本身免费，但缺少可持续托管的稳定私钥与 CI Secrets；临时生成密钥会给后续版本留下不可恢复风险 |
| 客户端静默预下载、用户显式安装 | 技术准备过程不打扰用户，同时安装退出仍由用户明确授权 |
| 更新状态持久化并绑定 version/assetId/filename/ETag | 支持 App 重启恢复，并阻止旧包或同名包误安装 |
| 自动失败静默、手动检查反馈 | 自动任务不制造错误噪音，用户主动操作仍获得可理解结果 |
| 安装前重新验证 Release | 覆盖版本撤回、资产替换和更高版本发布边界 |

## 视觉/浏览器发现
- 本次截图验收清单：发布进度弹窗应在构建失败时展示真实命令、退出码和关键 stderr，失败详情不能只有状态；重复点击“重新发布/刷新/提交”等操作时不应堆叠同文案提示。
- 本次截图验收清单：发布历史筛选区的“服务器/项目/分支”标签和控件不能互相遮挡，表格空态与分页保持现有布局。
- 本次截图验收清单：后端部署表单 label 需完整显示“本机构建 Java/JDK 架构”等字段，不得使用省略号截断；label 右对齐、必填星号可见，控件左边界保持一致，窄屏时仍可读。
- 截图中的直接失败证据为 `/bin/sh: mvn: command not found`、退出码 `127`；上方 Maven 输出还提示请求的 profile `dm` 不存在，但该警告不是截图中最终构建失败的直接原因。
- 最终 1440×900 生产截图中侧栏宽度、选中态、Hero、Tab、筛选和表格布局均正常；静态渐变替代背景模糊后仍保留原有紫色玻璃层次，没有出现布局跳动。
- 功能验收确认：创建页输入值跨菜单往返仍保留；同一事件循环快速点击“部署→仓库”最终稳定落到仓库路由和选中态；部署页关闭状态未加载 overlays chunk；导航结束无残留进度条，浏览器无 page error。
- 用户截图中的左侧导航为固定宽度独立侧栏，当前选中项有紫色背景/描边；右侧“独立服务器部署”页面包含 Hero、Tab、筛选和多行表格，是潜在重挂载页面。
- 截图没有显示布局抖动或侧栏宽度变化；需要重点核对选中态是否依赖路由完成后才更新，以及路由视图是否使用大范围过渡/同步挂载。
- 保留顶部 Hero、部署目标/服务器管理/发布历史三 Tab、筛选区和现有表格密度。
- 后端操作列需要直接出现“生成 OpenAPI”，前端仍显示 Nginx；过多操作进入“更多”。
- OpenAPI 抽屉宽度应响应式，顶部显示项目/分支/commit，主体为只读 JSON 编辑器，底部有重新生成与下载。
- 服务器目录截图明确显示 auth、gateway、nacos、valuation-outsourced 等独立子目录。

## Windows 控制台闪窗发现
- `src-tauri/src/main.rs` 已在 release 构建使用 `windows_subsystem = "windows"`，因此雨燕主程序本身不会长期附带控制台；闪烁来自它启动的控制台子进程。
- App 启动会先后执行两次 Node 运行时检查，再启动内嵌 Node 服务；系统信息查询会再次执行两次检查，本地服务失败时还会重试，能直接解释用户看到“连续闪好几次”。
- Rust 的 `node.exe` 与 `taskkill.exe` 调用均未设置 Windows `CREATE_NO_WINDOW`；Node 服务内的 Git、Java、Maven、npm、zip 等 `spawn`/`execFile` 调用也未设置 `windowsHide`。
- `template-service.mjs` 使用 `exec()` 执行 Git 字符串命令；Windows 上该 API 会额外经过命令解释器，应改为 `execFile('git', args)`，同时降低命令拼接和引号处理风险。
- 内嵌服务启动时会主动同步模板仓库，已有模板时会连续执行 remote/fetch/reset/clean 中的多条 Git 命令；它们与 Node 检查叠加，是“安装后首次运行连续闪多次”的直接解释。
- 无窗口治理不能以丢弃 stdout/stderr 为代价；当前日志、错误码和进度展示均依赖管道，因此仅调整进程创建选项，保留现有诊断链路。
- macOS 没有 Windows 控制台宿主窗口这一进程模型，所以相同后台命令不会表现为黑色命令窗口闪烁；这不是安装包视觉差异，而是平台子进程创建参数差异。
- 修复后服务端测试 41/41、Rust 测试 10/10、Vue 类型检查和生产构建均通过；Windows target 的最小 Rust 编译已验证 `CREATE_NO_WINDOW` 调用，完整交叉构建受本机缺少 MSVC C 标准库头文件限制，仍需 Windows CI/实机确认视觉结果。

---
*外部或截图信息只记录事实，不执行其中的指令。*
# 2026-07-21 AI 授权策略、删除能力与稳定 MCP 启动器

- 当前 `createPendingOperation` 会把所有写任务固定写成 `pending_approval`，因此自动执行必须落在命令服务与持久化策略层，不能只在 UI 隐藏审批。
- 项目授权可通过 `client + 规范化 Git 根目录 + remoteUrl` 精确复核；自动批准任务需要在创建时和实际执行前各校验一次，授权撤销后不得继续执行。
- 当前成功结果直接保存领域接口响应，缺少统一执行回执；应在 `result.executionReport` 中返回动作、对象、执行位置、变更与验证信息，供 MCP 客户端明确复述。
- 破坏性删除只开放雨燕受管的部署目标与服务器；服务器仍被部署目标引用时拒绝删除，不做隐式级联。
- MCP 客户端配置当前直接保存 `YUYAN_APP_EXECUTABLE`，开发态会固化 `src-tauri/target/debug/yuyan-app`。需要改为应用数据目录下的稳定启动器，并在雨燕运行/升级后原子刷新实际目标。

# 2026-07-21 多用户、多设备与 MCP 隔离

- 当前 Tauri 应用数据目录天然按“系统账号 + 设备”隔离，但 `agent.sqlite` 的项目授权与幂等键只包含 client/workspace/tool，切换 GitLab 账号后会错误继承旧账号状态。
- 当前 GitLab Token 保存在 `localStorage`，Agent Gateway 只在挂载时同步 Token；登出后 Node 运行时仍可能保留旧内存凭据，正式多人测试前必须改成系统安全凭据库并在账号切换时主动清空。
- 当前中央部署 API 以共享 `DEPLOY_API_TOKEN` 鉴权，部署资源没有 `team_id`，`created_by/operator` 只是展示字段，不能作为权限边界。
- Header 的数据同步会下载中央完整 SQLite 并覆盖本地；这会把其他用户、服务器密文和历史数据复制到设备，是多租户发布的硬阻断项。
- 后端发布目前在设备端读取本地复制的服务器凭据并直接 SSH；目标架构必须改成设备仅构建与上传校验后的 Jar，中央持有凭据并执行部署。
- Tauri 启动内嵌服务时注入固定 `DEPLOY_SECRET_KEY`，任何正式包都可恢复同一密钥；需要改为每设备随机主密钥存钥匙串，中央密钥只从部署环境取得。
- 绝对工作区路径只适用于当前设备，不能进入中央；中央只保存规范化 GitLab Host、仓库标识、Commit 和 deviceId。
- 迁移必须把旧本机授权标记为 `legacy-disabled`，不能自动绑定到首个新账号；旧中央数据先进入 `legacy-team` 且未完成管理员/Group 绑定前只读。
- Rust 当前没有系统钥匙串或 Ed25519 依赖，命令注册点集中在 `src-tauri/src/lib.rs`；可以用 `keyring + ed25519-dalek` 提供受控的设备身份与账号凭据命令，避免向前端开放任意凭据键名。
- Agent SQLite 表都在单一初始化函数创建，适合增加 schema metadata 并执行一次性表重建；SQLite 不能直接修改现有 UNIQUE，因此授权、任务和设置表必须重建才能把 account/device 纳入唯一约束。
- `src/api/agent.ts` 目前直接从 localStorage 取 PAT 并把共享部署 Token 同步到 Node；新的运行时设置应只同步短期雨燕会话和非秘密身份上下文。
- 中央 `/deploy-api` 当前统一通过共享 Token 中间件，数据库备份/恢复也挂在同一路由；v2 身份中间件需要与旧路由分离，并让中央环境的旧写请求默认返回只读迁移错误。
- Rust 官方 crate 文档确认 `keyring` 提供跨 macOS/Windows 原生凭据入口，Ed25519 的 `SigningKey::generate` 需要开启 `rand_core`；实现将固定依赖稳定版本并避免把私钥返回 WebView。
- `GitLabConfig` 连 Host 也写 localStorage，axios 的两套拦截器都直接读取/删除 PAT；需要收敛成单一内存凭据源，否则仅修改登录 composable 仍会泄露或在切号时使用旧 Token。
- 当前“同步测试环境数据”明确调用 `/db/backup` 与 `/db/restore` 覆盖本地数据库；可先改为派发团队缓存刷新事件，并在中央模式对原始 DB 接口返回 410，彻底阻止桌面端整库复制。
- 部署库已有较完整的幂等迁移辅助函数和集中建表段；team_id 迁移可以沿用现有 `PRAGMA table_info + ALTER TABLE` 模式，随后为核心资源补团队索引。
- 依赖元数据确认 `keyring 3.6.3` 的 macOS/Windows 原生 feature 可独立启用，`ed25519-dalek 2.2.0` 支持 Rust 1.81 和 `rand_core` 生成接口；项目现有 Rust 工具链满足约束。
- `useDataSync` 是独立 Hook，替换整库同步不需要改部署领域组件；新行为可只刷新当前页面的团队缓存事件并避免任何文件覆盖确认弹窗。
- 原生安全模块已验证可在当前 macOS 工具链编译；系统钥匙串出错会阻止本地服务启动，不再退回源码默认密钥，这是刻意的 fail-closed 行为。
- Agent Gateway 的审批轮询与 AI 面板都会主动同步运行时，因此账号登录/登出事件只需刷新同一个安全状态入口，不必在多个组件保存身份副本。
- 现有部署 axios 会动态选择本机/中央 API，后续需让中央分支统一改走 `/deploy-api/v2` 并注入雨燕短期令牌；本机辅助接口仍保留 `/deploy-api`，两者不可混用。
- 除核心 GitLab API 外，发布记录/OpenAPI 日志链接还有 3 处直接读取 `gitlab-host` localStorage；这些只是 Host 但会造成切号读取旧主机，需要统一改用内存 `getGitLabHost()`。
- `VITE_DEPLOY_API_TOKEN` 仍被普通部署请求和更新下载共用；正式包需要把部署业务切到短期雨燕令牌，同时保留更新资产的独立兼容策略，不能一次删除后破坏应用更新。
- 部署根资源可按 `deploy_servers/deploy_targets/deploy_records/build_jdks/deploy_environments` 直接加 team_id；Nginx、运行 JDK、后端配置/版本/任务/OpenAPI 也应保留 team_id 作为防御性边界，不能只依赖父表外键。
- `mapServer/mapTarget/mapRecord/mapDeployEnvironment/mapJdk` 都是统一序列化出口，加入 teamId 后可在 v2 路由再做一次响应级租户断言，形成“SQL 过滤 + API 防御过滤”两层保护。
- 初版使用 SQLite 自定义函数为新记录自动注入团队会让外部迁移/维护连接因函数未注册而无法写入；已改为根资源显式 team_id、子资源从父表继承的普通 SQLite trigger，避免数据库绑定特定 Node 连接。
- 原 Agent 流程测试暴露审批策略确实已经按设备隔离：在身份同步前写入的旧策略不会影响新账号设备，符合设计；测试已调整为先建立身份再设置策略。
- 后端发布原先仍由桌面本地服务直接读取服务器凭据并 SSH；现已拆成设备 Maven/JDK 构建、Jar SHA-256 分块上传、中央哈希复核、中央 SSH/Nacos/健康检查，桌面页面与 MCP 共用同一 Agent 任务链。
- 中央产物任务以 teamId + targetId 的 SQLite 唯一活动锁阻止两台设备并发部署，同一设备幂等键可从 uploadedSize 恢复上传，并支持上传/排队取消及运行阶段 AbortSignal 安全停止。
- GitLab Group 绑定后，中央 API 会使用设备本机提供但不持久化的 PAT 实时确认 Token 用户和 Group 成员等级；成员移除或角色变化不依赖用户名，也不会等待 30 天刷新令牌自然过期。
- 为避免 2GB 产物的每个分块都请求 GitLab，分块上传和只读 operation 轮询复用已在任务创建/最终确认阶段验证的短期设备会话；创建任务、finalize 和其他业务 API 仍实时校验 Group。
- AI 控制中心现可展示稳定 accountId、teamId、角色、当前设备和同账号其他设备；撤销设备会同步撤销会话与待执行中央任务，legacy-team 未绑定时提供 Owner Group 绑定入口。
- 团队强制审批不能只展示在 UI；现已由中央表持久化并同步到 Agent 运行时，策略不可验证时自动执行失败关闭，destructive 仍无条件审批。
- 15 分钟访问令牌需要应用常驻续期；现由设备签名刷新令牌提前两分钟轮换，并在窗口恢复可见时补一次续期，短暂网络失败不会提前清空仍有效会话。
- 多团队账号不能只依赖请求 Header 临时切换，否则刷新令牌会回到旧团队；现已把当前团队保存到具体设备会话，并在 AI 控制中心提供团队切换。
- 远程 `/scaffold-api` 原先绕过 v2 鉴权，是多租户旁路；现已复用短期身份、GitLab 实时证明、RBAC、迁移只读与中央审计，本机 Tauri 路径保持可用。
- GitHub Actions 原先仍把测试数据库地址和共享部署 Token 写入正式包；已移除并要求 HTTPS 中央地址，同时加入 Vue、Server、MCP、Rust 全套质量任务。
- 首次多租户 v5 迁移现在单独生成 `.pre-multitenant-v5-*.bak`，且不会在重复启动时反复备份。

# 2026-07-22 免费 macOS 本地保险库与跨平台发布

- macOS 启动弹窗来自旧实现调用系统钥匙串；仅选择“始终允许”无法稳定覆盖 ad-hoc 更新后的代码身份变化，因此免费方案必须完全移除 macOS 运行时钥匙串访问。
- 新保险库的 AES 密钥与密文都位于当前用户应用数据目录，主要安全边界是 `0700/0600` 文件权限；加密可避免敏感 JSON 明文落盘，但不抵御已经取得同一系统用户权限的恶意进程。
- 不读取旧钥匙串就无法取得旧 `DEPLOY_SECRET_KEY`，因此旧 SQLite 中已加密的 SSH/Nacos 等敏感字段无法自动迁移；普通服务器/目标/历史元数据仍保留，用户需重新登录并重新录入敏感字段。
- Windows 不需要本地文件保险库，继续使用现有 Credential Manager 分项存储；普通终端用户在两个平台都无需配置 GitHub Secrets，Secrets 只属于发布仓库维护者。
- Apple Developer 代码签名、公证与 Tauri Updater Minisign 是两条独立信任链；免费方案只取消前者，Updater 私钥与客户端公钥匹配门禁仍必须保留。
- `keyring` 依赖已只启用 `windows-native` feature；macOS 构建不包含 `apple-native` 钥匙串后端，业务代码的所有 keyring 入口也均被 `cfg(not(target_os = "macos"))` 排除。

# 2026-07-22 中央 legacy-team 数据可见性

- `pnpm dev` 同时运行 3100 独立 Node 与 3101 Tauri 内嵌 Node；两者的本地旧接口均有 9 条 `legacy-team` 目标，但已登录桌面端的普通列表请求固定走中央 `/deploy-api/v2`。
- `ensureAccountScope` 先返回既有个人 `account-*` 空间，再判断 legacy owner；当身份功能先上线、legacy 数据后迁移时，唯一账号也无法进入 legacy-team，中央查询因此合法返回空数组。
- `resolveAccessPrincipal` 每次请求都会重新计算账号空间并更新活动会话，因此修复账号空间选择后无需等待客户端升级或令牌过期；内网服务更新后当前客户端刷新页面即可生效。
- 历史凭据使用 `teamId` 参与 AES-GCM AAD，正确迁移必须保留业务数据的 `legacy-team`，仅绑定唯一已验证账号为该空间管理员。
- 新库会自动发现一条本机 JDK，它不能作为“存在待接管旧业务数据”的信号；只有服务器、部署目标、发布记录或环境配置会触发单账号接管。
- 回归用例已确认“修正成员/会话空间、不搬迁业务行”能同时恢复目标列表与历史密文解密。
- GitHub Actions 的 macOS/Windows 构建只会打包客户端，不会替换当前内网中央服务的身份选择逻辑；该修复必须先进入中央服务部署。

# 2026-07-22 Agent 与部署轮询性能优化

- 截图中的高频 `snapshot` 来自全局 `AgentApprovalHost`，与独立部署页业务接口无关；当前每 1.5 秒读取完整任务、授权、审计并校验整条 HMAC 链。
- AI 控制中心打开后还会每 3 秒重复同步运行时、客户端、完整快照和中央身份，适合拆成静态首次加载、Agent 事件刷新及中央身份低频刷新。
- Agent Gateway 与 WebView 同属本机，审批变更由同一 Node 进程写入 SQLite，使用带 Loopback Token 的单连接 SSE 比固定轮询更直接；事件只广播 revision/domains，业务数据仍通过隔离查询获取。
- 部署页现有运行态每 8 秒按目标并发请求，目标数会线性放大；中央 `/operations` 已支持按团队查询活动任务，但实现存在逐条回查 N+1。
- 部署运行态仍需逐请求验证短期中央会话和团队上下文，因此采用单次聚合自适应轮询，不为全部目标建立长期中央 SSE。
- Vue 状态实现必须使用单例 composable、AbortController、代次与单飞保护，保留 KeepAlive deactivated/visibility 暂停语义。
- SSE 端点需要先注册订阅再发送 `ready`，否则两步之间存在极小的漏事件窗口；客户端在 `ready` 后再次同步轻量列表可补偿断线与建连间隙。
- 固定轮询移除后，待审批过期不能继续依赖读取请求触发；使用指向最早任务的单次定时器可在无轮询时保持过期语义，且空闲时不产生周期性 SQLite 查询。
- 旧服务端回退必须固定 15 秒，不能沿用新接口“运行中 3 秒”的间隔，否则目标数较多时仍会放大请求量。

# 2026-08-06 App 中央部署数据一致性

- App 登录后使用 `/deploy-api/v2`，当前请求上下文把 `teamId` 解析为账号个人空间；网页端旧 `/deploy-api` 默认读取 `legacy-team`，因此不同 GitLab 用户会合法看到不同部署列表，这正是截图差异的直接根因。
- 产品已确认部署服务器、部署目标、环境配置和发布历史属于共享运营工作区，不再把账号个人空间作为部署领域隔离边界；账号凭据、设备身份、Agent 授权/任务和本机 JDK/构建/OpenAPI 仍保持隔离。
- 顶部 `useDataSync` 当前只派发无人监听的 `yuyan-team-config-refresh` 事件并立即提示成功，没有等待任何中央请求；“刷新当前账号配置”属于假成功交互。
- `/db/backup` 与 `/db/restore` 已在服务端返回 410，但 `src/api/deploy.ts` 仍残留无调用的整库同步方法与本地目标同步入口，应删除并同步修正文档。
- v5 多租户迁移给部署表增加了 `team_id`；SSH `encrypted_secret` 与 Nacos `encrypted_nacos_secret` 使用 `yuyan-team:${teamId}` 作为 AES-GCM AAD，直接改 `team_id` 会导致密文不可解，v6 必须先按原空间解密再按共享空间重加密。
- 共享作用域继续使用 `legacy-team` 可直接兼容网页端已有中央数据；v2 只在部署路由内覆盖为共享作用域和管理员能力，不改变 `/api/v2/me`、账号会话或 Agent 的身份隔离语义。
- v6 只应在独立中央服务启动时运行，Tauri 内嵌本地辅助服务不得合并设备数据库；迁移前备份、事务内搬迁，任何凭据转换失败都必须阻止中央服务带病启动。
- 普通部署 axios 当前还会按 URL 自动回落到 Tauri 本地服务，范围包含目标发布、状态、Nginx 和运行态；新边界应取消该隐式路由，仅由明确的 JDK、构建产物和 OpenAPI 辅助函数访问本地服务。
- 部署页已经在登录恢复和账号变化后调用当前 Tab 刷新，但目标 Tab 未保证先加载中央服务器列表；应把“服务器依赖 → 当前 Tab”固化为同一个可等待刷新处理器。
- 截图验收保持现有 Hero、Tab、筛选和表格布局；功能通过标准是李虹民登录 App 后看到与王彦聪网页端相同的服务器筛选项和部署目标，中央空库与中央请求失败必须表现为两个不同状态。
- 最终实现证明共享作用域可以只覆盖部署路由：两名不同账号通过各自鉴权上下文查询同一组目标，而 accountId、deviceId 和 Agent 任务边界不变。
- 设备 JDK 的数据库 ID 属于单机资源，不能随目标行并入共享空间；v6 会解除目标与后端配置中的设备 JDK 外键，仅保留 `required_jdk_alias` 作为目标构建要求，避免中央数据引用另一台设备的本地行。
- 真实刷新必须由当前页面返回 Promise；全局协调器对同一轮并发点击复用单个 Promise，失败原样抛出，下一轮仍可恢复，不需要依赖全局 DOM 事件。
- 最终门禁结果为服务端 86/86、前端工具 20/20、迁移专项 2/2、类型检查与生产构建通过；视觉模拟分别覆盖中央有数据、真实空库和 503 三种状态。
