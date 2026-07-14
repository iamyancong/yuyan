---
name: yuyan-app-update-proxy
description: 实现或审查雨燕桌面端自动更新、GitHub Release 查询、内网代理下载、预缓存、断点续传和安装状态。修改 UpdateCapsule、app-update API、deploy-controller、app_update.rs、GITHUB_TOKEN 或缓存目录时使用。
---

# 雨燕自动更新代理

## 固定架构

```text
Tauri 客户端
  └─ /deploy-api/app-update/check
       └─ 内网 API（容器 GITHUB_TOKEN）
            ├─ 查询 GitHub Releases
            ├─ 异步预下载 Release Asset
            └─ app-update-cache 缓存
```

- 客户端启动约 2 秒后首次静默检查，之后每 15 分钟检查一次，并保留手动“检查更新”入口。
- 客户端不持有 GitHub Token；`GITHUB_TOKEN` 只配置在 GitLab CI/CD Variables，并由 `.gitlab-ci.yml` 注入 API 容器。
- GitHub 仓库的 `PERSONAL_ACCESS_TOKEN` 用于 GitHub Actions 私有依赖，不替代 GitLab 的 `GITHUB_TOKEN`。

## 更新检测

- 使用 `/deploy-api/app-update/check?currentVersion&platform&arch&channel`。
- 若有效静态 manifest 存在，服务端优先使用；正常代理模式下允许 manifest 不存在并回退 GitHub Releases。
- 查询 Releases 时禁用缓存，忽略 draft，按语义版本排序，并选择包含当前平台安装包的最高版本。
- 平台资源映射：macOS 必须结合 `aarch64` / `x86_64` 架构选择对应 `.dmg`，Windows x86_64 选择 `.exe`。
- 只有远程版本更新且存在匹配资源时返回 `hasUpdate: true` 和 `downloadUrl`。
- 不把 GitHub Tag 当成可更新版本；必须存在带安装包资产的 GitHub Release。

## 预下载与缓存

- 中央 API 启动后定时查询最新 Release，并主动预热 macOS ARM、macOS Intel 和 Windows 安装包；更新检测也只负责确保任务已启动，不等待资源下载完成。
- 缓存目录固定为 `${DEPLOY_DATA_DIR}/app-update-cache`；生产默认路径为 `/data/yuyan-ops/deploy-data/app-update-cache`。
- 缓存文件使用 `${assetId}-${filename}`，稳定临时文件使用 `${assetId}-${filename}.part`，校验通过后原子重命名。
- 使用带 Promise 和进度快照的任务 Map 避免同一 asset 并发回源；服务端回源支持 Range、If-Range、指数退避和断点续传。
- EXE 必须具有 `MZ` 文件头；DMG 必须具有 `koly` 尾部签名；损坏缓存立即删除并回源。

## 客户端下载

- 命中有效缓存时直接 `sendFile`，支持 Range 和长期不可变缓存。
- 新客户端未命中缓存时轮询 `/deploy-api/app-update/cache-status`，下载接口在准备中返回 `202`，不得再创建第二条 GitHub 回源流。
- 旧客户端允许短暂等待同一缓存任务，仍未就绪时使用 GitHub Token 实时代理兼容；兼容代理不写缓存，尤其不得把 `206` 分段响应写成完整缓存。
- Tauri 原生层负责断点下载、进度、大小/SHA-256 校验、拉起安装程序和安全退出。
- 顶部更新胶囊仅在 Tauri 环境且接口返回有效更新时展示；不要为网页端伪造 Tauri 状态。

## 修改约束与验证

- 不在前端、URL、日志、仓库或 `tauri.conf.json` 中写入 Token。
- 不引入 GitHub Actions 到内网的强制 SSH 发布；内网 API 代理缓存是默认路径。
- 修改版本比较、Release 筛选或缓存逻辑时补充 `server/services/app-update-service.test.mjs`。
- 至少验证：旧版本有更新、同版本无更新、draft 被忽略、平台资产匹配、缓存损坏回源、单任务回源、服务端 Range/If-Range 续传和新客户端准备状态。
