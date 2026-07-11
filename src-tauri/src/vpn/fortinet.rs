use super::{LogPayload, VpnManager, VpnManagerInner, VpnStatePayload, VpnStatus, VpnType};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

// 获取 macOS 当前主网络状态（PrimaryInterface, PrimaryService, Router）
#[derive(Clone)]
struct PrimaryNetworkState {
    interface: String,
    service: String,
    router: String,
}

async fn get_primary_network_state() -> Option<PrimaryNetworkState> {
    let mut child = tokio::process::Command::new("scutil")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin
            .write_all(b"show State:/Network/Global/IPv4\nquit\n")
            .await;
    }

    let output = child.wait_with_output().await.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);

    let mut interface = String::new();
    let mut service = String::new();
    let mut router = String::new();

    for line in text.lines() {
        let clean = line.trim();
        if clean.contains("PrimaryInterface :") {
            if let Some(val) = clean.split(':').nth(1) {
                interface = val.trim().to_string();
            }
        } else if clean.contains("PrimaryService :") {
            if let Some(val) = clean.split(':').nth(1) {
                service = val.trim().to_string();
            }
        } else if clean.contains("Router :") {
            if let Some(val) = clean.split(':').nth(1) {
                router = val.trim().to_string();
            }
        }
    }

    if interface.is_empty() || service.is_empty() || router.is_empty() {
        None
    } else {
        Some(PrimaryNetworkState {
            interface,
            service,
            router,
        })
    }
}

// 寻找 configd 自动生成的 VPN Service ID
async fn find_vpn_service_id(interface_name: &str) -> Option<String> {
    let mut child = tokio::process::Command::new("scutil")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin
            .write_all(b"list State:/Network/Service/.*/IPv4\nquit\n")
            .await;
    }

    let output = child.wait_with_output().await.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);

    // scutil 实际输出格式为：subKey [0] = State:/Network/Service/<UUID>/IPv4
    for line in text.lines() {
        let clean = line.trim();
        if let Some((_, key_path)) = clean.split_once(" = ") {
            let actual_key = key_path.trim();
            if actual_key.starts_with("State:/Network/Service/") && actual_key.ends_with("/IPv4") {
                let mut show_child = tokio::process::Command::new("scutil")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .spawn()
                    .ok()?;
                if let Some(mut show_stdin) = show_child.stdin.take() {
                    let _ = show_stdin
                        .write_all(format!("show {actual_key}\nquit\n").as_bytes())
                        .await;
                }
                let show_out = show_child.wait_with_output().await.ok()?;
                let show_text = String::from_utf8_lossy(&show_out.stdout);

                if show_text.contains(&format!("InterfaceName : {interface_name}")) {
                    if let Some(parts) = actual_key.split('/').nth(3) {
                        return Some(parts.to_string());
                    }
                }
            }
        }
    }
    None
}

// 摘除 VPN 接口默认主网络，恢复 WiFi 路由，维持分流
async fn detach_vpn_network_service(
    sudo_password: &str,
    vpn_service_id: &str,
    system_state: &PrimaryNetworkState,
) {
    let scutil_cmd = format!(
        "remove State:/Network/Service/{vpn_service_id}/DNS\n\
         remove State:/Network/Service/{vpn_service_id}/IPv4\n\
         d.init\n\
         d.add PrimaryInterface {}\n\
         d.add PrimaryService {}\n\
         d.add Router {}\n\
         set State:/Network/Global/IPv4\n\
         quit\n",
        system_state.interface, system_state.service, system_state.router
    );

    let child = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg("scutil")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok();

    if let Some(mut c) = child {
        if let Some(mut stdin) = c.stdin.take() {
            let _ = stdin
                .write_all(format!("{sudo_password}\n{scutil_cmd}").as_bytes())
                .await;
        }
        let _ = c.wait().await;
    }
}

// 恢复 Clash 等代理
async fn restore_system_proxy(sudo_password: &str) {
    let proxy_cmd = "d.init\n\
                     d.add ExceptionsList * 127.0.0.1 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12 localhost '*.local' '*.crashlytics.com' '<local>'\n\
                     d.add HTTPEnable # 1\n\
                     d.add HTTPProxy 127.0.0.1\n\
                     d.add HTTPPort # 7897\n\
                     d.add HTTPSEnable # 1\n\
                     d.add HTTPSProxy 127.0.0.1\n\
                     d.add HTTPSPort # 7897\n\
                     d.add SOCKSEnable # 1\n\
                     d.add SOCKSProxy 127.0.0.1\n\
                     d.add SOCKSPort # 7897\n\
                     d.add ProxyAutoConfigEnable # 0\n\
                     set State:/Network/Global/Proxies\n\
                     quit\n";

    let child = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg("scutil")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok();

    if let Some(mut c) = child {
        if let Some(mut stdin) = c.stdin.take() {
            let _ = stdin
                .write_all(format!("{sudo_password}\n{proxy_cmd}").as_bytes())
                .await;
        }
        let _ = c.wait().await;
    }
}

/// 判断指定网络接口当前是否存在。
async fn interface_exists(interface_name: &str) -> bool {
    tokio::process::Command::new("ifconfig")
        .arg(interface_name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 使用 sudo 执行 route 命令并等待结束。
async fn run_sudo_route(sudo_password: &str, args: &[&str]) {
    let child = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg("route")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = child {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin
                .write_all(format!("{sudo_password}\n").as_bytes())
                .await;
        }
        let _ = child.wait().await;
    }
}

/// 刷新 macOS DNS 缓存，使恢复后的主网络解析器立即生效。
async fn flush_dns_cache(sudo_password: &str) {
    for args in [
        vec!["dscacheutil", "-flushcache"],
        vec!["killall", "-HUP", "mDNSResponder"],
    ] {
        let child = tokio::process::Command::new("sudo")
            .arg("-S")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = child {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin
                    .write_all(format!("{sudo_password}\n").as_bytes())
                    .await;
            }
            let _ = child.wait().await;
        }
    }
}

/// 判断系统 HTTP 代理是否仍处于启用状态。
async fn system_proxy_enabled() -> bool {
    tokio::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .await
        .map(|output| String::from_utf8_lossy(&output.stdout).contains("HTTPEnable : 1"))
        .unwrap_or(false)
}

/// 持续维持 Fortinet 分流：PPP 仅承载公司路由，系统主网络始终保持连接前状态。
async fn maintain_split_network(
    sudo_password: String,
    system_state: PrimaryNetworkState,
    custom_routes: Vec<String>,
    manager: Arc<Mutex<VpnManagerInner>>,
    app_handle: AppHandle,
) {
    loop {
        while !interface_exists("ppp0").await {
            let status = manager.lock().await.fortinet_status;
            if matches!(
                status,
                VpnStatus::Disconnected | VpnStatus::Disconnecting | VpnStatus::Error
            ) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        let assigned_ip = tokio::process::Command::new("ifconfig")
            .arg("ppp0")
            .output()
            .await
            .ok()
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .find_map(|line| {
                        line.trim()
                            .strip_prefix("inet ")
                            .and_then(|value| value.split_whitespace().next())
                            .map(str::to_string)
                    })
            })
            .unwrap_or_else(|| "ppp0".to_string());

        {
            let mut inner = manager.lock().await;
            inner.fortinet_ip = Some(assigned_ip.clone());
            inner.fortinet_status = VpnStatus::Connected;
        }
        let _ = app_handle.emit(
            "vpn-status-changed",
            VpnStatePayload {
                vpn_type: VpnType::Fortinet,
                status: VpnStatus::Connected,
                message: "已连接".to_string(),
                virtual_ip: Some(assigned_ip),
                uptime: 0,
            },
        );

        for route_net in &custom_routes {
            run_sudo_route(&sudo_password, &["-n", "delete", "-net", route_net]).await;
            run_sudo_route(
                &sudo_password,
                &["-n", "add", "-net", route_net, "-interface", "ppp0"],
            )
            .await;
        }

        while interface_exists("ppp0").await {
            let status = manager.lock().await.fortinet_status;
            if matches!(
                status,
                VpnStatus::Disconnected | VpnStatus::Disconnecting | VpnStatus::Error
            ) {
                return;
            }

            if let Some(service_id) = find_vpn_service_id("ppp0").await {
                detach_vpn_network_service(&sudo_password, &service_id, &system_state).await;
                flush_dns_cache(&sudo_password).await;
            }
            if !system_proxy_enabled().await {
                restore_system_proxy(&sudo_password).await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        let mut inner = manager.lock().await;
        if inner.fortinet_status == VpnStatus::Connected {
            inner.fortinet_status = VpnStatus::Connecting;
            inner.fortinet_ip = None;
        }
    }
}

#[tauri::command]
pub async fn connect_fortinet(
    app_handle: AppHandle,
    state: tauri::State<'_, VpnManager>,
    openfortivpn_bin: String,
    password: String,
    host: String,
    port: u16,
    username: String,
    custom_routes: Vec<String>,
) -> Result<(), String> {
    let sudo_pass = {
        let mut inner = state.inner.lock().await;
        if inner.fortinet_status == VpnStatus::Connecting
            || inner.fortinet_status == VpnStatus::Connected
        {
            return Err("Fortinet VPN 已经连接或正在连接中".to_string());
        }

        let sudo_pass = inner
            .sudo_password
            .clone()
            .ok_or("请先配置并验证系统 Sudo 提权密码")?;
        inner.fortinet_status = VpnStatus::Connecting;
        inner.fortinet_start_time = Some(std::time::Instant::now());
        inner.fortinet_ip = None;
        sudo_pass
    };

    // A. 抓取连接前的网络状态以备分流恢复
    let primary_state = match get_primary_network_state().await {
        Some(primary_state) => primary_state,
        None => {
            let mut inner = state.inner.lock().await;
            inner.fortinet_status = VpnStatus::Error;
            inner.fortinet_start_time = None;
            return Err("无法取得连接前的系统主网关状态，已停止连接。".to_string());
        }
    };

    // B. 创建临时配置文件
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let temp_conf_path = format!("/tmp/openfortivpn_temp_{ts}.conf");

    let conf_content = format!(
        "host = {host}\n\
         port = {port}\n\
         username = {username}\n\
         password = {password}\n\
         trusted-cert = 491a5bbe4cc44c3e42141d9babfbdd29eee75aaf36401221a1dac9305c846b56\n\
         insecure-ssl = 1\n"
    );

    if let Err(error) = tokio::fs::write(&temp_conf_path, conf_content).await {
        let mut inner = state.inner.lock().await;
        inner.fortinet_status = VpnStatus::Error;
        inner.fortinet_start_time = None;
        return Err(format!("写入临时配置文件失败: {error}"));
    }

    // 1. 防套娃路由：在外部把 VPN 网关 Host 直接绑定到 WiFi Gateway 上
    let wifi_gateway = match tokio::process::Command::new("ipconfig")
        .args(&["getoption", "en0", "router"])
        .output()
        .await
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    };

    let sudo_pass_clone = sudo_pass.clone();
    let host_clone = host.clone();
    let wifi_gateway_clone = wifi_gateway.clone();
    tokio::spawn(async move {
        if !wifi_gateway_clone.is_empty() {
            let mut del_child = tokio::process::Command::new("sudo")
                .arg("-S")
                .arg("route")
                .arg("-n")
                .arg("delete")
                .arg("-host")
                .arg(&host_clone)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            if let Some(mut stdin) = del_child.stdin.take() {
                let _ = stdin
                    .write_all(format!("{sudo_pass_clone}\n").as_bytes())
                    .await;
            }
            let _ = del_child.wait().await;

            let mut add_child = tokio::process::Command::new("sudo")
                .arg("-S")
                .arg("route")
                .arg("-n")
                .arg("add")
                .arg("-host")
                .arg(&host_clone)
                .arg(&wifi_gateway_clone)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            if let Some(mut stdin) = add_child.stdin.take() {
                let _ = stdin
                    .write_all(format!("{sudo_pass_clone}\n").as_bytes())
                    .await;
            }
            let _ = add_child.wait().await;
        }
    });

    // 2. 启动 openfortivpn
    let child_result = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg(&openfortivpn_bin)
        .arg("-c")
        .arg(&temp_conf_path)
        .arg("--no-routes")
        .arg("--no-dns")
        .arg("--pppd-no-peerdns")
        .arg("--min-tls=1.0")
        .arg("--cipher-list=DHE-RSA-AES256-SHA:@SECLEVEL=0")
        .arg("--persistent=5")
        .arg("-v")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child_result {
        Ok(child) => child,
        Err(error) => {
            let _ = tokio::fs::remove_file(&temp_conf_path).await;
            let mut inner = state.inner.lock().await;
            inner.fortinet_status = VpnStatus::Error;
            inner.fortinet_start_time = None;
            return Err(format!("无法拉起 openfortivpn: {error}"));
        }
    };

    let mut stdin = child.stdin.take().ok_or("无法打开 stdin")?;

    // 先行喂入 sudo 密码
    let _ = stdin.write_all(format!("{sudo_pass}\n").as_bytes()).await;

    let stdout = child.stdout.take().ok_or("无法打开 stdout")?;
    let stderr = child.stderr.take().ok_or("无法打开 stderr")?;

    let manager_clone = state.inner.clone();
    let app_handle_clone = app_handle.clone();
    let sudo_pass_clone2 = sudo_pass.clone();
    let temp_conf_cleanup = temp_conf_path.clone();

    // 路由监控及日志的协程
    let watcher = tokio::spawn(async move {
        // 延时 3 秒自动删除明文临时配置文件，确保安全性
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let _ = tokio::fs::remove_file(&temp_conf_cleanup).await;
        });

        let mut reader_out = BufReader::new(stdout).lines();
        let mut reader_err = BufReader::new(stderr).lines();

        let mut ppp0_watcher_started = false;

        loop {
            tokio::select! {
                line = reader_out.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            let _ = app_handle_clone.emit("vpn-log", LogPayload {
                                vpn_type: VpnType::Fortinet,
                                text: text.clone(),
                            });

                            if text.contains("Tunnel is up") || text.contains("Interface ppp0 is up") {
                                if !ppp0_watcher_started {
                                    ppp0_watcher_started = true;
                                    let inner_pass = sudo_pass_clone2.clone();
                                    let inner_app = app_handle_clone.clone();
                                    let inner_manager = manager_clone.clone();
                                    let inner_state = PrimaryNetworkState {
                                        interface: primary_state.interface.clone(),
                                        service: primary_state.service.clone(),
                                        router: primary_state.router.clone(),
                                    };
                                    let inner_routes = custom_routes.clone();

                                    let network_watcher = tokio::spawn(maintain_split_network(
                                        inner_pass,
                                        inner_state,
                                        inner_routes,
                                        inner_manager.clone(),
                                        inner_app,
                                    ));
                                    inner_manager.lock().await.fortinet_network_watcher =
                                        Some(network_watcher);
                                }
                            }
                        }
                        _ => break,
                    }
                }
                line = reader_err.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            let _ = app_handle_clone.emit("vpn-log", LogPayload {
                                vpn_type: VpnType::Fortinet,
                                text: text.clone(),
                            });
                        }
                        _ => break,
                    }
                }
            }
        }

        let mut inner_lock = manager_clone.lock().await;
        let exit_status = if inner_lock.fortinet_status == VpnStatus::Disconnecting {
            VpnStatus::Disconnected
        } else {
            VpnStatus::Error
        };
        inner_lock.fortinet_status = exit_status;
        inner_lock.fortinet_ip = None;
        inner_lock.fortinet_start_time = None;
        inner_lock.fortinet_child = None;
        if let Some(network_watcher) = inner_lock.fortinet_network_watcher.take() {
            network_watcher.abort();
        }

        let _ = app_handle_clone.emit(
            "vpn-status-changed",
            VpnStatePayload {
                vpn_type: VpnType::Fortinet,
                status: exit_status,
                message: if exit_status == VpnStatus::Error {
                    "Fortinet 进程意外退出，请检查日志".to_string()
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
        inner.fortinet_child = Some(child);
        inner.fortinet_watcher = Some(watcher);
    }

    Ok(())
}

#[tauri::command]
pub async fn disconnect_fortinet(
    app_handle: AppHandle,
    state: tauri::State<'_, VpnManager>,
) -> Result<(), String> {
    let (child, watcher, network_watcher, sudo_pass) = {
        let mut inner = state.inner.lock().await;
        let sudo_pass = inner
            .sudo_password
            .clone()
            .ok_or("断开 Fortinet 前需要重新验证 macOS 提权密码")?;
        inner.fortinet_status = VpnStatus::Disconnecting;
        (
            inner.fortinet_child.take(),
            inner.fortinet_watcher.take(),
            inner.fortinet_network_watcher.take(),
            sudo_pass,
        )
    };

    // 不持有全局状态锁执行进程操作，保证状态查询和 aTrust 仍可响应。
    if let Some(mut child) = child {
        let _ = child.kill().await;
    }

    if let Some(watcher) = watcher {
        watcher.abort();
    }
    if let Some(network_watcher) = network_watcher {
        network_watcher.abort();
    }

    // 强杀进程，同时执行 sudo killall openfortivpn 清理残留
    let mut cleanup = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg("killall")
        .arg("openfortivpn")
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
        inner.fortinet_status = VpnStatus::Disconnected;
        inner.fortinet_ip = None;
        inner.fortinet_start_time = None;
    }

    let _ = app_handle.emit(
        "vpn-status-changed",
        VpnStatePayload {
            vpn_type: VpnType::Fortinet,
            status: VpnStatus::Disconnected,
            message: "已断开".to_string(),
            virtual_ip: None,
            uptime: 0,
        },
    );

    Ok(())
}
