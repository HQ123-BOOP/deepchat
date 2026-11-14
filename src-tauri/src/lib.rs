mod asr;

/// Tauri 2 移动端入口与桌面端共用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            asr::asr_open,
            asr::asr_transcribe,
            asr::asr_close,
            asr::asr_available,
            asr::asr_model_path,
            asr::asr_model_ready,
            asr::asr_download_model,
            asr::asr_download_progress
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
