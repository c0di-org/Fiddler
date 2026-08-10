mod apk;
mod commands;
mod content_search;
mod fs_scan;
mod git;
mod model;
// USB devices that aren't running Fiddler. Android has no host-side USB stack
// to speak MTP with, so this is a desktop capability only.
#[cfg(not(target_os = "android"))]
mod mtp;
mod nearby;
mod peers;
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
            let peer_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("peers");
            let peers = peers::PeerService::start(peer_dir, cache.clone())?;
            #[cfg(not(target_os = "android"))]
            let usb = mtp::MtpService::start(app.handle().clone());
            app.manage(AppState {
                cache,
                watcher,
                thumbs,
                peers,
                #[cfg(not(target_os = "android"))]
                usb,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_dir,
            commands::nearby_entries,
            commands::nearby_devices,
            #[cfg(not(target_os = "android"))]
            commands::usb_devices,
            commands::nearby_pairing_info,
            commands::pair_nearby_device,
            commands::search_contents,
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
            commands::install_apk,
            commands::reveal_in_finder,
            commands::open_terminal_here,
            commands::create_folder,
            commands::create_text_file,
            commands::write_text_file,
            commands::rename_path,
            commands::copy_paths,
            commands::trash_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fiddler");
}
