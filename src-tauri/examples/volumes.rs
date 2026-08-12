//! What the system actually says about every mounted volume.
//!
//!     cargo run --example volumes
//!
//! Two sources answer the same question differently and neither is complete:
//! `getmntinfo(2)` knows the mount — where it is, what filesystem, read-only or
//! not, how full — and DiskArbitration knows the *media* — removable, ejectable,
//! internal, network, and the name a person gave the disk. Classification has to
//! read both, so this prints both side by side and lets us see which fields are
//! actually populated rather than guessing from the headers.
//!
//! Run it against the interesting cases rather than just the laptop:
//!
//!     hdiutil create -size 100m -fs APFS -volname TestDrive /tmp/test.dmg
//!     hdiutil attach /tmp/test.dmg
//!     hdiutil create -size 20m -fs APFS -volname ReadOnly /tmp/ro.dmg
//!     hdiutil attach /tmp/ro.dmg -readonly
//!
//! and a USB stick, and an SMB share, if there is one to hand.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("volumes: this probe is macOS-only — DiskArbitration doesn't exist elsewhere");
}

#[cfg(target_os = "macos")]
fn main() {
    use std::ffi::CStr;

    use objc2_core_foundation::{CFRetained, CFURL};
    use objc2_disk_arbitration::{DADisk, DASession};

    // SAFETY: `getmntinfo` fills in a pointer to a static array owned by libc
    // and returns how many entries it wrote. Not thread-safe, and this probe is
    // single-threaded.
    let mounts = unsafe {
        let mut buf: *mut libc::statfs = std::ptr::null_mut();
        let count = libc::getmntinfo(&mut buf, libc::MNT_NOWAIT);
        if count <= 0 {
            eprintln!("getmntinfo returned nothing");
            return;
        }
        std::slice::from_raw_parts(buf, count as usize)
    };

    let session = unsafe { DASession::new(None) };
    if session.is_none() {
        eprintln!("no DiskArbitration session — the DA half will be blank");
    }

    for fs in mounts {
        // SAFETY: both are NUL-terminated C strings inside the statfs libc
        // filled in, valid for as long as the static buffer is.
        let on = unsafe { CStr::from_ptr(fs.f_mntonname.as_ptr()) }.to_string_lossy();
        let from = unsafe { CStr::from_ptr(fs.f_mntfromname.as_ptr()) }.to_string_lossy();
        let kind = unsafe { CStr::from_ptr(fs.f_fstypename.as_ptr()) }.to_string_lossy();

        println!("=== {on}");
        println!("  from        : {from}");
        println!("  fstype      : {kind}  (subtype {})", fs.f_fssubtype);
        println!("  flags       : 0x{:08x} {}", fs.f_flags, flag_names(fs.f_flags));
        println!("  flags_ext   : 0x{:08x}", fs.f_flags_ext);
        println!(
            "  capacity    : {} total, {} free, {} available ({}-byte blocks)",
            fs.f_blocks * fs.f_bsize as u64,
            fs.f_bfree * fs.f_bsize as u64,
            fs.f_bavail * fs.f_bsize as u64,
            fs.f_bsize,
        );

        let Some(session) = session.as_deref() else { continue };
        // SAFETY: the mount point as bytes, with the length the kernel's own
        // string has, and `true` because a mount point is always a directory.
        let url = unsafe {
            CFURL::from_file_system_representation(
                None,
                fs.f_mntonname.as_ptr().cast::<u8>(),
                on.len() as isize,
                true,
            )
        };
        let Some(url) = url else {
            println!("  DA          : no CFURL for this mount point");
            continue;
        };
        // SAFETY: a live session and a file URL for a path the kernel just
        // named. Returns null for a mount DA has no disk object for — an
        // autofs trigger, say — which is checked rather than assumed.
        let disk: Option<CFRetained<DADisk>> = unsafe { DADisk::from_volume_path(None, session, &url) };
        let Some(disk) = disk else {
            println!("  DA          : no disk object");
            continue;
        };
        // SAFETY: DADiskCopyDescription on a live disk object; null means the
        // disk went away between the two calls.
        match unsafe { disk.description() } {
            // `Debug` on a CF type is `CFCopyDescription`, which prints the
            // whole dictionary. Deliberately raw: the point of a probe is to
            // show what is there, including keys we haven't thought about.
            Some(description) => println!("  DA          : {description:?}"),
            None => println!("  DA          : no description"),
        }
    }
}

/// The `MNT_*` flags worth naming, so the hex above is readable at a glance.
#[cfg(target_os = "macos")]
fn flag_names(flags: u32) -> String {
    // Not in libc's apple module, but it is in <sys/mount.h> and is the flag
    // that most directly means "this can be taken out".
    const MNT_REMOVABLE: u32 = 0x0000_0200;
    let known: [(u32, &str); 8] = [
        (libc::MNT_RDONLY as u32, "RDONLY"),
        (libc::MNT_LOCAL as u32, "LOCAL"),
        (libc::MNT_ROOTFS as u32, "ROOTFS"),
        (libc::MNT_DONTBROWSE as u32, "DONTBROWSE"),
        (libc::MNT_AUTOMOUNTED as u32, "AUTOMOUNTED"),
        (libc::MNT_QUARANTINE as u32, "QUARANTINE"),
        (libc::MNT_SNAPSHOT as u32, "SNAPSHOT"),
        (MNT_REMOVABLE, "REMOVABLE"),
    ];
    let hits: Vec<&str> = known.iter().filter(|(bit, _)| flags & bit != 0).map(|(_, name)| *name).collect();
    hits.join(" ")
}
