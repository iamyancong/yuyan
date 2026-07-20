use crate::LocalServerManager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

/** 主托盘图标的稳定标识。 */
const TRAY_ID: &str = "yuyan-main-tray";
/** 托盘菜单项标识：打开主窗口。 */
const MENU_OPEN: &str = "tray-open-main-window";
/** 托盘菜单项标识：安全退出应用。 */
const MENU_QUIT: &str = "tray-quit-app";

/** 创建 Windows 原生托盘及右键菜单。 */
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, MENU_OPEN, "打开雨燕", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出雨燕", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("未找到应用默认图标，无法创建系统托盘")?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("雨燕")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/** 处理 Windows 托盘菜单事件，返回事件是否已消费。 */
pub fn handle_menu_event(app_handle: &AppHandle, event_id: &str) -> bool {
    match event_id {
        MENU_OPEN => show_main_window(app_handle),
        MENU_QUIT => {
            let server_manager = app_handle.state::<LocalServerManager>();
            server_manager.stop("tray quit");
            app_handle.exit(0);
        }
        _ => return false,
    }

    true
}

/** 显示、恢复并聚焦主窗口。 */
fn show_main_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
