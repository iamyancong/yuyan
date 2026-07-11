use std::process::Command;
use tauri::image::Image;
use tauri::{Emitter, Manager};

mod app_update;
mod vpn;

const DARK_ICON: &[u8] = include_bytes!("../resources/yuyan_dark_clean.png");
const LIGHT_ICON: &[u8] = include_bytes!("../resources/yuyan_light_clean.png");

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

#[cfg(target_os = "macos")]
fn set_macos_dock_icon(png_bytes: &[u8]) {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let ns_data: id = msg_send![objc::class!(NSData), dataWithBytes: png_bytes.as_ptr() length: png_bytes.len()];
        let ns_image_alloc: id = msg_send![objc::class!(NSImage), alloc];
        let ns_image: id = msg_send![ns_image_alloc, initWithData: ns_data];
        let shared_app: id = msg_send![objc::class!(NSApplication), sharedApplication];
        let _: () = msg_send![shared_app, setApplicationIconImage: ns_image];
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    app_version: String,
    tauri_version: String,
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

#[tauri::command]
fn get_system_info(app_handle: tauri::AppHandle) -> SystemInfo {
    let app_version = app_handle.package_info().version.to_string();

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
        os_info,
    }
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    println!("🛑 收到强制退出指令，正在安全退出应用...");
    app.exit(0);
}

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
    let vpn_manager = vpn::VpnManager::new();

    tauri::Builder::default()
        .manage(app_update::AppUpdateManager::default())
        .manage(vpn_manager)
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
            vpn::save_vpn_config,
            vpn::load_vpn_config,
            vpn::verify_sudo_password,
            vpn::has_sudo_credentials,
            vpn::get_vpn_state,
            vpn::atrust::connect_atrust,
            vpn::atrust::disconnect_atrust,
            vpn::fortinet::connect_fortinet,
            vpn::fortinet::disconnect_fortinet,
            vpn::submit_vpn_mfa
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
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
                                let _ = app_submenu.remove_at(0);
                                if let Ok(about_item) = MenuItemBuilder::new("关于雨燕VPN")
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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            match event {
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
