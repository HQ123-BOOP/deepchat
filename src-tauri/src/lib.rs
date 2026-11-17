mod asr;
mod db;
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
        .setup(|app| {
            db::init(app)?;
            Ok(())
        })
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
            secrets::secret_delete,
            db::db_load_summaries_page,
            db::db_health,
            db::db_retry,
            db::db_rebuild,
            db::db_free_space,
            db::db_load_session,
            db::db_save_session,
            db::db_session_write_begin,
            db::db_session_write_chunk,
            db::db_session_write_commit,
            db::db_load_session_len,
            db::db_load_session_chunk,
            db::db_delete_session,
            db::db_save_files,
            db::db_load_file,
            db::db_save_file_text,
            db::db_load_file_text,
            db::db_clear_staging,
            db::db_add_staging_session,
            db::db_add_staging_sessions,
            db::db_save_staging_files,
            db::db_update_staging_file_types,
            db::db_commit_staging,
            db::db_merge_staging,
            db::db_session_versions,
            db::db_import_mode,
            db::db_search,
            db::ws_list,
            db::ws_read,
            db::ws_write,
            db::ws_edit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
