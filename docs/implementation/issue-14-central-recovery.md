# Issue #14：中央短中断恢复

关联：https://github.com/iamyancong/yuyan/issues/14

## 交付范围

本次实现为 **P0 + 部分 P1**：P0 覆盖列表短中断恢复、快照保留和执行结果与刷新解耦；部分 P1 覆盖持久化任务结果、按任务 ID 只读对账及手动核实。不包含执行进程重启后的任务续跑。

## 行为与边界

- 服务器、目标、发布记录读取失败时保留已有列表；成功的空列表同样属于有效快照。
- 网络错误、读取超时、HTTP 408/500/502/503/504 使用 1、2、4、6、8 秒退避；首次失败后最多使用 30 秒恢复预算，单次读取最多 5 秒。认证、权限、业务错误和主动取消不进入重试。
- 有快照时恢复过程展示 warning，无快照时展示 error。恢复预算或次数耗尽后保留快照并展示明确错误，用户可立即开始新一轮重试。
- 页面刷新使用独立取消信号。同一查询合并请求；新查询、账号/团队变化、页面停用或销毁会废弃旧请求。取消时同时清除提示和不可用标记，避免无提示地禁用操作；切 Tab 后在 180ms 后重新读取，页面停用前未完成或失败的查询会在重新激活时探测。
- 目标列表先展示，运行态徽章异步补齐，不占用列表恢复预算。运行态读取失败沿用轮询退避，后端服务探测失败显示 unknown 并保留错误详情。
- 有筛选时每轮额外读取一次全量目标，用于更新分支选项和目录占用校验缓存；无筛选时直接复用当前列表结果。这是缓存纠偏的请求成本。
- 已确认的执行终态先完成展示和通知，随后独立刷新列表。刷新异常不能转换成发布、回滚或服务启停失败。
- 已知中央不可用时，禁用新发布、回滚及服务启停；发布确认框在最终执行前再次检查。结果待确认期间禁止重复发起操作。
- 流式事件附带持久化 taskId/targetId；只读接口 `GET /targets/:id/deploy-tasks/:taskId` 校验目标所属团队及任务归属，返回运行快照或持久化终态。
- 已有任务的观察请求绑定 taskId，防止误订阅同目标后来启动的任务。后端项目按已有 operationId 查询。
- 进度断线后只查询原任务，不重放 POST。查到执行失败或重启中断时展示真实失败；无法核实时展示“结果待确认”，已有任务标识时可手动核实。
- 未收到任何任务标识前执行连接中断，不能确定服务端是否受理；此时保留“结果待确认”，需要核实发布历史，不能自动重发。
- 中央执行进程真正重启后，沿用现有 interrupted / stopped / service_restarted 收口行为。本实现不承诺执行进程重启后任务继续运行。

## 实现位置

- `src/utils/centralReadRecovery.ts`：只读恢复、退避、超时、取消。
- `src/views/NginxDeploy/hooks/useCentralRefreshRecovery.ts` / `src/views/NginxDeploy/hooks/useNginxDeployLifecycle.ts`：页面刷新会话与状态。
- `src/views/NginxDeploy/hooks/useDeployConnectionState.ts` / `src/views/NginxDeploy/hooks/useNginxDeployProgress.ts`：任务结果与列表刷新隔离、待确认与手动核实。
- `src/api/deployTaskRecovery.ts` / `src/api/deploy.ts`：按任务 ID 对账及 NDJSON 连接恢复。
- `server/services/deploy-task-reconciliation.mjs`：访问校验及持久化终态读取。
- `server/utils/central-read-recovery.mjs`：本地 Agent 查询中央任务时的有限重试。

数据库按现有增量迁移模式为 deploy_tasks 添加 result_json，保存服务启停等不对应发布记录的执行结果；已有发布任务仍可通过 result_ref 查询记录。接口增加的任务标识字段兼容旧客户端。新客户端连接旧服务端时，如果没有稳定任务标识，会停留在结果待确认，不猜测终态。

回归测试位于 `scripts/tests/deploy-resilience.test.mjs`、`src/utils/tests/centralReadRecovery.test.ts` 和 `server/services/tests/deploy-task-reconciliation.test.mjs`。页面回归覆盖恢复中取消、切换到已有缓存的 Tab、停用后重新激活，避免故障状态残留。

## 验证命令

```sh
pnpm test:deploy-resilience
pnpm test:frontend-utils
pnpm test:server
pnpm typecheck
pnpm frontend:build:ci
```

浏览器验收先启动 Vite 或构建预览，然后执行：

```sh
YUYAN_TEST_URL=http://127.0.0.1:1421 python3 scripts/tests/deploy-resilience.browser.py
```

浏览器脚本使用独立 Chrome 上下文与测试账号夹具，拦截全部部署 API、GitLab API，并阻止其他外部请求；不会启动真实发布。覆盖 20 秒列表中断、20 秒进度查询中断、成功后刷新失败、无缓存错误、重试耗尽与手动恢复。截图和结果默认写入 `/tmp/yuyan-issue14-browser`。

服务端测试使用独立临时 SQLite，验证结果跨重启保存、真实中断状态收口，以及跨团队和目标错配时不可读取任务；不会重启实际中央服务。
