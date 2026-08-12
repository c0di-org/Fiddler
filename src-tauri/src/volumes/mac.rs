//! macOS: `getmntinfo(2)` for the mounts, DiskArbitration for everything else.
//!
//! The split is not arbitrary. The kernel knows about *mounts* — where, which
//! filesystem, read-only, how full — and DiskArbitration knows about *disks* —
//! removable, ejectable, internal, network, and the name written on the volume.
//! Neither can answer on its own: `statfs` cannot tell an external SSD from the
//! internal one, and DiskArbitration has no idea how full anything is.
//!
//! DiskArbitration also happens to be the framework that performs an eject, and
//! the one that calls back when a disk appears or goes away. One dependency
//! covers enumeration, notification and the action, which is why there is no
//! timer in this file.
//!
//! The readings this was written against are in `docs/volumes.md`, and
//! `cargo run --example volumes` reproduces them.

use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::mpsc::{channel, Sender};
use std::thread;
use std::time::Duration;

use objc2_core_foundation::{
    kCFRunLoopDefaultMode, CFArray, CFBoolean, CFDictionary, CFRetained, CFRunLoop, CFString,
    CFType, CFURL,
};
use objc2_disk_arbitration::{
    kDADiskDescriptionDeviceInternalKey, kDADiskDescriptionDeviceProtocolKey,
    kDADiskDescriptionMediaBSDNameKey, kDADiskDescriptionMediaEjectableKey,
    kDADiskDescriptionMediaRemovableKey, kDADiskDescriptionVolumeNameKey,
    kDADiskDescriptionVolumeNetworkKey, kDADiskEjectOptionDefault, kDADiskUnmountOptionDefault,
    kDADiskUnmountOptionForce, kDAReturnBusy, kDAReturnNotMounted, DADisk, DADissenter,
    DARegisterDiskAppearedCallback, DARegisterDiskDescriptionChangedCallback,
    DARegisterDiskDisappearedCallback, DASession,
};

use super::classify::{classify, MountFacts};
use super::{stage_of, EjectOutcome, Holder, Volume, VolumeKind};

/// `MNT_REMOVABLE`, from `<sys/mount.h>`. libc's Apple module carries most of
/// the `MNT_*` flags but not this one.
const MNT_REMOVABLE: u32 = 0x0000_0200;

/// How long to wait for an unmount or an eject to come back.
///
/// DiskArbitration answers asynchronously and there is no upper bound on how
/// long a filesystem takes to flush, but a person is watching a button. Ten
/// seconds is long enough for a real unmount of a busy disk and short enough
/// that a wedged one gets an answer rather than a spinner forever.
const EJECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Everything mounted, filtered to what belongs in a sidebar.
pub fn scan() -> Vec<Volume> {
    // SAFETY: DASessionCreate with the default allocator. Null only under
    // memory pressure, and a scan without it still answers from `statfs` alone
    // — every volume comes back as `Internal` and nothing is offered an eject,
    // which is the right way to degrade.
    let session = unsafe { DASession::new(None) };
    scan_with(session.as_deref())
}

fn scan_with(session: Option<&DASession>) -> Vec<Volume> {
    mounts().iter().filter_map(|fs| volume_from(fs, session)).collect()
}

/// A copy of the kernel's mount table.
///
/// Copied rather than borrowed because `getmntinfo` hands back a pointer into a
/// buffer it owns and reuses on the next call from this process.
fn mounts() -> Vec<libc::statfs> {
    // SAFETY: `getmntinfo` writes a pointer to its own buffer and returns the
    // number of entries in it. `MNT_NOWAIT` asks it not to go to each
    // filesystem for fresh statistics, which is what keeps a stalled network
    // share from holding up the whole enumeration.
    unsafe {
        let mut buf: *mut libc::statfs = std::ptr::null_mut();
        let count = libc::getmntinfo(&mut buf, libc::MNT_NOWAIT);
        if count <= 0 || buf.is_null() {
            return Vec::new();
        }
        std::slice::from_raw_parts(buf, count as usize).to_vec()
    }
}

fn volume_from(fs: &libc::statfs, session: Option<&DASession>) -> Option<Volume> {
    let mount_point = c_string(&fs.f_mntonname);

    let description = session.and_then(|session| describe(session, &mount_point));
    let bsd_name = description.as_deref().and_then(|d| string(d, unsafe { kDADiskDescriptionMediaBSDNameKey }));
    let volume_name = description.as_deref().and_then(|d| string(d, unsafe { kDADiskDescriptionVolumeNameKey }));
    let protocol = description.as_deref().and_then(|d| string(d, unsafe { kDADiskDescriptionDeviceProtocolKey }));

    let facts = MountFacts {
        mount_point: &mount_point,
        read_only: fs.f_flags & libc::MNT_RDONLY as u32 != 0,
        local: fs.f_flags & libc::MNT_LOCAL as u32 != 0,
        root_fs: fs.f_flags & libc::MNT_ROOTFS as u32 != 0,
        browsable: fs.f_flags & libc::MNT_DONTBROWSE as u32 == 0,
        removable_mount: fs.f_flags & MNT_REMOVABLE != 0,
        volume_name: volume_name.as_deref(),
        network: description.as_deref().and_then(|d| boolean(d, unsafe { kDADiskDescriptionVolumeNetworkKey })),
        removable_media: description
            .as_deref()
            .and_then(|d| boolean(d, unsafe { kDADiskDescriptionMediaRemovableKey })),
        ejectable: description
            .as_deref()
            .and_then(|d| boolean(d, unsafe { kDADiskDescriptionMediaEjectableKey })),
        internal_device: description
            .as_deref()
            .and_then(|d| boolean(d, unsafe { kDADiskDescriptionDeviceInternalKey })),
        protocol: protocol.as_deref(),
    };

    let verdict = classify(&facts);
    if !verdict.listed {
        return None;
    }

    // `f_bavail` rather than `f_bfree`: the difference is the reserve only root
    // can write into, and a meter that counts it is promising space the person
    // looking at it cannot have.
    let block = fs.f_bsize as u64;
    Some(Volume {
        // A network share has no BSD name at all, so the mount point stands in.
        // Eject goes through the path either way; this is an identity, not an
        // address.
        id: bsd_name.unwrap_or_else(|| mount_point.clone()),
        stage: stage_of(&mount_point, verdict.kind),
        name: verdict.name,
        path: mount_point,
        kind: verdict.kind,
        read_only: verdict.read_only,
        free_space: fs.f_bavail * block,
        total_capacity: fs.f_blocks * block,
        ejectable: can_detach(verdict.kind),
    })
}

/// Can Fiddler offer to put this away?
///
/// A network share unmounts rather than ejects, but from the sidebar it is the
/// same gesture with the same consequence, so it is included and the wording is
/// left to the UI. The startup disk and any volume on an internal disk are not:
/// there is nothing to take away, and macOS would refuse anyway.
fn can_detach(kind: VolumeKind) -> bool {
    matches!(kind, VolumeKind::Removable | VolumeKind::DiskImage | VolumeKind::Network)
}

// ------------------------------------------------------------- watching

/// Watch for disks arriving and leaving, calling back with the whole list.
///
/// The callback is handed a complete list rather than a delta because that is
/// what the sidebar draws, and because a mount is not one event: a disk appears,
/// and then its description changes as the filesystem is actually mounted and a
/// volume path shows up. Rescanning on each and comparing is both simpler and
/// more truthful than trying to reconstruct the state from the sequence.
///
/// It calls back more often than anything changes, and by design.
/// `DARegisterDiskAppearedCallback` replays every disk already on the machine
/// at registration — measured at fifteen calls on a laptop with two images
/// attached — and a single `hdiutil attach` produces five more. Rescanning is a
/// handful of syscalls; deciding whether the answer is *different* is the
/// caller's job, and `VolumeService` does exactly that before emitting.
pub fn watch(on_change: impl Fn(Vec<Volume>) + Send + 'static) {
    thread::Builder::new()
        .name("fiddler-volumes".into())
        .spawn(move || {
            // SAFETY: DASessionCreate with the default allocator, on the thread
            // whose run loop it is about to be scheduled on.
            let Some(session) = (unsafe { DASession::new(None) }) else {
                eprintln!("volumes: no DiskArbitration session; drives will not appear on their own");
                return;
            };

            // Leaked on purpose: the callbacks hold this pointer for as long as
            // the session is scheduled, which is until the process exits. There
            // is no unwatch — Fiddler wants volumes for its whole life — so a
            // box that is never dropped is the honest way to say so.
            let watcher: *mut Watcher = Box::into_raw(Box::new(Watcher {
                on_change: Box::new(on_change),
                session: session.clone(),
            }));
            let context = watcher.cast::<c_void>();

            // SAFETY: a live session, no match dictionary (every disk), and
            // callbacks that only read through `context`, which outlives them.
            unsafe {
                DARegisterDiskAppearedCallback(&session, None, Some(rescan_appeared), context);
                DARegisterDiskDisappearedCallback(&session, None, Some(rescan_disappeared), context);
                // No watch list: a volume being mounted, renamed, or turned
                // read-only all matter, and filtering the keys here would only
                // move the same decision into a second place.
                DARegisterDiskDescriptionChangedCallback(
                    &session,
                    None,
                    None,
                    Some(rescan_changed),
                    context,
                );
            }

            let Some(run_loop) = CFRunLoop::current() else {
                eprintln!("volumes: no run loop on the watcher thread");
                return;
            };
            // SAFETY: scheduling the session on this thread's own run loop,
            // which is entered immediately below and never left.
            unsafe {
                session.schedule_with_run_loop(&run_loop, default_mode());
            }

            // The list as it stands before anything moves. `VolumeService`
            // already seeded itself synchronously, so this ordinarily changes
            // nothing — it is here for the disk that mounts in the gap between
            // that scan and this thread getting going.
            // SAFETY: `watcher` was just created and is not freed.
            unsafe { (*watcher).announce() };

            CFRunLoop::run();
        })
        .ok();
}

struct Watcher {
    on_change: Box<dyn Fn(Vec<Volume>) + Send>,
    session: CFRetained<DASession>,
}

impl Watcher {
    fn announce(&self) {
        (self.on_change)(scan_with(Some(&self.session)));
    }
}

/// # Safety
/// `context` must be the `Watcher` pointer given at registration.
unsafe extern "C-unwind" fn rescan_appeared(_disk: NonNull<DADisk>, context: *mut c_void) {
    unsafe { rescan(context) }
}

/// # Safety
/// `context` must be the `Watcher` pointer given at registration.
unsafe extern "C-unwind" fn rescan_disappeared(_disk: NonNull<DADisk>, context: *mut c_void) {
    unsafe { rescan(context) }
}

/// # Safety
/// `context` must be the `Watcher` pointer given at registration.
unsafe extern "C-unwind" fn rescan_changed(
    _disk: NonNull<DADisk>,
    _keys: NonNull<CFArray>,
    context: *mut c_void,
) {
    unsafe { rescan(context) }
}

/// # Safety
/// `context` must be the `Watcher` pointer given at registration.
unsafe fn rescan(context: *mut c_void) {
    let Some(watcher) = (unsafe { context.cast::<Watcher>().as_ref() }) else { return };
    watcher.announce();
}

// -------------------------------------------------------------- ejecting

/// Unmount a volume, and where there is a drive to tell, tell it to let go.
///
/// Synchronous from the caller's point of view, because it is a button. The
/// asynchrony is real — DiskArbitration answers on a run loop — so this makes a
/// run loop of its own on the calling thread and waits on it, rather than
/// borrowing the watcher's and blocking every other mount notification behind
/// one stuck unmount.
pub fn eject(volume: &Volume, force: bool) -> Result<EjectOutcome, String> {
    // SAFETY: DASessionCreate with the default allocator.
    let session = unsafe { DASession::new(None) }.ok_or("Couldn't reach DiskArbitration")?;
    let disk = disk_at(&session, &volume.path).ok_or_else(|| {
        format!("{} isn't mounted any more", volume.name)
    })?;

    let Some(run_loop) = CFRunLoop::current() else {
        return Err("No run loop on this thread".into());
    };
    // SAFETY: the session is scheduled on this thread's run loop for the
    // duration of the call and unscheduled before it returns.
    unsafe { session.schedule_with_run_loop(&run_loop, default_mode()) };

    let options = if force { kDADiskUnmountOptionForce } else { kDADiskUnmountOptionDefault };
    let (tx, rx) = channel();
    let reply: *mut Sender<Option<Dissent>> = Box::into_raw(Box::new(tx));
    // SAFETY: `reply` is a live boxed Sender; `unmounted` takes ownership of it
    // exactly once, and DiskArbitration calls an unmount callback exactly once.
    unsafe { disk.unmount(options, Some(unmounted), reply.cast()) };

    let answer = wait(&run_loop, &rx);
    // SAFETY: unscheduling the session we scheduled, from the same run loop.
    unsafe { session.unschedule_from_run_loop(&run_loop, default_mode()) };

    match answer {
        // Nothing objected, or there was nothing mounted to object — pressing
        // eject on a volume that has already gone is not a failure.
        Some(None) => {}
        Some(Some(dissent)) if dissent.status == kDAReturnNotMounted => {}
        Some(Some(dissent)) if is_busy(dissent.status) => {
            return Ok(EjectOutcome::Busy { holders: holders(&volume.path) });
        }
        Some(Some(dissent)) => {
            // DiskArbitration's own wording where it gave any: it is written
            // for a person, and anything invented here would be a guess at
            // what a status code meant.
            return Err(match dissent.message {
                Some(message) => format!("{} couldn't be ejected: {message}", volume.name),
                None => format!("{} couldn't be ejected ({:#x})", volume.name, dissent.status),
            });
        }
        None => return Err(format!("{} didn't answer in time", volume.name)),
    }

    // Unmounting is the part that protects the data; ejecting is the part that
    // makes the drive safe to unplug and spins down anything spinning. A
    // failure here is deliberately not reported: the volume is already off the
    // machine, the files are already flushed, and telling someone their
    // successful eject failed would be worse than saying nothing. Network
    // volumes and anything without ejectable media simply have nothing to tell.
    if volume.kind != VolumeKind::Network {
        eject_media(&session, &disk);
    }
    Ok(EjectOutcome::Ejected)
}

/// Tell the drive itself to let go, on a best-effort basis.
fn eject_media(session: &DASession, disk: &DADisk) {
    // The volume is one partition; what ejects is the whole disk behind it.
    // SAFETY: a live disk object; null when the disk has already gone, which
    // is a perfectly ordinary outcome one line after unmounting it.
    let Some(whole) = (unsafe { disk.whole_disk() }) else { return };
    let Some(run_loop) = CFRunLoop::current() else { return };
    // SAFETY: scheduled and unscheduled around the wait, as above.
    unsafe { session.schedule_with_run_loop(&run_loop, default_mode()) };
    let (tx, rx) = channel();
    let reply: *mut Sender<Option<Dissent>> = Box::into_raw(Box::new(tx));
    // SAFETY: as for `unmount` — one callback, one owned Sender.
    unsafe { whole.eject(kDADiskEjectOptionDefault, Some(ejected), reply.cast()) };
    let _ = wait(&run_loop, &rx);
    // SAFETY: unscheduling what was just scheduled.
    unsafe { session.unschedule_from_run_loop(&run_loop, default_mode()) };
}

/// Why DiskArbitration refused, in its own terms.
struct Dissent {
    status: i32,
    /// `DADissenterGetStatusString`, which is populated for some refusals and
    /// not others.
    message: Option<String>,
}

/// Was this refusal "something is still using it"?
///
/// Worth its own function because the answer is not the constant you would
/// reach for. `kDAReturnBusy` exists, and a volume with a file open on it does
/// not produce it: the refusal comes back from the kernel as `EBUSY` wrapped in
/// the `err_sub(3)` subsystem field — `0x0000c010` — which matches none of the
/// `kDAReturn*` values. Measured; see the test below.
fn is_busy(status: i32) -> bool {
    status == kDAReturnBusy || unix_errno(status) == Some(libc::EBUSY)
}

/// The BSD errno inside a DiskArbitration status, if that is what it is.
///
/// `<sys/kern_return.h>` builds these out of a system field, a subsystem field
/// and a code. What comes back here carries the subsystem — `err_sub(3)`, the
/// unix subsystem — and the errno, and nothing else.
fn unix_errno(status: i32) -> Option<i32> {
    /// `err_sub(3)`.
    const UNIX_SUBSYSTEM: i32 = 3 << 14;
    /// Everything above the 14-bit code field.
    const CODE: i32 = 0x3fff;
    (status & !CODE == UNIX_SUBSYSTEM).then_some(status & CODE)
}

/// Run this thread's run loop until the callback reports, or time runs out.
fn wait(
    run_loop: &CFRunLoop,
    rx: &std::sync::mpsc::Receiver<Option<Dissent>>,
) -> Option<Option<Dissent>> {
    let deadline = std::time::Instant::now() + EJECT_TIMEOUT;
    loop {
        if let Ok(answer) = rx.try_recv() {
            return Some(answer);
        }
        let left = deadline.checked_duration_since(std::time::Instant::now())?;
        // Returns as soon as the callback has been handled, so the usual case
        // costs one pass rather than the slice below.
        CFRunLoop::run_in_mode(Some(default_mode()), left.as_secs_f64().min(0.25), true);
        let _ = run_loop;
    }
}

/// # Safety
/// `context` must be the boxed `Sender` handed to `DADiskUnmount`, which this
/// takes ownership of.
unsafe extern "C-unwind" fn unmounted(
    _disk: NonNull<DADisk>,
    dissenter: *const DADissenter,
    context: *mut c_void,
) {
    unsafe { answer(dissenter, context) }
}

/// # Safety
/// `context` must be the boxed `Sender` handed to `DADiskEject`.
unsafe extern "C-unwind" fn ejected(
    _disk: NonNull<DADisk>,
    dissenter: *const DADissenter,
    context: *mut c_void,
) {
    unsafe { answer(dissenter, context) }
}

/// # Safety
/// `context` must be a boxed `Sender` this call takes ownership of, and
/// `dissenter` must be null or a valid dissenter.
unsafe fn answer(dissenter: *const DADissenter, context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let reply = unsafe { Box::from_raw(context.cast::<Sender<Option<Dissent>>>()) };
    // A null dissenter is DiskArbitration's way of saying nothing objected.
    let result = unsafe { dissenter.as_ref() }.map(|dissenter| Dissent {
        // SAFETY: reading out of a dissenter that is alive for the duration of
        // this callback.
        status: unsafe { dissenter.status() },
        message: unsafe { dissenter.status_string() }.map(|message| message.to_string()),
    });
    let _ = reply.send(result);
}

/// Who still has this volume open.
///
/// DiskArbitration says only that something objected; naming it is a separate
/// question with no public framework answer, so this asks `lsof`. Measured at
/// roughly 300ms against a volume with two holders, which is affordable exactly
/// once — after an eject has already been refused and someone is reading a
/// message.
///
/// `+f --` makes the argument mean "this filesystem" rather than "this path",
/// which is what catches both cases people actually hit: a file open on the
/// disk, and a shell sitting in a folder on it.
fn holders(mount_point: &str) -> Vec<Holder> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-F", "cp", "+f", "--", mount_point])
        .output();
    let Ok(output) = output else { return Vec::new() };

    // `-F cp` is lsof's machine-readable form: one field per line, tagged by
    // its first character. `p` opens a process, `c` names it.
    let mut found: Vec<Holder> = Vec::new();
    let mut pid: Option<u32> = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let (tag, value) = line.split_at(1);
        match tag {
            "p" => pid = value.parse().ok(),
            "c" => {
                if let Some(pid) = pid.take() {
                    // One process can hold a dozen files on the volume and is
                    // still one thing to quit.
                    if !found.iter().any(|holder| holder.pid == pid) {
                        found.push(Holder { name: value.to_string(), pid });
                    }
                }
            }
            _ => {}
        }
    }
    found
}

// ----------------------------------------------------------- CF plumbing

fn default_mode() -> &'static CFString {
    // SAFETY: reading a Core Foundation constant. Present in every process that
    // has linked CoreFoundation, which is every process on macOS.
    unsafe { kCFRunLoopDefaultMode }.expect("kCFRunLoopDefaultMode")
}

/// The disk object for a mount point, or none if it has gone.
fn disk_at(session: &DASession, mount_point: &str) -> Option<CFRetained<DADisk>> {
    let bytes = mount_point.as_bytes();
    // SAFETY: a byte string and its length, and `true` because a mount point is
    // always a directory.
    let url = unsafe {
        CFURL::from_file_system_representation(None, bytes.as_ptr(), bytes.len() as isize, true)
    }?;
    // SAFETY: a live session and a file URL. Null for a mount with no disk
    // object behind it, which is checked by the caller.
    unsafe { DADisk::from_volume_path(None, session, &url) }
}

/// A disk description, typed.
///
/// The binding returns the untyped `CFDictionary`, whose key and value types
/// are placeholders. DiskArbitration documents these dictionaries as keyed by
/// `CFString` with Core Foundation values, so naming that once here is what
/// lets the three readers below be ordinary safe code.
type Description = CFDictionary<CFString, CFType>;

fn describe(session: &DASession, mount_point: &str) -> Option<CFRetained<Description>> {
    // SAFETY: DADiskCopyDescription on a disk object that is alive here. Null
    // when the disk goes away between the two calls, which is possible and is
    // why this returns an Option rather than unwrapping.
    let description = unsafe { disk_at(session, mount_point)?.description() }?;
    // SAFETY: naming the key and value types the framework documents. Nothing
    // is dereferenced on the strength of it — every read below goes through a
    // checked downcast, so a value that isn't what we expected is `None`
    // rather than a misread.
    Some(unsafe { CFRetained::cast_unchecked::<Description>(description) })
}

fn string(dictionary: &Description, key: &CFString) -> Option<String> {
    Some(dictionary.get(key)?.downcast_ref::<CFString>()?.to_string())
}

fn boolean(dictionary: &Description, key: &CFString) -> Option<bool> {
    Some(dictionary.get(key)?.downcast_ref::<CFBoolean>()?.as_bool())
}

/// A fixed-size C string field from `statfs`, as a Rust `String`.
fn c_string(field: &[std::ffi::c_char]) -> String {
    // SAFETY: every one of these fields is NUL-terminated by the kernel and
    // lives inside the `statfs` we own a copy of.
    unsafe { CStr::from_ptr(field.as_ptr()) }.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use objc2_disk_arbitration::kDAReturnNotPermitted;

    use super::*;

    /// Whatever is mounted right now, classified — a check that the two APIs
    /// are being read correctly, which no fixture can give us.
    ///
    /// Asserts almost nothing on purpose: what is plugged into the machine
    /// running the tests is not knowable. The one thing that is always true is
    /// the thing worth failing on, and it is the mistake with the worst
    /// consequences: the startup disk must never be listed, because everything
    /// under it would then be governed by a read-only volume's rules.
    #[test]
    fn scanning_this_machine_never_lists_the_startup_disk() {
        for volume in scan() {
            assert_ne!(volume.kind, VolumeKind::Startup, "{volume:?}");
            assert!(!volume.path.is_empty());
            assert!(volume.path.starts_with('/'));
        }
    }

    /// The encoding this got wrong first time round, pinned so it stays right.
    ///
    /// `0xc010` is what a volume with a file open on it actually answers, and
    /// nothing in the `kDAReturn*` list is anywhere near it. Reading it as
    /// "some other error" is how an eject button ends up reporting a hex code
    /// instead of naming the app that has to be quit.
    #[test]
    fn a_busy_volume_is_recognised_from_either_encoding() {
        assert_eq!(unix_errno(0xc010), Some(libc::EBUSY));
        assert!(is_busy(0xc010), "EBUSY wrapped in err_sub(3)");
        assert!(is_busy(kDAReturnBusy), "DiskArbitration's own constant");

        // Other refusals are not busy, and must not be reported as though
        // quitting an app would fix them.
        assert!(!is_busy(kDAReturnNotMounted));
        assert!(!is_busy(kDAReturnNotPermitted));
        assert!(!is_busy(0));
        // `EPERM` in the same subsystem: the neighbouring value, so this is the
        // test that the mask isn't simply matching the subsystem field.
        assert_eq!(unix_errno(0xc001), Some(libc::EPERM));
        assert!(!is_busy(0xc001));
        // A DiskArbitration constant is not a unix errno wearing a hat.
        assert_eq!(unix_errno(kDAReturnBusy), None);
    }

    /// The whole eject path, against a disk image this test makes itself.
    ///
    /// Ignored because it attaches and detaches a real volume, which is rude to
    /// do behind someone's back during an ordinary `cargo test`:
    ///
    ///     cargo test --lib -- --ignored --nocapture ejecting_a_busy_volume
    ///
    /// What it pins down is the part that cannot be reasoned about from the
    /// headers: that an unmount refused because a file is open comes back as
    /// `kDAReturnBusy` and not as an error, that `lsof` can put a name to it,
    /// and that the same eject then succeeds once nothing is holding on. Those
    /// three facts are the entire difference between a button that works and
    /// one that silently does nothing.
    #[test]
    #[ignore = "attaches and detaches a real disk image"]
    fn ejecting_a_busy_volume_names_the_holder_and_changes_nothing() {
        const NAME: &str = "FiddlerEjectTest";
        let image = std::path::Path::new("/tmp/fiddler-eject-test.dmg");

        let _ = std::fs::remove_file(image);
        run("hdiutil", &["create", "-size", "20m", "-fs", "APFS", "-volname", NAME, "-quiet", "/tmp/fiddler-eject-test.dmg"]);
        run("hdiutil", &["attach", "/tmp/fiddler-eject-test.dmg"]);

        let volume = scan()
            .into_iter()
            .find(|volume| volume.name == NAME)
            .expect("the image this test just attached should be in the scan");
        assert_eq!(volume.kind, VolumeKind::DiskImage);
        assert!(volume.ejectable);

        // Hold a file open on it, which is what a person's editor is doing when
        // they press eject and it doesn't work.
        let held = std::fs::File::create(format!("{}/held.txt", volume.path)).expect("write to the image");

        match eject(&volume, false) {
            Ok(EjectOutcome::Busy { holders }) => {
                // Naming the holder is best-effort — `lsof` may be absent or
                // refuse — so the empty case is reported rather than failed on.
                println!("busy, held by: {holders:?}");
                assert!(
                    holders.iter().any(|holder| holder.pid == std::process::id()),
                    "this test process is holding a file open and should have been named: {holders:?}"
                );
            }
            other => panic!("expected the open file to refuse the eject, got {other:?}"),
        }
        // The refusal has to leave the volume exactly as it was: a half-ejected
        // disk is the outcome this whole flow exists to avoid.
        assert!(std::path::Path::new(&volume.path).is_dir(), "the volume should still be mounted");

        drop(held);
        assert_eq!(eject(&volume, false), Ok(EjectOutcome::Ejected));
        assert!(!std::path::Path::new(&volume.path).exists(), "the volume should be gone");

        let _ = std::fs::remove_file(image);
    }

    #[cfg(test)]
    fn run(program: &str, args: &[&str]) {
        let status = std::process::Command::new(program)
            .args(args)
            .status()
            .unwrap_or_else(|e| panic!("couldn't run {program}: {e}"));
        assert!(status.success(), "{program} {args:?} failed");
    }

    /// Mount and unmount arriving as events, checked against real hardware.
    ///
    /// Ignored because it needs a person: run it and then attach or eject
    /// something while it watches.
    ///
    ///     cargo test --lib -- --ignored --nocapture watching_reports
    ///     hdiutil attach /tmp/test.dmg     # in another shell
    ///
    /// It exists because the timing is the one thing worth doubting here.
    /// DiskArbitration announces a *disk*, and the volume is mounted a moment
    /// later — so a watcher that rescanned only on `DiskAppeared` would report
    /// the list from just before the mount and then sit there looking correct.
    /// Watching description changes as well is what covers that, and this is
    /// how we know it does.
    #[test]
    #[ignore = "needs someone to plug something in"]
    fn watching_reports_mounts_as_they_happen() {
        let (tx, rx) = channel();
        watch(move |volumes| {
            let _ = tx.send(volumes);
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        println!("watching for 30s — attach or eject something now");
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(volumes) => {
                    println!("--- {} volume(s)", volumes.len());
                    for volume in volumes {
                        println!(
                            "  {:<24} {:?} {:?} ro={} {}/{} bytes free",
                            volume.name,
                            volume.kind,
                            volume.stage,
                            volume.read_only,
                            volume.free_space,
                            volume.total_capacity
                        );
                    }
                }
                Err(_) => break,
            }
        }
    }
}
