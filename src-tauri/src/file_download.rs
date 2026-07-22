use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_DISPOSITION, CONTENT_LENGTH};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const STALL_TIMEOUT: Duration = Duration::from_secs(120);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(500);
const DOWNLOAD_DIRECTORY_NAME: &str = "yuyan-runtime-packages";
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/** 原生文件下载进度。 */
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFileDownloadProgress {
    stage: &'static str,
    loaded_bytes: u64,
    total_bytes: Option<u64>,
    file_name: Option<String>,
}

/** 原生文件下载结果。 */
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFileDownloadResult {
    path: String,
    file_name: String,
    file_size: u64,
    sha256: String,
}

/** 跨命令共享的通用文件下载状态。 */
#[derive(Clone, Default)]
pub struct FileDownloadManager {
    cancel_requested: Arc<AtomicBool>,
    task_active: Arc<AtomicBool>,
}

/** 下载任务活跃状态守卫，确保任何退出路径都会释放占用。 */
struct ActiveTaskGuard {
    task_active: Arc<AtomicBool>,
}

impl Drop for ActiveTaskGuard {
    fn drop(&mut self) {
        self.task_active.store(false, Ordering::Release);
    }
}

/** 判断请求头是否允许从 WebView 转发到中央服务。 */
fn is_allowed_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "x-yuyan-team-id"
            | "x-yuyan-client"
            | "x-gitlab-token"
            | "x-gitlab-host"
            | "cache-control"
            | "pragma"
            | "accept"
    )
}

/** 构建经过白名单约束的中央服务请求头，不记录任何凭据。 */
fn build_request_headers(headers: HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        if !is_allowed_request_header(&name) {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("下载请求头名称无效：{name}"))?;
        let header_value =
            HeaderValue::from_str(&value).map_err(|_| format!("下载请求头值无效：{name}"))?;
        result.insert(header_name, header_value);
    }
    Ok(result)
}

/** 清理服务端提供的文件名，禁止借助文件名跨越下载目录。 */
fn sanitize_file_name(value: &str, fallback: &str) -> String {
    let candidate = value.trim().trim_matches('"');
    let is_safe = !candidate.is_empty()
        && candidate != "."
        && candidate != ".."
        && !candidate.contains('/')
        && !candidate.contains('\\')
        && !candidate.contains('\0');
    if is_safe {
        candidate.to_string()
    } else {
        fallback.to_string()
    }
}

/** 从 Content-Disposition 中提取 ASCII 文件名。 */
fn parse_content_disposition_file_name(value: &str) -> Option<String> {
    value.split(';').find_map(|part| {
        let (name, raw_value) = part.trim().split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("filename") {
            return None;
        }
        let candidate = raw_value.trim().trim_matches('"');
        (!candidate.is_empty()).then(|| candidate.to_string())
    })
}

/** 为同名文件生成不覆盖已有文件的保存路径。 */
fn resolve_available_path(directory: &Path, file_name: &str) -> PathBuf {
    let initial = directory.join(file_name);
    if !initial.exists() {
        return initial;
    }

    let (stem, extension) = if let Some(stem) = file_name.strip_suffix(".tar.gz") {
        (stem.to_string(), ".tar.gz".to_string())
    } else {
        let path = Path::new(file_name);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
            .to_string();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"))
            .unwrap_or_default();
        (stem, extension)
    };

    for index in 1..10_000 {
        let candidate = directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!(
        "{stem}-{}{}",
        uuid::Uuid::new_v4().simple(),
        extension
    ))
}

/** 将中央服务 HTTP 错误正文转换为用户可读消息。 */
fn parse_http_error(status: reqwest::StatusCode, body: &[u8]) -> String {
    let bounded = &body[..body.len().min(MAX_ERROR_BODY_BYTES)];
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(bounded) {
        if let Some(message) = value
            .get("error")
            .and_then(|value| value.as_str())
            .or_else(|| {
                value
                    .get("error")
                    .and_then(|value| value.get("message"))
                    .and_then(|value| value.as_str())
            })
            .or_else(|| value.get("message").and_then(|value| value.as_str()))
        {
            return format!("中央服务返回 {}：{}", status.as_u16(), message);
        }
    }
    let text = String::from_utf8_lossy(bounded).trim().to_string();
    if text.is_empty() {
        format!("中央服务返回 HTTP {}", status.as_u16())
    } else {
        format!("中央服务返回 {}：{text}", status.as_u16())
    }
}

/** 安全删除未完成的临时文件。 */
async fn remove_partial_file(path: &Path) {
    if let Err(error) = tokio::fs::remove_file(path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[File Download] 清理临时文件失败: {error}");
        }
    }
}

/** 向前端发送下载进度；窗口关闭时忽略通道错误并继续完成磁盘清理。 */
fn send_progress(
    reporter: &(dyn Fn(NativeFileDownloadProgress) + Send + Sync),
    stage: &'static str,
    loaded_bytes: u64,
    total_bytes: Option<u64>,
    file_name: Option<String>,
) {
    reporter(NativeFileDownloadProgress {
        stage,
        loaded_bytes,
        total_bytes,
        file_name,
    });
}

/** 将成功的 HTTP 响应可靠写入指定目录。 */
async fn save_response_to_directory(
    mut response: reqwest::Response,
    download_directory: &Path,
    suggested_file_name: Option<String>,
    cancel_requested: &AtomicBool,
    progress: &(dyn Fn(NativeFileDownloadProgress) + Send + Sync),
) -> Result<NativeFileDownloadResult, String> {
    let total_bytes = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let response_file_name = response
        .headers()
        .get(CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_disposition_file_name);
    let fallback_file_name = suggested_file_name
        .as_deref()
        .map(|value| sanitize_file_name(value, "yuyan-download.tar.gz"))
        .unwrap_or_else(|| "yuyan-download.tar.gz".to_string());
    let file_name = response_file_name
        .as_deref()
        .map(|value| sanitize_file_name(value, &fallback_file_name))
        .unwrap_or(fallback_file_name);

    tokio::fs::create_dir_all(download_directory)
        .await
        .map_err(|error| format!("创建下载目录失败：{error}"))?;
    let final_path = resolve_available_path(download_directory, &file_name);
    let final_file_name = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&file_name)
        .to_string();
    let partial_path = download_directory.join(format!("{final_file_name}.part"));
    remove_partial_file(&partial_path).await;

    let mut file = tokio::fs::File::create(&partial_path)
        .await
        .map_err(|error| format!("创建下载临时文件失败：{error}"))?;
    let mut loaded_bytes = 0_u64;
    let mut sha256 = Sha256::new();
    let mut last_received_at = Instant::now();
    send_progress(
        progress,
        "writing",
        loaded_bytes,
        total_bytes,
        Some(final_file_name.clone()),
    );

    let download_result: Result<(), String> = async {
        loop {
            if cancel_requested.load(Ordering::Acquire) {
                return Err("下载已取消".to_string());
            }
            match tokio::time::timeout(CANCEL_POLL_INTERVAL, response.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    file.write_all(&chunk)
                        .await
                        .map_err(|error| format!("写入下载文件失败：{error}"))?;
                    sha256.update(&chunk);
                    loaded_bytes = loaded_bytes.saturating_add(chunk.len() as u64);
                    last_received_at = Instant::now();
                    send_progress(
                        progress,
                        "writing",
                        loaded_bytes,
                        total_bytes,
                        Some(final_file_name.clone()),
                    );
                }
                Ok(Ok(None)) => break,
                Ok(Err(error)) => return Err(format!("下载传输异常中断：{error}")),
                Err(_) if last_received_at.elapsed() >= STALL_TIMEOUT => {
                    return Err("下载长时间没有收到数据，已终止".to_string());
                }
                Err(_) => continue,
            }
        }

        if cancel_requested.load(Ordering::Acquire) {
            return Err("下载已取消".to_string());
        }
        if loaded_bytes == 0 {
            return Err("中央服务返回了空文件，下载未保存".to_string());
        }
        if let Some(expected_bytes) = total_bytes {
            if loaded_bytes != expected_bytes {
                return Err(format!(
                    "下载传输不完整：预期 {expected_bytes} 字节，实际收到 {loaded_bytes} 字节"
                ));
            }
        }
        file.flush()
            .await
            .map_err(|error| format!("刷新下载文件失败：{error}"))?;
        file.sync_all()
            .await
            .map_err(|error| format!("同步下载文件失败：{error}"))?;
        Ok(())
    }
    .await;

    drop(file);
    if let Err(error) = download_result {
        remove_partial_file(&partial_path).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::rename(&partial_path, &final_path).await {
        remove_partial_file(&partial_path).await;
        return Err(format!("原子保存下载文件失败：{error}"));
    }

    send_progress(
        progress,
        "finished",
        loaded_bytes,
        total_bytes,
        Some(final_file_name.clone()),
    );
    Ok(NativeFileDownloadResult {
        path: final_path.to_string_lossy().into_owned(),
        file_name: final_file_name,
        file_size: loaded_bytes,
        sha256: format!("{:x}", sha256.finalize()),
    })
}

/** 使用当前认证头从中央服务流式下载文件并原子落盘。 */
#[tauri::command]
pub async fn start_file_download(
    app: AppHandle,
    manager: State<'_, FileDownloadManager>,
    url: String,
    headers: HashMap<String, String>,
    suggested_file_name: Option<String>,
    on_progress: Channel<NativeFileDownloadProgress>,
) -> Result<NativeFileDownloadResult, String> {
    if manager
        .task_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("已有文件正在下载，请稍候".to_string());
    }
    let _active_guard = ActiveTaskGuard {
        task_active: manager.task_active.clone(),
    };
    manager.cancel_requested.store(false, Ordering::Release);

    let parsed_url = reqwest::Url::parse(&url).map_err(|error| format!("下载地址无效：{error}"))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("下载地址只支持 HTTP 或 HTTPS".to_string());
    }

    let report_connecting = |progress| {
        let _ = on_progress.send(progress);
    };
    send_progress(&report_connecting, "connecting", 0, None, None);
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化下载客户端失败：{error}"))?;
    let request_future = client
        .get(parsed_url)
        .headers(build_request_headers(headers)?)
        .send();
    let mut request_future = Box::pin(request_future);
    let response = loop {
        if manager.cancel_requested.load(Ordering::Acquire) {
            return Err("下载已取消".to_string());
        }
        match tokio::time::timeout(CANCEL_POLL_INTERVAL, request_future.as_mut()).await {
            Ok(result) => {
                break result.map_err(|error| format!("连接中央下载服务失败：{error}"))?;
            }
            Err(_) => continue,
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("读取中央服务错误响应失败：{error}"))?;
        return Err(parse_http_error(status, &body));
    }

    let download_directory = app
        .path()
        .download_dir()
        .map_err(|error| format!("无法获取系统下载目录：{error}"))?
        .join(DOWNLOAD_DIRECTORY_NAME);
    let report_progress = |progress| {
        let _ = on_progress.send(progress);
    };
    save_response_to_directory(
        response,
        &download_directory,
        suggested_file_name,
        &manager.cancel_requested,
        &report_progress,
    )
    .await
}

/** 请求取消当前通用文件下载。 */
#[tauri::command]
pub fn cancel_file_download(manager: State<'_, FileDownloadManager>) -> Result<(), String> {
    if !manager.task_active.load(Ordering::Acquire) {
        return Err("当前没有正在下载的文件".to_string());
    }
    manager.cancel_requested.store(true, Ordering::Release);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /** 创建单次请求的本地 HTTP 测试服务。 */
    fn serve_http_response(chunks: Vec<Vec<u8>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("应可绑定测试端口");
        let address = listener.local_addr().expect("应可读取测试端口");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("应收到 HTTP 请求");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            for chunk in chunks {
                stream.write_all(&chunk).expect("应可写入测试响应");
                stream.flush().expect("应可刷新测试响应");
                thread::sleep(Duration::from_millis(5));
            }
        });
        format!("http://{address}/archive")
    }

    /** 创建独立的下载测试目录。 */
    fn create_test_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "yuyan-file-download-test-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    /** 在当前线程运行异步下载测试。 */
    fn run_async_test(future: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("应可创建 Tokio 测试运行时")
            .block_on(future);
    }

    #[test]
    fn content_disposition_只解析普通文件名() {
        assert_eq!(
            parse_content_disposition_file_name("attachment; filename=\"server-32089.tar.gz\""),
            Some("server-32089.tar.gz".to_string())
        );
        assert_eq!(parse_content_disposition_file_name("attachment"), None);
    }

    #[test]
    fn 文件名不能跨越下载目录() {
        assert_eq!(
            sanitize_file_name("../../secret", "safe.tar.gz"),
            "safe.tar.gz"
        );
        assert_eq!(
            sanitize_file_name("server.tar.gz", "safe.tar.gz"),
            "server.tar.gz"
        );
    }

    #[test]
    fn 请求头仅转发认证相关白名单() {
        let headers = build_request_headers(HashMap::from([
            ("Authorization".to_string(), "Bearer secret".to_string()),
            ("Cookie".to_string(), "should-not-forward".to_string()),
        ]))
        .expect("请求头应可构建");
        assert!(headers.contains_key("authorization"));
        assert!(!headers.contains_key("cookie"));
    }

    #[test]
    fn http_400_透传中央服务嵌套错误() {
        let message = parse_http_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"code":"bad_archive","message":"服务器凭据解密失败"}}"#.as_bytes(),
        );
        assert!(message.contains("400"));
        assert!(message.contains("服务器凭据解密失败"));
    }

    #[test]
    fn 分块下载成功后原子落盘并清理_part() {
        run_async_test(async {
            let url = serve_http_response(vec![
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Disposition: attachment; filename=\"selected.tar.gz\"\r\nConnection: close\r\n\r\n".to_vec(),
                b"5\r\nhello\r\n".to_vec(),
                b"6\r\n world\r\n0\r\n\r\n".to_vec(),
            ]);
            let response = reqwest::get(url).await.expect("应取得分块响应");
            let directory = create_test_directory();
            let cancel = AtomicBool::new(false);
            let result = save_response_to_directory(response, &directory, None, &cancel, &|_| {})
                .await
                .expect("分块下载应成功");
            assert_eq!(result.file_size, 11);
            assert_eq!(
                tokio::fs::read(&result.path)
                    .await
                    .expect("应可读取落盘文件"),
                b"hello world"
            );
            assert!(!directory.join("selected.tar.gz.part").exists());
            let _ = tokio::fs::remove_dir_all(directory).await;
        });
    }

    #[test]
    fn 传输截断不会留下正式文件或_part() {
        run_async_test(async {
            let url = serve_http_response(vec![
                b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc".to_vec(),
            ]);
            let response = reqwest::get(url).await.expect("应取得截断响应头");
            let directory = create_test_directory();
            let cancel = AtomicBool::new(false);
            let result = save_response_to_directory(
                response,
                &directory,
                Some("truncated.tar.gz".to_string()),
                &cancel,
                &|_| {},
            )
            .await;
            assert!(result.expect_err("截断传输必须失败").contains("传输"));
            assert!(!directory.join("truncated.tar.gz").exists());
            assert!(!directory.join("truncated.tar.gz.part").exists());
            let _ = tokio::fs::remove_dir_all(directory).await;
        });
    }

    #[test]
    fn 空文件与取消都会清理_part() {
        run_async_test(async {
            let empty_url = serve_http_response(vec![
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            ]);
            let empty_response = reqwest::get(empty_url).await.expect("应取得空响应");
            let empty_directory = create_test_directory();
            let cancel = AtomicBool::new(false);
            let empty_result = save_response_to_directory(
                empty_response,
                &empty_directory,
                Some("empty.conf".to_string()),
                &cancel,
                &|_| {},
            )
            .await;
            assert!(empty_result.expect_err("空文件必须失败").contains("空文件"));
            assert!(!empty_directory.join("empty.conf.part").exists());

            let cancel_url = serve_http_response(vec![
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".to_vec(),
            ]);
            let cancel_response = reqwest::get(cancel_url).await.expect("应取得取消测试响应");
            let cancel_directory = create_test_directory();
            let cancel = AtomicBool::new(true);
            let cancel_result = save_response_to_directory(
                cancel_response,
                &cancel_directory,
                Some("cancelled.tar.gz".to_string()),
                &cancel,
                &|_| {},
            )
            .await;
            assert!(cancel_result
                .expect_err("取消下载必须失败")
                .contains("取消"));
            assert!(!cancel_directory.join("cancelled.tar.gz.part").exists());
            let _ = tokio::fs::remove_dir_all(empty_directory).await;
            let _ = tokio::fs::remove_dir_all(cancel_directory).await;
        });
    }
}
