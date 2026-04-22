mod media;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            media::get_ffmpeg_status,
            media::append_debug_log,
            media::inspect_video,
            media::export_gif,
            media::render_quality_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
