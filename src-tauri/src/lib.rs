mod asr;
mod secrets;

/// 让原生标题栏跟随应用内主题；不支持主题的平台直接忽略。
#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let theme = match theme.as_str() {
        "dark" => tauri::Theme::Dark,
        "light" => tauri::Theme::Light,
        _ => return Ok(()),
    };
    window.set_theme(Some(theme)).map_err(|error| error.to_string())
}

/// Tauri 2 移动端入口与桌面端共用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_window_theme,
            asr::asr_open,
            asr::asr_transcribe,
            asr::asr_close,
            asr::asr_available,
            asr::asr_model_path,
            asr::asr_model_ready,
            asr::asr_download_model,
            asr::asr_download_progress,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
