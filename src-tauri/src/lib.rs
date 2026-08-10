mod commands;
mod fs_scan;
mod git;
mod model;
#[cfg(target_os = "macos")]
mod page;
#[cfg(not(target_os = "macos"))]
#[path = "page_mobile.rs"]
mod page;
#[cfg(target_os = "macos")]
mod thumb;
#[cfg(not(target_os = "macos"))]
#[path = "thumb_mobile.rs"]
mod thumb;
mod thumb_pool;
#[cfg(target_os = "macos")]
mod thumb_text;
mod watcher;

use std::sync::Arc;

use tauri::Manager;

use commands::AppState;
use git::GitCache;
use thumb_pool::ThumbPool;
use watcher::FsWatcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let cache = Arc::new(GitCache::new());
            let watcher = FsWatcher::start(app.handle().clone(), cache.clone());
            let thumbs = ThumbPool::start(app.handle().clone());
            app.manage(AppState {
                cache,
                watcher,
                thumbs,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_dir,
            commands::repo_info,
            commands::refresh_repo,
            commands::sidebar_places,
            commands::system_accent,
            commands::thumbnail,
            commands::thumbnails,
            commands::inspect,
            commands::read_text,
            commands::pdf_meta,
            commands::pdf_page,
            commands::reveal_in_finder,
            commands::open_terminal_here,
            commands::create_folder,
            commands::rename_path,
            commands::trash_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fiddler");
}
