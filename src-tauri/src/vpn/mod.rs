use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

pub mod atrust;
pub mod fortinet;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub enum VpnType {
    Fortinet,
    Atrust,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
pub enum VpnStatus {
    Disconnected,
    Connecting,
    Authenticating, // 等待二次验证码
    Connected,
    Disconnecting,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VpnConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub save_password: bool,
    pub custom_routes: Vec<String>, // 用户自定义的分流网段，如 "192.168.100.0/24"
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatePayload {
    pub vpn_type: VpnType,
    pub status: VpnStatus,
    pub message: String,
    pub virtual_ip: Option<String>,
    pub uptime: u64, // 连接时长（秒）
}

#[derive(Clone, Serialize)]
pub struct LogPayload {
    pub vpn_type: VpnType,
    pub text: String,
}

// 两个 VPN 独立的状态管理
pub struct VpnManagerInner {
    // 内存临时保存的 sudo 密码
    pub sudo_password: Option<String>,

    // Fortinet 状态与进程句柄
    pub fortinet_status: VpnStatus,
    pub fortinet_child: Option<tokio::process::Child>,
    pub fortinet_watcher: Option<tokio::task::JoinHandle<()>>,
    pub fortinet_network_watcher: Option<tokio::task::JoinHandle<()>>,
    pub fortinet_ip: Option<String>,
    pub fortinet_start_time: Option<std::time::Instant>,

    // aTrust 状态与进程句柄
    pub atrust_status: VpnStatus,
    pub atrust_child: Option<tokio::process::Child>,
    pub atrust_watcher: Option<tokio::task::JoinHandle<()>>,
    pub atrust_ip: Option<String>,
    pub atrust_start_time: Option<std::time::Instant>,
    pub atrust_stdin: Option<tokio::process::ChildStdin>,
}

#[derive(Clone)]
pub struct VpnManager {
    pub inner: Arc<Mutex<VpnManagerInner>>,
}

impl VpnManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VpnManagerInner {
                sudo_password: None,
                fortinet_status: VpnStatus::Disconnected,
                fortinet_child: None,
                fortinet_watcher: None,
                fortinet_network_watcher: None,
                fortinet_ip: None,
                fortinet_start_time: None,
                atrust_status: VpnStatus::Disconnected,
                atrust_child: None,
                atrust_watcher: None,
                atrust_ip: None,
                atrust_start_time: None,
                atrust_stdin: None,
            })),
        }
    }
}

// 统一保存配置和密码的方法（第一期先通过普通 JSON 读写，稍后扩展 Keychain）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppVpnSettings {
    pub fortinet: VpnConfig,
    pub atrust: VpnConfig,
}

fn get_config_path(app_handle: &AppHandle) -> std::path::PathBuf {
    app_handle
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("vpn_config.json")
}

#[tauri::command]
pub async fn save_vpn_config(
    app_handle: AppHandle,
    settings: AppVpnSettings,
) -> Result<(), String> {
    let path = get_config_path(&app_handle);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json_str =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("序列化配置失败: {e}"))?;
    std::fs::write(&path, json_str).map_err(|e| format!("写入配置文件失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn load_vpn_config(app_handle: AppHandle) -> Result<AppVpnSettings, String> {
    let path = get_config_path(&app_handle);
    if !path.exists() {
        // 返回默认配置
        return Ok(AppVpnSettings {
            fortinet: VpnConfig {
                enabled: false,
                host: "219.141.235.68".to_string(),
                port: 12345,
                username: "ssl".to_string(),
                password: None,
                save_password: false,
                custom_routes: vec!["192.168.100.0/24".to_string()],
            },
            atrust: VpnConfig {
                enabled: false,
                host: "222.240.48.26".to_string(),
                port: 60201,
                username: "yssdm".to_string(),
                password: None,
                save_password: false,
                custom_routes: vec![],
            },
        });
    }
    let json_str = std::fs::read_to_string(&path).map_err(|e| format!("读取配置文件失败: {e}"))?;
    let settings: AppVpnSettings =
        serde_json::from_str(&json_str).map_err(|e| format!("解析配置文件失败: {e}"))?;
    Ok(settings)
}

#[tauri::command]
pub async fn verify_sudo_password(
    state: State<'_, VpnManager>,
    password: String,
) -> Result<bool, String> {
    // 通过跑一个简单的 sudo -S id 命令来验证密码是否正确
    let mut child = tokio::process::Command::new("sudo")
        .arg("-S")
        .arg("id")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动提权验证进程: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("提权进程执行错误: {e}"))?;

    if output.status.success() {
        let mut inner = state.inner.lock().await;
        inner.sudo_password = Some(password);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 返回当前 App 会话是否已经保存过经验证的 sudo 密码。
#[tauri::command]
pub async fn has_sudo_credentials(state: State<'_, VpnManager>) -> Result<bool, String> {
    Ok(state.inner.lock().await.sudo_password.is_some())
}

#[tauri::command]
pub async fn get_vpn_state(
    state: State<'_, VpnManager>,
    vpn_type: VpnType,
) -> Result<VpnStatePayload, String> {
    let inner = state.inner.lock().await;
    let (status, ip, start_time) = match vpn_type {
        VpnType::Fortinet => (
            inner.fortinet_status,
            &inner.fortinet_ip,
            inner.fortinet_start_time,
        ),
        VpnType::Atrust => (
            inner.atrust_status,
            &inner.atrust_ip,
            inner.atrust_start_time,
        ),
    };

    let uptime = start_time.map(|t| t.elapsed().as_secs()).unwrap_or(0);

    Ok(VpnStatePayload {
        vpn_type,
        status,
        message: match status {
            VpnStatus::Disconnected => "未连接".to_string(),
            VpnStatus::Connecting => "正在建立安全通道...".to_string(),
            VpnStatus::Authenticating => "等待二次验证...".to_string(),
            VpnStatus::Connected => "已连接，分流保护中".to_string(),
            VpnStatus::Disconnecting => "正在断开...".to_string(),
            VpnStatus::Error => "连接出错，请检查日志".to_string(),
        },
        virtual_ip: ip.clone(),
        uptime,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnAuthPayload {
    pub vpn_type: VpnType,
    pub prompt: String,
}

#[tauri::command]
pub async fn submit_vpn_mfa(state: State<'_, VpnManager>, code: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut inner = state.inner.lock().await;
    if let Some(mut stdin) = inner.atrust_stdin.take() {
        stdin
            .write_all(format!("{code}\n").as_bytes())
            .await
            .map_err(|e| format!("写入二次验证码失败: {e}"))?;
        // 写完后将其保留，以防万一后续还需要 stdin
        inner.atrust_stdin = Some(stdin);
        Ok(())
    } else {
        Err("当前未处于等待二次认证验证码的状态".to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnCaptchaPayload {
    pub vpn_type: VpnType,
    pub url: String,
}
