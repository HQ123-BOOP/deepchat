//! 设备令牌的安全存储：优先用系统凭据库（Windows 凭据管理器 / macOS 钥匙串 /
//! Linux Secret Service），失败时退回应用数据目录下的受限文件，避免整条链路不可用。

use std::path::PathBuf;

const SERVICE: &str = "com.hq123boop.chatdemo";

fn fallback_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("secrets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建密钥目录: {e}"))?;
    Ok(dir.join(format!("{}.txt", key)))
}

#[cfg(not(target_os = "android"))]
fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("凭据库不可用: {e}"))
}

/// Android 没有可用的 keyring 后端：令牌只落在应用私有目录（其他 App 无法读取）
#[cfg(target_os = "android")]
fn entry(_key: &str) -> Result<(), String> {
    Err("移动端使用应用私有目录".into())
}

#[tauri::command]
pub fn secret_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    if let Ok(entry) = entry(&key) {
        if entry.set_password(&value).is_ok() {
            return Ok(());
        }
    }
    let path = fallback_path(&app, &key)?;
    std::fs::write(&path, value).map_err(|e| format!("写入失败: {e}"))
}

#[tauri::command]
pub fn secret_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    #[cfg(not(target_os = "android"))]
    if let Ok(entry) = entry(&key) {
        if let Ok(value) = entry.get_password() {
            return Ok(Some(value));
        }
    }
    let path = fallback_path(&app, &key)?;
    match std::fs::read_to_string(&path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取失败: {error}")),
    }
}

#[tauri::command]
pub fn secret_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    if let Ok(entry) = entry(&key) {
        let _ = entry.delete_credential();
    }
    #[cfg(target_os = "android")]
    let _ = entry(&key);
    let path = fallback_path(&app, &key)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除失败: {error}")),
    }
}
