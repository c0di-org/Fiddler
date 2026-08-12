//! Disks that come and go: USB sticks, external SSDs, SD cards, mounted disk
//! images, network shares — and on Android, a card in the phone.
//!
//! # Why this is not part of `sidebar_places`
//!
//! Places are five folders under a home directory. They are decided once, they
//! are always there, and asking for them is a handful of `is_dir` calls. A
//! volume is the opposite of every one of those: it appears while Fiddler is
//! running, it can be taken away mid-listing, it has a capacity worth drawing,
//! and it can refuse to be detached. It needs a watcher, an event, and an
//! action — so it gets its own module rather than making `sidebar_places`
//! quietly become one.
//!
//! # Why there is a watcher rather than a timer
//!
//! Nothing in Fiddler refreshes itself; every change arrives as an event and
//! the view responds. macOS gives us that directly: DiskArbitration calls back
//! when a disk appears, disappears, or changes description, which is also the
//! framework that performs the eject, so there is one dependency rather than a
//! timer plus a second way to unmount. Android has no equivalent and is polled;
//! see `android.rs` for why that is the honest answer there rather than a
//! shortcut.
//!
//! # What is deliberately not here
//!
//! Mounting. A share you are not connected to isn't a volume yet, and "connect
//! to server" is a credential dialog and a protocol picker — a different
//! feature that would be dishonest to half-build behind an eject button.

pub mod classify;

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "macos")]
mod mac;

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub use classify::VolumeKind;

/// Whether a mounted volume can actually be read.
///
/// Both platforms have a state where the disk is genuinely mounted and Fiddler
/// still cannot see inside it, and in both cases it is a permission the person
/// can grant rather than a broken disk. Hiding those volumes would be the same
/// mistake `Stage::AwaitingGrant` exists to avoid over in `mtp`: a drive that is
/// plainly plugged in and simply missing from the sidebar is unactionable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum VolumeStage {
    /// Browsable.
    Ready,
    /// Mounted, and reading it was refused. macOS asks separately about
    /// removable volumes (System Settings › Privacy & Security); Android needs
    /// All files access. The copy for each lives in the frontend, which already
    /// knows which platform it is.
    Locked,
    /// Mounted, and reading it failed for a reason that isn't permission — a
    /// disk going bad, or a share whose far end has gone.
    #[serde(rename_all = "camelCase")]
    Unreadable { message: String },
}

/// One mounted volume, as the sidebar draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    /// What `eject_volume` is keyed on. The BSD name on macOS (`disk6s1`),
    /// which survives the volume being renamed; the mount point on Android,
    /// which is all there is.
    pub id: String,
    /// The name written on the disk.
    pub name: String,
    /// The mount point. An ordinary local path: this is the whole reason a
    /// volume needs no new address space the way `mtp://` did.
    pub path: String,
    pub kind: VolumeKind,
    #[serde(flatten)]
    pub stage: VolumeStage,
    /// Writes will be refused by the kernel. True for a `.dmg` attached
    /// read-only, a locked SD card, and a share exported read-only.
    pub read_only: bool,
    /// Bytes an ordinary user could still write here, and the size of the whole
    /// volume. Zero for both where the filesystem doesn't say — a network share
    /// that hasn't answered — which `fullness()` already draws as an empty bar
    /// rather than a full one.
    pub free_space: u64,
    pub total_capacity: u64,
    /// Fiddler can offer to detach this one. Separate from `kind.detachable()`
    /// because the platform gets the last word: Android has removable storage
    /// and no way for an app to unmount it safely.
    pub ejectable: bool,
}

/// One process holding a volume open, as `lsof` named it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    /// The command, which is the name a person will recognise in Activity
    /// Monitor. Not always the application: a shell sitting in the folder is
    /// `zsh`, and saying so is more use than saying "Terminal" and being wrong
    /// about which window.
    pub name: String,
    pub pid: u32,
}

/// How an eject went.
///
/// `Busy` is a first-class answer rather than an error because it is the
/// ordinary one — something is nearly always still holding a disk you just
/// finished using — and because it comes with the two things an error string
/// can't carry: who, and the fact that trying again may simply work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum EjectOutcome {
    /// Unmounted, and the drive told to let go where there was one to tell.
    Ejected,
    /// Refused: something on this machine still has the volume open. Holders is
    /// empty when nothing could be named, which is possible — the refusal comes
    /// from the kernel and naming who caused it is a separate question.
    #[serde(rename_all = "camelCase")]
    Busy { holders: Vec<Holder> },
}

/// The mounted volumes, kept current by whatever the platform gives us.
pub struct VolumeService {
    volumes: Arc<Mutex<Vec<Volume>>>,
}

impl VolumeService {
    pub fn start(app: AppHandle) -> Arc<Self> {
        // Seeded synchronously: the sidebar asks once on mount, and a drive
        // that was already plugged in when Fiddler launched should be in that
        // first answer rather than appearing a moment later as if it had just
        // been connected.
        let volumes = Arc::new(Mutex::new(platform::scan()));

        let held = volumes.clone();
        platform::watch(move |found| {
            // Only say something when something changed. Every mount produces a
            // burst of callbacks — a disk appearing, then its description
            // changing as the filesystem is mounted — and each one rescans.
            {
                let mut current = match held.lock() {
                    Ok(current) => current,
                    Err(_) => return,
                };
                if *current == found {
                    return;
                }
                *current = found.clone();
            }
            let _ = app.emit("fiddler:volumes", &found);
        });

        Arc::new(VolumeService { volumes })
    }

    /// The volumes mounted right now. Reads a mutex, never a disk.
    pub fn volumes(&self) -> Vec<Volume> {
        self.volumes.lock().map(|v| v.clone()).unwrap_or_default()
    }

    /// Put a volume away.
    ///
    /// `force` is the caller having asked a person first: an unforced eject
    /// answers `Busy` and changes nothing, and forcing one takes the volume out
    /// from under whatever is still writing to it. The decision is not this
    /// function's to make, which is why it is a parameter rather than a retry.
    pub fn eject(&self, id: &str, force: bool) -> Result<EjectOutcome, String> {
        let volume = self
            .volumes()
            .into_iter()
            .find(|volume| volume.id == id)
            .ok_or("That volume isn't mounted any more")?;
        if !volume.ejectable {
            return Err(format!("{} can't be ejected from Fiddler", volume.name));
        }
        platform::eject(&volume, force)
    }
}

// ------------------------------------------------------------- platforms
//
// One shape, three answers. The web build never reaches Rust at all; a browser
// tab has no volumes and `web.ts` says so.

#[cfg(target_os = "macos")]
use mac as platform;

#[cfg(target_os = "android")]
use android as platform;

/// Everywhere that is neither macOS nor Android — a Linux or Windows build of
/// the desktop app. Enumerating volumes there is a real feature and a different
/// one (udisks2, `GetLogicalDrives`), so this answers nothing rather than
/// guessing, and the section simply doesn't appear.
#[cfg(not(any(target_os = "macos", target_os = "android")))]
mod platform {
    use super::{EjectOutcome, Volume};

    pub fn scan() -> Vec<Volume> {
        Vec::new()
    }

    pub fn watch(_on_change: impl Fn(Vec<Volume>) + Send + 'static) {}

    pub fn eject(_volume: &Volume, _force: bool) -> Result<EjectOutcome, String> {
        Err("Ejecting volumes isn't supported on this platform".into())
    }
}

/// Whether a mounted volume can be read, asked of the filesystem itself.
///
/// One `opendir`, and only for volumes that are going to be listed. It is worth
/// the syscall because the answer is otherwise invisible until someone clicks:
/// macOS's removable-volume permission and Android's All files access both
/// leave a disk mounted, present, and empty-looking.
///
/// Not asked of network volumes. A share whose far end has gone answers this
/// question by not answering, and the watcher thread is the wrong place to wait.
#[cfg(any(target_os = "macos", target_os = "android"))]
fn stage_of(path: &str, kind: VolumeKind) -> VolumeStage {
    if kind == VolumeKind::Network {
        return VolumeStage::Ready;
    }
    match std::fs::read_dir(path) {
        Ok(_) => VolumeStage::Ready,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => VolumeStage::Locked,
        Err(e) => VolumeStage::Unreadable { message: e.to_string() },
    }
}
