---
name: yuyan-release-versioning
description: 管理雨燕桌面端版本号、GitHub Actions 自动递增、Tauri 打包、Release 资源和本地更新验证。修改 package.json、tauri.conf.json、Cargo.toml、Cargo.lock、bump-version.js、apply-version.js 或 build-tauri.yml 时使用。
---

# 雨燕版本发布管理

## 版本源

- 源码版本必须同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。
- 批量修改使用 `node scripts/apply-version.js <version>`；提交前检查四处一致。
- Tauri 运行时版本以 `tauri.conf.json` 为准，不要只修改一个文件做正式发布。

## 持续集成与发版流水线（对标 yss-ui）

- **日常提交与 CI 门禁**：
  - `feat/github-actions-build` 或 `main` 的 Push / PR 仅触发 `.github/workflows/ci.yml`。
  - 仅运行代码质量、类型检查、测试与前端/Rust 构建验证；**不修改版本号、不打包、不创建 GitHub Release**。
- **手动客户端发版**：
  - 在 GitHub Actions 中手动触发 `.github/workflows/release-tauri.yml`（`workflow_dispatch`）。
  - 支持参数：`bump` (`patch` | `minor` | `major`)、`dry_run`（预览模式）、`prerelease`、`custom_notes`。
  - **前置质量门禁**：发版前通过 `scripts/verify-ci-status.mjs` 校验当前 Commit 的 CI 必须已经成功（`success`），若 CI 正在运行自动轮询等待，若失败立即阻断发版。
  - **版本推算与日志**：`scripts/bump-version.js` 根据选定 `bump` 类型计算下一版本，自动提取自上一 Release Tag 至今的 Git Commit 记录作为 Release Notes。
  - **版本回写**：发版成功后，CI 通过 `scripts/apply-version.js` 统一更新四处版本，并推回 `chore(release): bump version to x.y.z [skip ci]`。
- **Tag 逃生舱**：直接推送 `v*` Tag 触发发版时，流水线直接使用 Tag 自身版本，不进行二次 bump。

## Release 要求

- GitHub Release 必须同时包含 Windows x86_64 `.exe`、macOS ARM64 `.dmg` 和 macOS Intel x86_64 `.dmg`，以及 `latest.json`、Windows 签名 NSIS `.exe + .sig`、macOS 双架构 `.app.tar.gz + .sig`。
- 免费发布允许 macOS ARM64 与 Intel 产物使用 ad-hoc 签名，不要求 Apple Developer Secrets；首次打开可能需要用户在 Finder 中右键选择“打开”。
- ad-hoc 构建不得依赖 macOS 钥匙串保存持久凭据，账号、设备私钥和本机数据库主密钥必须使用应用本地加密保险库；Windows 继续使用 Credential Manager。
- 只有 Tag、源码 zip 或 tar.gz 不构成客户端可用更新。
- Release 可标记 prerelease，但 Tag 必须是可比较的语义版本；旧 hash 后缀版本不得压过更高正式版本。
- GitLab CI 不打包客户端，不创建 GitHub Release。

## 验证清单

1. 确认四处源码版本一致。
2. 运行服务端版本选择测试和 Vue 类型检查。
3. 检查 GitHub Actions 的 Windows、macOS ARM64、macOS Intel 和 release jobs。
4. 确认两个 macOS `.app` 的架构与内置 Node 架构一致；免费 ad-hoc 产物不校验 Developer ID 或 Team ID，并确认启动路径不访问 macOS 钥匙串。
5. 检查 Release 资产同时包含 Windows x86_64、macOS ARM64、macOS Intel 安装包，以及三平台签名 Updater 资源和 `latest.json`。
6. 用低一版客户端请求 `/deploy-api/app-update/check`，应返回新版本和下载地址。
7. 用同版本客户端请求，应返回“已是最新版本”。

不要通过把本地版本改成极低值并提交来模拟更新；临时验证完成后必须恢复真实版本。
