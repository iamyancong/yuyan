---
name: yuyan-release-versioning
description: 管理雨燕桌面端版本号、GitHub Actions 自动递增、Tauri 打包、Release 资源和本地更新验证。修改 package.json、tauri.conf.json、Cargo.toml、Cargo.lock、bump-version.js、apply-version.js 或 build-tauri.yml 时使用。
---

# 雨燕版本发布管理

## 版本源

- 源码版本必须同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`。
- 批量修改使用 `node scripts/apply-version.js <version>`；提交前检查四处一致。
- Tauri 运行时版本以 `tauri.conf.json` 为准，不要只修改一个文件做正式发布。

## 自动递增

- `feat/github-actions-build` Push 触发 `.github/workflows/build-tauri.yml`。
- `scripts/bump-version.js` 读取 GitHub Releases 中最新的干净语义版本。
- 当源码版本不高于线上最新版本时自动递增 patch。例如线上为 `v1.0.2`、源码为 `1.0.2`，本次 CI 发布 `v1.0.3`。
- CI 通过 `scripts/apply-version.js` 把计算版本写入构建工作区；不要尝试覆盖已有 Release。
- Tag 触发时使用 Tag 自身版本；重跑历史分支流水线前先确认不会产生意外的新版本。

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
