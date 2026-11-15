mod asr;
mod secrets;

/// Tauri 2 移动端入口与桌面端共用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_barcode_scanner::init())
        .invoke_handler(tauri::generate_handler![
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
