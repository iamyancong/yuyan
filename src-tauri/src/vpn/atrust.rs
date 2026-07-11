use super::{
    LogPayload, VpnCaptchaPayload, VpnManager, VpnManagerInner, VpnStatePayload, VpnStatus, VpnType,
};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// 将用户输入编码为 TOML 基本字符串内容，防止引号或换行破坏运行时配置。
fn toml_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

/// 将 aTrust 启动阶段恢复为可重试的错误状态。
async fn mark_start_error(manager: &VpnManager) {
    let mut inner = manager.inner.lock().await;
    inner.atrust_status = VpnStatus::Error;
    inner.atrust_start_time = None;
    inner.atrust_ip = None;
    inner.atrust_stdin = None;
}

/// 统一处理 zju-connect 的 stdout/stderr，Go 标准日志默认写入 stderr。
async fn handle_client_log(
    text: String,
    manager: &Arc<Mutex<VpnManagerInner>>,
    app_handle: &AppHandle,
) {
    let _ = app_handle.emit(
        "vpn-log",
        LogPayload {
            vpn_type: VpnType::Atrust,
            text: text.clone(),
        },
    );

    let received_ip = text
        .split_once("Received IP:")
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(ip) = received_ip {
        let mut inner = manager.lock().await;
        inner.atrust_ip = Some(ip.clone());
        if inner.atrust_status == VpnStatus::Connected {
            drop(inner);
            let _ = app_handle.emit(
                "vpn-status-changed",
                VpnStatePayload {
                    vpn_type: VpnType::Atrust,
                    status: VpnStatus::Connected,
                    message: "已连接".to_string(),
                    virtual_ip: Some(ip),
                    uptime: 0,
                },
            );
        }
    }

    if text.contains("SOCKS5 server listening on") || text.contains("HTTP server listening on") {
        let virtual_ip = {
            let mut inner = manager.lock().await;
            inner.atrust_status = VpnStatus::Connected;
            inner
                .atrust_ip
                .clone()
                .or_else(|| Some("127.0.0.1".to_string()))
        };
        let _ = app_handle.emit(
            "vpn-status-changed",
            VpnStatePayload {
                vpn_type: VpnType::Atrust,
                status: VpnStatus::Connected,
                message: "已连接".to_string(),
                virtual_ip,
                uptime: 0,
            },
        );
    }

    if let Some(pos) = text.find("http://127.0.0.1:") {
        let url = text[pos..]
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        if !url.is_empty() {
            let _ = app_handle.emit(
                "vpn-captcha-required",
                VpnCaptchaPayload {
                    vpn_type: VpnType::Atrust,
                    url,
                },
            );
        }
    }

    let lower_text = text.to_lowercase();
    if lower_text.contains("请输入")
        || lower_text.contains("验证码")
        || lower_text.contains("sms code")
        || lower_text.contains("verification code")
        || lower_text.contains("mfa")
        || lower_text.contains("otp")
    {
        manager.lock().await.atrust_status = VpnStatus::Authenticating;
        let _ = app_handle.emit(
            "vpn-status-changed",
            VpnStatePayload {
                vpn_type: VpnType::Atrust,
                status: VpnStatus::Authenticating,
                message: "等待二次验证...".to_string(),
                virtual_ip: None,
                uptime: 0,
            },
        );
        let _ = app_handle.emit(
            "vpn-auth-required",
            super::VpnAuthPayload {
                vpn_type: VpnType::Atrust,
                prompt: text,
            },
        );
    } else if lower_text.contains("incorrect password")
        || lower_text.contains("vpn client setup error")
        || lower_text.contains("login error:")
    {
        manager.lock().await.atrust_status = VpnStatus::Error;
    }
}

// 预清理 stale 主机路由
async fn prepare_tun_routes(sudo_password: &str) -> Result<(), String> {
    let stale_hosts = vec!["192.168.167.142"];
    for host in stale_hosts {
        let mut child = tokio::process::Command::new("sudo")
            .arg("-S")
            .arg("route")
            .arg("-n")
            .arg("delete")
            .arg("-host")
            .arg(host)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin
                .write_all(format!("{sudo_password}\n").as_bytes())
                .await;
        }
        let _ = child.wait().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_atrust(
    app_handle: AppHandle,
    state: tauri::State<'_, VpnManager>,
    zju_connect_bin: String,
    password: String,
) -> Result<(), String> {
    let sudo_pass = {
        let mut inner = state.inner.lock().await;
        if inner.atrust_status == VpnStatus::Connecting
            || inner.atrust_status == VpnStatus::Authenticating
            || inner.atrust_status == VpnStatus::Connected
        {
            return Err("aTrust VPN 已经连接或正在连接中".to_string());
        }

        let sudo_pass = inner
            .sudo_password
            .clone()
            .ok_or("请先配置并验证系统 Sudo 提权密码")?;

        inner.atrust_status = VpnStatus::Connecting;
        inner.atrust_start_time = Some(std::time::Instant::now());
        inner.atrust_ip = None;
        sudo_pass
    };

    // 1. 预清理 stale 路由
    let sudo_pass_clone = sudo_pass.clone();
    tokio::spawn(async move {
        let _ = prepare_tun_routes(&sudo_pass_clone).await;
    });

    // 2. 创建内存中的 FIFO 管道
    let rand_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pipe_path = format!("/tmp/atrust-config-{rand_id}");

    let status = match tokio::process::Command::new("mkfifo")
        .arg(&pipe_path)
        .status()
        .await
    {
        Ok(status) => status,
        Err(error) => {
            mark_start_error(&state).await;
            return Err(format!("创建 FIFO 管道失败: {error}"));
        }
    };

    if !status.success() {
        mark_start_error(&state).await;
        return Err("创建 FIFO 管道退出异常".to_string());
    }

    // 设置管道权限
    let _ = tokio::process::Command::new("chmod")
        .arg("600")
        .arg(&pipe_path)
        .status()
        .await;

    // 3. 构建 TOML 配置文本
    let runtime_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_default()
        .join(".runtime");
    let client_data_file = runtime_dir.join("atrust-client-data.json");
    let _ = std::fs::create_dir_all(&runtime_dir);

    // aTrust 账户固定 yssdm，网关固定 222.240.48.26:60201
    let toml_config = format!(
        r#"protocol = "atrust"
server_address = "222.240.48.26"
server_port = 60201
username = "yssdm"
password = "{}"
disable_zju_config = true
socks_bind = "127.0.0.1:1080"
http_bind = "127.0.0.1:1081"
tcp_tunnel_mode = false
tun_mode = true
add_route = true
dns_hijack = false
fake_ip = false
auth_type = "auth/psw"
login_domain = "local"
client_data_file = "{}"
"#,
        toml_escape(&password),
        toml_escape(&client_data_file.to_string_lossy())
    );

    // 4. 先启动客户端，再启动 FIFO 写入端；这样客户端启动失败时不会留下永久阻塞的 writer。
    let child_result = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg(&zju_connect_bin)
        .arg("-config")
        .arg(&pipe_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child_result {
        Ok(child) => child,
        Err(error) => {
            let _ = tokio::fs::remove_file(&pipe_path).await;
            mark_start_error(&state).await;
            return Err(format!("启动 zju-connect 失败: {error}"));
        }
    };

    let pipe_path_writer = pipe_path.clone();
    let writer = tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&pipe_path_writer)
            .map_err(|error| format!("打开 aTrust 配置管道失败: {error}"))?;
        file.write_all(toml_config.as_bytes())
            .map_err(|error| format!("写入 aTrust 配置管道失败: {error}"))?;
        file.flush()
            .map_err(|error| format!("刷新 aTrust 配置管道失败: {error}"))
    });

    // 5. 往 stdin 喂入 sudo 密码，并保留同一 stdin 供后续 MFA 交互。
    let mut stdin = child.stdin.take().ok_or("无法获取 zju-connect stdin")?;
    stdin
        .write_all(format!("{sudo_pass}\n").as_bytes())
        .await
        .map_err(|error| format!("向 sudo 写入提权凭据失败: {error}"))?;

    let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取 stderr")?;

    let manager_clone = state.inner.clone();
    let app_handle_clone = app_handle.clone();
    let pipe_path_cleanup = pipe_path.clone();

    // FIFO 只能在 zju-connect 完成读取后删除，不能在 watcher 启动时抢先删除。
    tokio::spawn(async move {
        let _ = writer.await;
        let _ = tokio::fs::remove_file(&pipe_path_cleanup).await;
    });

    // 监控日志和进程状态的协程
    let watcher = tokio::spawn(async move {
        let mut reader_out = BufReader::new(stdout).lines();
        let mut reader_err = BufReader::new(stderr).lines();

        loop {
            tokio::select! {
                line = reader_out.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            handle_client_log(text, &manager_clone, &app_handle_clone).await;
                        }
                        _ => break,
                    }
                }
                line = reader_err.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            handle_client_log(text, &manager_clone, &app_handle_clone).await;
                        }
                        _ => break,
                    }
                }
            }
        }

        // 进程退出处理
        let mut inner_lock = manager_clone.lock().await;
        let exit_status = if inner_lock.atrust_status == VpnStatus::Disconnecting {
            VpnStatus::Disconnected
        } else {
            VpnStatus::Error
        };
        inner_lock.atrust_status = exit_status;
        inner_lock.atrust_ip = None;
        inner_lock.atrust_start_time = None;
        inner_lock.atrust_stdin = None;
        inner_lock.atrust_child = None;

        let _ = app_handle_clone.emit(
            "vpn-status-changed",
            VpnStatePayload {
                vpn_type: VpnType::Atrust,
                status: exit_status,
                message: if exit_status == VpnStatus::Error {
                    "aTrust 进程意外退出，请检查日志".to_string()
                } else {
                    "已断开".to_string()
                },
                virtual_ip: None,
                uptime: 0,
            },
        );
    });

    {
        let mut inner = state.inner.lock().await;
        inner.atrust_stdin = Some(stdin);
        inner.atrust_child = Some(child);
        inner.atrust_watcher = Some(watcher);
    }

    Ok(())
}

#[tauri::command]
pub async fn disconnect_atrust(
    app_handle: AppHandle,
    state: tauri::State<'_, VpnManager>,
) -> Result<(), String> {
    let (child, watcher, sudo_pass) = {
        let mut inner = state.inner.lock().await;
        let sudo_pass = inner
            .sudo_password
            .clone()
            .ok_or("断开 aTrust 前需要重新验证 macOS 提权密码")?;
        inner.atrust_status = VpnStatus::Disconnecting;
        inner.atrust_stdin = None;
        (
            inner.atrust_child.take(),
            inner.atrust_watcher.take(),
            sudo_pass,
        )
    };

    // 不持有全局状态锁执行进程操作，保证状态查询和其他 VPN 仍可响应。
    if let Some(mut child) = child {
        let _ = child.kill().await;
    }

    if let Some(watcher) = watcher {
        watcher.abort();
    }

    // 因为是 sudo 跑的，强杀 child 可能依然会在系统里遗留 zju-connect 守护进程，我们执行 sudo killall 来彻底清理
    let mut cleanup = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg("killall")
        .arg("zju-connect")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(mut stdin) = cleanup.stdin.take() {
        let _ = stdin.write_all(format!("{sudo_pass}\n").as_bytes()).await;
    }
    let _ = cleanup.wait().await;

    {
        let mut inner = state.inner.lock().await;
        inner.atrust_status = VpnStatus::Disconnected;
        inner.atrust_ip = None;
        inner.atrust_start_time = None;
    }

    let _ = app_handle.emit(
        "vpn-status-changed",
        VpnStatePayload {
            vpn_type: VpnType::Atrust,
            status: VpnStatus::Disconnected,
            message: "已断开".to_string(),
            virtual_ip: None,
            uptime: 0,
        },
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::toml_escape;

    /// 验证密码中的 TOML 特殊字符不会逃逸出字符串值。
    #[test]
    fn escapes_toml_basic_string_content() {
        assert_eq!(toml_escape("a\\b\"c\nd\r"), "a\\\\b\\\"c\\nd\\r");
    }
}
