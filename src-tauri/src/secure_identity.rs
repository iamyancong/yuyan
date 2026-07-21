use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use keyring::{Entry, Error as KeyringError};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

const KEYRING_SERVICE: &str = "cn.yuyan.ops";
const DEVICE_ENTRY: &str = "device-identity-v1";
const MASTER_KEY_ENTRY: &str = "local-master-key-v1";
const ACTIVE_ACCOUNT_ENTRY: &str = "active-account-v1";
#[cfg(target_os = "macos")]
const SECURE_VAULT_ENTRY: &str = "secure-vault-v2";
#[cfg(target_os = "macos")]
const SECURE_VAULT_SCHEMA_VERSION: u8 = 2;

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

/** macOS 单一钥匙串项，避免每个敏感字段分别触发一次系统授权。 */
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecureVault {
    schema_version: u8,
    device: StoredDeviceIdentity,
    local_master_key: String,
    active_account: Option<SecureAccountState>,
}

/** macOS 进程内只解锁一次钥匙串，后续签名和会话读取均复用内存副本。 */
#[cfg(target_os = "macos")]
static SECURE_VAULT_CACHE: OnceLock<Result<Mutex<SecureVault>, String>> = OnceLock::new();

/** 获取固定服务下的系统凭据条目。 */
fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, name).map_err(|error| format!("系统安全凭据库不可用: {error}"))
}

/** 生成不含账号原文的凭据条目名。 */
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

/** 将 macOS 安全保险箱持久化到唯一钥匙串项。 */
#[cfg(target_os = "macos")]
fn persist_secure_vault(vault: &SecureVault) -> Result<(), String> {
    let encoded =
        serde_json::to_string(vault).map_err(|error| format!("序列化安全保险箱失败: {error}"))?;
    entry(SECURE_VAULT_ENTRY)?
        .set_password(&encoded)
        .map_err(|error| format!("保存安全保险箱失败: {error}"))
}

/** 读取旧版钥匙串文本；不存在时返回空值。 */
#[cfg(target_os = "macos")]
fn read_legacy_password(name: &str, label: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取旧版{label}失败: {error}")),
    }
}

/** 将旧版多个钥匙串项一次性迁移为 macOS 单一保险箱。 */
#[cfg(target_os = "macos")]
fn migrate_legacy_secure_vault() -> Result<SecureVault, String> {
    let device = read_legacy_password(DEVICE_ENTRY, "设备身份")?
        .map(|raw| {
            serde_json::from_str(&raw).map_err(|error| format!("旧版设备身份数据损坏: {error}"))
        })
        .transpose()?
        .unwrap_or_else(create_stored_device);
    let local_master_key = read_legacy_password(MASTER_KEY_ENTRY, "本机数据库主密钥")?
        .filter(|value| value.len() >= 64)
        .unwrap_or_else(create_local_master_key);
    let active_account = match read_legacy_password(ACTIVE_ACCOUNT_ENTRY, "活动账号")? {
        Some(account_id) => {
            let account_name = account_entry_name(&account_id)?;
            read_legacy_password(&account_name, "账号安全状态")?
                .map(|raw| {
                    serde_json::from_str(&raw)
                        .map_err(|error| format!("旧版账号安全状态损坏: {error}"))
                })
                .transpose()?
        }
        None => None,
    };
    let vault = SecureVault {
        schema_version: SECURE_VAULT_SCHEMA_VERSION,
        device,
        local_master_key,
        active_account,
    };
    persist_secure_vault(&vault)?;
    Ok(vault)
}

/** 加载 macOS 安全保险箱；首次运行时创建，旧版则完成一次性迁移。 */
#[cfg(target_os = "macos")]
fn load_or_create_secure_vault() -> Result<SecureVault, String> {
    let vault_entry = entry(SECURE_VAULT_ENTRY)?;
    let vault: SecureVault = match vault_entry.get_password() {
        Ok(raw) => {
            serde_json::from_str(&raw).map_err(|error| format!("安全保险箱数据损坏: {error}"))?
        }
        Err(KeyringError::NoEntry) => return migrate_legacy_secure_vault(),
        Err(error) => return Err(format!("读取安全保险箱失败: {error}")),
    };
    if vault.schema_version != SECURE_VAULT_SCHEMA_VERSION {
        return Err(format!("不支持的安全保险箱版本: {}", vault.schema_version));
    }
    if vault.local_master_key.len() < 64 {
        return Err("安全保险箱中的本机数据库主密钥无效".to_string());
    }
    signing_key_from_stored(&vault.device)?;
    Ok(vault)
}

/** 获取 macOS 进程级安全保险箱缓存。 */
#[cfg(target_os = "macos")]
fn secure_vault() -> Result<&'static Mutex<SecureVault>, String> {
    match SECURE_VAULT_CACHE.get_or_init(|| load_or_create_secure_vault().map(Mutex::new)) {
        Ok(vault) => Ok(vault),
        Err(error) => Err(error.clone()),
    }
}

/** 只读访问 macOS 安全保险箱。 */
#[cfg(target_os = "macos")]
fn read_secure_vault<T>(
    reader: impl FnOnce(&SecureVault) -> Result<T, String>,
) -> Result<T, String> {
    let guard = secure_vault()?
        .lock()
        .map_err(|_| "安全保险箱内存状态已损坏".to_string())?;
    reader(&guard)
}

/** 原子更新 macOS 安全保险箱，持久化成功后才替换内存副本。 */
#[cfg(target_os = "macos")]
fn update_secure_vault<T>(
    updater: impl FnOnce(&mut SecureVault) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = secure_vault()?
        .lock()
        .map_err(|_| "安全保险箱内存状态已损坏".to_string())?;
    let mut next = guard.clone();
    let result = updater(&mut next)?;
    persist_secure_vault(&next)?;
    *guard = next;
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
}
