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

## 执行流程（Worktree 物理双目录标准）

1. **客户端主线提交**：
   - 在当前目录 `yuyan-app`（`feat/github-actions-build`）确认差异，完成功能与单测/构建验证。
   - 生成符合规范的 Conventional Commit。
   - 推送：`git push github feat/github-actions-build`，触发 GitHub Actions 客户端构建发布。
2. **内网 API 部署线同步（通过物理 Worktree）**：
   - 进入同级独立物理目录 `../yuyan-app-internal`（已绑定 `yuyan-3.0` 分支，无需在主目录切分支）。
   - 拉取最新代码：`git pull --ff-only origin yuyan-3.0`。
   - 同步提交：`git cherry-pick <github-commit>`。
   - 解决分支专属职责差异（如保留 `.github/workflows/build-tauri.yml` 删除状态）。
   - 推送：`git push origin yuyan-3.0`，触发内网 GitLab CI 仅构建 Docker 镜像并部署 API。
3. **两边状态核验**：
   - 确认主工作区 `yuyan-app` 与物理工作区 `../yuyan-app-internal` 均处于 clean 状态。

## 冲突与隔离规则

- **包名完全同构 (Zero-Conflict)**：客户端主线与内网分支已全面统一为公网 `@yss-ui/*` 组件库与 Hooks 体系，cherry-pick 业务代码时**无需再手动替换任何包名**，零语法冲突！
- **物理目录隔离**：通过 `../yuyan-app-internal` 独立工作区执行 cherry-pick 和 push，彻底避免在主开发目录下频繁切换分支导致 node_modules 变动或本地未提交改动被污染。
- **分支职责专属保留**：
  - `yuyan-3.0` 不保留 `.github/workflows/build-tauri.yml`；cherry-pick 出现 modify/delete 冲突时直接保留删除。
  - 不在 `.gitlab-ci.yml` 恢复客户端构建或打包阶段。
- **原子闭环**：不使用 merge 代替 cherry-pick，只同步本次业务相关 commit，不夹带无关改动。

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
