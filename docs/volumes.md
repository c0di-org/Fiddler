# External and removable volumes

Context for the sidebar's Volumes section: what the two macOS APIs actually
report, which of those readings are measured and which are inferred, and the
decisions that are easy to get wrong in a way that only shows up on someone
else's machine.

Everything marked *measured* below came from `cargo run --example volumes` on an
Apple-silicon MacBook running macOS 15, against the startup disk, a writable
APFS disk image, a read-only APFS disk image, and an installer's hidden disk
image that happened to be attached.

## Where the code is

| | |
|---|---|
| `src-tauri/src/volumes/classify.rs` | `classify`, `MountFacts` — the pure decision, and where to add a case |
| `src-tauri/src/volumes/mac.rs` | `getmntinfo` + DiskArbitration, the watcher, eject |
| `src-tauri/src/volumes/android.rs` | `/storage` enumeration, the poll loop |
| `src-tauri/src/volumes/mod.rs` | the model, `VolumeService`, the platform split |
| `src/volumes.ts` | `volumeFor`, and everything a person reads |
| `src/location.ts` | what a read-only volume refuses, and how the refusal is worded |
| `src-tauri/examples/volumes.rs` | the probe that produced this document |

## The two sources, and why both are needed

`getmntinfo(2)` knows about **mounts**: where, which filesystem, read-only,
capacity, and the `MNT_*` flags. DiskArbitration knows about **disks**:
removable, ejectable, internal, network, and the name written on the volume.

Neither is sufficient. `statfs` cannot tell an external SSD from the internal
one — both are `apfs`, both are `MNT_LOCAL`. DiskArbitration has no idea how
full anything is.

## What the fields actually say

Measured, one line per reading that mattered:

| Mount | flags | `DAMediaRemovable` | `DAMediaEjectable` | `DADeviceInternal` | `DADeviceProtocol` |
|---|---|---|---|---|---|
| `/` | `RDONLY LOCAL ROOTFS SNAPSHOT` | 0 | 0 | 1 | `Apple Fabric` |
| `/System/Volumes/Data` | `LOCAL DONTBROWSE` | 0 | 0 | 1 | `Apple Fabric` |
| `/Volumes/TestDrive` (rw dmg) | `LOCAL REMOVABLE` | 1 | 1 | *absent* | `Virtual Interface` |
| `/Volumes/ReadOnlyDisk` (ro dmg) | `RDONLY LOCAL REMOVABLE` | 1 | 1 | *absent* | `Virtual Interface` |
| `/Volumes/dmg.XBU1Rs` (installer) | `LOCAL DONTBROWSE REMOVABLE` | 1 | 1 | *absent* | `Virtual Interface` |
| `/System/Volumes/Data/home` (autofs) | `DONTBROWSE AUTOMOUNTED` | — | — | — | — |

Four things in that table are worth stating outright.

**The startup disk is read-only, and it is browsable.** `/` is genuinely
`MNT_RDONLY` — it is the signed system volume — and it does *not* carry
`MNT_DONTBROWSE`. A classifier that only looked at those two flags would list
the running system as a read-only drive, and because `/Users` resolves through a
firmlink into `/System/Volumes/Data`, a longest-prefix lookup would then match
every path on the machine against `/` and refuse every write in the app. This is
the single most consequential thing in this document, and it is why
`VolumeKind::Startup` is tested for before anything about hardware and why the
startup disk is never listed.

**`DADeviceInternal` is absent, not false, on a disk image.** Every
DiskArbitration field is an `Option` for this reason. Reading an absent key as
`false` happens to be right here and is not a habit worth forming.

**`MNT_DONTBROWSE` is the flag that does the real filtering.** It removes
`/System/Volumes/*`, `/dev`, `nullfs` app-wrapper mounts under
`/private/var/folders`, autofs triggers, and installer disk images mounted at
`/Volumes/dmg.XXXXXX` — all in one test, and it is the same flag Finder honours.
`MNT_REMOVABLE` is not in libc's Apple module; it is `0x00000200` in
`<sys/mount.h>`.

**A disk image is told from a drive by `DADeviceProtocol`.** A `.dmg` reports
`Virtual Interface` and `DADeviceModel = "Disk Image"`; it is otherwise
indistinguishable from a USB stick, reporting removable and ejectable media on
every field.

### Not measured

Two rows in `classify.rs`'s tests are inferred rather than read off a machine,
and are marked as such in the code:

- **A USB stick and an external SSD.** No such hardware was attached when this
  was written. The shape is taken from the fields the other readings share:
  `DADeviceProtocol = "USB"`, `DADeviceInternal = 0`, and — the part worth
  knowing — `DAMediaRemovable = 0` on an external SSD, whose media does not come
  out of it. That is why "removable" is decided by *ejectable and not internal*
  as well as by removable media.
- **An SMB share.** No file server was reachable, and mounting one needs
  credentials. The network test is driven from the autofs trigger at
  `/System/Volumes/Data/home`, which is a genuine network-backed mount and does
  demonstrate the two signals: `MNT_LOCAL` clear, `DAVolumeNetwork = 1`. Either
  alone is treated as enough, and network is tested first, so a share cannot
  fall through into any of the hardware cases.

If you attach either, run the probe and correct the fixtures.

## The busy eject, which is not `kDAReturnBusy`

Measured, and it took a failing test to find. An unmount refused because a file
is open on the volume comes back as `0x0000c010`, which is `EBUSY` wrapped in
the `err_sub(3)` unix subsystem field. It matches none of the `kDAReturn*`
constants, and `kDAReturnBusy` (`0xf8da0002`) is not what arrives. Both are
accepted; see `is_busy` and its test.

Naming who is holding the disk has no public framework answer. `diskutil`
prints `dissented by PID 30069 (/bin/sleep)` and gets that from a private call.
`lsof -F cp +f -- /Volumes/X` is the public equivalent: `+f` makes the argument
mean *this filesystem* rather than *this path*, which is what catches both cases
people hit — a file open on the disk, and a shell sitting in a folder on it.
Measured at about 300ms with two holders, which is affordable exactly once,
after an eject has already been refused.

## Decisions, and why

**Volumes are their own sidebar section, not more Places.** Places are five
home-relative folders that are decided once and are always there. A volume
appears while Fiddler is running, can be taken away mid-listing, has a capacity
worth drawing, and can refuse to be detached.

**They are not folded into Wired.** "Wired" was renamed to name a *mechanism* —
MTP over a cable — and widening it to mean "and also disks" would undo the
point of the name. An external SSD is on a cable too and is nothing like a
phone: it is a filesystem, not a protocol.

**The startup disk is classified but never listed.** See above for the damage
listing it would do. It is still a named kind, because the enumeration sees it
and has to recognise it in order to leave it out.

**Read-only is a per-volume flag, not a fourth address space.** The three spaces
in `location.ts` are properties of the *path* — you can tell them apart by
looking at the string. Read-only is a property of the *disk*: the same path had
it and then didn't, when someone flipped the lock switch on a card and
remounted it. So `locationCaps` takes the volume list and resolves it.

The refusals are worded differently on purpose. "Fiddler can't rename items on a
device on a cable **yet**" is a promise about Fiddler — MTP has a rename and
this app has not called it. "ReadOnlyDisk is read-only" is a fact about the
disk, and no future version changes it, so it gets no "yet". `refusal()` is the
one place that decides which of the two a place deserves.

**Mounting is deliberately absent.** A share you are not connected to is not a
volume yet, and "connect to server" is a credential dialog and a protocol
picker — a different feature, and one it would be dishonest to half-build
behind an eject button.

## Android

An SD card mounts at `/storage/XXXX-XXXX` alongside `/storage/emulated/0`, which
is the shared storage `sidebar_places` already starts from. Enumeration is a
`read_dir` of `/storage` with `emulated` and `self` skipped, and `statvfs` for
capacity — there is no DiskArbitration and no mount table an app can read.

It polls, every three seconds. That is the only timer in Fiddler standing in for
an event, and the trade is deliberate: the alternative is `ACTION_MEDIA_MOUNTED`,
which means Kotlin, a manifest receiver and a bridge back into Rust, to notice a
card being physically pushed into a slot.

There is no eject. Unmounting a public volume is `StorageManager`'s business and
needs privileges an ordinary app does not have, so `Volume::ejectable` is false
and no control is drawn at all — better plainly absent than plausibly broken.

The card is called "Removable storage" rather than `1A2B-3C4D`, which is the FAT
volume serial Android names the mount point after. This is the same choice
`device_label` makes for `SAMSUNG_Android` over in `mtp`: where the only
available string is a machine's, say the honest generic thing rather than invent
a specific one. In particular it does not guess between an SD card and a stick
on the USB-C port, which nothing available here can tell apart.
`StorageManager.getStorageVolumes()` has the name a person set and Android's own
"SD card" wording, and is a Kotlin bridge away if it becomes worth it.

**Not verified on a device.** No Android phone was attached when this was
written. The Rust compiles for `aarch64-linux-android` and the classification is
unit-tested with the shape `/storage` produces, but nothing here has been seen
running on a phone with a card in it.

## Testing

```
cargo test --lib volumes            # classification, name derivation, is_busy
npm test                            # volumeFor, the notices, the refusals
```

Two tests need hardware or permission to attach some, and are `#[ignore]`d:

```
cargo test --lib -- --ignored --nocapture watching_reports
    # then, in another shell: hdiutil attach /tmp/test.dmg

cargo test --lib -- --ignored --nocapture ejecting_a_busy
    # self-contained: makes its own image, holds a file open, ejects
```

Making test volumes without hardware:

```
hdiutil create -size 100m -fs APFS -volname TestDrive /tmp/test.dmg
hdiutil attach /tmp/test.dmg
hdiutil create -size 20m -fs APFS -volname ReadOnlyDisk /tmp/ro.dmg
hdiutil attach /tmp/ro.dmg -readonly
```

## Constraints that will bite

**DiskArbitration replays every disk at registration.** Measured at fifteen
`DiskAppeared` callbacks on a laptop with two images attached, and five more per
`hdiutil attach`. The watcher rescans on each; `VolumeService` compares against
the last list and only emits when something actually changed. Do not add work
per callback on the assumption that a callback means a change.

**A mount is not one event.** The disk appears, and the filesystem is mounted a
moment later — which arrives as a description change, not an appearance. Both
are watched. A watcher registered only on `DiskAppeared` would report the list
from just before the mount and then sit there looking correct.

**`stage_of` calls `read_dir` on the watcher thread.** It is one `opendir`, and
only for volumes that are going to be listed, but a genuinely wedged disk would
stall the whole watcher until it returned. Network volumes are skipped for
exactly this reason. If a third kind of volume turns out to hang, skip it too
rather than making the probe asynchronous.

**`f_bavail`, not `f_bfree`.** The difference is the reserve only root can
write into. A meter built on `f_bfree` promises space the person looking at it
cannot have.
