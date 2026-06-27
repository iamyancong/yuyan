use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

const UPDATE_SERVER_HOST: &str = "192.168.164.27";
const UPDATE_SERVER_PORT: u16 = 3100;
const UPDATE_DOWNLOAD_PATH: &str = "/deploy-api/app-update/download-asset";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

/** 应用更新下载状态。 */
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    status: String,
    progress: u8,
    error: Option<String>,
    local_path: Option<String>,
}

impl Default for AppUpdateStatus {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            progress: 0,
            error: None,
            local_path: None,
        }
    }
}

/** Tauri 命令通用执行结果。 */
#[derive(Debug, Serialize)]
pub struct AppUpdateCommandResult {
    success: bool,
    message: String,
}

/** 跨命令共享的应用更新状态管理器。 */
#[derive(Clone, Default)]
pub struct AppUpdateManager {
    state: Arc<Mutex<AppUpdateStatus>>,
}

impl AppUpdateManager {
    /** 获取更新状态锁，自动恢复被污染的互斥锁。 */
    fn lock(&self) -> MutexGuard<'_, AppUpdateStatus> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /** 获取当前状态快照。 */
    fn snapshot(&self) -> AppUpdateStatus {
        self.lock().clone()
    }

    /** 将状态切换为下载中。 */
    fn mark_downloading(&self) {
        *self.lock() = AppUpdateStatus {
            status: "downloading".to_string(),
            progress: 0,
            error: None,
            local_path: None,
        };
    }

    /** 更新下载进度。 */
    fn set_progress(&self, progress: u8) {
        self.lock().progress = progress;
    }

    /** 将状态切换为下载完成。 */
    fn mark_completed(&self, local_path: &Path) {
        *self.lock() = AppUpdateStatus {
            status: "completed".to_string(),
            progress: 100,
            error: None,
            local_path: Some(local_path.to_string_lossy().into_owned()),
        };
    }

    /** 将状态切换为失败。 */
    fn mark_error(&self, error: String) {
        *self.lock() = AppUpdateStatus {
            status: "error".to_string(),
            progress: 0,
            error: Some(error),
            local_path: None,
        };
    }
}

/** 校验更新下载地址仅指向受信任的内网代理。 */
fn validate_download_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("更新下载地址无效: {error}"))?;
    let is_allowed_origin = parsed.scheme() == "http"
        && parsed.host_str() == Some(UPDATE_SERVER_HOST)
        && parsed.port_or_known_default() == Some(UPDATE_SERVER_PORT);
    if !is_allowed_origin || parsed.path() != UPDATE_DOWNLOAD_PATH {
        return Err("仅允许从雨燕测试环境内网更新代理下载安装包".to_string());
    }

    let has_asset_id = parsed
        .query_pairs()
        .any(|(key, value)| key == "assetId" && !value.is_empty());
    if !has_asset_id {
        return Err("更新下载地址缺少 assetId".to_string());
    }

    Ok(parsed)
}

/** 校验并规范安装包文件名，防止路径穿越和错误格式。 */
fn validate_filename(filename: &str) -> Result<&str, String> {
    if filename.is_empty() || filename.len() > 128 {
        return Err("更新安装包文件名长度无效".to_string());
    }
    if Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(filename)
    {
        return Err("更新安装包文件名包含非法路径".to_string());
    }
    if !filename
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return Err("更新安装包文件名包含非法字符".to_string());
    }

    let expected_extension = if cfg!(target_os = "windows") {
        "exe"
    } else if cfg!(target_os = "macos") {
        "dmg"
    } else {
        return Err("当前操作系统暂不支持自动安装更新".to_string());
    };
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case(expected_extension) {
        return Err(format!("当前系统仅允许下载 .{expected_extension} 安装包"));
    }

    Ok(filename)
}

/** 校验下载结果不为空，并与响应声明的长度保持一致。 */
fn validate_downloaded_length(
    downloaded_length: u64,
    expected_length: Option<u64>,
) -> Result<(), String> {
    if downloaded_length == 0 {
        return Err("内网更新服务器返回了空安装包".to_string());
    }
    if let Some(total_length) = expected_length {
        if downloaded_length != total_length {
            return Err(format!(
                "安装包大小校验失败，期望 {total_length} 字节，实际 {downloaded_length} 字节"
            ));
        }
    }
    Ok(())
}

/** 将内网安装包下载到临时文件，并在校验完成后原子替换正式文件。 */
async fn download_update(
    app: AppHandle,
    manager: AppUpdateManager,
    url: reqwest::Url,
    filename: String,
) -> Result<PathBuf, String> {
    let update_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法获取应用缓存目录: {error}"))?
        .join("app-update");
    tokio::fs::create_dir_all(&update_dir)
        .await
        .map_err(|error| format!("创建更新缓存目录失败: {error}"))?;

    let destination_path = update_dir.join(&filename);
    let partial_path = update_dir.join(format!("{filename}.part"));
    let _ = tokio::fs::remove_file(&partial_path).await;
    let _ = tokio::fs::remove_file(&destination_path).await;

    let result = download_to_partial(&manager, url, &partial_path).await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return Err(error);
    }

    tokio::fs::rename(&partial_path, &destination_path)
        .await
        .map_err(|error| format!("保存更新安装包失败: {error}"))?;
    Ok(destination_path)
}

/** 执行流式下载并校验响应声明的文件长度。 */
async fn download_to_partial(
    manager: &AppUpdateManager,
    url: reqwest::Url,
    partial_path: &Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent("yuyan-app")
        .build()
        .map_err(|error| format!("创建更新下载客户端失败: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("连接内网更新服务器失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("内网更新服务器返回异常: {error}"))?;
    let expected_length = response.content_length();
    let mut downloaded_length = 0_u64;
    let mut file = tokio::fs::File::create(partial_path)
        .await
        .map_err(|error| format!("创建更新临时文件失败: {error}"))?;

    loop {
        let chunk = tokio::time::timeout(STALL_TIMEOUT, response.chunk())
            .await
            .map_err(|_| "连续 60 秒未收到更新数据，下载已中断".to_string())?
            .map_err(|error| format!("接收更新数据失败: {error}"))?;
        let Some(chunk) = chunk else {
            break;
        };

        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入更新安装包失败: {error}"))?;
        downloaded_length += chunk.len() as u64;
        if let Some(total_length) = expected_length.filter(|length| *length > 0) {
            let progress = ((downloaded_length.saturating_mul(100) / total_length).min(99)) as u8;
            manager.set_progress(progress);
        }
    }

    file.flush()
        .await
        .map_err(|error| format!("刷新更新安装包失败: {error}"))?;
    validate_downloaded_length(downloaded_length, expected_length)
}

/** 启动 Tauri 原生后台下载任务。 */
#[tauri::command]
pub async fn start_app_update_download(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
    url: String,
    filename: String,
) -> Result<AppUpdateCommandResult, String> {
    if manager.snapshot().status == "downloading" {
        return Ok(AppUpdateCommandResult {
            success: true,
            message: "更新安装包正在下载中".to_string(),
        });
    }

    let parsed_url = validate_download_url(&url)?;
    let safe_filename = validate_filename(&filename)?.to_string();
    let manager = manager.inner().clone();
    manager.mark_downloading();
    let task_manager = manager.clone();

    tauri::async_runtime::spawn(async move {
        match download_update(app, task_manager.clone(), parsed_url, safe_filename).await {
            Ok(local_path) => task_manager.mark_completed(&local_path),
            Err(error) => {
                eprintln!("[App Update] 原生下载失败: {error}");
                task_manager.mark_error(error);
            }
        }
    });

    Ok(AppUpdateCommandResult {
        success: true,
        message: "已启动 Tauri 原生后台下载".to_string(),
    })
}

/** 查询 Tauri 原生更新下载状态。 */
#[tauri::command]
pub fn get_app_update_status(manager: State<'_, AppUpdateManager>) -> AppUpdateStatus {
    manager.snapshot()
}

/** 使用系统默认程序打开已下载的更新安装包。 */
#[tauri::command]
pub fn install_app_update(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateCommandResult, String> {
    let snapshot = manager.snapshot();
    if snapshot.status != "completed" {
        return Err("更新安装包尚未下载完成".to_string());
    }
    let local_path = snapshot
        .local_path
        .ok_or_else(|| "更新安装包本地路径不存在".to_string())?;
    if !Path::new(&local_path).is_file() {
        return Err("更新安装包文件不存在，请重新下载".to_string());
    }

    app.opener()
        .open_path(local_path, None::<&str>)
        .map_err(|error| format!("拉起更新安装程序失败: {error}"))?;
    Ok(AppUpdateCommandResult {
        success: true,
        message: "更新安装程序已启动".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        validate_download_url, validate_downloaded_length, validate_filename, AppUpdateManager,
    };

    /** 验证仅允许指定内网更新代理。 */
    #[test]
    fn validates_allowed_update_url() {
        let valid_url = "http://192.168.164.27:3100/deploy-api/app-update/download-asset?assetId=123&filename=yuyan.dmg";
        assert!(validate_download_url(valid_url).is_ok());
        assert!(validate_download_url("https://example.com/update?assetId=123").is_err());
        assert!(validate_download_url(
            "http://192.168.164.27:3100/deploy-api/app-update/download-asset"
        )
        .is_err());
    }

    /** 验证安装包文件名拒绝路径穿越和错误扩展名。 */
    #[test]
    fn validates_update_filename() {
        assert!(validate_filename("../yuyan.dmg").is_err());
        assert!(validate_filename("yuyan 1.0.0.dmg").is_err());

        if cfg!(target_os = "macos") {
            assert!(validate_filename("yuyan-1.0.0.dmg").is_ok());
            assert!(validate_filename("yuyan-1.0.0.exe").is_err());
        } else if cfg!(target_os = "windows") {
            assert!(validate_filename("yuyan-1.0.0.exe").is_ok());
            assert!(validate_filename("yuyan-1.0.0.dmg").is_err());
        }
    }

    /** 验证有无 Content-Length 时的文件大小校验行为。 */
    #[test]
    fn validates_downloaded_length() {
        assert!(validate_downloaded_length(1024, None).is_ok());
        assert!(validate_downloaded_length(1024, Some(1024)).is_ok());
        assert!(validate_downloaded_length(0, None).is_err());
        assert!(validate_downloaded_length(1023, Some(1024)).is_err());
    }

    /** 验证共享状态可正确记录下载进度、完成和失败。 */
    #[test]
    fn manages_update_status_transitions() {
        let manager = AppUpdateManager::default();
        manager.mark_downloading();
        manager.set_progress(42);
        let downloading = manager.snapshot();
        assert_eq!(downloading.status, "downloading");
        assert_eq!(downloading.progress, 42);

        manager.mark_error("网络中断".to_string());
        let failed = manager.snapshot();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.error.as_deref(), Some("网络中断"));
    }
}
