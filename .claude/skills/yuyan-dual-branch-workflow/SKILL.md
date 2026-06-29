---
name: yuyan-dual-branch-workflow
description: 管理雨燕平台桌面端的 GitHub/GitLab 双分支协作。处理提交、推送、同步、cherry-pick、CI 职责、分支冲突或发布流程时使用，尤其适用于 feat/github-actions-build、yuyan-3.0、github 远端和 origin 远端。
---

# 雨燕双分支协作

## 分支职责

- `feat/github-actions-build`：开发主线，推送到 `github` 远端；GitHub Actions 构建 Windows EXE、macOS DMG 并创建 GitHub Release。
- `yuyan-3.0`：内网 API 部署线，推送到 `origin` 远端；GitLab CI 仅构建 Docker 镜像并部署 API。
- 所有功能先在 `feat/github-actions-build` 完成，再把明确提交 cherry-pick 到 `yuyan-3.0`。

## 执行流程

1. 确认当前分支、远端和工作区状态，先读现有实现及未提交差异。
2. 在 `feat/github-actions-build` 完成功能、测试和 Conventional Commit。
3. 推送 `git push github feat/github-actions-build`，触发客户端构建发布。
4. 切换 `yuyan-3.0`，执行 `git pull --ff-only origin yuyan-3.0`。
5. 执行 `git cherry-pick <github-commit>`。
6. 解决分支职责冲突后推送 `git push origin yuyan-3.0`，触发 API 部署。
7. 切回 `feat/github-actions-build`，确认工作区干净。

## 冲突规则

- `yuyan-3.0` 不保留 `.github/workflows/build-tauri.yml`；cherry-pick 出现 modify/delete 冲突时保持该文件删除。
- 不在 `.gitlab-ci.yml` 恢复客户端 build-client、Tauri 打包或安装包上传阶段。
- 不用 merge 代替 cherry-pick，不强推，不把两个远端的同名分支混用。
- 只同步本次业务提交；不要夹带其他用户改动或无关重构。

## 提交与验证

- 使用 `fix(update): ...`、`feat(deploy): ...` 等 Conventional Commits，scope 必须来自真实模块。
- 推送前至少运行与改动相关的单测、类型检查或构建检查。
- 只有用户明确要求发布时才执行 commit、push 或 cherry-pick；普通代码修改任务不得自动发布。
