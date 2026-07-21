#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--mcp") {
        if let Err(error) = yuyan_app_lib::run_mcp_sidecar() {
            eprintln!("[yuyan-mcp] {error}");
            std::process::exit(1);
        }
        return;
    }
    yuyan_app_lib::run();
}
