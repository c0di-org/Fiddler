//! Deciding what a mount *is*, away from the APIs that report it.
//!
//! Everything here is a pure function over [`MountFacts`], which is a
//! platform-neutral rendering of what `getmntinfo(2)` and DiskArbitration said
//! on macOS, or what walking `/storage` found on Android. Keeping it separate is
//! what makes the interesting cases — a read-only disk image, the startup disk,
//! a network share — testable without hardware, a DMG, or a file server.
//!
//! The field values in the tests below are transcribed from
//! `cargo run --example volumes` against real mounts; see `docs/volumes.md` for
//! the readings and which of them are measured rather than inferred.

use serde::{Deserialize, Serialize};

/// What kind of thing a mount is, which decides its glyph, whether it can be
/// ejected, and whether it belongs in the sidebar at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VolumeKind {
    /// The volume this machine booted from. Never listed as a drive: it is not
    /// somewhere you arrive by plugging something in, and it cannot be ejected.
    Startup,
    /// A volume on a disk inside the machine that isn't the startup disk —
    /// another partition, or a second built-in drive.
    Internal,
    /// A disk the person can take away: a USB stick, an SD card, an external
    /// SSD. What they have in common is not that the media pops out — an
    /// external SSD's doesn't — but that pulling the cable is a thing someone
    /// will do, so the data has to be flushed first.
    Removable,
    /// A mounted `.dmg`. Backed by a file rather than by hardware, which is why
    /// it is worth telling apart: "eject" here means "close the image".
    DiskImage,
    /// SMB, AFP, NFS, or an autofs trigger for one. The bytes are somewhere
    /// else and the connection can drop mid-listing.
    Network,
}

/// What the system said about one mount, before anything has been decided.
///
/// Deliberately booleans rather than a `MNT_*` bitmask: Android has no such
/// flags, and a struct that only macOS can fill in would push the classification
/// back into the platform layer where it can't be tested. The macOS side
/// unpacks the mask; the Android side answers from what it can see.
///
/// Every DiskArbitration field is an `Option` because a mount can have no disk
/// object at all — `devfs`, an autofs trigger — and because the keys are
/// genuinely absent rather than false on the ones that do: a disk image's
/// description carries no `DADeviceInternal` at all.
#[derive(Debug, Default, Clone)]
pub struct MountFacts<'a> {
    /// Where it is mounted. Also the path the sidebar navigates to.
    pub mount_point: &'a str,
    /// `MNT_RDONLY`. The kernel's own answer, so it is the one writes are
    /// checked against.
    pub read_only: bool,
    /// `MNT_LOCAL`: the bytes are on this machine.
    pub local: bool,
    /// `MNT_ROOTFS`: this is the volume the machine booted from.
    pub root_fs: bool,
    /// `MNT_DONTBROWSE` is *unset* — macOS's own "show this to a person" flag.
    /// Finder honours it, and so does this: it is what keeps `/System/Volumes/*`,
    /// `/dev`, app-wrapper `nullfs` mounts and installer disk images out.
    pub browsable: bool,
    /// `MNT_REMOVABLE`.
    pub removable_mount: bool,
    /// `DAVolumeName` — the name written on the disk, which is what a person
    /// calls it. Falls back to the mount point's last component.
    pub volume_name: Option<&'a str>,
    /// `DAVolumeNetwork`.
    pub network: Option<bool>,
    /// `DAMediaRemovable`: the media comes out of the drive, as a card does.
    pub removable_media: Option<bool>,
    /// `DAMediaEjectable`: the drive can be told to let go.
    pub ejectable: Option<bool>,
    /// `DADeviceInternal`: the device is inside the machine.
    pub internal_device: Option<bool>,
    /// `DADeviceProtocol`: `USB`, `Apple Fabric`, `Virtual Interface`.
    pub protocol: Option<&'a str>,
}

/// What a mount turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub kind: VolumeKind,
    /// Belongs in the sidebar. See [`classify`] for what this excludes.
    pub listed: bool,
    pub read_only: bool,
    /// What to call it.
    pub name: String,
}

/// `DADeviceProtocol` for anything served by `diskimages-helper` rather than by
/// a bus. Measured: a `.dmg` attached with `hdiutil` reports exactly this, along
/// with `DADeviceModel = "Disk Image"`.
const VIRTUAL_INTERFACE: &str = "Virtual Interface";

/// Which of the five kinds this mount is, whether it is worth showing, and what
/// to call it.
///
/// The order of the tests is the whole design, so it is worth saying why:
///
/// 1. **Network first.** A share is never removable media, and asking about its
///    hardware is a category error — there isn't any on this end.
/// 2. **The startup disk next**, because it also answers yes to "is it
///    ejectable media" on a machine that boots from a USB stick, and getting
///    that wrong offers to eject the running system.
/// 3. **Disk images**, which report themselves as removable and ejectable in
///    every field — they are, but "eject" means something different, and a
///    read-only `.dmg` is the one case where refusing writes is normal rather
///    than a fault.
/// 4. **Removable**, which is the case this feature exists for.
/// 5. **Internal** as the fallback, on purpose: it is the answer that claims the
///    least. A mount we can't identify gets no eject button and is never
///    described to anyone as an external drive.
pub fn classify(facts: &MountFacts) -> Verdict {
    let kind = kind_of(facts);
    Verdict {
        kind,
        // A volume is listed when macOS says it is for people, and when it
        // isn't the disk we booted from. The startup disk is excluded because
        // the sidebar's Places already lead into it, and a row that is always
        // present, can never be ejected, and reports the whole machine's
        // capacity is a different thing wearing this row's clothes.
        listed: facts.browsable && kind != VolumeKind::Startup,
        read_only: facts.read_only,
        name: name_of(facts),
    }
}

fn kind_of(facts: &MountFacts) -> VolumeKind {
    // `MNT_LOCAL` unset is the kernel saying the bytes are elsewhere, and
    // `DAVolumeNetwork` is DiskArbitration saying the same thing. Either alone
    // is enough: an autofs trigger sets the DA key and clears the mount flag,
    // and a mount with no disk object at all has only the flag to offer.
    if facts.network == Some(true) || !facts.local {
        return VolumeKind::Network;
    }
    if facts.root_fs {
        return VolumeKind::Startup;
    }
    if facts.protocol == Some(VIRTUAL_INTERFACE) {
        return VolumeKind::DiskImage;
    }
    // Removable media is removable wherever the drive is bolted: the SD slot in
    // a MacBook is an internal device, and the card in it is still the card the
    // person is about to pull out.
    if facts.removable_media == Some(true) || facts.removable_mount {
        return VolumeKind::Removable;
    }
    // An external SSD's media is not removable — the whole drive is. So this is
    // the pair that names it: it can be told to let go, and it isn't inside the
    // machine. Both are needed, because the internal SSD is ejectable in the
    // sense that macOS will unmount a data volume on it.
    if facts.ejectable == Some(true) && facts.internal_device != Some(true) {
        return VolumeKind::Removable;
    }
    VolumeKind::Internal
}

/// What a person calls this volume.
///
/// `DAVolumeName` is the name written on the disk and is what Finder shows.
/// Without it — no disk object, or a filesystem that carries no label — the
/// mount point's last component is the next best thing, and is usually the same
/// string, because that is what macOS names the mount after.
fn name_of(facts: &MountFacts) -> String {
    let labelled = facts.volume_name.map(str::trim).filter(|name| !name.is_empty());
    if let Some(name) = labelled {
        return name.to_string();
    }
    let leaf = facts.mount_point.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    if leaf.is_empty() {
        // Only reachable for a mount at `/` with no volume name, which in
        // practice means a system without a labelled root.
        return facts.mount_point.to_string();
    }
    leaf.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The startup disk as `getmntinfo` and DiskArbitration actually describe
    /// it on an Apple-silicon Mac. Two things here are traps: the signed system
    /// volume is genuinely `MNT_RDONLY`, and it is *not* `MNT_DONTBROWSE`. A
    /// classifier that only looked at those two flags would list the running
    /// system as a read-only drive.
    fn startup() -> MountFacts<'static> {
        MountFacts {
            mount_point: "/",
            read_only: true,
            local: true,
            root_fs: true,
            browsable: true,
            removable_mount: false,
            volume_name: Some("Macintosh HD"),
            network: Some(false),
            removable_media: Some(false),
            ejectable: Some(false),
            internal_device: Some(true),
            protocol: Some("Apple Fabric"),
        }
    }

    /// A writable APFS disk image attached with `hdiutil attach`.
    fn writable_dmg() -> MountFacts<'static> {
        MountFacts {
            mount_point: "/Volumes/TestDrive",
            read_only: false,
            local: true,
            root_fs: false,
            browsable: true,
            removable_mount: true,
            volume_name: Some("TestDrive"),
            network: Some(false),
            removable_media: Some(true),
            ejectable: Some(true),
            // Absent in the real description, which is the point of the Option.
            internal_device: None,
            protocol: Some("Virtual Interface"),
            ..Default::default()
        }
    }

    /// A USB stick. Inferred from the shape the other readings share rather
    /// than measured — see `docs/volumes.md`.
    fn usb_stick() -> MountFacts<'static> {
        MountFacts {
            mount_point: "/Volumes/NO NAME",
            read_only: false,
            local: true,
            root_fs: false,
            browsable: true,
            removable_mount: true,
            volume_name: Some("NO NAME"),
            network: Some(false),
            removable_media: Some(true),
            ejectable: Some(true),
            internal_device: Some(false),
            protocol: Some("USB"),
        }
    }

    #[test]
    fn startup_disk_is_never_a_drive() {
        let verdict = classify(&startup());
        assert_eq!(verdict.kind, VolumeKind::Startup);
        assert!(!verdict.listed);
    }

    /// The read-only flag on the startup disk is real, and reporting it
    /// faithfully is fine — what must not happen is that flag reaching a
    /// listed row, because nothing else in Fiddler would then let you save.
    #[test]
    fn the_signed_system_volume_is_read_only_and_hidden() {
        let verdict = classify(&startup());
        assert!(verdict.read_only);
        assert!(!verdict.listed);
    }

    #[test]
    fn the_data_volume_is_not_a_drive_either() {
        // `/System/Volumes/Data` is where a home directory really lives. It is
        // writable, local, and not the root — and only `MNT_DONTBROWSE` keeps
        // it out of the sidebar.
        let facts = MountFacts {
            mount_point: "/System/Volumes/Data",
            local: true,
            browsable: false,
            volume_name: Some("Data"),
            internal_device: Some(true),
            ejectable: Some(false),
            removable_media: Some(false),
            network: Some(false),
            ..Default::default()
        };
        let verdict = classify(&facts);
        assert_eq!(verdict.kind, VolumeKind::Internal);
        assert!(!verdict.listed);
    }

    #[test]
    fn a_disk_image_is_told_from_a_drive_by_its_protocol() {
        let verdict = classify(&writable_dmg());
        assert_eq!(verdict.kind, VolumeKind::DiskImage);
        assert!(verdict.listed);
        assert!(!verdict.read_only);
        assert_eq!(verdict.name, "TestDrive");
    }

    /// The case that must not offer to write: a `.dmg` attached `-readonly`.
    #[test]
    fn a_read_only_disk_image_says_so() {
        let facts = MountFacts {
            mount_point: "/Volumes/ReadOnlyDisk",
            read_only: true,
            volume_name: Some("ReadOnlyDisk"),
            ..writable_dmg()
        };
        let verdict = classify(&facts);
        assert_eq!(verdict.kind, VolumeKind::DiskImage);
        assert!(verdict.read_only);
        assert!(verdict.listed);
    }

    /// An installer's disk image mounts at `/Volumes/dmg.XXXXXX` with
    /// `MNT_DONTBROWSE` set. It is a real disk image; it is nobody's
    /// destination.
    #[test]
    fn a_hidden_disk_image_is_classified_but_not_listed() {
        let facts = MountFacts {
            mount_point: "/Volumes/dmg.XBU1Rs",
            browsable: false,
            volume_name: Some("Gitty"),
            ..writable_dmg()
        };
        let verdict = classify(&facts);
        assert_eq!(verdict.kind, VolumeKind::DiskImage);
        assert!(!verdict.listed);
    }

    #[test]
    fn a_usb_stick_is_removable() {
        let verdict = classify(&usb_stick());
        assert_eq!(verdict.kind, VolumeKind::Removable);
        assert!(verdict.listed);
    }

    /// An external SSD is the case that has no removable media at all: nothing
    /// pops out of it, and it is still the thing someone unplugs.
    #[test]
    fn an_external_ssd_is_removable_without_removable_media() {
        let facts = MountFacts {
            mount_point: "/Volumes/Archive",
            local: true,
            browsable: true,
            volume_name: Some("Archive"),
            network: Some(false),
            removable_media: Some(false),
            ejectable: Some(true),
            internal_device: Some(false),
            protocol: Some("USB"),
            ..Default::default()
        };
        assert_eq!(classify(&facts).kind, VolumeKind::Removable);
    }

    /// A card in a built-in slot is on an internal device and is still a card.
    #[test]
    fn a_card_in_an_internal_reader_is_removable() {
        let facts = MountFacts {
            mount_point: "/Volumes/SDCARD",
            local: true,
            browsable: true,
            volume_name: Some("SDCARD"),
            removable_media: Some(true),
            ejectable: Some(true),
            internal_device: Some(true),
            ..Default::default()
        };
        assert_eq!(classify(&facts).kind, VolumeKind::Removable);
    }

    #[test]
    fn an_smb_share_is_a_network_volume() {
        let facts = MountFacts {
            mount_point: "/Volumes/photos",
            // A share is not `MNT_LOCAL`, and DiskArbitration says so too.
            local: false,
            browsable: true,
            volume_name: Some("photos"),
            network: Some(true),
            ..Default::default()
        };
        let verdict = classify(&facts);
        assert_eq!(verdict.kind, VolumeKind::Network);
        assert!(verdict.listed);
    }

    /// Either signal alone is enough. An autofs trigger sets `DAVolumeNetwork`
    /// while carrying no `MNT_LOCAL` either way, and a share on a filesystem DA
    /// has no disk object for has only the mount flag to go on.
    #[test]
    fn network_is_believed_from_either_source() {
        let flag_only = MountFacts { local: false, browsable: true, ..Default::default() };
        assert_eq!(classify(&flag_only).kind, VolumeKind::Network);

        let key_only =
            MountFacts { local: true, network: Some(true), browsable: true, ..Default::default() };
        assert_eq!(classify(&key_only).kind, VolumeKind::Network);
    }

    /// A network share must never be mistaken for something to eject, even
    /// when the mount flags look removable.
    #[test]
    fn network_wins_over_removable() {
        let facts = MountFacts {
            local: false,
            browsable: true,
            removable_mount: true,
            removable_media: Some(true),
            ejectable: Some(true),
            ..Default::default()
        };
        assert_eq!(classify(&facts).kind, VolumeKind::Network);
    }

    /// Booting from an external disk is a thing people do. The running system
    /// must still not be offered an eject button.
    #[test]
    fn a_removable_startup_disk_is_still_the_startup_disk() {
        let facts = MountFacts {
            mount_point: "/",
            root_fs: true,
            local: true,
            browsable: true,
            volume_name: Some("External Boot"),
            removable_media: Some(true),
            ejectable: Some(true),
            internal_device: Some(false),
            protocol: Some("USB"),
            ..Default::default()
        };
        let verdict = classify(&facts);
        assert_eq!(verdict.kind, VolumeKind::Startup);
        assert!(!verdict.listed);
    }

    /// Nothing known but the mount: the answer claims the least it can.
    #[test]
    fn an_unidentifiable_local_mount_falls_back_to_internal() {
        let facts = MountFacts {
            mount_point: "/Volumes/Something",
            local: true,
            browsable: true,
            ..Default::default()
        };
        let verdict = classify(&facts);
        assert_eq!(verdict.kind, VolumeKind::Internal);
        assert_eq!(verdict.name, "Something");
    }

    #[test]
    fn the_mount_point_names_a_volume_with_no_label() {
        let facts = MountFacts {
            mount_point: "/Volumes/Untitled/",
            local: true,
            browsable: true,
            volume_name: None,
            ..Default::default()
        };
        assert_eq!(classify(&facts).name, "Untitled");
    }

    #[test]
    fn a_blank_volume_name_is_not_a_name() {
        let facts = MountFacts {
            mount_point: "/Volumes/Untitled",
            local: true,
            browsable: true,
            volume_name: Some("   "),
            ..Default::default()
        };
        assert_eq!(classify(&facts).name, "Untitled");
    }

    /// Android's SD card, which arrives with no DiskArbitration at all: a path
    /// under `/storage` that isn't the shared storage, and the enumerator
    /// saying it is removable.
    #[test]
    fn an_android_card_is_removable_without_disk_arbitration() {
        let facts = MountFacts {
            mount_point: "/storage/1A2B-3C4D",
            local: true,
            browsable: true,
            removable_mount: true,
            ..Default::default()
        };
        let verdict = classify(&facts);
        assert_eq!(verdict.kind, VolumeKind::Removable);
        assert!(verdict.listed);
        assert_eq!(verdict.name, "1A2B-3C4D");
    }
}
