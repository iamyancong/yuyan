use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::path::Path;

/** 从 Tauri 配置读取 Updater 公钥。 */
fn read_configured_public_key() -> Result<String, String> {
    let config_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let content = std::fs::read_to_string(config_path)
        .map_err(|error| format!("读取 tauri.conf.json 失败: {error}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("解析 Tauri 配置失败: {error}"))?;
    config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Tauri 配置缺少 updater pubkey".to_string())
}

/** 使用 Tauri 配置公钥验证指定更新产物。 */
fn verify_artifact(artifact_path: &Path, signature_path: &Path) -> Result<(), String> {
    let bytes =
        std::fs::read(artifact_path).map_err(|error| format!("读取更新产物失败: {error}"))?;
    let release_signature = std::fs::read_to_string(signature_path)
        .map_err(|error| format!("读取更新签名失败: {error}"))?;
    let public_key = read_configured_public_key()?;
    let public_key_text = base64::engine::general_purpose::STANDARD
        .decode(public_key.trim())
        .map_err(|error| format!("解码 Updater 公钥失败: {error}"))?;
    let public_key_text = std::str::from_utf8(&public_key_text)
        .map_err(|error| format!("Updater 公钥格式无效: {error}"))?;
    let public_key = PublicKey::decode(public_key_text)
        .map_err(|error| format!("读取 Updater 公钥失败: {error}"))?;
    let signature_text = base64::engine::general_purpose::STANDARD
        .decode(release_signature.trim())
        .map_err(|error| format!("解码 Updater 签名失败: {error}"))?;
    let signature_text = std::str::from_utf8(&signature_text)
        .map_err(|error| format!("Updater 签名格式无效: {error}"))?;
    let signature = Signature::decode(signature_text)
        .map_err(|error| format!("读取 Updater 签名失败: {error}"))?;
    public_key
        .verify(&bytes, &signature, true)
        .map_err(|error| format!("Updater 私钥与客户端公钥不匹配: {error}"))?;
    Ok(())
}

/** 校验 CI 刚生成的 updater 产物与客户端内置公钥匹配。 */
fn main() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let artifact_path = args
        .next()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "缺少 updater 产物路径".to_string())?;
    let signature_path = args
        .next()
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "缺少 updater 签名路径".to_string())?;
    if args.next().is_some() {
        return Err("参数过多".to_string());
    }
    verify_artifact(&artifact_path, &signature_path)?;
    println!("Updater signature matches configured public key");
    Ok(())
}
