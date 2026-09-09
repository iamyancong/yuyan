# 雨燕（Yuyan）开源贡献指南

感谢你对雨燕项目的关注！我们欢迎来自开源社区的代码贡献、功能建议、Bug 报告与文档优化。

## 🛠️ 开发环境要求

- **Node.js** ≥ 20（推荐 22 LTS）
- **pnpm** ≥ 9
- **Rust** 稳定版工具链（用于 Tauri 桌面端构建）
- 各平台 Tauri 系统前置依赖（参考 [Tauri 官方文档](https://tauri.app/start/prerequisites/)）

## 🚀 本地启动与调试

```bash
# 1. 克隆仓库
git clone https://github.com/ycwang-dev/yuyan.git
cd yuyan

# 2. 安装依赖（已全面接入公网 @yss-ui 开源生态，无需任何私有 Token）
pnpm install

# 3. 运行开发环境（同时拉起前端与本地 Express 服务）
pnpm dev

# 仅调试前端 SPA（浏览器运行模式）
pnpm frontend:dev
```

## 📋 提交规范 (Conventional Commits)

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

- `feat(scope): ...`：新功能
- `fix(scope): ...`：Bug 修复
- `docs(scope): ...`：文档修改
- `refactor(scope): ...`：重构（不增加新功能也不修改原有行为）
- `test(scope): ...`：增加或修改测试用例
- `chore(scope): ...`：构建过程、辅助工具或依赖变动

示例：
```bash
git commit -m "feat(scaffold): 支持自定义模板变量注入"
git commit -m "fix(deploy): 修复 SSH 传输断点恢复超时问题"
```

## 🧪 提测与质量门禁

在提交 PR 之前，请务必在本地运行并通过以下质量门禁：

```bash
# 1. TypeScript 类型检查
pnpm typecheck

# 2. 前端构建测试
pnpm frontend:build

# 3. 运行单元测试套件
pnpm test:frontend-utils
pnpm test:server
```
