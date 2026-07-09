use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

mod app_update;

const DARK_ICON: &[u8] = include_bytes!("../resources/yuyan_dark_clean.png");
const LIGHT_ICON: &[u8] = include_bytes!("../resources/yuyan_light_clean.png");
const DEFAULT_LOCAL_SERVER_PORT: u16 = 3101;
const LOCAL_SERVER_STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const LOCAL_SERVER_STOP_TIMEOUT: Duration = Duration::from_secs(3);

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
    last_error: Option<String>,
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
    last_error: Option<String>,
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
        LocalServerStatus {
            port: state.port,
            pid,
            running,
            last_error: state.last_error.clone(),
        }
    }

    /** 启动内嵌 Node 服务并记录端口和进程。 */
    fn start(&self, app: &tauri::App, node_path: &std::path::Path) -> Result<u16, String> {
        let mut retries = 0;
        let mut last_err = String::new();

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

            match start_node_server(app, node_path, port) {
                Ok(child) => {
                    let pid = child.id();
                    let mut state = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state.child = Some(child);
                    state.port = port;
                    state.last_error = None;
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
        state.last_error = Some(last_err.clone());
        Err(last_err)
    }

    /** 停止内嵌 Node 服务，优先 graceful shutdown，超时后终止进程树。 */
    pub(crate) fn stop(&self, reason: &str) {
        let mut child = {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.child.take()
        };

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

// 获取 Node.js 可执行文件的路径
fn get_node_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    // 0. 开发环境：直接返回系统全局 Node 命令，避免本地代码签名导致的 137 挂起问题
    if cfg!(dev) {
        println!("🔧 开发模式：使用系统全局 Node 路径");
        return std::path::PathBuf::from("node");
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
            return embedded_node;
        }

        // 开发环境：项目根目录/src-tauri/resources/bin/node
        let dev_node = resource_dir
            .join("src-tauri")
            .join("resources")
            .join("bin")
            .join(binary_name);
        if dev_node.exists() {
            println!("🔍 找到开发环境内嵌 Node 二进制文件: {:?}", dev_node);
            return dev_node;
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
                    return path1;
                }
            }
        }
    }

    // 3. 在 macOS 上，若是 GUI 双击启动，PATH 环境可能丢失，在此做常见路径补丁
    #[cfg(target_os = "macos")]
    {
        let common_paths = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
        for path in common_paths {
            let path_buf = std::path::PathBuf::from(path);
            if path_buf.exists() {
                println!("🔍 找到 macOS 常见全局 Node 路径: {:?}", path_buf);
                return path_buf;
            }
        }
    }

    // 4. 找不到内嵌的，则回退到系统环境变量中的 "node"
    std::path::PathBuf::from("node")
}

// 检查系统中是否安装了 Node.js
fn check_node_installed(node_path: &std::path::Path) -> bool {
    Command::new(node_path)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// 管道日志输出辅助函数
fn pipe_output<R: std::io::Read + Send + 'static>(reader: R, prefix: &'static str) {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            if let Ok(l) = line {
                println!("[Node Server {}] {}", prefix, l);
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
        let _ = Command::new("taskkill").args(args).output();
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
    app: &tauri::App,
    node_path: &std::path::Path,
    port: u16,
) -> Result<Child, String> {
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

    let mut command = Command::new(node_path);
    command
        .arg(resource_path)
        .env("DEPLOY_DATA_DIR", deploy_data_dir.to_str().unwrap_or(""))
        .env(
            "TEMPLATE_REPO_PATH",
            template_repo_path.to_str().unwrap_or(""),
        )
        .env(
            "DEPLOY_SECRET_KEY",
            "15170bd388b349e5f3f40cb8080ba6d1e82c66f8d097ef7b18e6243ddbb655b6",
        )
        .env("PORT", port.to_string())
        .env("IS_TAURI_SUBPROCESS", "true")
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
        pipe_output(stdout, "STDOUT");
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_output(stderr, "STDERR");
    }

    if let Err(error) = wait_for_local_server_health(&mut child, port) {
        terminate_child_tree(&mut child, true);
        let _ = child.wait();
        return Err(error);
    }

    Ok(child)
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    app_version: String,
    tauri_version: String,
    node_version: String,
    os_info: String,
}

/** 获取桌面端系统诊断信息的命令。 */
#[tauri::command]
fn get_system_info(app_handle: tauri::AppHandle) -> SystemInfo {
    let app_version = app_handle.package_info().version.to_string();

    // 获取 Node 版本
    let node_path = get_node_path(&app_handle);
    let node_version = Command::new(&node_path)
        .arg("--version")
        .output()
        .map(|o| {
            if o.status.success() {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            } else {
                "Unknown".to_string()
            }
        })
        .unwrap_or_else(|_| "Not Installed".to_string());

    // 操作系统信息
    #[cfg(target_os = "macos")]
    let os_version = Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());

    #[cfg(target_os = "windows")]
    let os_version = Command::new("cmd")
        .args(&["/c", "ver"])
        .output()
        .map(|o| {
            let ver_str = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if let Some(start) = ver_str.find("Version ") {
                let temp = &ver_str[start + 8..];
                if let Some(end) = temp.find(']') {
                    temp[..end].to_string()
                } else {
                    ver_str
                }
            } else {
                ver_str
            }
        })
        .unwrap_or_else(|_| "Unknown".to_string());

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
    println!("🔍 正在打开文件管理器定位文件: {}", path);
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        } else {
            Err("无效路径".to_string())
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let local_server_manager = LocalServerManager::default();
    let setup_server_manager = local_server_manager.clone();
    let run_server_manager = local_server_manager.clone();

    tauri::Builder::default()
        .manage(app_update::AppUpdateManager::default())
        .manage(local_server_manager)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
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
            app_update::get_app_update_target,
            app_update::install_app_update,
            exit_app,
            reveal_in_file_manager,
            get_system_info,
            get_local_server_port,
            get_local_server_status
        ])

        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    // 在 macOS 下，点击叉号不退出，仅隐藏窗口
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .on_menu_event(|app_handle, event| {
            let event_id = event.id().as_ref();
            if event_id == "check-update" {
                let _ = app_handle.emit("menu-check-update", ());
            } else if event_id == "about-yuyan" {
                let _ = app_handle.emit("menu-about", ());
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
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

            let app_handle = app.handle();
            let node_path = get_node_path(app_handle);




            // 1. 检查 Node.js 环境
            let node_installed = check_node_installed(&node_path);
            if !node_installed {
                let handle = app.handle().clone();
                // 弹出提示弹窗，告知用户缺失 Node.js，但不退出程序
                handle.dialog()
                    .message("未检测到本地 Node.js 环境。\n\n雨燕平台需要依赖 Node.js 来启动本地数据库和辅助服务。请先安装 Node.js（推荐 LTS 版本）后重启应用。\n\n当前您仍可点击“确定”继续使用连接远程测试环境的功能。")
                    .title("本地环境缺失")
                    .kind(MessageDialogKind::Warning)
                    .blocking_show();
            }

            if node_installed {
                if let Err(last_err) = setup_server_manager.start(app, &node_path) {
                    let handle = app.handle().clone();
                    handle.dialog()
                        .message(&format!("Node 本地服务在重试 3 次后均启动失败：\n{}\n\n请检查端口占用或服务脚本完整性。\n\n当前您仍可点击“确定”继续使用连接远程测试环境的功能。", last_err))
                        .title("本地服务启动错误")
                        .kind(MessageDialogKind::Warning)
                        .blocking_show();
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
