# 雨燕中央数据库与 Nginx 配置灾备及恢复指南

本文档说明雨燕平台中央部署数据库（`deploy.sqlite`）每日异地备份，以及 Nginx 配置中央快照的架构、日常运维与灾备恢复操作流程。

---

## 1. 备份包含什么 / 不包含什么

### ✅ 备份包含内容

中央库每日通过 SQLite `VACUUM INTO` 生成一致性快照并压缩为 `.sqlite.gz`，其中包含：

- 服务器配置与连接信息（`deploy_servers`，凭据为 AES-256-GCM 密文）
- 托管 / 外部 Nginx 实例信息（`nginx_instances`、`nginx_runtimes`）
- 部署目标配置（`deploy_targets`、`backend_target_configs`）
- 发布历史记录（`deploy_records`）
- **Nginx 配置中央快照表（`nginx_config_snapshots`）**：保存所有纳管 Nginx 配置文件的最新正文、SHA-256 及 SSL 证书到期时间摘要
- 共享环境、Java 运行时、中央灾备设置及账号权限元数据

### ❌ 备份不包含内容

- **`DEPLOY_SECRET_KEY` 环境变量**：绝不写入备份文件或传往备份机
- **SSL 私钥文件（`ssl_certificate_key`）及证书正文**：巡检仅记录证书路径和到期时间（`notAfter`），绝不读取或存储私钥
- **构建产物、发布日志大文件、CAS 对象池**：不在本期异地备份范围内

> [!CAUTION]
> **⚠️ 密钥必须单独妥善保管！**
>
> 数据库中的服务器 SSH 密码、SSH 私钥、Nacos 密码均使用 `DEPLOY_SECRET_KEY` 加密存储。
> **若丢失原 `DEPLOY_SECRET_KEY`，即使恢复了中央库文件，服务启动后也无法解密任何服务器凭据。**
> 请务必将 `DEPLOY_SECRET_KEY` 单独保存在运维密码库或离线安全介质中，并与数据库备份分开存放。

---

## 2. 在雨燕平台登记备份服务器与开启定时备份

1. 在雨燕部署中心「**服务器管理**」中新增一台用于存放异地备份的 Linux 服务器（建议配置免密登录或独立密钥；**备份 SSH 账号需对目标备份目录拥有直接写权限，不走 `sudo` 提权**）。
2. 点击部署中心顶部「**中央灾备**」按钮打开灾备抽屉（仅 `admin` 管理员可修改配置）：
   - **备份服务器**：选择刚登记的备份机。
   - **远端备份目录**：默认 `/bak/wangyancong-yuyan`。目录必须为至少两级绝对路径，仅允许 `[A-Za-z0-9._/-]`，禁止包含 `..`、空白、引号及系统关键目录（`/etc`、`/usr`、`/root` 等）。
   - **每日定时备份开关**：开启后，服务进程将在每天指定时刻自动运行。
3. 点击「**保存配置**」。

> - **每日调度时间**：Nginx 配置巡检与中央库备份共用每日定时调度，默认在服务器本地时间 **02:30** 执行（先巡检、再备份），可通过环境变量 `YUYAN_CENTRAL_BACKUP_TIME=HH:mm` 调整。桌面端本地辅助服务不运行此定时任务。
> - **删除服务器联动**：若在「服务器管理」中删除了当前被选为备份服务器的部署服务器，平台会自动清空该备份服务器引用并关闭每日定时备份开关，同时清理该服务器关联的 Nginx 配置中央快照。

---

## 3. 文件命名与保留规则

### 文件命名

- 正式备份文件：`yuyan-deploy-YYYYMMDD-HHmmss.sqlite.gz`（服务器本地时区时间）
- 校验文件：`yuyan-deploy-YYYYMMDD-HHmmss.sqlite.gz.sha256`（标准 `sha256sum -c` 格式）
- 上传过程中的临时文件：`yuyan-deploy-YYYYMMDD-HHmmss.sqlite.gz.tmp-<12位hex>`，校验通过后通过 SFTP 原子 `rename` 落地为正式文件。

### 保留策略

每次备份成功后，通过 SFTP 遍历目录逐个清理过期文件（绝不使用 shell 通配符，绝不触碰不匹配本规则的任何其他文件或目录）：

1. **日备**：保留按时间最新的 **7 份** 正式备份及其 `.sha256`。
2. **月备**：在当前自然月及往前 2 个自然月（共 **3 个月**）内，每月额外保留 **1 号** 生成的最新 1 份正式备份及其 `.sha256`。
3. **清理孤儿文件**：主文件已清理的孤儿 `.sha256`，以及超过 24 小时的残留 `.tmp-*` 文件一并清理。

---

## 4. 手动备份与巡检

- 在「**中央灾备**」抽屉中，`operator` 与 `admin` 账号均可点击：
  - **立即备份**：立即执行一次完整的中央库快照、压缩、SFTP 上传与远端校验。同一时刻只允许一个备份任务执行，并发点击会提示「正在备份」。
  - **立即巡检**：立即扫描全部已登记服务器的纳管 Nginx 配置与 SSL 证书到期时间（30 天内到期标橙，已过期标红）。
- `viewer`（只读账号）仅可查看状态与证书列表，无法触发备份或巡检。

---

## 5. 从备份机取回文件（示例）

假设备份机地址为 `backup-host.internal`、SSH 端口 `10022`、账号 `backup`，备份目录为 `/bak/wangyancong-yuyan`：

```bash
# 查看备份机上的最新备份
ssh -p 10022 backup@backup-host.internal "ls -lh /bak/wangyancong-yuyan/"

# 下载指定备份及 sha256 校验文件到中央服务器临时目录
mkdir -p /tmp/yuyan-restore
scp -P 10022 \
  backup@backup-host.internal:/bak/wangyancong-yuyan/yuyan-deploy-20261125-023000.sqlite.gz \
  backup@backup-host.internal:/bak/wangyancong-yuyan/yuyan-deploy-20261125-023000.sqlite.gz.sha256 \
  /tmp/yuyan-restore/
```

---

## 6. 中央库恢复步骤

> [!IMPORTANT]
> 页面不提供一键恢复中央库功能，避免误操作覆盖线上库。请严格按以下 CLI 步骤执行。

1. **先停止雨燕中央服务**（例如 `systemctl stop yuyan-server` 或停止对应容器/PM2 进程）。
2. 运行仓库提供的恢复脚本 `scripts/restore-central-db.sh`：

```bash
./scripts/restore-central-db.sh \
  --file /tmp/yuyan-restore/yuyan-deploy-20261125-023000.sqlite.gz \
  --data-dir /var/lib/yuyan-deploy
```

脚本会自动完成：
- 校验 `.sqlite.gz` 与 `.sha256` 一致性（不匹配立即中止）
- 解压并进行 `PRAGMA integrity_check`（必须为 `ok`）
- 检查 `deploy.sqlite-wal` 是否残留并提示停服确认
- 将当前 `deploy.sqlite`（含 `-wal`、`-shm`）重命名为 `deploy.sqlite.before-restore-<时间戳>` 留底
- 原子替换为恢复后的 `deploy.sqlite`

3. **使用原来的 `DEPLOY_SECRET_KEY` 启动雨燕中央服务**：

```bash
export DEPLOY_SECRET_KEY="<原来的密钥>"
# 启动中央服务...
```

4. 启动后打开雨燕界面，核对服务器列表、部署目标和发布记录，可对一台服务器点击「测试连接」验证 SSH 凭据解密正常。

---

## 7. Nginx 配置从中央快照恢复步骤

当目标机器的 Nginx 配置文件被误删或损坏时，无需手动翻库：

1. 在部署目标列表点击该目标的「**Nginx 配置**」打开配置抽屉。
2. 点击工具栏中的「**从中央备份恢复**」按钮（若中央暂无快照或快照与线上完全一致，按钮会禁用并提示原因）。
3. 在弹出的只读 Diff 弹窗中核对左侧「中央备份（含更新时间、来源）」与右侧「线上当前」差异（若线上文件已被删除，右侧会提示「线上文件不存在」）。
4. `operator` 或 `admin` 账号点击「**载入编辑器**」将内容放入编辑器（不会自动保存覆盖线上）。
5. 检查内容无误后，点击抽屉底部「**保存并重载**」，仍会走标准 `nginx -t` 校验与重载流程（校验失败自动回滚）。

---

## 8. 常见失败排查

| 现象 | 可能原因 | 排查方式 |
| --- | --- | --- |
| 报错「目录校验不通过」 | 使用了 `/`、`/etc` 等系统目录、相对路径、含 `..` 或空白/引号 | 改为至少两级且仅含 `[A-Za-z0-9._/-]` 的安全路径，如 `/bak/wangyancong-yuyan` |
| 报错「Permission denied」或创建目录失败 | 备份机登录账号对远端目录无直接写权限 | SFTP 不走 `sudo`，请确保备份账号对父目录/目标目录拥有写权限 |
| 备份成功但日志提示跳过远端 sha256 | 备份机精简系统未安装 `sha256sum` 命令 | 已校验 SFTP 上传后的文件字节大小；建议在备份机安装 `coreutils` |
| 恢复后提示「服务器凭据解密失败」 | 启动服务时使用的 `DEPLOY_SECRET_KEY` 与备份时不一致 | 核对环境变量或 `.env` 中的 `DEPLOY_SECRET_KEY` 并重启服务 |
| 并发点击提示 409「正在备份」 | 已有手动或定时备份任务在执行 | 稍等当前备份完成再重试 |
