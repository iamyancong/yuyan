use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::{Emitter, Manager};

mod app_update;
mod file_download;
mod secure_identity;
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod tray;

const DARK_ICON: &[u8] = include_bytes!("../resources/yuyan_dark_clean.png");
const LIGHT_ICON: &[u8] = include_bytes!("../resources/yuyan_light_clean.png");
const DEFAULT_LOCAL_SERVER_PORT: u16 = 3101;
const LOCAL_SERVER_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const LOCAL_SERVER_STOP_TIMEOUT: Duration = Duration::from_secs(3);

/** Windows 后台控制台进程的无窗口创建标志。 */
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/** 在 Windows 上隐藏后台控制台子进程窗口，同时保留标准输出与错误管道。 */
#[cfg(target_os = "windows")]
fn hide_background_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

/** 非 Windows 平台无需调整后台子进程窗口。 */
#[cfg(not(target_os = "windows"))]
fn hide_background_command_window(_command: &mut Command) {}

// 检测本地端口是否可用
fn is_port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// 动态获取系统当前闲置的可用端口
fn get_free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

#[derive(Default)]
struct LocalServerInner {
    child: Option<Child>,
    port: u16,
    status: String,
    node_path: Option<String>,
    last_error: Option<String>,
    last_output: String,
    agent_runtime: Option<AgentRuntimeDescriptor>,
    agent_runtime_path: Option<PathBuf>,
}

/** 管理内嵌 Node 服务生命周期。 */
#[derive(Clone, Default)]
pub(crate) struct LocalServerManager {
    inner: Arc<Mutex<LocalServerInner>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalServerStatus {
    port: u16,
    pid: Option<u32>,
    running: bool,
    status: String,
    node_path: Option<String>,
    last_error: Option<String>,
    last_output: String,
}

/** MCP Sidecar 用于发现雨燕本机网关的短期运行时描述。 */
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeDescriptor {
    schema_version: u8,
    app_version: String,
    pid: u32,
    port: u16,
    session_token: String,
    started_at: String,
}

/** WebView 读取 Agent Gateway 时所需的本机运行时信息。 */
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeStatus {
    descriptor: AgentRuntimeDescriptor,
    executable_path: String,
}

impl LocalServerManager {
    /** 获取当前本地服务监听端口。 */
    fn port(&self) -> u16 {
        self.inner
            .lock()
            .map(|state| state.port)
            .unwrap_or(DEFAULT_LOCAL_SERVER_PORT)
    }

    /** 获取当前本地服务诊断状态。 */
    fn status(&self) -> LocalServerStatus {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let running = state
            .child
            .as_mut()
            .map(|child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false);
        let pid = state.child.as_ref().map(|child| child.id());
        let status = if running {
            "running".to_string()
        } else if state.last_error.is_some() {
            "error".to_string()
        } else if state.status == "running" {
            "stopped".to_string()
        } else if state.status.is_empty() {
            "idle".to_string()
        } else {
            state.status.clone()
        };
        LocalServerStatus {
            port: state.port,
            pid,
            running,
            status,
            node_path: state.node_path.clone(),
            last_error: state.last_error.clone(),
            last_output: state.last_output.clone(),
        }
    }

    /** 获取供 WebView 访问 Agent Gateway 的运行时信息。 */
    fn agent_runtime(&self) -> Result<AgentRuntimeStatus, String> {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let descriptor = state
            .agent_runtime
            .clone()
            .ok_or_else(|| "Agent Gateway 尚未就绪".to_string())?;
        let executable_path = std::env::current_exe()
            .map_err(|error| format!("无法获取雨燕可执行文件路径: {error}"))?
            .to_string_lossy()
            .into_owned();
        Ok(AgentRuntimeStatus {
            descriptor,
            executable_path,
        })
    }

    /** 记录本地服务启动不可用状态。 */
    fn mark_error(&self, message: String, node_path: Option<&std::path::Path>) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.status = "error".to_string();
        state.child = None;
        state.port = DEFAULT_LOCAL_SERVER_PORT;
        state.node_path = node_path.map(|path| path.to_string_lossy().into_owned());
        state.last_error = Some(message);
        if let Some(runtime_path) = state.agent_runtime_path.take() {
            let _ = std::fs::remove_file(runtime_path);
        }
        state.agent_runtime = None;
    }

    /** 记录 Node 子进程最近输出，便于前端诊断展示。 */
    fn record_output(&self, prefix: &str, line: &str) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next_line = format!("[{prefix}] {line}");
        let mut lines = state
            .last_output
            .lines()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        lines.push(next_line);
        let keep_from = lines.len().saturating_sub(20);
        state.last_output = lines[keep_from..].join("\n");
    }

    /** 启动内嵌 Node 服务并记录端口和进程。 */
    fn start(&self, app: &tauri::AppHandle, node_path: &std::path::Path) -> Result<u16, String> {
        let mut retries = 0;
        let mut last_err = String::new();
        {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.status = "starting".to_string();
            state.node_path = Some(node_path.to_string_lossy().into_owned());
            state.last_error = None;
            state.last_output.clear();
        }

        let session_token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );

        while retries < 3 {
            let port = if retries == 0 && is_port_free(DEFAULT_LOCAL_SERVER_PORT) {
                DEFAULT_LOCAL_SERVER_PORT
            } else {
                get_free_port().unwrap_or(DEFAULT_LOCAL_SERVER_PORT + 1 + retries)
            };

            println!(
                "⏳ 正在尝试在端口 {} 启动 Node 服务（第 {} 次尝试）...",
                port,
                retries + 1
            );

            match start_node_server(app, node_path, port, &session_token, self.clone()) {
                Ok((child, runtime_path, runtime_descriptor)) => {
                    let pid = child.id();
                    let mut state = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state.child = Some(child);
                    state.port = port;
                    state.status = "running".to_string();
                    state.last_error = None;
                    state.agent_runtime = Some(runtime_descriptor);
                    state.agent_runtime_path = Some(runtime_path);
                    println!("✅ Node 服务启动成功！进程 PID: {pid}，监听端口: {port}");
                    return Ok(port);
                }
                Err(err) => {
                    println!(
                        "⚠️ 在端口 {} 启动 Node 服务失败: {}，准备重试...",
                        port, err
                    );
                    last_err = err;
                    retries += 1;
                }
            }
        }

        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.port = DEFAULT_LOCAL_SERVER_PORT;
        state.status = "error".to_string();
        state.last_error = Some(last_err.clone());
        Err(last_err)
    }

    /** 停止内嵌 Node 服务，优先 graceful shutdown，超时后终止进程树。 */
    pub(crate) fn stop(&self, reason: &str) {
        let (mut child, runtime_path) = {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.agent_runtime = None;
            (state.child.take(), state.agent_runtime_path.take())
        };

        if let Some(runtime_path) = runtime_path {
            let _ = std::fs::remove_file(runtime_path);
        }

        let Some(mut child) = child.take() else {
            return;
        };

        println!(
            "🛑 正在停止 Node 本地服务进程 (PID: {}, reason: {})...",
            child.id(),
            reason
        );

        let _ = child.stdin.take();
        if wait_for_child_exit(&mut child, LOCAL_SERVER_STOP_TIMEOUT) {
            println!("✅ Node 本地服务已正常退出");
            return;
        }

        terminate_child_tree(&mut child, false);
        if !wait_for_child_exit(&mut child, Duration::from_secs(2)) {
            terminate_child_tree(&mut child, true);
            let _ = child.wait();
        }
    }
}

/** 使用 0600 权限原子写入运行时描述文件。 */
fn write_agent_runtime_descriptor(
    app: &tauri::AppHandle,
    port: u16,
    session_token: &str,
) -> Result<(PathBuf, AgentRuntimeDescriptor), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("创建应用数据目录失败: {error}"))?;
    let runtime_path = app_data_dir.join("agent-runtime.json");
    let temp_path = app_data_dir.join(format!("agent-runtime.{}.tmp", std::process::id()));
    let descriptor = AgentRuntimeDescriptor {
        schema_version: 1,
        app_version: app.package_info().version.to_string(),
        pid: std::process::id(),
        port,
        session_token: session_token.to_string(),
        started_at: format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ),
    };
    let content = serde_json::to_vec_pretty(&descriptor)
        .map_err(|error| format!("序列化 Agent 运行时描述失败: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temp_path)
            .map_err(|error| format!("创建 Agent 运行时描述失败: {error}"))?;
        file.write_all(&content)
            .map_err(|error| format!("写入 Agent 运行时描述失败: {error}"))?;
        let _ = file.sync_all();
    }
    #[cfg(not(unix))]
    std::fs::write(&temp_path, &content)
        .map_err(|error| format!("写入 Agent 运行时描述失败: {error}"))?;

    std::fs::rename(&temp_path, &runtime_path)
        .map_err(|error| format!("替换 Agent 运行时描述失败: {error}"))?;
    Ok((runtime_path, descriptor))
}

// 获取 Node.js 可执行文件的路径
fn get_node_path(app_handle: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    // 0. 开发环境：直接返回系统全局 Node 命令，便于本地调试
    if cfg!(dev) {
        println!("🔧 开发模式：使用系统全局 Node 路径");
        return Some(std::path::PathBuf::from("node"));
    }

    let binary_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };

    // 1. 尝试查找打包后（或开发模式）的标准资源目录
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        // 打包后在 app bundle 内的路径：Contents/Resources/resources/bin/node
        let embedded_node = resource_dir.join("resources").join("bin").join(binary_name);
        if embedded_node.exists() {
            println!("🔍 找到打包后内嵌 Node 二进制文件: {:?}", embedded_node);
            return Some(embedded_node);
        }

        // 开发环境：项目根目录/src-tauri/resources/bin/node
        let dev_node = resource_dir
            .join("src-tauri")
            .join("resources")
            .join("bin")
            .join(binary_name);
        if dev_node.exists() {
            println!("🔍 找到开发环境内嵌 Node 二进制文件: {:?}", dev_node);
            return Some(dev_node);
        }
    }

    // 2. 尝试从当前可执行文件所在路径向上追溯寻找资源（适用于双击运行 target/debug 或 release 中的二进制）
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            if let Some(grandparent) = parent.parent() {
                // 例如：src-tauri/target/debug/yuyan-app -> 向上两级为 src-tauri
                let path1 = grandparent.join("resources").join("bin").join(binary_name);
                if path1.exists() {
                    println!("🔍 追溯找到内嵌 Node 二进制文件: {:?}", path1);
                    return Some(path1);
                }
            }
        }
    }

    // 生产环境不回退系统 Node，避免客户端 Node 缺失或版本不一致导致首启失败
    None
}

/** 解析 Node 主版本号。 */
fn parse_node_major_version(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
}

/** 检查内嵌 Node 运行时是否满足本地服务要求。 */
fn check_node_runtime(node_path: &std::path::Path) -> Result<String, String> {
    let mut version_command = Command::new(node_path);
    hide_background_command_window(&mut version_command);
    let output = version_command
        .arg("--version")
        .output()
        .map_err(|error| format!("执行 Node 版本检查失败: {error}"))?;
    if !output.status.success() {
        return Err("Node 版本检查命令退出失败".to_string());
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let major = parse_node_major_version(&version)
        .ok_or_else(|| format!("无法解析 Node 版本号: {version}"))?;
    if major < 22 {
        return Err(format!(
            "内嵌 Node 版本过低: {version}，本地服务要求 Node 22 或更高版本"
        ));
    }

    let mut sqlite_command = Command::new(node_path);
    hide_background_command_window(&mut sqlite_command);
    let sqlite_check = sqlite_command
        .args([
            "--input-type=module",
            "-e",
            "import('node:sqlite').then(() => {}).catch((error) => { console.error(error?.message || error); process.exit(1); })",
        ])
        .output()
        .map_err(|error| format!("检查 node:sqlite 支持失败: {error}"))?;
    if !sqlite_check.status.success() {
        let stderr = String::from_utf8_lossy(&sqlite_check.stderr)
            .trim()
            .to_string();
        return Err(format!(
            "当前 Node 运行时不支持 node:sqlite{}",
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }

    Ok(version)
}

// 管道日志输出辅助函数
fn pipe_output<R: std::io::Read + Send + 'static>(
    reader: R,
    prefix: &'static str,
    server_manager: LocalServerManager,
) {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            if let Ok(l) = line {
                println!("[Node Server {}] {}", prefix, l);
                server_manager.record_output(prefix, &l);
            }
        }
    });
}

/** 等待子进程退出，超时返回 false。 */
fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if started_at.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => return false,
            Err(_) => return true,
        }
    }
}

/** 请求终止 Node 子进程树。 */
fn terminate_child_tree(child: &mut Child, force: bool) {
    let pid = child.id();

    #[cfg(target_os = "windows")]
    {
        let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
        if force {
            args.push("/F".to_string());
        }
        let mut command = Command::new("taskkill");
        hide_background_command_window(&mut command);
        let _ = command.args(args).output();
        return;
    }

    #[cfg(unix)]
    {
        let signal = if force { "-KILL" } else { "-TERM" };
        let group_pid = format!("-{}", pid);
        if Command::new("kill")
            .args([signal, &group_pid])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return;
        }
    }

    let _ = child.kill();
}

/** 使用 /health 探测本地 Node 服务是否已可用。 */
fn is_local_server_healthy(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 64];
    match stream.read(&mut response) {
        Ok(length) => {
            String::from_utf8_lossy(&response[..length]).starts_with("HTTP/1.1 200")
                || String::from_utf8_lossy(&response[..length]).starts_with("HTTP/1.0 200")
        }
        Err(_) => false,
    }
}

/** 等待本地 Node 服务健康检查通过。 */
fn wait_for_local_server_health(child: &mut Child, port: u16) -> Result<(), String> {
    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Node 服务进程启动后立即退出，状态: {status}。可能是端口 {port} 已被旧服务占用，请先关闭旧的雨燕进程或释放该端口后重试。"
                ));
            }
            Ok(None) => {}
            Err(error) => return Err(format!("检查 Node 服务进程状态失败: {error}")),
        }

        if is_local_server_healthy(port) {
            return Ok(());
        }

        if started_at.elapsed() >= LOCAL_SERVER_STARTUP_TIMEOUT {
            return Err(format!(
                "Node 服务启动超时，端口 {port} 在 {} 秒内未通过 /health 检查",
                LOCAL_SERVER_STARTUP_TIMEOUT.as_secs()
            ));
        }

        thread::sleep(Duration::from_millis(200));
    }
}

// 启动 Express Node 服务
fn start_node_server(
    app: &tauri::AppHandle,
    node_path: &std::path::Path,
    port: u16,
    session_token: &str,
    server_manager: LocalServerManager,
) -> Result<(Child, PathBuf, AgentRuntimeDescriptor), String> {
    let resource_path = if cfg!(dev) {
        let cwd = std::env::current_dir().unwrap();
        let path1 = cwd.join("server/index.mjs");
        if path1.exists() {
            path1
        } else {
            let path2 = cwd.join("../server/index.mjs");
            if path2.exists() {
                path2
            } else {
                app.path()
                    .resource_dir()
                    .map_err(|e| format!("无法获取资源目录: {}", e))?
                    .join("server/index.mjs")
            }
        }
    } else {
        let res_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("无法获取资源目录: {}", e))?;
        let path1 = res_dir.join("server/index.mjs");
        if path1.exists() {
            path1
        } else {
            res_dir.join("_up_/server/index.mjs")
        }
    };

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;

    let deploy_data_dir = app_data_dir.join("deploy-data");
    let template_repo_path = app_data_dir.join("yuyan-template");
    let runtime_descriptor_path = app_data_dir.join("agent-runtime.json");
    let executable_path =
        std::env::current_exe().map_err(|error| format!("无法获取雨燕可执行文件路径: {error}"))?;

    // 确保需要的目录存在
    std::fs::create_dir_all(&deploy_data_dir)
        .map_err(|e| format!("创建部署数据目录失败: {}", e))?;
    std::fs::create_dir_all(&template_repo_path)
        .map_err(|e| format!("创建模板缓存目录失败: {}", e))?;

    println!("==================================================");
    println!("🚀 正在启动内嵌 Node 服务...");
    println!("📂 监听端口 (PORT): {}", port);
    println!("📂 脚本路径: {:?}", resource_path);
    println!("📂 部署数据目录 (DEPLOY_DATA_DIR): {:?}", deploy_data_dir);
    println!(
        "📂 模板缓存目录 (TEMPLATE_REPO_PATH): {:?}",
        template_repo_path
    );
    println!("==================================================");

    let local_master_key = secure_identity::get_or_create_local_master_key()?;
    let mut command = Command::new(node_path);
    hide_background_command_window(&mut command);
    command
        .arg(resource_path)
        .env("DEPLOY_DATA_DIR", deploy_data_dir.to_str().unwrap_or(""))
        .env(
            "TEMPLATE_REPO_PATH",
            template_repo_path.to_str().unwrap_or(""),
        )
        .env("DEPLOY_SECRET_KEY", &local_master_key)
        .env("YUYAN_AGENT_AUDIT_KEY", &local_master_key)
        .env("PORT", port.to_string())
        .env("IS_TAURI_SUBPROCESS", "true")
        .env("YUYAN_AGENT_SESSION_TOKEN", session_token)
        .env("YUYAN_RUNTIME_DESCRIPTOR", &runtime_descriptor_path)
        .env("YUYAN_APP_EXECUTABLE", &executable_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 Node 服务进程失败: {}", e))?;

    // 管道化标准输出和错误输出到终端以方便调试
    if let Some(stdout) = child.stdout.take() {
        pipe_output(stdout, "STDOUT", server_manager.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_output(stderr, "STDERR", server_manager);
    }

    if let Err(error) = wait_for_local_server_health(&mut child, port) {
        terminate_child_tree(&mut child, true);
        let _ = child.wait();
        return Err(error);
    }

    match write_agent_runtime_descriptor(app, port, session_token) {
        Ok((runtime_path, descriptor)) => Ok((child, runtime_path, descriptor)),
        Err(error) => {
            terminate_child_tree(&mut child, true);
            let _ = child.wait();
            Err(error)
        }
    }
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon(png_bytes: &[u8]) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        // 1. 创建 NSData
        let ns_data: id = msg_send![objc::class!(NSData), dataWithBytes: png_bytes.as_ptr() length: png_bytes.len()];

        // 2. 从 NSData 创建 NSImage
        let ns_image_alloc: id = msg_send![objc::class!(NSImage), alloc];
        let ns_image: id = msg_send![ns_image_alloc, initWithData: ns_data];

        // 3. 获取 [NSApplication sharedApplication]
        let shared_app: id = msg_send![objc::class!(NSApplication), sharedApplication];

        // 4. 设置 Dock 图标
        let _: () = msg_send![shared_app, setApplicationIconImage: ns_image];
    }
}

#[tauri::command]
fn change_app_icon(app_handle: tauri::AppHandle, is_dark: bool) -> Result<(), String> {
    let icon_bytes = if is_dark { DARK_ICON } else { LIGHT_ICON };

    #[cfg(target_os = "macos")]
    {
        set_macos_dock_icon(icon_bytes);
    }

    let img = Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;
    for window in app_handle.webview_windows().values() {
        let _ = window.set_icon(img.clone());
    }

    Ok(())
}

/** 获取当前运行的本地 Node 服务端口的命令。 */
#[tauri::command]
fn get_local_server_port(state: tauri::State<'_, LocalServerManager>) -> u16 {
    state.port()
}

/** 获取本地 Node 服务诊断状态。 */
#[tauri::command]
fn get_local_server_status(state: tauri::State<'_, LocalServerManager>) -> LocalServerStatus {
    state.status()
}

/** 获取 AI 集成界面访问本机 Agent Gateway 所需的短期运行时信息。 */
#[tauri::command]
fn get_agent_runtime(
    state: tauri::State<'_, LocalServerManager>,
) -> Result<AgentRuntimeStatus, String> {
    state.agent_runtime()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    app_version: String,
    tauri_version: String,
    node_version: String,
    os_info: String,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[allow(non_snake_case)]
struct RtlOsVersionInfoW {
    dwOSVersionInfoSize: u32,
    dwMajorVersion: u32,
    dwMinorVersion: u32,
    dwBuildNumber: u32,
    dwPlatformId: u32,
    szCSDVersion: [u16; 128],
}

#[cfg(target_os = "windows")]
#[link(name = "ntdll")]
extern "system" {
    fn RtlGetVersion(version_info: *mut RtlOsVersionInfoW) -> i32;
}

/** 使用 Windows 原生 API 获取系统版本，避免 cmd 本地代码页导致乱码。 */
#[cfg(target_os = "windows")]
fn get_windows_version_label() -> String {
    let mut version_info = RtlOsVersionInfoW {
        dwOSVersionInfoSize: std::mem::size_of::<RtlOsVersionInfoW>() as u32,
        dwMajorVersion: 0,
        dwMinorVersion: 0,
        dwBuildNumber: 0,
        dwPlatformId: 0,
        szCSDVersion: [0; 128],
    };

    let status = unsafe { RtlGetVersion(&mut version_info) };
    if status >= 0 {
        format!(
            "Windows {}.{}.{}",
            version_info.dwMajorVersion, version_info.dwMinorVersion, version_info.dwBuildNumber
        )
    } else {
        "Windows Unknown".to_string()
    }
}

/** 获取桌面端系统诊断信息的命令。 */
#[tauri::command]
fn get_system_info(app_handle: tauri::AppHandle) -> SystemInfo {
    let app_version = app_handle.package_info().version.to_string();

    // 获取 Node 版本
    let node_version = get_node_path(&app_handle)
        .and_then(|node_path| check_node_runtime(&node_path).ok())
        .unwrap_or_else(|| "Not Bundled".to_string());

    // 操作系统信息
    #[cfg(target_os = "macos")]
    let os_version = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());

    #[cfg(target_os = "windows")]
    let os_version = get_windows_version_label();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let os_version = "Unknown".to_string();

    let os_info = format!(
        "{} ({} {})",
        os_version,
        std::env::consts::OS,
        std::env::consts::ARCH
    );

    SystemInfo {
        app_version,
        tauri_version: tauri::VERSION.to_string(),
        node_version,
        os_info,
    }
}

/** 安全退出整个应用并清理 Node 子进程的命令。 */
#[tauri::command]
fn exit_app(app: tauri::AppHandle, server_manager: tauri::State<'_, LocalServerManager>) {
    println!("🛑 收到强制退出指令，正在安全退出应用并清理子进程...");
    server_manager.stop("exit_app");
    app.exit(0);
}

/** 在系统的文件管理器中定位并选中该文件。 */
#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if !target.is_file() {
        return Err(format!("文件不存在或不是普通文件：{path}"));
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer.exe")
            .arg("/select,")
            .arg(&path)
            .status()
            .map_err(|error| format!("启动文件资源管理器失败：{error}"))?;
        if !status.success() {
            return Err(format!("文件资源管理器定位文件失败：{status}"));
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
            .map_err(|error| format!("启动 Finder 失败：{error}"))?;
        if !status.success() {
            return Err(format!("Finder 定位文件失败：{status}"));
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let parent = target
            .parent()
            .ok_or_else(|| "文件路径没有父目录".to_string())?;
        let status = Command::new("xdg-open")
            .arg(parent)
            .status()
            .map_err(|error| format!("启动文件管理器失败：{error}"))?;
        if !status.success() {
            return Err(format!("文件管理器打开目录失败：{status}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod reveal_file_tests {
    use super::*;

    #[test]
    fn 不存在的路径无法打开文件位置() {
        let path = std::env::temp_dir()
            .join(format!("yuyan-missing-{}", uuid::Uuid::new_v4().simple()))
            .to_string_lossy()
            .into_owned();
        assert!(reveal_in_file_manager(path).is_err());
    }
}

/** 返回候选列表中第一个存在的文件。 */
fn first_existing_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/** 从当前可执行文件和开发仓库位置解析 MCP 所需的 Node 与入口脚本。 */
fn resolve_mcp_runtime_files() -> Result<(PathBuf, PathBuf), String> {
    let current_exe =
        std::env::current_exe().map_err(|error| format!("无法获取雨燕可执行文件路径: {error}"))?;
    let binary_name = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let mut node_candidates = Vec::new();
    let mut script_candidates = Vec::new();
    if let Ok(configured_node) = std::env::var("YUYAN_NODE_PATH") {
        node_candidates.push(PathBuf::from(configured_node));
    }
    if let Ok(configured_script) = std::env::var("YUYAN_MCP_ENTRY") {
        script_candidates.push(PathBuf::from(configured_script));
    }
    if let Ok(cwd) = std::env::current_dir() {
        node_candidates.push(cwd.join("src-tauri/resources/bin").join(binary_name));
        node_candidates.push(cwd.join("resources/bin").join(binary_name));
        script_candidates.push(cwd.join("mcp/dist/index.js"));
        script_candidates.push(cwd.join("../mcp/dist/index.js"));
    }
    for ancestor in current_exe.ancestors().take(8) {
        node_candidates.push(ancestor.join("resources/bin").join(binary_name));
        node_candidates.push(ancestor.join("Resources/resources/bin").join(binary_name));
        script_candidates.push(ancestor.join("mcp/dist/index.js"));
        script_candidates.push(ancestor.join("_up_/mcp/dist/index.js"));
        script_candidates.push(ancestor.join("Resources/_up_/mcp/dist/index.js"));
        script_candidates.push(ancestor.join("Resources/mcp/dist/index.js"));
    }
    let node_path = first_existing_file(node_candidates)
        .or_else(|| {
            if cfg!(debug_assertions) {
                Some(PathBuf::from("node"))
            } else {
                None
            }
        })
        .ok_or_else(|| "安装包中未找到内嵌 Node 运行时".to_string())?;
    let script_path = first_existing_file(script_candidates)
        .ok_or_else(|| "安装包中未找到 mcp/dist/index.js，请重新安装或修复雨燕".to_string())?;
    Ok((node_path, script_path))
}

/**
 * 使用当前雨燕可执行文件启动 TypeScript 编译产物形式的 stdio MCP Sidecar。
 * @description stdout/stderr/stdin 均直接继承，Rust 层不向 stdout 写入任何诊断内容。
 */
pub fn run_mcp_sidecar() -> Result<(), String> {
    let (node_path, script_path) = resolve_mcp_runtime_files()?;
    let executable_path =
        std::env::current_exe().map_err(|error| format!("无法获取雨燕可执行文件路径: {error}"))?;
    let forwarded_args = std::env::args()
        .skip(1)
        .filter(|argument| argument != "--mcp")
        .collect::<Vec<_>>();
    let status = Command::new(node_path)
        .arg(script_path)
        .args(forwarded_args)
        .env("YUYAN_APP_EXECUTABLE", executable_path)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("启动 MCP Sidecar 失败: {error}"))?;
    if !status.success() {
        return Err(format!("MCP Sidecar 异常退出: {status}"));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let local_server_manager = LocalServerManager::default();
    let setup_server_manager = local_server_manager.clone();
    let run_server_manager = local_server_manager.clone();

    tauri::Builder::default()
        .manage(app_update::AppUpdateManager::default())
        .manage(file_download::FileDownloadManager::default())
        .manage(local_server_manager)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            change_app_icon,
            app_update::start_app_update_download,
            app_update::cancel_app_update_download,
            app_update::get_app_update_status,
            app_update::discard_app_update,
            app_update::get_app_update_target,
            app_update::install_app_update,
            file_download::start_file_download,
            file_download::cancel_file_download,
            exit_app,
            reveal_in_file_manager,
            get_system_info,
            get_local_server_port,
            get_local_server_status,
            get_agent_runtime,
            secure_identity::get_or_create_device_identity,
            secure_identity::sign_device_challenge,
            secure_identity::save_secure_account,
            secure_identity::load_active_secure_account,
            secure_identity::clear_active_secure_account
        ])

        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                {
                    if window.label() == "main" {
                        // 在 macOS 和 Windows 下，点击叉号不退出，仅隐藏主窗口
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .on_menu_event(|app_handle, event| {
            let event_id = event.id().as_ref();
            #[cfg(target_os = "windows")]
            if tray::handle_menu_event(app_handle, event_id) {
                return;
            }
            if event_id == "check-update" {
                let _ = app_handle.emit("menu-check-update", ());
            } else if event_id == "about-yuyan" {
                let _ = app_handle.emit("menu-about", ());
            }
        })
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(format!("无法获取应用数据目录: {error}")))?;
            secure_identity::initialize_secure_storage(&app_data_dir)
                .map_err(|error| std::io::Error::other(format!("初始化安全存储失败: {error}")))?;

            #[cfg(target_os = "windows")]
            tray::setup(app)?;

            #[cfg(target_os = "macos")]
            {
                use cocoa::base::id;
                use objc::{msg_send, sel, sel_impl};
                use tauri::menu::{Menu, MenuItemBuilder};
                let app_handle = app.handle();
                if let Ok(menu) = Menu::default(app_handle) {
                    if let Ok(items) = menu.items() {
                        if let Some(first_item) = items.first() {
                            if let Some(app_submenu) = first_item.as_submenu() {
                                // 移除默认的 About 菜单项 (通常在索引 0)
                                let _ = app_submenu.remove_at(0);
                                // 插入自定义的关于菜单项
                                if let Ok(about_item) = MenuItemBuilder::new("关于雨燕")
                                    .id("about-yuyan")
                                    .build(app_handle)
                                {
                                    let _ = app_submenu.insert(&about_item, 0);
                                }

                                if let Ok(check_update_item) = MenuItemBuilder::new("检查更新")
                                    .id("check-update")
                                    .build(app_handle)
                                {
                                    let _ = app_submenu.insert(&check_update_item, 1);
                                }
                            }
                        }
                    }
                    let _ = app.set_menu(menu);
                }
            }

            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.unminimize();
                let _ = main_window.set_focus();

                #[cfg(target_os = "macos")]
                {
                    use cocoa::base::id;
                    use objc::{msg_send, sel, sel_impl};
                    unsafe {
                        let shared_app: id = msg_send![objc::class!(NSApplication), sharedApplication];
                        let _: () = msg_send![shared_app, activateIgnoringOtherApps: true];
                    }
                }
            }

            let app_handle = app.handle();
            match get_node_path(app_handle) {
                Some(node_path) => match check_node_runtime(&node_path) {
                    Ok(version) => {
                        println!("✅ 内嵌 Node 运行时检查通过: {version}");
                        let start_app_handle = app.handle().clone();
                        let start_server_manager = setup_server_manager.clone();
                        thread::spawn(move || {
                            if let Err(last_err) =
                                start_server_manager.start(&start_app_handle, &node_path)
                            {
                                eprintln!(
                                    "[Local Server] 本地服务启动失败，应用将以降级模式继续运行: {last_err}"
                                );
                            }
                        });
                    }
                    Err(error) => {
                        let message = format!("内嵌 Node 运行时不可用：{error}");
                        eprintln!("[Local Server] {message}");
                        setup_server_manager.mark_error(message, Some(&node_path));
                    }
                },
                None => {
                    let message = "生产包未找到内嵌 Node 运行时，应用将以降级模式继续运行".to_string();
                    eprintln!("[Local Server] {message}");
                    setup_server_manager.mark_error(message, None);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            match event {
                // 3. 应用退出时杀死 Node.js 子进程
                tauri::RunEvent::Exit => {
                    run_server_manager.stop("tauri exit");
                }
                // macOS 下点击 Dock 图标时重新显示主窗口
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                _ => {}
            }
        });
}
