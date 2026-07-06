use std::process::{Command, Stdio, Child};
use std::sync::{Arc, Mutex};
use std::io::{BufRead, BufReader};
use std::thread;
use tauri::{Manager, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri::image::Image;

mod app_update;

const DARK_ICON: &[u8] = include_bytes!("../resources/yuyan_dark_clean.png");
const LIGHT_ICON: &[u8] = include_bytes!("../resources/yuyan_light_clean.png");


// 存储 Node 服务进程的全局状态
#[allow(dead_code)]
struct ServerState {
    child: Arc<Mutex<Option<Child>>>,
}

// 获取 Node.js 可执行文件的路径
fn get_node_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    // 0. 开发环境：直接返回系统全局 Node 命令，避免本地代码签名导致的 137 挂起问题
    if cfg!(dev) {
        println!("🔧 开发模式：使用系统全局 Node 路径");
        return std::path::PathBuf::from("node");
    }

    let binary_name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };

    // 1. 尝试查找打包后（或开发模式）的标准资源目录
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        // 打包后在 app bundle 内的路径：Contents/Resources/resources/bin/node
        let embedded_node = resource_dir.join("resources").join("bin").join(binary_name);
        if embedded_node.exists() {
            println!("🔍 找到打包后内嵌 Node 二进制文件: {:?}", embedded_node);
            return embedded_node;
        }

        // 开发环境：项目根目录/src-tauri/resources/bin/node
        let dev_node = resource_dir.join("src-tauri").join("resources").join("bin").join(binary_name);
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
        let common_paths = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ];
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

// 启动 Express Node 服务
fn start_node_server(app: &tauri::App, node_path: &std::path::Path) -> Result<Child, String> {
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
                app.path().resource_dir()
                    .map_err(|e| format!("无法获取资源目录: {}", e))?
                    .join("server/index.mjs")
            }
        }
    } else {
        let res_dir = app.path().resource_dir()
            .map_err(|e| format!("无法获取资源目录: {}", e))?;
        let path1 = res_dir.join("server/index.mjs");
        if path1.exists() {
            path1
        } else {
            res_dir.join("_up_/server/index.mjs")
        }
    };
        
    let app_data_dir = app.path().app_data_dir()
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
    println!("📂 脚本路径: {:?}", resource_path);
    println!("📂 部署数据目录 (DEPLOY_DATA_DIR): {:?}", deploy_data_dir);
    println!("📂 模板缓存目录 (TEMPLATE_REPO_PATH): {:?}", template_repo_path);
    println!("==================================================");
    
    let mut child = Command::new(node_path)
        .arg(resource_path)
        .env("DEPLOY_DATA_DIR", deploy_data_dir.to_str().unwrap_or(""))
        .env("TEMPLATE_REPO_PATH", template_repo_path.to_str().unwrap_or(""))
        .env("DEPLOY_SECRET_KEY", "15170bd388b349e5f3f40cb8080ba6d1e82c66f8d097ef7b18e6243ddbb655b6")
        .env("PORT", "3101")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 Node 服务进程失败: {}", e))?;
        
    // 管道化标准输出和错误输出到终端以方便调试
    if let Some(stdout) = child.stdout.take() {
        pipe_output(stdout, "STDOUT");
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_output(stderr, "STDERR");
    }
    
    Ok(child)
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon(png_bytes: &[u8]) {
    use cocoa::base::{id, nil};
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

/** 安全退出整个应用并清理 Node 子进程的命令。 */
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    println!("🛑 收到强制退出指令，正在安全退出应用并清理子进程...");
    app.exit(0);
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let child_state = Arc::new(Mutex::new(None));
    let child_state_clone = Arc::clone(&child_state);

    tauri::Builder::default()
        .manage(app_update::AppUpdateManager::default())
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
            exit_app
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
            if event.id().as_ref() == "check-update" {
                let _ = app_handle.emit("menu-check-update", ());
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
            if !check_node_installed(&node_path) {
                let handle = app.handle().clone();
                // 弹出警告弹窗
                handle.dialog()
                    .message("未检测到本地 Node.js 环境。\n\n雨燕平台桌面端需要依赖 Node.js 来启动本地服务，请先在系统中安装 Node.js（推荐使用 LTS 版本）后，再重新运行此应用。")
                    .title("系统环境缺失")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
                    
                std::process::exit(1);
            }

            // 2. 启动 Express 数据库与服务
            match start_node_server(app, &node_path) {
                Ok(child) => {
                    let mut lock = child_state.lock().unwrap();
                    *lock = Some(child);
                    println!("✅ Node 服务启动成功！进程监听端口: 3100");
                }
                Err(err) => {
                    let handle = app.handle().clone();
                    handle.dialog()
                        .message(&format!("Node 本地服务启动失败：\n{}\n\n请检查服务脚本及文件完整性。", err))
                        .title("服务启动错误")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                        
                    std::process::exit(1);
                }
            }

            // 将进程状态托管到 Tauri State 中
            app.manage(ServerState {
                child: Arc::clone(&child_state),
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            match event {
                // 3. 应用退出时杀死 Node.js 子进程
                tauri::RunEvent::Exit => {
                    let mut lock = child_state_clone.lock().unwrap();
                    if let Some(mut child) = lock.take() {
                        println!("🛑 正在停止 Node 本地服务进程 (PID: {})...", child.id());
                        let _ = child.kill();
                    }
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
