# 雨燕 SwiftVPN 桌面端 (yuyan-vpn)

> 雨燕 SwiftVPN 桌面端 —— 基于 Tauri 2 + Vue 3 的多 VPN 并行连接与智能分流网络管理工具。

雨燕 SwiftVPN 旨在解决企业多云或异地混合办公环境下，需要同时连接多个不同类型 VPN（如 Fortinet 与 aTrust）并进行精细化分流的痛点。通过对底层网络接口、路由表和 DNS 的动态守护，雨燕能够保障在双 VPN 并行连接时，流量智能按需分流，避免默认网关冲突导致的断网与网络死锁。

---

## ✨ 核心功能

### 1. 双 VPN 并行管理
* **Fortinet (SSL VPN) 支持**：集成对 Fortinet 网络协议的连接控制。
* **aTrust (安全接入网关) 支持**：集成对 aTrust 客户端及守护进程的连接与管道控制。
* **双通道独立启停**：支持两路 VPN 的同时连接、独立断开或一键全部断开。

### 2. 智能分流与路由注入
* **自定义网段分流**：支持在配置中为每个 VPN 独立指定分流网段（如 `192.168.100.0/24`），连接建立后自动向系统注入路由规则。
* **断网与路由守护**：实时监控默认网关和主 DNS 变动。自动摘除 PPP 默认服务网关，当系统代理或 DNS 遭到 VPN 意外篡改或死锁时，能够秒级自动重置恢复，确保公网与内网同时畅通。

### 3. 特权操作与凭证保护
* **Sudo 安全提权**：部分底层路由修改及网络接口操作需 root 权限。本客户端支持在本地会话中通过 `sudo -S id` 提权验证，且仅在内存中暂存凭证，绝不持久化到磁盘，确保账户安全。
* **二次身份认证 (MFA)**：内置 stdin 管道交互。当 VPN 服务端触发二次验证时，客户端可弹出图形化 MFA 验证码输入框，并实时回传给子进程。

### 4. 极致交互与系统适配
* **Dock 图标跟随主题**：在 macOS 下通过 Cocoa API 动态刷新 Dock 栏图标，提供亮色/暗色两套高精度 C4D 液态玻璃图标。
* **实时日志终端**：内嵌控制台，流式输出 VPN 进程的标准输出与标准错误，便于快速排查连接与协议错误。
* **软件自动更新**：内置版本更新检测服务，支持多线程异步包下载、原生断点续传及热重启更新。

---

## 🏗️ 技术架构

雨燕 SwiftVPN 采用「Tauri 2 (Rust) 外壳 + Vue 3 前端 + 外部子进程管道通信」的架构：

```
┌────────────────────────────────────────────────────────┐
│           Tauri 2 (Rust, src-tauri/)                   │
│  · 主进程生命周期与窗口管理、网络状态监控与路由表控制       │
│  · 托盘菜单、macOS Dock 明暗图标 (Cocoa API 调用)         │
│  · 提权密码暂存、多线程 VPN 子进程管道管道通信             │
└───────────────┬──────────────────────────┬─────────────┘
                │ WebView                   │ spawn child process
                ▼                           ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│    前端 SPA (Vue 3, src/) │   │     外部 VPN 客户端依赖    │
│  · 状态轮询/并行交互展示  │   │  · openfortivpn (Fortinet)│
│  · 路由与分流配置管理面板 │   │  · aTrust-client/daemons  │
│  · 实时日志与终端面板    │   │  · 动态路由注入/系统 DNS   │
└───────────────────────────┘   └───────────────────────────┘
```

### 技术栈
* **前端 (Frontend)**
  * Vue 3.5 (Setup Script + TypeScript)
  * Vite 7 + vue-tsc (构建工具与类型检查)
  * Vue Router 4 (Hash 模式)
  * Ant Design Vue 4 + vxe-pc-ui 4 (UI 组件库)
  * `@ycwang-dev/components`、`@ycwang-dev/hooks`、`@ycwang-dev/utils` (企业级封装库)
  * Less (样式预处理)
* **桌面后端 (Desktop Backend)**
  * Tauri 2 (Rust 2021)
  * `tokio` (异步任务与子进程管理)
  * `cocoa` & `objc` (macOS 原生 Dock API 绑定)
  * `tauri-plugin-opener` & `tauri-plugin-dialog`

---

## 📁 目录结构

```
yuyan-vpn/
├── src/                     # 前端 Vue3 SPA 源码
│   ├── views/               # 核心视图页面
│   │   ├── Dashboard/       # 控制中心（连接状态展示与独立启停交互）
│   │   ├── Settings/        # 分流配置（VPN 节点、账号、自定义路由网段）
│   │   └── Console/         # 日志终端（实时流式查看 VPN 日志）
│   ├── layouts/             # 框架布局组件
│   ├── api/                 # 与 Tauri Command 交互的接口封装
│   ├── components/          # 公共组件
│   ├── hooks/ & composables/# 组合式逻辑与主题管理
│   ├── router/              # 路由配置
│   └── main.ts              # 应用入口
├── src-tauri/               # Tauri Rust 后端
│   ├── src/
│   │   ├── vpn/             # VPN 业务领域
│   │   │   ├── fortinet.rs  # Fortinet 状态机、守护进程与网络监测
│   │   │   ├── atrust.rs    # aTrust 启动控制与 stdin MFA 管道交互
│   │   │   └── mod.rs       # 统一 we VpnManager 状态和配置管理
│   │   ├── app_update.rs    # 自动检查更新与多线程下载模块
│   │   ├── lib.rs           # Tauri Command 注册及 macOS 窗口事件绑定
│   │   └── main.rs          # Rust 程序入口
│   ├── resources/           # 暗色/亮色高精度客户端图标等资源
│   ├── tauri.conf.json      # Tauri 配置文件（打包、特权插件配置）
│   └── Cargo.toml           # Rust 依赖包管理
└── package.json             # Node.js 依赖与脚本配置
```

---

## 🚀 快速开始

### 1. 环境准备
* **Node.js**：建议使用 Node.js ≥ 20.0.0 (推荐 22 LTS)
* **pnpm**：包管理器建议使用 pnpm ≥ 9
* **Rust**：确保已安装 Rust 稳定版工具链 (含 `rustc`, `cargo` 1.75+)
* **VPN 外部底座依赖**：
  * Fortinet VPN 连接依赖系统内配置好 `openfortivpn`（macOS 用户建议通过 `brew install openfortivpn` 安装）。
  * aTrust 连接依赖本地已安装官方 `aTrust` 客户端软件（部分 API 需在本地服务可用）。

### 2. 配置 NPM 私有源
本项目使用了托管于 GitHub Packages 的 `@ycwang-dev/*` 企业级私有包。安装依赖前请配置您的 GitHub Token：

```bash
# 设置您的 GitHub 访问 Token（需要有 read:packages 权限）
export GITHUB_TOKEN=<your_github_token>

# 安装依赖
pnpm install
```

> **提示**：项目根目录下的 `.npmrc` 会自动读取此环境变量，并将 `@ycwang-dev` 作用域下的请求重定向到 `npm.pkg.github.com`。

### 3. 常用开发与构建命令

#### 开发调试 (Tauri)
运行以下命令会以开发模式启动 Tauri，它将启动 Rust 后端并拉起本地窗口，前端热重载运行在 `localhost:1420`。
```bash
pnpm dev
```

#### 仅调试前端 (无原生外壳)
若只需在普通浏览器中调试前端 UI，可直接运行：
```bash
pnpm frontend:dev
```

#### TypeScript 类型检查
```bash
pnpm typecheck
```

#### 编译打包
执行以下命令将编译前端静态资源，并在 `src-tauri` 中完成 Rust 编译与签名。
```bash
pnpm build
```
打包成功后，编译产物输出在 `src-tauri/target/release/bundle/` 中（如 macOS 下的 `.dmg` / `.app`，Windows 下的 `.exe` / `.msi`）。

---

## ⚙️ 配置说明

客户端配置持久化于用户的系统数据目录。配置文件为 `vpn_config.json`，路径如下：
* **macOS**: `~/Library/Application Support/yuyan-vpn/vpn_config.json`
* **Windows**: `%APPDATA%\yuyan-vpn\vpn_config.json`

### 配置文件结构示例

```json
{
  "fortinet": {
    "enabled": true,
    "host": "vpn.yourcompany.com",
    "port": 443,
    "username": "employee_name",
    "password": "encrypted_or_plain_password",
    "savePassword": true,
    "customRoutes": [
      "192.168.10.0/24",
      "10.200.0.0/16"
    ]
  },
  "atrust": {
    "enabled": false,
    "host": "atrust.yourcompany.com",
    "port": 60201,
    "username": "employee_name",
    "password": null,
    "savePassword": false,
    "customRoutes": []
  }
}
```

---

## 📄 许可

私有项目，仅供内部及团队授权使用。
