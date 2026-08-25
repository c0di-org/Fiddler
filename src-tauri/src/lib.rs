#[cfg(target_os = "android")]
mod android_jni;
mod apk;
mod back;
mod commands;
mod content_search;
mod transfer;
mod fs_scan;
mod git;
mod model;
// USB devices that aren't running Fiddler. Android has no host-side USB stack
// to speak MTP with, so this is a desktop capability only.
#[cfg(not(target_os = "android"))]
mod mtp;
mod nearby;
mod opened;
mod volumes;
mod peers;
mod share;
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
            // Before anything slow: a file opened from another app may already
            // be waiting, and its nudge needs somewhere to land.
            opened::remember(app.handle().clone());
            // Same reason, one line later: Back is pressed long before anything slow.
            back::remember(app.handle().clone());
            let cache = Arc::new(GitCache::new());
            let watcher = FsWatcher::start(app.handle().clone(), cache.clone());
            let thumbs = ThumbPool::start(app.handle().clone());
            let peer_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("peers");
            let peers = peers::PeerService::start(peer_dir, cache.clone())?;
            let volumes = volumes::VolumeService::start(app.handle().clone());
            #[cfg(not(target_os = "android"))]
            let usb = mtp::MtpService::start(app.handle().clone());
            app.manage(AppState {
                cache,
                watcher,
                thumbs,
                peers,
                volumes,
                #[cfg(not(target_os = "android"))]
                usb,
                transfers: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_dir,
            commands::nearby_entries,
            commands::nearby_devices,
            #[cfg(not(target_os = "android"))]
            commands::usb_devices,
            #[cfg(not(target_os = "android"))]
            commands::release_usb_device,
            commands::nearby_pairing_info,
            commands::pair_nearby_device,
            commands::nearby_requests,
            commands::respond_nearby_request,
            commands::nearby_access,
            commands::withdraw_nearby_device,
            commands::forget_nearby_device,
            commands::search_contents,
            commands::repo_info,
            commands::refresh_repo,
            commands::sidebar_places,
            commands::volumes,
            commands::eject_volume,
            commands::system_accent,
            commands::thumbnail,
            commands::thumbnails,
            commands::inspect,
            commands::folder_peek,
            commands::read_text,
            commands::pdf_meta,
            commands::pdf_page,
            commands::install_apk,
            commands::take_opened_files,
            commands::set_back_enabled,
            commands::share_paths,
            commands::reveal_in_finder,
            commands::has_open_handler,
            commands::open_terminal_here,
            commands::create_folder,
            commands::create_text_file,
            commands::write_text_file,
            commands::create_file,
            commands::write_file,
            commands::free_name,
            commands::rename_path,
            commands::copy_paths,
            commands::cancel_transfer,
            commands::move_paths,
            commands::trash_paths,
            commands::restore_trashed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fiddler");
}
