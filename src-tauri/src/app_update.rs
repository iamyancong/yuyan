use crate::LocalServerManager;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const UPDATE_SERVER_HOST: &str = match option_env!("UPDATE_SERVER_HOST") {
    Some(host) => host,
    None => "192.168.164.27",
};
const UPDATE_SERVER_SCHEME: &str = match option_env!("UPDATE_SERVER_SCHEME") {
    Some(scheme) => scheme,
    None => "http",
};
const UPDATE_SERVER_PORT_STR: Option<&str> = option_env!("UPDATE_SERVER_PORT");
const UPDATE_DOWNLOAD_PATH: &str = "/deploy-api/app-update/download-asset";
const UPDATE_STATIC_PATH_PREFIX: &str = "/app-updates/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAX_DOWNLOAD_RETRIES: u8 = 3;
const UPDATE_STATE_FILENAME: &str = "update-state.json";
const UPDATE_STATE_TEMP_FILENAME: &str = "update-state.json.tmp";
const MIN_FREE_SPACE_RESERVE_BYTES: u64 = 100 * 1024 * 1024;

/** 应用更新下载状态。 */
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppUpdateStatus {
    status: String,
    progress: u8,
    error: Option<String>,
    local_path: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    bytes_per_second: u64,
    remaining_seconds: Option<u64>,
    resumable: bool,
    retry_count: u8,
    version: String,
    asset_id: String,
    filename: String,
    expected_sha256: Option<String>,
    expected_etag: Option<String>,
}

impl Default for AppUpdateStatus {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            progress: 0,
            error: None,
            local_path: None,
            downloaded_bytes: 0,
            total_bytes: None,
            bytes_per_second: 0,
            remaining_seconds: None,
            resumable: false,
            retry_count: 0,
            version: String::new(),
            asset_id: String::new(),
            filename: String::new(),
            expected_sha256: None,
            expected_etag: None,
        }
    }
}

/** Tauri 命令通用执行结果。 */
#[derive(Debug, Serialize)]
pub struct AppUpdateCommandResult {
    success: bool,
    message: String,
}

/** 当前桌面客户端更新目标。 */
#[derive(Debug, Serialize)]
pub struct AppUpdateTarget {
    platform: &'static str,
    arch: &'static str,
}

/** 跨命令共享的应用更新状态管理器。 */
#[derive(Clone, Default)]
pub struct AppUpdateManager {
    state: Arc<Mutex<AppUpdateStatus>>,
    cancel_requested: Arc<AtomicBool>,
    initialized: Arc<AtomicBool>,
    task_active: Arc<AtomicBool>,
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

    /** 替换当前更新状态。 */
    fn replace(&self, status: AppUpdateStatus) {
        *self.lock() = status;
    }

    /** 将状态切换为下载中并绑定目标资源。 */
    fn mark_downloading(
        &self,
        version: String,
        asset_id: String,
        filename: String,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        expected_sha256: Option<String>,
        expected_etag: Option<String>,
    ) {
        self.cancel_requested.store(false, Ordering::Relaxed);
        *self.lock() = AppUpdateStatus {
            status: "downloading".to_string(),
            progress: calculate_progress(downloaded_bytes, total_bytes),
            error: None,
            local_path: None,
            downloaded_bytes,
            total_bytes,
            bytes_per_second: 0,
            remaining_seconds: None,
            resumable: downloaded_bytes > 0,
            retry_count: 0,
            version,
            asset_id,
            filename,
            expected_sha256,
            expected_etag,
        };
    }

    /** 更新下载进度与实时吞吐。 */
    fn set_download_progress(
        &self,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        bytes_per_second: u64,
        resumable: bool,
        retry_count: u8,
    ) {
        let remaining_seconds = total_bytes.and_then(|total| {
            if bytes_per_second == 0 || downloaded_bytes >= total {
                None
            } else {
                Some((total - downloaded_bytes).div_ceil(bytes_per_second))
            }
        });
        let mut state = self.lock();
        state.progress = calculate_progress(downloaded_bytes, total_bytes);
        state.downloaded_bytes = downloaded_bytes;
        state.total_bytes = total_bytes;
        state.bytes_per_second = bytes_per_second;
        state.remaining_seconds = remaining_seconds;
        state.resumable = resumable;
        state.retry_count = retry_count;
    }

    /** 请求暂停当前下载任务。 */
    fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::Relaxed);
    }

    /** 判断当前下载是否已被用户取消。 */
    fn is_cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Relaxed)
    }

    /** 将状态切换为已暂停，并保留断点信息。 */
    fn mark_paused(&self) {
        let mut state = self.lock();
        state.status = "paused".to_string();
        state.error = None;
        state.bytes_per_second = 0;
        state.remaining_seconds = None;
    }

    /** 将状态切换为下载完成。 */
    fn mark_completed(&self, local_path: &Path) {
        let mut state = self.lock();
        state.status = "completed".to_string();
        state.progress = 100;
        state.error = None;
        state.local_path = Some(local_path.to_string_lossy().into_owned());
        state.downloaded_bytes = state.total_bytes.unwrap_or(state.downloaded_bytes);
        state.bytes_per_second = 0;
        state.remaining_seconds = Some(0);
        state.resumable = false;
    }

    /** 将状态切换为失败。 */
    fn mark_error(&self, error: String) {
        let mut state = self.lock();
        state.status = "error".to_string();
        state.error = Some(error);
        state.bytes_per_second = 0;
        state.remaining_seconds = None;
    }

    /** 判断状态是否属于指定版本资源。 */
    fn matches_asset(&self, version: &str, asset_id: &str, filename: &str) -> bool {
        let state = self.lock();
        state.version == version && state.asset_id == asset_id && state.filename == filename
    }

    /** 首次访问时从磁盘恢复更新状态。 */
    async fn ensure_initialized(&self, app: &AppHandle) -> Result<(), String> {
        if self.initialized.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        match restore_update_state(app).await {
            Ok(status) => {
                self.replace(status);
                Ok(())
            }
            Err(error) => {
                self.initialized.store(false, Ordering::Release);
                Err(error)
            }
        }
    }
}

/** 获取客户端更新缓存目录。 */
fn get_update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("app-update"))
        .map_err(|error| format!("无法获取应用缓存目录: {error}"))
}

/** 原子保存更新状态，确保 App 重启后可以恢复。 */
async fn persist_update_state(app: &AppHandle, status: &AppUpdateStatus) -> Result<(), String> {
    let update_dir = get_update_dir(app)?;
    tokio::fs::create_dir_all(&update_dir)
        .await
        .map_err(|error| format!("创建更新缓存目录失败: {error}"))?;
    let state_path = update_dir.join(UPDATE_STATE_FILENAME);
    let temporary_path = update_dir.join(UPDATE_STATE_TEMP_FILENAME);
    let content =
        serde_json::to_vec(status).map_err(|error| format!("序列化更新状态失败: {error}"))?;
    tokio::fs::write(&temporary_path, content)
        .await
        .map_err(|error| format!("保存更新状态失败: {error}"))?;
    #[cfg(target_os = "windows")]
    if state_path.is_file() {
        tokio::fs::remove_file(&state_path)
            .await
            .map_err(|error| format!("替换旧更新状态失败: {error}"))?;
    }
    tokio::fs::rename(&temporary_path, &state_path)
        .await
        .map_err(|error| format!("提交更新状态失败: {error}"))
}

/** 删除指定目录中的旧更新包与断点文件。 */
async fn cleanup_update_files(
    update_dir: &Path,
    keep_filename: Option<&str>,
) -> Result<(), String> {
    let mut entries = match tokio::fs::read_dir(update_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取更新缓存目录失败: {error}")),
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("遍历更新缓存目录失败: {error}"))?
    {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name == UPDATE_STATE_FILENAME || name == UPDATE_STATE_TEMP_FILENAME {
            continue;
        }
        let should_keep = keep_filename.is_some_and(|filename| {
            name == filename
                || name == format!("{filename}.part")
                || name == format!("{filename}.part.etag")
        });
        if should_keep {
            continue;
        }
        let is_update_file = name.ends_with(".dmg")
            || name.ends_with(".exe")
            || name.ends_with(".part")
            || name.ends_with(".part.etag");
        if is_update_file {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
    Ok(())
}

/** 校验剩余空间能够容纳安装包及安全余量。 */
fn ensure_available_space(
    update_dir: &Path,
    expected_size: Option<u64>,
    existing_length: u64,
) -> Result<(), String> {
    let available = fs2::available_space(update_dir)
        .map_err(|error| format!("读取磁盘剩余空间失败: {error}"))?;
    let remaining = expected_size
        .unwrap_or_default()
        .saturating_sub(existing_length);
    let required = remaining.saturating_add(MIN_FREE_SPACE_RESERVE_BYTES);
    if available < required {
        return Err(format!(
            "磁盘空间不足，至少需要保留 {} MB 可用空间",
            required.div_ceil(1024 * 1024)
        ));
    }
    Ok(())
}

/** 校验版本和资源身份，避免持久化异常或超长元数据。 */
fn validate_update_identity(version: &str, asset_id: &str) -> Result<(), String> {
    let is_safe = |value: &str| {
        !value.is_empty()
            && value.len() <= 256
            && value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':')
            })
    };
    if !is_safe(version) {
        return Err("更新版本号格式无效".to_string());
    }
    if !is_safe(asset_id) {
        return Err("更新资源身份格式无效".to_string());
    }
    Ok(())
}

/** 根据字节数计算下载百分比。 */
fn calculate_progress(downloaded_bytes: u64, total_bytes: Option<u64>) -> u8 {
    total_bytes
        .filter(|total| *total > 0)
        .map(|total| ((downloaded_bytes.saturating_mul(100) / total).min(99)) as u8)
        .unwrap_or(0)
}

/** 校验更新下载地址仅指向受信任的内网代理。 */
fn validate_download_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("更新下载地址无效: {error}"))?;
    let port = UPDATE_SERVER_PORT_STR
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(3100);
    let is_allowed_origin = parsed.scheme() == UPDATE_SERVER_SCHEME
        && parsed.host_str() == Some(UPDATE_SERVER_HOST)
        && parsed.port_or_known_default() == Some(port);
    let is_allowed_path = parsed.path() == UPDATE_DOWNLOAD_PATH
        || parsed.path().starts_with(UPDATE_STATIC_PATH_PREFIX);
    if !is_allowed_origin || !is_allowed_path {
        return Err("仅允许从雨燕测试环境内网更新代理下载安装包".to_string());
    }

    let has_asset_id = parsed.path() != UPDATE_DOWNLOAD_PATH
        || parsed
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

/** 根据系统安装包格式校验关键文件签名。 */
fn validate_package_signature(
    filename: &str,
    first_bytes: &[u8],
    dmg_trailer: Option<&[u8]>,
) -> Result<(), String> {
    if filename.to_ascii_lowercase().ends_with(".exe") {
        if first_bytes.starts_with(b"MZ") {
            return Ok(());
        }
        return Err("下载文件不是有效的 Windows EXE 安装包".to_string());
    }
    if filename.to_ascii_lowercase().ends_with(".dmg") {
        if dmg_trailer.is_some_and(|trailer| trailer.starts_with(b"koly")) {
            return Ok(());
        }
        return Err("下载文件不是有效的 macOS DMG 磁盘映像，请重试".to_string());
    }
    Err("无法识别更新安装包格式".to_string())
}

/** 从磁盘读取安装包头部和 DMG 尾部签名并执行格式校验。 */
async fn validate_package_file(path: &Path, filename: &str) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("读取更新安装包失败: {error}"))?;
    let file_length = file
        .metadata()
        .await
        .map_err(|error| format!("读取更新安装包大小失败: {error}"))?
        .len();
    let mut first_bytes = [0_u8; 2];
    file.read_exact(&mut first_bytes)
        .await
        .map_err(|error| format!("读取更新安装包头部失败: {error}"))?;

    if filename.to_ascii_lowercase().ends_with(".dmg") {
        if file_length < 512 {
            return Err("下载的 macOS DMG 磁盘映像大小无效".to_string());
        }
        file.seek(std::io::SeekFrom::End(-512))
            .await
            .map_err(|error| format!("定位 DMG 尾部签名失败: {error}"))?;
        let mut trailer = [0_u8; 4];
        file.read_exact(&mut trailer)
            .await
            .map_err(|error| format!("读取 DMG 尾部签名失败: {error}"))?;
        return validate_package_signature(filename, &first_bytes, Some(&trailer));
    }

    validate_package_signature(filename, &first_bytes, None)
}

/** 校验文件大小和 SHA-256 摘要。 */
async fn validate_package_integrity(
    path: &Path,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("读取更新安装包大小失败: {error}"))?;
    validate_downloaded_length(metadata.len(), expected_size)?;

    let Some(expected_digest) = expected_sha256.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("读取更新安装包失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read_length = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("计算安装包 SHA-256 失败: {error}"))?;
        if read_length == 0 {
            break;
        }
        hasher.update(&buffer[..read_length]);
    }
    let actual_digest = format!("{:x}", hasher.finalize());
    if actual_digest.eq_ignore_ascii_case(expected_digest) {
        return Ok(());
    }
    Err(format!(
        "安装包 SHA-256 校验失败，期望 {expected_digest}，实际 {actual_digest}"
    ))
}

/** 从磁盘恢复已完成安装包或可续传断点。 */
async fn restore_update_state(app: &AppHandle) -> Result<AppUpdateStatus, String> {
    let update_dir = get_update_dir(app)?;
    let state_path = update_dir.join(UPDATE_STATE_FILENAME);
    let content = match tokio::fs::read(&state_path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let _ = tokio::fs::remove_file(update_dir.join(UPDATE_STATE_TEMP_FILENAME)).await;
            cleanup_update_files(&update_dir, None).await?;
            return Ok(AppUpdateStatus::default());
        }
        Err(error) => return Err(format!("读取更新状态失败: {error}")),
    };
    let mut status = match serde_json::from_slice::<AppUpdateStatus>(&content) {
        Ok(status) => status,
        Err(error) => {
            let _ = tokio::fs::remove_file(&state_path).await;
            let _ = tokio::fs::remove_file(update_dir.join(UPDATE_STATE_TEMP_FILENAME)).await;
            cleanup_update_files(&update_dir, None).await?;
            eprintln!("[App Update] 已清理损坏的更新状态: {error}");
            return Ok(AppUpdateStatus::default());
        }
    };
    if validate_update_identity(&status.version, &status.asset_id).is_err()
        || validate_filename(&status.filename).is_err()
    {
        let _ = tokio::fs::remove_file(&state_path).await;
        let _ = tokio::fs::remove_file(update_dir.join(UPDATE_STATE_TEMP_FILENAME)).await;
        cleanup_update_files(&update_dir, None).await?;
        return Ok(AppUpdateStatus::default());
    }

    let destination_path = update_dir.join(&status.filename);
    let partial_path = update_dir.join(format!("{}.part", status.filename));
    if matches!(status.status.as_str(), "completed" | "installing") && destination_path.is_file() {
        let integrity = validate_package_integrity(
            &destination_path,
            status.total_bytes,
            status.expected_sha256.as_deref(),
        )
        .await;
        let format = validate_package_file(&destination_path, &status.filename).await;
        if integrity.is_ok() && format.is_ok() {
            status.status = "completed".to_string();
            status.progress = 100;
            status.error = None;
            status.local_path = Some(destination_path.to_string_lossy().into_owned());
            status.downloaded_bytes = status.total_bytes.unwrap_or(status.downloaded_bytes);
            status.bytes_per_second = 0;
            status.remaining_seconds = Some(0);
            status.resumable = false;
            persist_update_state(app, &status).await?;
            return Ok(status);
        }
        let _ = tokio::fs::remove_file(&destination_path).await;
    }

    let partial_length = tokio::fs::metadata(&partial_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    if partial_length > 0 {
        status.status = "paused".to_string();
        status.progress = calculate_progress(partial_length, status.total_bytes);
        status.error = None;
        status.local_path = None;
        status.downloaded_bytes = partial_length;
        status.bytes_per_second = 0;
        status.remaining_seconds = None;
        status.resumable = true;
        persist_update_state(app, &status).await?;
        return Ok(status);
    }

    let _ = tokio::fs::remove_file(&state_path).await;
    let _ = tokio::fs::remove_file(update_dir.join(UPDATE_STATE_TEMP_FILENAME)).await;
    cleanup_update_files(&update_dir, None).await?;
    Ok(AppUpdateStatus::default())
}

/** 从 Content-Range 响应头中解析起始位置和文件总长度。 */
fn parse_content_range(value: &str) -> Option<(u64, u64)> {
    let range = value.strip_prefix("bytes ")?;
    let (positions, total) = range.split_once('/')?;
    let (start, _) = positions.split_once('-')?;
    Some((start.parse().ok()?, total.parse().ok()?))
}

/** 构建更新包下载请求，仅为受鉴权保护的动态代理附加部署 Token。 */
fn build_download_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    deploy_api_token: Option<&str>,
) -> reqwest::RequestBuilder {
    let is_protected_proxy = url.path() == UPDATE_DOWNLOAD_PATH;
    let mut request = client.get(url);
    if is_protected_proxy {
        if let Some(token) = deploy_api_token.filter(|value| !value.is_empty()) {
            request = request.header("X-Deploy-Token", token);
        }
    }
    request
}

/** 将内网安装包下载到临时文件，并在校验完成后原子替换正式文件。 */
async fn download_update(
    app: AppHandle,
    manager: AppUpdateManager,
    url: reqwest::Url,
    version: String,
    asset_id: String,
    filename: String,
    expected_size: Option<u64>,
    expected_sha256: Option<String>,
    expected_etag: Option<String>,
    deploy_api_token: Option<String>,
    allow_resume: bool,
) -> Result<PathBuf, String> {
    let update_dir = get_update_dir(&app)?;
    tokio::fs::create_dir_all(&update_dir)
        .await
        .map_err(|error| format!("创建更新缓存目录失败: {error}"))?;
    cleanup_update_files(&update_dir, Some(&filename)).await?;

    let destination_path = update_dir.join(&filename);
    let partial_path = update_dir.join(format!("{filename}.part"));
    let etag_path = update_dir.join(format!("{filename}.part.etag"));
    let _ = tokio::fs::remove_file(&destination_path).await;
    if !allow_resume {
        let _ = tokio::fs::remove_file(&partial_path).await;
        let _ = tokio::fs::remove_file(&etag_path).await;
    }

    let stored_etag = tokio::fs::read_to_string(&etag_path).await.ok();
    if partial_path.is_file()
        && expected_etag.is_some()
        && stored_etag.as_deref() != expected_etag.as_deref()
    {
        let _ = tokio::fs::remove_file(&partial_path).await;
    }
    if let Some(etag) = expected_etag.as_deref() {
        tokio::fs::write(&etag_path, etag)
            .await
            .map_err(|error| format!("保存更新断点标识失败: {error}"))?;
    }

    let existing_length = tokio::fs::metadata(&partial_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    ensure_available_space(&update_dir, expected_size, existing_length)?;
    manager.mark_downloading(
        version,
        asset_id,
        filename.clone(),
        existing_length,
        expected_size,
        expected_sha256.clone(),
        expected_etag.clone(),
    );
    persist_update_state(&app, &manager.snapshot()).await?;
    let result = download_to_partial(
        &manager,
        url,
        &partial_path,
        expected_size,
        expected_etag.as_deref(),
        deploy_api_token.as_deref(),
    )
    .await;
    if let Err(error) = result {
        if manager.is_cancel_requested() {
            manager.mark_paused();
        }
        return Err(error);
    }
    if let Err(error) =
        validate_package_integrity(&partial_path, expected_size, expected_sha256.as_deref()).await
    {
        let _ = tokio::fs::remove_file(&partial_path).await;
        let _ = tokio::fs::remove_file(&etag_path).await;
        return Err(error);
    }
    if let Err(error) = validate_package_file(&partial_path, &filename).await {
        let _ = tokio::fs::remove_file(&partial_path).await;
        let _ = tokio::fs::remove_file(&etag_path).await;
        return Err(error);
    }

    tokio::fs::rename(&partial_path, &destination_path)
        .await
        .map_err(|error| format!("保存更新安装包失败: {error}"))?;
    let _ = tokio::fs::remove_file(&etag_path).await;
    Ok(destination_path)
}

/** 执行支持 Range、If-Range 和指数退避重试的流式下载。 */
async fn download_to_partial(
    manager: &AppUpdateManager,
    url: reqwest::Url,
    partial_path: &Path,
    expected_size: Option<u64>,
    expected_etag: Option<&str>,
    deploy_api_token: Option<&str>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent("yuyan-app")
        .build()
        .map_err(|error| format!("创建更新下载客户端失败: {error}"))?;

    let started_at = Instant::now();
    let session_start_length = tokio::fs::metadata(partial_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    let mut retry_count = 0_u8;

    loop {
        if manager.is_cancel_requested() {
            return Err("下载已暂停".to_string());
        }

        let offset = tokio::fs::metadata(partial_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or_default();
        if expected_size.is_some_and(|size| offset == size) {
            manager.set_download_progress(offset, expected_size, 0, true, retry_count);
            return Ok(());
        }

        let mut request = build_download_request(&client, url.clone(), deploy_api_token);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            if let Some(etag) = expected_etag {
                request = request.header(reqwest::header::IF_RANGE, etag);
            }
        }

        let attempt = async {
            let mut response = request
                .send()
                .await
                .map_err(|error| format!("连接内网更新服务器失败: {error}"))?;
            let status = response.status();
            if status != reqwest::StatusCode::OK && status != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(format!("内网更新服务器返回异常: {status}"));
            }

            let content_range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range);
            let (write_offset, total_length, resumable) =
                if status == reqwest::StatusCode::PARTIAL_CONTENT {
                    let (range_start, total) = content_range
                        .ok_or_else(|| "续传响应缺少有效 Content-Range".to_string())?;
                    if range_start != offset {
                        return Err(format!(
                        "续传位置不一致，期望从 {offset} 字节开始，服务器从 {range_start} 字节开始"
                    ));
                    }
                    (offset, Some(total), true)
                } else {
                    (0, response.content_length().or(expected_size), false)
                };

            let mut options = tokio::fs::OpenOptions::new();
            options.create(true).write(true);
            if write_offset > 0 {
                options.append(true);
            } else {
                options.truncate(true);
            }
            let mut file = options
                .open(partial_path)
                .await
                .map_err(|error| format!("打开更新临时文件失败: {error}"))?;
            let mut downloaded_length = write_offset;

            let mut last_chunk_at = Instant::now();
            loop {
                if manager.is_cancel_requested() {
                    file.flush()
                        .await
                        .map_err(|error| format!("保存下载断点失败: {error}"))?;
                    return Err("下载已暂停".to_string());
                }
                let chunk = loop {
                    match tokio::time::timeout(CANCEL_POLL_INTERVAL, response.chunk()).await {
                        Ok(result) => {
                            break result.map_err(|error| format!("接收更新数据失败: {error}"))?
                        }
                        Err(_) if manager.is_cancel_requested() => {
                            file.flush()
                                .await
                                .map_err(|error| format!("保存下载断点失败: {error}"))?;
                            return Err("下载已暂停".to_string());
                        }
                        Err(_) if last_chunk_at.elapsed() >= STALL_TIMEOUT => {
                            return Err("连续 60 秒未收到更新数据，下载已中断".to_string())
                        }
                        Err(_) => continue,
                    }
                };
                let Some(chunk) = chunk else {
                    break;
                };
                last_chunk_at = Instant::now();

                file.write_all(&chunk)
                    .await
                    .map_err(|error| format!("写入更新安装包失败: {error}"))?;
                downloaded_length += chunk.len() as u64;
                let elapsed_seconds = started_at.elapsed().as_secs().max(1);
                let session_bytes = downloaded_length.saturating_sub(session_start_length);
                let bytes_per_second = session_bytes / elapsed_seconds;
                manager.set_download_progress(
                    downloaded_length,
                    total_length.or(expected_size),
                    bytes_per_second,
                    resumable,
                    retry_count,
                );
            }

            file.flush()
                .await
                .map_err(|error| format!("刷新更新安装包失败: {error}"))?;
            validate_downloaded_length(downloaded_length, total_length.or(expected_size))
        }
        .await;

        match attempt {
            Ok(()) => return Ok(()),
            Err(error) if manager.is_cancel_requested() => return Err(error),
            Err(_error) if retry_count < MAX_DOWNLOAD_RETRIES => {
                retry_count += 1;
                let current_length = tokio::fs::metadata(partial_path)
                    .await
                    .map(|metadata| metadata.len())
                    .unwrap_or_default();
                manager.set_download_progress(
                    current_length,
                    expected_size,
                    0,
                    current_length > 0,
                    retry_count,
                );
                tokio::time::sleep(Duration::from_secs(2_u64.pow(retry_count.into()))).await;
            }
            Err(error) => return Err(format!("{error}，已重试 {retry_count} 次")),
        }
    }
}

/** 启动 Tauri 原生后台下载任务。 */
#[tauri::command]
pub async fn start_app_update_download(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
    url: String,
    version: String,
    asset_id: String,
    filename: String,
    expected_size: Option<u64>,
    sha256: Option<String>,
    etag: Option<String>,
    deploy_api_token: Option<String>,
) -> Result<AppUpdateCommandResult, String> {
    manager.ensure_initialized(&app).await?;
    validate_update_identity(&version, &asset_id)?;
    let safe_filename = validate_filename(&filename)?.to_string();
    let matches_asset = manager.matches_asset(&version, &asset_id, &safe_filename);
    let current_status = manager.snapshot().status;
    if manager.task_active.load(Ordering::Acquire) {
        if !matches_asset {
            return Err("另一个版本的更新任务正在收尾，请稍后重试".to_string());
        }
        return Ok(AppUpdateCommandResult {
            success: true,
            message: "当前更新任务正在处理中".to_string(),
        });
    }
    if current_status == "downloading" {
        if !matches_asset {
            return Err("另一个版本的更新包正在下载，请稍后重试".to_string());
        }
        return Ok(AppUpdateCommandResult {
            success: true,
            message: "更新安装包正在下载中".to_string(),
        });
    }
    if current_status == "completed" && matches_asset {
        return Ok(AppUpdateCommandResult {
            success: true,
            message: "更新安装包已下载完成".to_string(),
        });
    }

    let parsed_url = validate_download_url(&url)?;
    let manager = manager.inner().clone();
    let task_manager = manager.clone();
    let task_app = app.clone();
    manager.task_active.store(true, Ordering::Release);

    tauri::async_runtime::spawn(async move {
        match download_update(
            app,
            task_manager.clone(),
            parsed_url,
            version,
            asset_id,
            safe_filename,
            expected_size.filter(|size| *size > 0),
            sha256.filter(|value| !value.is_empty()),
            etag.filter(|value| !value.is_empty()),
            deploy_api_token.filter(|value| !value.is_empty()),
            matches_asset,
        )
        .await
        {
            Ok(local_path) => task_manager.mark_completed(&local_path),
            Err(error) if task_manager.is_cancel_requested() => {
                eprintln!("[App Update] 原生下载已暂停: {error}");
                task_manager.mark_paused();
            }
            Err(error) => {
                eprintln!("[App Update] 原生下载失败: {error}");
                task_manager.mark_error(error);
            }
        }
        if let Err(error) = persist_update_state(&task_app, &task_manager.snapshot()).await {
            eprintln!("[App Update] 持久化原生下载状态失败: {error}");
        }
        task_manager.task_active.store(false, Ordering::Release);
    });

    Ok(AppUpdateCommandResult {
        success: true,
        message: "已启动 Tauri 原生后台下载".to_string(),
    })
}

/** 暂停当前下载任务并保留断点文件。 */
#[tauri::command]
pub fn cancel_app_update_download(manager: State<'_, AppUpdateManager>) -> AppUpdateCommandResult {
    if manager.snapshot().status != "downloading" {
        return AppUpdateCommandResult {
            success: true,
            message: "当前没有正在下载的更新".to_string(),
        };
    }
    manager.request_cancel();
    AppUpdateCommandResult {
        success: true,
        message: "正在暂停更新下载".to_string(),
    }
}

/** 查询 Tauri 原生更新下载状态。 */
#[tauri::command]
pub async fn get_app_update_status(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateStatus, String> {
    manager.ensure_initialized(&app).await?;
    Ok(manager.snapshot())
}

/** 清理不再需要的本机更新包与持久化状态。 */
#[tauri::command]
pub async fn discard_app_update(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
) -> Result<AppUpdateCommandResult, String> {
    manager.ensure_initialized(&app).await?;
    if manager.task_active.load(Ordering::Acquire) {
        manager.request_cancel();
        return Ok(AppUpdateCommandResult {
            success: false,
            message: "正在停止旧版本更新下载，请稍后重试".to_string(),
        });
    }
    let update_dir = get_update_dir(&app)?;
    cleanup_update_files(&update_dir, None).await?;
    let _ = tokio::fs::remove_file(update_dir.join(UPDATE_STATE_FILENAME)).await;
    let _ = tokio::fs::remove_file(update_dir.join(UPDATE_STATE_TEMP_FILENAME)).await;
    manager.replace(AppUpdateStatus::default());
    manager.cancel_requested.store(false, Ordering::Release);
    Ok(AppUpdateCommandResult {
        success: true,
        message: "已清理旧版本更新缓存".to_string(),
    })
}

/** 获取当前操作系统和 CPU 架构。 */
#[tauri::command]
pub fn get_app_update_target() -> AppUpdateTarget {
    AppUpdateTarget {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

/** 使用系统默认程序打开已下载的更新安装包。 */
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    manager: State<'_, AppUpdateManager>,
    server_manager: State<'_, LocalServerManager>,
) -> Result<AppUpdateCommandResult, String> {
    manager.ensure_initialized(&app).await?;
    let snapshot = manager.snapshot();
    if snapshot.status != "completed" {
        return Err("更新安装包尚未下载完成".to_string());
    }
    let local_path = snapshot
        .local_path
        .as_deref()
        .ok_or_else(|| "更新安装包本地路径不存在".to_string())?;
    let expected_path = get_update_dir(&app)?.join(&snapshot.filename);
    if Path::new(local_path) != expected_path || !expected_path.is_file() {
        return Err("更新安装包文件不存在，请重新下载".to_string());
    }
    let filename = expected_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "更新安装包文件名无效".to_string())?;
    validate_package_integrity(
        &expected_path,
        snapshot.total_bytes,
        snapshot.expected_sha256.as_deref(),
    )
    .await?;
    validate_package_file(&expected_path, filename).await?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&expected_path)
            .arg("/S")
            .spawn()
            .map_err(|error| format!("拉起静默更新安装程序失败: {error}"))?;
        // 启动安装程序后，当前应用应该立即退出，以防文件被占用导致更新覆盖失败
        server_manager.stop("app update install");
        app.exit(0);
    }

    #[cfg(not(target_os = "windows"))]
    {
        app.opener()
            .open_path(expected_path.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| format!("拉起更新安装程序失败: {error}"))?;
        server_manager.stop("app update install");
        app.exit(0);
    }

    Ok(AppUpdateCommandResult {
        success: true,
        message: "更新安装程序已启动".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_download_request, cleanup_update_files, parse_content_range, validate_download_url,
        validate_downloaded_length, validate_filename, validate_package_signature,
        validate_update_identity, AppUpdateManager, UPDATE_STATE_FILENAME,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    /** 验证仅允许指定内网更新代理。 */
    #[test]
    fn validates_allowed_update_url() {
        let port = super::UPDATE_SERVER_PORT_STR
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(3100);
        let valid_url = format!(
            "http://{}:{}/deploy-api/app-update/download-asset?assetId=123&filename=yuyan.dmg",
            super::UPDATE_SERVER_HOST,
            port
        );
        assert!(validate_download_url(&valid_url).is_ok());

        let valid_static_url = format!(
            "http://{}:{}/app-updates/stable/1.2.3/darwin-aarch64/yuyan.dmg",
            super::UPDATE_SERVER_HOST,
            port
        );
        assert!(validate_download_url(&valid_static_url).is_ok());

        assert!(validate_download_url("https://example.com/update?assetId=123").is_err());

        let invalid_url = format!(
            "http://{}:{}/deploy-api/app-update/download-asset",
            super::UPDATE_SERVER_HOST,
            port
        );
        assert!(validate_download_url(&invalid_url).is_err());
    }

    /** 验证动态更新代理携带鉴权头，静态安装包路径不泄露 Token。 */
    #[test]
    fn applies_deploy_token_only_to_protected_proxy() {
        let port = super::UPDATE_SERVER_PORT_STR
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(3100);
        let client = reqwest::Client::new();
        let proxy_url = format!(
            "http://{}:{}/deploy-api/app-update/download-asset?assetId=123&filename=yuyan.dmg",
            super::UPDATE_SERVER_HOST,
            port
        )
        .parse()
        .expect("动态代理 URL 应有效");
        let proxy_request = build_download_request(&client, proxy_url, Some("deploy-secret"))
            .build()
            .expect("动态代理请求应成功构建");
        assert_eq!(
            proxy_request
                .headers()
                .get("X-Deploy-Token")
                .and_then(|value| value.to_str().ok()),
            Some("deploy-secret")
        );

        let static_url = format!(
            "http://{}:{}/app-updates/stable/1.2.3/darwin-aarch64/yuyan.dmg",
            super::UPDATE_SERVER_HOST,
            port
        )
        .parse()
        .expect("静态安装包 URL 应有效");
        let static_request = build_download_request(&client, static_url, Some("deploy-secret"))
            .build()
            .expect("静态安装包请求应成功构建");
        assert!(static_request.headers().get("X-Deploy-Token").is_none());
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
        manager.mark_downloading(
            "1.2.9".to_string(),
            "asset:123".to_string(),
            "yuyan-1.2.9.dmg".to_string(),
            420,
            Some(1000),
            Some("a".repeat(64)),
            Some("update-etag".to_string()),
        );
        manager.set_download_progress(420, Some(1000), 100, true, 1);
        let downloading = manager.snapshot();
        assert_eq!(downloading.status, "downloading");
        assert_eq!(downloading.progress, 42);
        assert_eq!(downloading.remaining_seconds, Some(6));
        assert!(downloading.resumable);
        assert!(manager.matches_asset("1.2.9", "asset:123", "yuyan-1.2.9.dmg"));

        manager.mark_error("网络中断".to_string());
        let failed = manager.snapshot();
        assert_eq!(failed.status, "error");
        assert_eq!(failed.error.as_deref(), Some("网络中断"));
    }

    /** 验证版本和资源身份拒绝路径及异常字符。 */
    #[test]
    fn validates_update_identity_metadata() {
        assert!(validate_update_identity("1.2.9", "github:123").is_ok());
        assert!(validate_update_identity("1.2.9-beta.1", "manifest:1.2.9:darwin_aarch64").is_ok());
        assert!(validate_update_identity("../1.2.9", "github:123").is_err());
        assert!(validate_update_identity("1.2.9", "asset/123").is_err());
    }

    /** 验证清理旧版本时保留当前安装包、断点和状态文件。 */
    #[test]
    fn cleans_obsolete_update_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应有效")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("yuyan-update-cleanup-{unique}"));
        std::fs::create_dir_all(&directory).expect("应创建测试目录");
        for filename in [
            "current.dmg",
            "current.dmg.part",
            "current.dmg.part.etag",
            "old.dmg",
            "old.exe.part",
            UPDATE_STATE_FILENAME,
        ] {
            std::fs::write(directory.join(filename), b"test").expect("应写入测试文件");
        }

        tauri::async_runtime::block_on(cleanup_update_files(&directory, Some("current.dmg")))
            .expect("清理旧更新文件应成功");

        assert!(directory.join("current.dmg").is_file());
        assert!(directory.join("current.dmg.part").is_file());
        assert!(directory.join("current.dmg.part.etag").is_file());
        assert!(directory.join(UPDATE_STATE_FILENAME).is_file());
        assert!(!directory.join("old.dmg").exists());
        assert!(!directory.join("old.exe.part").exists());
        std::fs::remove_dir_all(directory).expect("应清理测试目录");
    }

    /** 验证 Content-Range 响应头解析。 */
    #[test]
    fn parses_content_range_header() {
        assert_eq!(parse_content_range("bytes 100-999/1000"), Some((100, 1000)));
        assert_eq!(parse_content_range("invalid"), None);
    }

    /** 验证 DMG 和 EXE 关键格式签名。 */
    #[test]
    fn validates_package_signatures() {
        assert!(validate_package_signature("yuyan.exe", b"MZ", None).is_ok());
        assert!(validate_package_signature("yuyan.exe", b"PK", None).is_err());
        assert!(validate_package_signature("yuyan.dmg", b"\0\0", Some(b"koly")).is_ok());
        assert!(validate_package_signature("yuyan.dmg", b"\0\0", Some(b"bad!")).is_err());
    }
}
