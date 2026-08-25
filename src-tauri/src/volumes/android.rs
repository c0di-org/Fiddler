//! Android: what is mounted under `/storage`.
//!
//! Removable storage on a phone is the same feature as a drive on the Mac and
//! nothing like the MTP module next door. That one is cfg'd off here because
//! Android is the device on the *other* end of the cable and has no USB host
//! stack to speak MTP with. A card in the phone is the opposite situation: it
//! is local, it is an ordinary POSIX path, and a DeX user with a card in the
//! phone wants it in the sidebar for exactly the reasons a laptop user wants
//! their SSD there.
//!
//! # Why this polls
//!
//! There is no DiskArbitration. Android broadcasts `ACTION_MEDIA_MOUNTED` to
//! registered receivers, which means Kotlin, a receiver in the manifest, and a
//! bridge back into Rust — a fair amount of machinery whose failure modes are
//! invisible from here. The thing being watched is a card being physically
//! inserted, which happens perhaps once a week, so a `read_dir` of a directory
//! with three entries in it every few seconds is genuinely cheap enough. That
//! is a real tradeoff rather than a shortcut, and it is the only place in
//! Fiddler where a timer stands in for an event.
//!
//! # Why there is no eject
//!
//! Unmounting a public volume is `StorageManager`'s business and needs
//! permissions an ordinary app does not have. Android already has a place to do
//! it — the Storage screen — and the phone flushes and unmounts on shutdown.
//! A button here would either do nothing or need a privilege Fiddler has no
//! business asking for, so `Volume::ejectable` is false and the sidebar draws
//! no control at all. Better to be plainly absent than plausibly broken.

use std::path::Path;
use std::thread;
use std::time::Duration;

use super::classify::{classify, MountFacts};
use super::{stage_of, EjectOutcome, Volume};

/// Where Android's volume daemon mounts everything.
const STORAGE: &str = "/storage";

/// The shared storage every Android app sees, which `sidebar_places` already
/// starts from as "Internal storage". It lives under `/storage` alongside the
/// removable volumes and is not one.
const EMULATED: &str = "emulated";

/// A per-process view of the same shared storage, not a volume.
const SELF: &str = "self";

/// How often to look. See the note at the top of the file: the event being
/// waited for is someone pushing a card into a slot.
const POLL: Duration = Duration::from_secs(3);

pub fn scan() -> Vec<Volume> {
    let Ok(entries) = std::fs::read_dir(STORAGE) else {
        // `/storage` itself is unreadable on some builds. Nothing to report is
        // the honest answer; the section simply doesn't appear.
        return Vec::new();
    };

    let mut found: Vec<Volume> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == EMULATED || name == SELF {
                return None;
            }
            volume_at(&entry.path(), &name)
        })
        .collect();
    // A stable order, so two cards don't swap places between polls.
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

fn volume_at(path: &Path, dir_name: &str) -> Option<Volume> {
    // `is_dir` follows the symlink Android sometimes puts here, and answers
    // false for a volume that has been pulled out but whose entry is still
    // being torn down.
    if !path.is_dir() {
        return None;
    }
    let path = path.to_str()?.to_string();
    let space = space(&path);
    let label = label(dir_name);

    let facts = MountFacts {
        mount_point: &path,
        // Nothing here reads a real mount table: `/proc/mounts` exists but is
        // filtered for an app, and the two facts that matter are already known
        // from where this is. Everything under `/storage` that isn't the
        // emulated volume is by definition one of vold's public volumes.
        removable_mount: true,
        local: true,
        browsable: true,
        read_only: space.map(|space| space.read_only).unwrap_or(false),
        volume_name: Some(&label),
        ..Default::default()
    };
    let verdict = classify(&facts);

    Some(Volume {
        id: path.clone(),
        stage: stage_of(&path, verdict.kind),
        name: verdict.name,
        path,
        kind: verdict.kind,
        read_only: verdict.read_only,
        free_space: space.map(|space| space.free).unwrap_or(0),
        total_capacity: space.map(|space| space.total).unwrap_or(0),
        // See the note at the top of the file.
        ejectable: false,
    })
}

/// What to call a volume whose directory is named after its UUID.
///
/// `1A2B-3C4D` is the FAT volume serial, and it is what Android names the mount
/// point after. It is true and it is useless — the same problem `device_label`
/// solves over in `mtp` for `SAMSUNG_Android`, and the same answer: where the
/// only string available is a machine's, say the honest generic thing instead
/// of inventing a specific one. "Removable storage" claims exactly what putting
/// it in this list already claims, and no more — in particular it does not
/// guess between an SD card and a stick on the USB-C port, which nothing here
/// can tell apart. The name a person set, and Android's own "SD card" wording,
/// live in `StorageManager.getStorageVolumes()`, which is a Kotlin bridge away.
fn label(dir_name: &str) -> String {
    if is_volume_uuid(dir_name) {
        return "Removable storage".into();
    }
    dir_name.to_string()
}

/// `XXXX-XXXX`, four hex digits, a dash, four hex digits.
fn is_volume_uuid(name: &str) -> bool {
    let Some((left, right)) = name.split_once('-') else { return false };
    let hex = |part: &str| part.len() == 4 && part.chars().all(|c| c.is_ascii_hexdigit());
    hex(left) && hex(right)
}

#[derive(Clone, Copy)]
struct Space {
    free: u64,
    total: u64,
    read_only: bool,
}

/// How big a volume is and how much of it is left.
fn space(path: &str) -> Option<Space> {
    let c_path = std::ffi::CString::new(path).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a NUL-terminated path and a zeroed `statvfs` to fill in.
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    // `f_frsize` is the fragment size the block counts are in; `f_bsize` is a
    // hint about efficient I/O and is the wrong multiplier here.
    //
    // The casts are redundant on aarch64 (clippy notices) but load-bearing on
    // 32-bit Android, where these `statvfs` fields are u32.
    #[allow(clippy::unnecessary_cast)]
    let block = stat.f_frsize as u64;
    #[allow(clippy::unnecessary_cast)]
    Some(Space {
        // `f_bavail` rather than `f_bfree`, for the reason given in `mac.rs`:
        // the difference is reserved space this app cannot write into.
        free: stat.f_bavail as u64 * block,
        total: stat.f_blocks as u64 * block,
        read_only: stat.f_flag as u64 & libc::ST_RDONLY != 0,
    })
}

pub fn watch(on_change: impl Fn(Vec<Volume>) + Send + 'static) {
    thread::Builder::new()
        .name("fiddler-volumes".into())
        .spawn(move || {
            let mut last = scan();
            on_change(last.clone());
            loop {
                thread::sleep(POLL);
                let found = scan();
                if found != last {
                    last = found.clone();
                    on_change(found);
                }
            }
        })
        .ok();
}

pub fn eject(volume: &Volume, _force: bool) -> Result<EjectOutcome, String> {
    // Unreachable from the UI, which draws no eject control where
    // `Volume::ejectable` is false. Here so that the answer is a sentence
    // rather than a panic if that ever stops being true.
    Err(format!(
        "{} has to be ejected from Android's Storage settings — apps can't unmount it safely",
        volume.name
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_volume_uuid_is_not_a_name() {
        assert!(is_volume_uuid("1A2B-3C4D"));
        assert!(is_volume_uuid("0000-0000"));
        assert!(is_volume_uuid("abcd-ef01"));
        assert_eq!(label("1A2B-3C4D"), "Removable storage");
    }

    /// A volume with a real label keeps it. Android uses the label where the
    /// filesystem has one, so this is not hypothetical.
    #[test]
    fn a_labelled_volume_keeps_its_label() {
        assert!(!is_volume_uuid("SANDISK"));
        assert!(!is_volume_uuid("1A2B-3C4D-5E6F"));
        assert!(!is_volume_uuid("12345-678"));
        assert_eq!(label("SANDISK"), "SANDISK");
        assert_eq!(label("Field recordings"), "Field recordings");
    }
}
