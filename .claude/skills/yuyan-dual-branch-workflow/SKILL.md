---
name: yuyan-dual-branch-workflow
description: 管理雨燕平台桌面端的 GitHub/GitLab 双分支协作。凡是处理代码提交、提交信息、推送、同步、cherry-pick、PR/MR、CI 职责、分支冲突或发布流程时必须使用，尤其适用于 feat/github-actions-build、yuyan-3.0、github 远端和 origin 远端。
---

# 雨燕双分支协作

## 分支职责

- `feat/github-actions-build`：开发主线，推送到 `github` 远端；GitHub Actions 构建 Windows EXE、macOS DMG 并创建 GitHub Release。
- `yuyan-3.0`：内网 API 部署线，推送到 `origin` 远端；GitLab CI 仅构建 Docker 镜像并部署 API。
- 所有功能先在 `feat/github-actions-build` 完成，再把明确提交 cherry-pick 到 `yuyan-3.0`。

## 强制触发场景

只要用户表达了以下任一意图，必须先读取本 Skill，并把双分支闭环纳入任务验收：

- “提交代码”“帮我 commit”“生成提交信息”“提交并推送”“发布 Branch”“推到远端”。
- “同步到网页端”“部署 Web 端”“GitLab CI”“GitHub Actions”“cherry-pick”“解决冲突”。
- 任何会产生 Git commit、push、tag、release、CI 触发或跨分支同步的操作。

默认假设：凡是业务代码、样式、接口、构建配置或服务端逻辑的提交，都需要同步到 `yuyan-3.0`。只有用户明确说明“只提交 App 分支”“不要同步 yuyan-3.0”“仅本地提交不推送”时，才允许跳过对应步骤，并在最终回复中说明跳过原因。

术语约定：用户说“提交代码”时，默认含义是 `git commit` 后继续 `git push` 到对应远端；不要把本地 commit 当作任务完成。只有用户明确说“只本地提交”“不要推送”时，才允许不 push。

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
- 如果当前存在未提交改动，先区分本次改动与用户既有改动；不得为了 cherry-pick 或切分支回滚用户改动。
- 推荐使用独立 worktree 处理 `yuyan-3.0`，避免污染 `feat/github-actions-build` 客户端工作区。
- **注意包名与路径差异 (Critical)**：客户端主线 `feat/github-actions-build` 中使用核心组件库 `@ycwang-dev/components`（以及 `hooks`、`utils` 等）；而内网分支 `yuyan-3.0` 对应使用企业内网组件库 `@yss-ui/components`（及其 hooks、utils）。当从客户端 cherry-pick 代码到内网分支时，若修改涉及到这些包的引入，**必须手动将 `@ycwang-dev/components` 改为 `@yss-ui/components`**（对 hooks 和 utils 亦同），并测试本地构建通过。

## 提交与验证

- 使用 `fix(update): ...`、`feat(deploy): ...` 等 Conventional Commits，scope 必须来自真实模块。
- 推送前至少运行与改动相关的单测、类型检查或构建检查。
- 用户只要求“修改代码”时，不自动 commit/push/cherry-pick；用户要求“提交代码/发布/推送”时，默认执行包含 push 的完整双分支闭环。

## 提交任务验收清单

提交或推送前必须逐项确认：

1. 当前提交是否已在 `feat/github-actions-build` 完成并验证。
2. 是否需要同步到 `yuyan-3.0`；默认需要，除非用户明确排除。
3. `yuyan-3.0` 是否只 cherry-pick 本次明确提交，没有夹带无关改动。
4. 两个分支职责是否保持正确：GitHub Actions 只在客户端主线，GitLab CI 只做内网 API/Web 部署。
5. 最终回复必须写明：客户端分支提交哈希、Web/API 分支提交哈希或跳过同步的明确原因。
