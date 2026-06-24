use std::process::{Command, Stdio, Child};
use std::sync::{Arc, Mutex};
use std::io::{BufRead, BufReader};
use std::thread;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

// 存储 Node 服务进程的全局状态
struct ServerState {
    child: Arc<Mutex<Option<Child>>>,
}

// 检查系统中是否安装了 Node.js
fn check_node_installed() -> bool {
    Command::new("node")
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
fn start_node_server(app: &tauri::App) -> Result<Child, String> {
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
        app.path().resource_dir()
            .map_err(|e| format!("无法获取资源目录: {}", e))?
            .join("server/index.mjs")
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
    
    let mut child = Command::new("node")
        .arg(resource_path)
        .env("DEPLOY_DATA_DIR", deploy_data_dir.to_str().unwrap_or(""))
        .env("TEMPLATE_REPO_PATH", template_repo_path.to_str().unwrap_or(""))
        .env("DEPLOY_SECRET_KEY", "15170bd388b349e5f3f40cb8080ba6d1e82c66f8d097ef7b18e6243ddbb655b6")
        .env("PORT", "3100")
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let child_state = Arc::new(Mutex::new(None));
    let child_state_clone = Arc::clone(&child_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // 1. 检查 Node.js 环境
            if !check_node_installed() {
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
            match start_node_server(app) {
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
        .run(move |_app_handle, event| {
            // 3. 应用退出时杀死 Node.js 子进程
            if let tauri::RunEvent::Exit = event {
                let mut lock = child_state_clone.lock().unwrap();
                if let Some(mut child) = lock.take() {
                    println!("🛑 正在停止 Node 本地服务进程 (PID: {})...", child.id());
                    let _ = child.kill();
                }
            }
        });
}
