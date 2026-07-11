# 进度日志

## 会话：2026-07-11 双 VPN 故障修复

### 阶段 7：双 VPN 连接与断开故障诊断
- **状态：** complete
- 已完成：
  - 读取项目规范、文件规划技能、用户 walkthrough 和故障截图。
  - 从截图确认 `get_vpn_state` 请求悬挂，aTrust 一直处于 Connecting，全部断开无效。
- 已确认根因：aTrust 自锁死、FIFO 提前删除、成功日志只解析 stdout、sudo 状态检测错误，以及 Fortinet TLS 参数未与独立脚本对齐。

### 阶段 8：连接生命周期修复
- **状态：** in_progress
- 已完成：
  - 两套连接/断开命令仅在状态读写时短暂加锁，系统命令执行期间不再阻塞查询。
  - aTrust FIFO 改为读取完成后清理，密码增加 TOML 转义测试。
  - aTrust stdout/stderr 统一解析，正确识别真实虚拟 IP、监听成功、MFA、验证码和错误。
  - Fortinet 补齐独立脚本已验证的 TLS/cipher 参数。
  - 前端状态并行查询且禁止轮询重入；全部断开无条件并行执行并接入 sudo 验证。
  - 用户截图实际验证双 VPN 同时 Connected，IP 分别为 `172.20.0.2` 与 `20.0.0.21`。
- 验证结果：
  - `cargo test --lib`：7/7 通过。
  - Node 22 环境下 `pnpm run typecheck`：通过。
- 待完成：用户点击“全部断开”并输入一次 macOS 密码后，检查 root 残留进程和接口是否清零。

### 阶段 8 补充：公网应用断网回归
- 现场证据：默认路由与 `PrimaryInterface` 为 `ppp0`，主 DNS `Not Reachable`，Apple/Google 域名均解析失败；系统代理仍为 `127.0.0.1:7897`，代理不是首要根因。
- 对照独立项目已验证提交 `e6cbd93` 后确认 App 漏同步持续网络守护，且 `scutil` 服务行解析字符串写错。
- 已完成：
  - 修正 `subKey [n] = ...` 解析，能够识别 ppp0 对应的动态网络服务。
  - 持续摘除 PPP 默认服务、恢复连接前主接口/服务/网关并刷新 DNS。
  - 持续检查系统代理，只有被 pppd 清空时才恢复，降低无效命令频率。
  - 将 Fortinet 网络 watcher 纳入 VpnManager，断开和进程退出时统一 abort。
  - `cargo test --lib` 7/7、Node 22 `pnpm run typecheck` 通过。
- 待验证：先全断开清理开发热重载产生的 ppp0~ppp3，再以新版代码干净重连，验证默认路由/DNS及 Antigravity、小旺。
