#[cfg(target_os = "macos")]
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
#[cfg(not(target_os = "macos"))]
use keyring::{Entry, Error as KeyringError};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "macos"))]
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[cfg(not(target_os = "macos"))]
const KEYRING_SERVICE: &str = "cn.yuyan.ops";
#[cfg(not(target_os = "macos"))]
const DEVICE_ENTRY: &str = "device-identity-v1";
#[cfg(not(target_os = "macos"))]
const MASTER_KEY_ENTRY: &str = "local-master-key-v1";
#[cfg(not(target_os = "macos"))]
const ACTIVE_ACCOUNT_ENTRY: &str = "active-account-v1";
#[cfg(target_os = "macos")]
const LOCAL_SECURE_STORAGE_DIR: &str = "secure-storage";
#[cfg(target_os = "macos")]
const LOCAL_SECURE_VAULT_FILE: &str = "secure-vault-v3.json";
#[cfg(target_os = "macos")]
const LOCAL_SECURE_KEY_FILE: &str = "secure-vault-v3.key";
#[cfg(target_os = "macos")]
const LOCAL_SECURE_VAULT_AAD: &[u8] = b"cn.yuyan.ops/secure-vault-v3";
#[cfg(target_os = "macos")]
const LOCAL_SECURE_VAULT_FORMAT_VERSION: u8 = 1;
#[cfg(target_os = "macos")]
const SECURE_VAULT_SCHEMA_VERSION: u8 = 3;
#[cfg(target_os = "macos")]
const LOCAL_SECURE_VAULT_MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDeviceIdentity {
    schema_version: u8,
    device_id: String,
    private_key: String,
    created_at: String,
}

/** WebView 可读取的非敏感设备身份。 */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    device_id: String,
    public_key: String,
    device_name: String,
    platform: String,
    created_at: String,
}

/** 设备签名结果。 */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSignature {
    device_id: String,
    algorithm: &'static str,
    signature: String,
}

/** 单个 GitLab 账号的安全凭据与雨燕短期会话。 */
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureAccountState {
    pub account_id: String,
    pub device_id: String,
    pub gitlab_host: String,
    pub gitlab_user_id: u64,
    #[serde(default)]
    pub gitlab_username: String,
    #[serde(default)]
    pub gitlab_display_name: String,
    #[serde(default)]
    pub gitlab_avatar_url: String,
    pub gitlab_token: String,
    pub access_token: String,
    pub refresh_token: String,
    pub team_id: String,
    pub role: String,
    pub access_expires_at: String,
    pub refresh_expires_at: String,
}

/** macOS 应用本地保险库中的安全材料。 */
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecureVault {
    schema_version: u8,
    device: StoredDeviceIdentity,
    local_master_key: String,
    active_account: Option<SecureAccountState>,
}

/** macOS 本地保险库的加密信封。 */
#[cfg(target_os = "macos")]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptedSecureVault {
    format_version: u8,
    nonce: String,
    ciphertext: String,
}

/** macOS 进程内保险库与本地加密密钥。 */
#[cfg(target_os = "macos")]
struct LocalSecureVault {
    vault: SecureVault,
    encryption_key: [u8; 32],
}

/** macOS 应用数据目录，只允许在 Tauri setup 阶段初始化一次。 */
#[cfg(target_os = "macos")]
static LOCAL_SECURE_STORAGE_PATH: OnceLock<PathBuf> = OnceLock::new();

/** macOS 进程内只解锁一次本地保险库，后续签名和会话读取均复用内存副本。 */
#[cfg(target_os = "macos")]
static SECURE_VAULT_CACHE: OnceLock<Result<Mutex<LocalSecureVault>, String>> = OnceLock::new();

/** 获取固定服务下的系统凭据条目。 */
#[cfg(not(target_os = "macos"))]
fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, name).map_err(|error| format!("系统安全凭据库不可用: {error}"))
}

/** 生成不含账号原文的凭据条目名。 */
#[cfg(not(target_os = "macos"))]
fn account_entry_name(account_id: &str) -> Result<String, String> {
    let normalized = account_id.trim();
    if normalized.is_empty() || normalized.len() > 512 {
        return Err("账号标识无效".to_string());
    }
    Ok(format!(
        "account-{:x}",
        Sha256::digest(normalized.as_bytes())
    ))
}

/** 返回当前毫秒时间文本，避免引入额外日期依赖。 */
fn current_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

/** 创建新的设备签名身份。 */
fn create_stored_device() -> StoredDeviceIdentity {
    let signing_key = SigningKey::generate(&mut OsRng);
    StoredDeviceIdentity {
        schema_version: 1,
        device_id: uuid::Uuid::new_v4().to_string(),
        private_key: STANDARD.encode(signing_key.to_bytes()),
        created_at: current_timestamp(),
    }
}

/** 创建 256 位本机数据库主密钥。 */
fn create_local_master_key() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

/** 校验并创建仅当前用户可访问的 macOS 安全存储目录。 */
#[cfg(target_os = "macos")]
fn prepare_local_secure_storage(app_data_dir: &Path) -> Result<PathBuf, String> {
    let storage_path = app_data_dir.join(LOCAL_SECURE_STORAGE_DIR);
    if storage_path.exists() {
        let metadata = fs::symlink_metadata(&storage_path)
            .map_err(|error| format!("读取本地安全存储目录失败: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("本地安全存储路径必须是普通目录，禁止使用符号链接".to_string());
        }
    } else {
        fs::create_dir_all(&storage_path)
            .map_err(|error| format!("创建本地安全存储目录失败: {error}"))?;
    }
    fs::set_permissions(&storage_path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("设置本地安全存储目录权限失败: {error}"))?;
    Ok(storage_path)
}

/** 在 Tauri setup 阶段初始化平台安全存储。 */
#[cfg(target_os = "macos")]
pub(crate) fn initialize_secure_storage(app_data_dir: &Path) -> Result<(), String> {
    let storage_path = prepare_local_secure_storage(app_data_dir)?;
    if let Some(existing) = LOCAL_SECURE_STORAGE_PATH.get() {
        if existing != &storage_path {
            return Err("本地安全存储目录已被其他路径初始化".to_string());
        }
    } else {
        LOCAL_SECURE_STORAGE_PATH
            .set(storage_path)
            .map_err(|_| "初始化本地安全存储目录失败".to_string())?;
    }
    secure_vault().map(|_| ())
}

/** Windows 保持系统 Credential Manager，不需要初始化文件目录。 */
#[cfg(not(target_os = "macos"))]
pub(crate) fn initialize_secure_storage(_app_data_dir: &std::path::Path) -> Result<(), String> {
    Ok(())
}

/** 获取已初始化的 macOS 安全存储目录。 */
#[cfg(target_os = "macos")]
fn local_secure_storage_path() -> Result<&'static PathBuf, String> {
    LOCAL_SECURE_STORAGE_PATH
        .get()
        .ok_or_else(|| "本地安全存储尚未初始化".to_string())
}

/** 校验普通私有文件并收紧为 0600 权限。 */
#[cfg(target_os = "macos")]
fn validate_private_file(path: &Path, label: &str) -> Result<fs::Metadata, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取{label}失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label}必须是普通文件，禁止使用符号链接"));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置{label}权限失败: {error}"))?;
    Ok(metadata)
}

/** 读取或创建 macOS 本地保险库随机密钥。 */
#[cfg(target_os = "macos")]
fn read_or_create_local_vault_key(
    storage_path: &Path,
    vault_exists: bool,
) -> Result<[u8; 32], String> {
    let key_path = storage_path.join(LOCAL_SECURE_KEY_FILE);
    if !key_path.exists() {
        if vault_exists {
            return Err("本地保险库密钥缺失，拒绝覆盖已有密文".to_string());
        }
        let mut generated = [0_u8; 32];
        OsRng.fill_bytes(&mut generated);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&key_path)
        {
            Ok(mut file) => {
                file.write_all(&generated)
                    .and_then(|_| file.sync_all())
                    .map_err(|error| format!("保存本地保险库密钥失败: {error}"))?;
                return Ok(generated);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("创建本地保险库密钥失败: {error}")),
        }
    }

    let metadata = validate_private_file(&key_path, "本地保险库密钥")?;
    if metadata.len() != 32 {
        return Err("本地保险库密钥长度无效".to_string());
    }
    let raw = fs::read(&key_path).map_err(|error| format!("读取本地保险库密钥失败: {error}"))?;
    raw.try_into()
        .map_err(|_| "本地保险库密钥长度无效".to_string())
}

/** 使用 AES-256-GCM 加密 macOS 本地保险库。 */
#[cfg(target_os = "macos")]
fn encrypt_secure_vault(vault: &SecureVault, encryption_key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let plaintext =
        serde_json::to_vec(vault).map_err(|error| format!("序列化本地保险库失败: {error}"))?;
    let cipher = Aes256Gcm::new_from_slice(encryption_key)
        .map_err(|_| "初始化本地保险库加密器失败".to_string())?;
    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: LOCAL_SECURE_VAULT_AAD,
            },
        )
        .map_err(|_| "加密本地保险库失败".to_string())?;
    let envelope = EncryptedSecureVault {
        format_version: LOCAL_SECURE_VAULT_FORMAT_VERSION,
        nonce: STANDARD.encode(nonce_bytes),
        ciphertext: STANDARD.encode(ciphertext),
    };
    serde_json::to_vec(&envelope).map_err(|error| format!("序列化保险库加密信封失败: {error}"))
}

/** 解密并验证 macOS 本地保险库。 */
#[cfg(target_os = "macos")]
fn decrypt_secure_vault(encoded: &[u8], encryption_key: &[u8; 32]) -> Result<SecureVault, String> {
    let envelope: EncryptedSecureVault = serde_json::from_slice(encoded)
        .map_err(|error| format!("本地保险库加密信封损坏: {error}"))?;
    if envelope.format_version != LOCAL_SECURE_VAULT_FORMAT_VERSION {
        return Err(format!(
            "不支持的本地保险库格式: {}",
            envelope.format_version
        ));
    }
    let nonce: [u8; 12] = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| "本地保险库随机数编码损坏".to_string())?
        .try_into()
        .map_err(|_| "本地保险库随机数长度无效".to_string())?;
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| "本地保险库密文编码损坏".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(encryption_key)
        .map_err(|_| "初始化本地保险库解密器失败".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: LOCAL_SECURE_VAULT_AAD,
            },
        )
        .map_err(|_| "本地保险库校验失败，文件可能已损坏或被篡改".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|error| format!("本地保险库数据损坏: {error}"))
}

/** 将 macOS 本地保险库以同目录临时文件原子保存到指定安全目录。 */
#[cfg(target_os = "macos")]
fn persist_secure_vault_at(
    storage_path: &Path,
    vault: &SecureVault,
    encryption_key: &[u8; 32],
) -> Result<(), String> {
    let vault_path = storage_path.join(LOCAL_SECURE_VAULT_FILE);
    let temp_path = storage_path.join(format!(
        ".{LOCAL_SECURE_VAULT_FILE}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let encoded = encrypt_secure_vault(vault, encryption_key)?;
    if encoded.len() as u64 > LOCAL_SECURE_VAULT_MAX_BYTES {
        return Err("本地保险库超过允许的最大体积".to_string());
    }

    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp_path)
            .map_err(|error| format!("创建本地保险库临时文件失败: {error}"))?;
        file.write_all(&encoded)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("保存本地保险库临时文件失败: {error}"))?;
        fs::rename(&temp_path, &vault_path)
            .map_err(|error| format!("原子替换本地保险库失败: {error}"))?;
        fs::set_permissions(&vault_path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("设置本地保险库权限失败: {error}"))?;
        File::open(storage_path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("同步本地保险库目录失败: {error}"))
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

/** 以同目录临时文件原子保存 macOS 本地保险库。 */
#[cfg(target_os = "macos")]
fn persist_secure_vault(vault: &SecureVault, encryption_key: &[u8; 32]) -> Result<(), String> {
    persist_secure_vault_at(local_secure_storage_path()?, vault, encryption_key)
}

/** 校验解密后的 macOS 本地保险库结构。 */
#[cfg(target_os = "macos")]
fn validate_secure_vault(vault: &SecureVault) -> Result<(), String> {
    if vault.schema_version != SECURE_VAULT_SCHEMA_VERSION {
        return Err(format!("不支持的本地保险库版本: {}", vault.schema_version));
    }
    if vault.local_master_key.len() != 64
        || !vault
            .local_master_key
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("本地保险库中的数据库主密钥无效".to_string());
    }
    signing_key_from_stored(&vault.device)?;
    Ok(())
}

/** 加载或创建 macOS 本地保险库；不会访问或迁移旧钥匙串。 */
#[cfg(target_os = "macos")]
fn load_or_create_secure_vault() -> Result<LocalSecureVault, String> {
    let storage_path = local_secure_storage_path()?;
    let vault_path = storage_path.join(LOCAL_SECURE_VAULT_FILE);
    let vault_exists = vault_path.exists();
    let encryption_key = read_or_create_local_vault_key(storage_path, vault_exists)?;
    let vault = if vault_exists {
        let metadata = validate_private_file(&vault_path, "本地保险库")?;
        if metadata.len() > LOCAL_SECURE_VAULT_MAX_BYTES {
            return Err("本地保险库超过允许的最大体积".to_string());
        }
        let encoded =
            fs::read(&vault_path).map_err(|error| format!("读取本地保险库失败: {error}"))?;
        decrypt_secure_vault(&encoded, &encryption_key)?
    } else {
        let created = SecureVault {
            schema_version: SECURE_VAULT_SCHEMA_VERSION,
            device: create_stored_device(),
            local_master_key: create_local_master_key(),
            active_account: None,
        };
        persist_secure_vault(&created, &encryption_key)?;
        created
    };
    validate_secure_vault(&vault)?;
    Ok(LocalSecureVault {
        vault,
        encryption_key,
    })
}

/** 获取 macOS 进程级本地保险库缓存。 */
#[cfg(target_os = "macos")]
fn secure_vault() -> Result<&'static Mutex<LocalSecureVault>, String> {
    match SECURE_VAULT_CACHE.get_or_init(|| load_or_create_secure_vault().map(Mutex::new)) {
        Ok(vault) => Ok(vault),
        Err(error) => Err(error.clone()),
    }
}

/** 只读访问 macOS 本地保险库。 */
#[cfg(target_os = "macos")]
fn read_secure_vault<T>(
    reader: impl FnOnce(&SecureVault) -> Result<T, String>,
) -> Result<T, String> {
    let guard = secure_vault()?
        .lock()
        .map_err(|_| "本地保险库内存状态已损坏".to_string())?;
    reader(&guard.vault)
}

/** 原子更新 macOS 本地保险库，持久化成功后才替换内存副本。 */
#[cfg(target_os = "macos")]
fn update_secure_vault<T>(
    updater: impl FnOnce(&mut SecureVault) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = secure_vault()?
        .lock()
        .map_err(|_| "本地保险库内存状态已损坏".to_string())?;
    let mut next = guard.vault.clone();
    let result = updater(&mut next)?;
    validate_secure_vault(&next)?;
    persist_secure_vault(&next, &guard.encryption_key)?;
    guard.vault = next;
    Ok(result)
}

/** 读取设备私钥；不存在时生成并只写入系统凭据库。 */
#[cfg(not(target_os = "macos"))]
fn get_or_create_stored_device() -> Result<StoredDeviceIdentity, String> {
    let device_entry = entry(DEVICE_ENTRY)?;
    match device_entry.get_password() {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| format!("设备身份数据损坏: {error}")),
        Err(KeyringError::NoEntry) => {
            let stored = create_stored_device();
            let encoded = serde_json::to_string(&stored)
                .map_err(|error| format!("序列化设备身份失败: {error}"))?;
            device_entry
                .set_password(&encoded)
                .map_err(|error| format!("保存设备身份失败: {error}"))?;
            Ok(stored)
        }
        Err(error) => Err(format!("读取设备身份失败: {error}")),
    }
}

/** macOS 从进程级单一保险箱读取设备私钥。 */
#[cfg(target_os = "macos")]
fn get_or_create_stored_device() -> Result<StoredDeviceIdentity, String> {
    read_secure_vault(|vault| Ok(vault.device.clone()))
}

/** 将存储的私钥恢复为签名密钥。 */
fn signing_key_from_stored(stored: &StoredDeviceIdentity) -> Result<SigningKey, String> {
    let bytes = STANDARD
        .decode(&stored.private_key)
        .map_err(|error| format!("设备私钥编码损坏: {error}"))?;
    let secret: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "设备私钥长度无效".to_string())?;
    Ok(SigningKey::from_bytes(&secret))
}

/** 获取或创建设备身份，仅返回公钥与设备元数据。 */
#[tauri::command]
pub fn get_or_create_device_identity() -> Result<DeviceIdentity, String> {
    let stored = get_or_create_stored_device()?;
    let signing_key = signing_key_from_stored(&stored)?;
    let device_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "雨燕设备".to_string());
    Ok(DeviceIdentity {
        device_id: stored.device_id,
        public_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
        device_name,
        platform: std::env::consts::OS.to_string(),
        created_at: stored.created_at,
    })
}

/** 使用设备私钥签署刷新会话挑战，私钥不会离开原生层。 */
#[tauri::command]
pub fn sign_device_challenge(payload: String) -> Result<DeviceSignature, String> {
    if payload.is_empty() || payload.len() > 16 * 1024 {
        return Err("设备签名内容长度无效".to_string());
    }
    let stored = get_or_create_stored_device()?;
    let signature = signing_key_from_stored(&stored)?.sign(payload.as_bytes());
    Ok(DeviceSignature {
        device_id: stored.device_id,
        algorithm: "Ed25519",
        signature: STANDARD.encode(signature.to_bytes()),
    })
}

/** 保存当前账号的 PAT 与雨燕会话，并切换活动账号。 */
#[tauri::command]
pub fn save_secure_account(state: SecureAccountState) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return update_secure_vault(|vault| {
            if state.device_id != vault.device.device_id {
                return Err("账号会话绑定设备与当前设备身份不一致".to_string());
            }
            vault.active_account = Some(state);
            Ok(())
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let stored_device = get_or_create_stored_device()?;
        if state.device_id != stored_device.device_id {
            return Err("账号会话绑定设备与当前设备身份不一致".to_string());
        }
        let account_id = state.account_id.trim().to_string();
        let name = account_entry_name(&account_id)?;
        let encoded = serde_json::to_string(&state)
            .map_err(|error| format!("序列化账号安全状态失败: {error}"))?;
        entry(&name)?
            .set_password(&encoded)
            .map_err(|error| format!("保存账号安全状态失败: {error}"))?;
        entry(ACTIVE_ACCOUNT_ENTRY)?
            .set_password(&account_id)
            .map_err(|error| format!("保存活动账号失败: {error}"))
    }
}

/** 加载当前活动账号的安全状态。 */
#[tauri::command]
pub fn load_active_secure_account() -> Result<Option<SecureAccountState>, String> {
    #[cfg(target_os = "macos")]
    {
        return read_secure_vault(|vault| Ok(vault.active_account.clone()));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let active_entry = entry(ACTIVE_ACCOUNT_ENTRY)?;
        let account_id = match active_entry.get_password() {
            Ok(value) => value,
            Err(KeyringError::NoEntry) => return Ok(None),
            Err(error) => return Err(format!("读取活动账号失败: {error}")),
        };
        let account_entry = entry(&account_entry_name(&account_id)?)?;
        match account_entry.get_password() {
            Ok(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|error| format!("账号安全状态损坏: {error}")),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(format!("读取账号安全状态失败: {error}")),
        }
    }
}

/** 清除当前活动账号的全部安全凭据。 */
#[tauri::command]
pub fn clear_active_secure_account() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return update_secure_vault(|vault| {
            vault.active_account = None;
            Ok(())
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let active_entry = entry(ACTIVE_ACCOUNT_ENTRY)?;
        let account_id = match active_entry.get_password() {
            Ok(value) => Some(value),
            Err(KeyringError::NoEntry) => None,
            Err(error) => return Err(format!("读取活动账号失败: {error}")),
        };
        if let Some(account_id) = account_id {
            let account_entry = entry(&account_entry_name(&account_id)?)?;
            match account_entry.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => {}
                Err(error) => return Err(format!("删除账号安全状态失败: {error}")),
            }
        }
        match active_entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("删除活动账号失败: {error}")),
        }
    }
}

/** 获取或创建本机数据库主密钥，只供原生层启动内嵌服务。 */
pub(crate) fn get_or_create_local_master_key() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        return read_secure_vault(|vault| Ok(vault.local_master_key.clone()));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let master_entry = entry(MASTER_KEY_ENTRY)?;
        match master_entry.get_password() {
            Ok(value) if value.len() >= 64 => Ok(value),
            Ok(_) | Err(KeyringError::NoEntry) => {
                let value = create_local_master_key();
                master_entry
                    .set_password(&value)
                    .map_err(|error| format!("保存本机数据库主密钥失败: {error}"))?;
                Ok(value)
            }
            Err(error) => Err(format!("读取本机数据库主密钥失败: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /** 创建包含测试账号的 macOS 本地保险库样本。 */
    #[cfg(target_os = "macos")]
    fn create_test_secure_vault() -> SecureVault {
        let device = create_stored_device();
        SecureVault {
            schema_version: SECURE_VAULT_SCHEMA_VERSION,
            local_master_key: create_local_master_key(),
            active_account: Some(SecureAccountState {
                account_id: "account-test".to_string(),
                device_id: device.device_id.clone(),
                gitlab_host: "https://gitlab.example.test".to_string(),
                gitlab_user_id: 1,
                gitlab_username: "tester".to_string(),
                gitlab_display_name: "测试账号".to_string(),
                gitlab_avatar_url: String::new(),
                gitlab_token: "glpat-local-vault-secret".to_string(),
                access_token: "access-secret".to_string(),
                refresh_token: "refresh-secret".to_string(),
                team_id: "legacy-team".to_string(),
                role: "admin".to_string(),
                access_expires_at: "2099-01-01T00:00:00.000Z".to_string(),
                refresh_expires_at: "2099-02-01T00:00:00.000Z".to_string(),
            }),
            device,
        }
    }

    /** 新建安全材料满足设备签名与 256 位主密钥约束。 */
    #[test]
    fn creates_valid_secure_material() {
        let device = create_stored_device();
        let master_key = create_local_master_key();
        assert_eq!(device.schema_version, 1);
        assert_eq!(master_key.len(), 64);
        assert!(master_key
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        assert!(signing_key_from_stored(&device).is_ok());
    }

    /** macOS 本地保险库能够加密往返且密文不包含敏感原文。 */
    #[cfg(target_os = "macos")]
    #[test]
    fn encrypts_and_decrypts_local_secure_vault() {
        let vault = create_test_secure_vault();
        let mut key = [0_u8; 32];
        OsRng.fill_bytes(&mut key);

        let encrypted = encrypt_secure_vault(&vault, &key).expect("保险库应可加密");
        assert!(!String::from_utf8_lossy(&encrypted).contains("glpat-local-vault-secret"));
        let decrypted = decrypt_secure_vault(&encrypted, &key).expect("保险库应可解密");

        assert_eq!(decrypted.device.device_id, vault.device.device_id);
        assert_eq!(decrypted.local_master_key, vault.local_master_key);
        assert_eq!(
            decrypted.active_account.expect("账号应存在").gitlab_token,
            "glpat-local-vault-secret"
        );
    }

    /** macOS 本地保险库拒绝被篡改的认证密文。 */
    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_tampered_local_secure_vault() {
        let vault = create_test_secure_vault();
        let mut key = [0_u8; 32];
        OsRng.fill_bytes(&mut key);
        let encrypted = encrypt_secure_vault(&vault, &key).expect("保险库应可加密");
        let mut envelope: EncryptedSecureVault =
            serde_json::from_slice(&encrypted).expect("加密信封应有效");
        let mut ciphertext = STANDARD
            .decode(&envelope.ciphertext)
            .expect("密文编码应有效");
        ciphertext[0] ^= 0x01;
        envelope.ciphertext = STANDARD.encode(ciphertext);
        let tampered = serde_json::to_vec(&envelope).expect("篡改信封应可序列化");

        assert!(decrypt_secure_vault(&tampered, &key).is_err());
    }

    /** macOS 本地保险库可原子持久化，且所有文件仅允许当前系统用户访问。 */
    #[cfg(target_os = "macos")]
    #[test]
    fn persists_private_local_secure_storage_files() {
        let root =
            std::env::temp_dir().join(format!("yuyan-secure-vault-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("测试目录应可创建");
        let storage = prepare_local_secure_storage(&root).expect("安全目录应可创建");
        let key = read_or_create_local_vault_key(&storage, false).expect("保险库密钥应可创建");
        let vault = create_test_secure_vault();
        persist_secure_vault_at(&storage, &vault, &key).expect("保险库应可原子保存");
        let directory_mode = fs::metadata(&storage)
            .expect("安全目录应存在")
            .permissions()
            .mode()
            & 0o777;
        let key_mode = fs::metadata(storage.join(LOCAL_SECURE_KEY_FILE))
            .expect("保险库密钥应存在")
            .permissions()
            .mode()
            & 0o777;
        let vault_path = storage.join(LOCAL_SECURE_VAULT_FILE);
        let vault_mode = fs::metadata(&vault_path)
            .expect("保险库应存在")
            .permissions()
            .mode()
            & 0o777;
        let persisted = fs::read(&vault_path).expect("保险库密文应可读取");
        let restored = decrypt_secure_vault(&persisted, &key).expect("持久化保险库应可解密");

        assert_ne!(key, [0_u8; 32]);
        assert_eq!(directory_mode, 0o700);
        assert_eq!(key_mode, 0o600);
        assert_eq!(vault_mode, 0o600);
        assert_eq!(restored.device.device_id, vault.device.device_id);
        assert!(!String::from_utf8_lossy(&persisted).contains("glpat-local-vault-secret"));
        fs::remove_dir_all(&root).expect("测试目录应可清理");
    }
}
