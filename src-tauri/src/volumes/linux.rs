//! Linux mounted volumes through GIO/GVfs.
//!
//! GVolumeMonitor is the desktop stack's view of "places a person can browse".
//! Only mounts with a native filesystem path are exposed here because the rest
//! of Fiddler's local backend is path-based; GVfs-only URIs would otherwise
//! draw a sidebar row that could never be opened.

use std::path::Path;
use std::thread;
use std::time::Duration;

use gio::prelude::*;

use super::{stage_of, EjectOutcome, Volume, VolumeKind};

pub fn scan() -> Vec<Volume> {
    let monitor = gio::VolumeMonitor::get();
    let mut found: Vec<_> = monitor
        .mounts()
        .into_iter()
        .filter_map(|mount| volume_from_mount(&mount))
        .collect();
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

fn volume_from_mount(mount: &gio::Mount) -> Option<Volume> {
    if mount.is_shadowed() {
        return None;
    }

    let root = mount.root();
    let path = root.path()?;
    if path == Path::new("/") {
        return None;
    }

    let attrs = [
        gio::FILE_ATTRIBUTE_FILESYSTEM_FREE,
        gio::FILE_ATTRIBUTE_FILESYSTEM_SIZE,
        gio::FILE_ATTRIBUTE_FILESYSTEM_READONLY,
        gio::FILE_ATTRIBUTE_FILESYSTEM_REMOTE,
    ]
    .join(",");

    let info = root
        .query_filesystem_info(&attrs, gio::Cancellable::NONE)
        .ok();

    let remote = info
        .as_ref()
        .is_some_and(|info| info.attribute_boolean(gio::FILE_ATTRIBUTE_FILESYSTEM_REMOTE));
    let read_only = info
        .as_ref()
        .is_some_and(|info| info.attribute_boolean(gio::FILE_ATTRIBUTE_FILESYSTEM_READONLY));
    let free_space = info
        .as_ref()
        .map(|info| info.attribute_uint64(gio::FILE_ATTRIBUTE_FILESYSTEM_FREE))
        .unwrap_or(0);
    let total_capacity = info
        .as_ref()
        .map(|info| info.attribute_uint64(gio::FILE_ATTRIBUTE_FILESYSTEM_SIZE))
        .unwrap_or(0);

    let ejectable = mount.can_eject() || mount.can_unmount();
    let kind = if remote {
        VolumeKind::Network
    } else if ejectable {
        VolumeKind::Removable
    } else {
        VolumeKind::Internal
    };

    let path_text = path.to_string_lossy().into_owned();
    let id = mount
        .uuid()
        .map(|uuid| uuid.to_string())
        .filter(|uuid| !uuid.is_empty())
        .unwrap_or_else(|| path_text.clone());

    Some(Volume {
        id,
        name: mount.name().to_string(),
        path: path_text.clone(),
        kind,
        stage: stage_of(&path_text, kind),
        read_only,
        free_space,
        total_capacity,
        ejectable,
    })
}

/// GIO signals require a GLib main context. Fiddler's Tauri loop is not GLib's
/// loop, so a low-frequency rescan is more dependable here and still reacts
/// quickly enough for a sidebar drive appearing/disappearing.
pub fn watch(on_change: impl Fn(Vec<Volume>) + Send + 'static) {
    thread::spawn(move || {
        let mut previous = scan();
        loop {
            thread::sleep(Duration::from_secs(2));
            let next = scan();
            if next != previous {
                previous = next.clone();
                on_change(next);
            }
        }
    });
}

pub fn eject(volume: &Volume, force: bool) -> Result<EjectOutcome, String> {
    let monitor = gio::VolumeMonitor::get();
    let mount = monitor
        .mounts()
        .into_iter()
        .find(|mount| mount_id(mount) == volume.id)
        .ok_or("That volume isn't mounted any more")?;

    let flags = if force {
        gio::MountUnmountFlags::FORCE
    } else {
        gio::MountUnmountFlags::NONE
    };
    let context = glib::MainContext::new();

    let result = if mount.can_eject() {
        context.block_on(mount.eject_with_operation_future(
            flags,
            gio::MountOperation::NONE,
        ))
    } else {
        context.block_on(mount.unmount_with_operation_future(
            flags,
            gio::MountOperation::NONE,
        ))
    };

    match result {
        Ok(()) => Ok(EjectOutcome::Ejected),
        Err(error) if error.to_string().to_lowercase().contains("busy") => {
            Ok(EjectOutcome::Busy { holders: Vec::new() })
        }
        Err(error) => Err(error.to_string()),
    }
}

fn mount_id(mount: &gio::Mount) -> String {
    mount
        .uuid()
        .map(|uuid| uuid.to_string())
        .filter(|uuid| !uuid.is_empty())
        .or_else(|| mount.root().path().map(|path| path.to_string_lossy().into_owned()))
        .unwrap_or_default()
}
