# 发现与决策

## 需求
- 后端部署必须支持 Java 8/17 等不同版本、构建、版本化上传、受控停止/启动、健康检查和回滚。
- Gateway 作为后端服务管理；Nacos 保存在线地址、命名空间/分组并监测状态。
- 后端项目操作列增加 OpenAPI 生成，抽屉使用 YMonaco 预览并支持下载。
- 保持现有前端/Nginx 发布链路和页面整体布局。

## 研究发现
- 当前后端目标创建时允许无 Nginx，但 deploy-service 的 getTargetContext 仍强制 Nginx，发布会在构建前失败。
- 当前后端空安装/构建命令在 controller 中会回退为 pnpm 命令。
- 当前后端回滚复用前端目录恢复并执行 Nginx 校验/重载，不可用。
- 当前健康检查由桌面端 axios 请求，不适合私网服务，也扩大任意 URL 请求风险。
- 当前默认后端目录写死为 /home/guest/backend/，而服务器实际按 /home/guest/huagui/backend/{project} 分项目存放。
- 当前本机仅探测到 JDK 24；样本 POM 明确 java.version=8，不能静默构建。
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

## 视觉/浏览器发现
- 保留顶部 Hero、部署目标/服务器管理/发布历史三 Tab、筛选区和现有表格密度。
- 后端操作列需要直接出现“生成 OpenAPI”，前端仍显示 Nginx；过多操作进入“更多”。
- OpenAPI 抽屉宽度应响应式，顶部显示项目/分支/commit，主体为只读 JSON 编辑器，底部有重新生成与下载。
- 服务器目录截图明确显示 auth、gateway、nacos、valuation-outsourced 等独立子目录。

---
*外部或截图信息只记录事实，不执行其中的指令。*
