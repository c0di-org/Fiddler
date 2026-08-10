# Thumbnails for files on a USB device

Context for extending device previews to more file types. Everything here was
learned building the photo and video routes against a Samsung Galaxy Z Fold 7
over MTP; the measurements are from that phone on a USB 2.0 cable.

## Where the code is

| | |
|---|---|
| `src-tauri/src/thumb.rs` | `usb_thumbnail`, `plan_source`, `embedded_thumbnail`, `exif_orientation`, `oriented` |
| `src-tauri/src/mtp/mod.rs` | `MtpService::read_range`, `MtpService::device_thumbnail`, the worker |
| `src-tauri/src/thumb_pool.rs` | four lanes, viewport ordering — unchanged by any of this |

`generate()` in `thumb.rs` is the fork: an `mtp://` path goes to
`usb_thumbnail`, everything else takes the existing local paths.

## The three routes, and how one is chosen

`plan_source(lane, head)` decides. It is a pure function and it is tested; if
you add a route, extend it there rather than inside `usb_thumbnail`.

- **`Source::Whole`** — the read covered the entire file (it came back shorter
  than `USB_HEAD_BYTES`), or it is text, which is drawn from its first lines by
  design. Decode normally.
- **`Source::Embedded`** — only the front of a photo arrived, but it contains a
  complete EXIF thumbnail. Cut that out and decode it on its own.
- **`Source::Device`** — nothing cheap will draw this. Ask the device via MTP
  `GetThumb` (`MtpService::device_thumbnail`).

`USB_HEAD_BYTES` is 256 KB. A file read that returns fewer bytes than asked for
is how "the whole file arrived" is detected — `read_range` clamps at EOF rather
than erroring, which is verified by a test.

## What has already been tried and does not work

Read this before touching the image path. Two of these cost real time.

**`kCGImageSourceCreateThumbnailFromImageIfAbsent` does not make ImageIO use an
embedded thumbnail.** The obvious fix for "ImageIO decoded the truncated main
image" is to flip `...FromImageAlways` to `...IfAbsent`. It changes nothing —
measured through the real code path, not assumed. ImageIO still decodes the
fragment and returns a photo that fades to grey part way down. The embedded
JPEG has to be cut out of the head and decoded as a file in its own right.

**An embedded thumbnail carries no EXIF of its own.** Extract it and a portrait
photo comes back on its side. The orientation lives in the parent file, so
`exif_orientation` parses the tag out of the head and `oriented` applies it.

**Core Graphics rotates the opposite way to EXIF.** Bottom-left origin,
counter-clockwise for positive angles, against EXIF's top-left and clockwise.
The two quarter-turn cases in `oriented` are therefore swapped relative to what
the EXIF numbers suggest. The first version rendered upside down.

**"It decoded without erroring" is not verification.** A truncated JPEG decodes
fine — to a grey sliver. This bug shipped because the check was `sips` exiting
zero. Render the thing and *look at the pixels*.

## Measurements

Per file, on the test phone over USB 2.0:

| route | cost |
|---|---|
| 256 KB head read | ~9 ms |
| `GetThumb`, still | 7–15 ms |
| `GetThumb`, video | 85–138 ms — the device is decoding video to answer |
| whole 4 MB photo | ~100 ms+, and it swamps the bus for a screen of tiles |

A folder listing is the dominant cost, not thumbnails: 1348 objects took 990 ms,
2.0 s and 6.15 s across three runs. mtp-rs has no bulk metadata call, so a
folder is one round trip per object. Listings stream (see `mtp/mod.rs`), and
`GetObjectPropList` (opcode 0x9805, present in mtp-rs only as a constant) is the
real repair — it belongs upstream.

## Candidates, most worth doing first

**PDF.** Currently falls to `Source::Device`, and Android has no thumbnail for
one, so it is a glyph. Page objects can sit anywhere in a PDF, so the head is
not enough. The tractable version: if the object is under a few MB, pull the
whole file with `read_range` and hand it to the existing `page::render`. At
~40 MB/s a 2 MB PDF costs ~50 ms, which is fine for a document folder and
absurd for a photo grid — so gate it on size, and only on the `Page` lane.

**HEIC/HEIF.** In the `RASTER` lane, so it takes the head route, but
`embedded_thumbnail` only finds a JPEG inside a JPEG — HEIC is an ISO-BMFF
container and its preview is not framed by `FFD8`/`FFD9`. It therefore falls
through to `GetThumb` today, which may well be the right answer. **Check what
actually happens before writing a parser**: if the phone serves HEIC thumbnails,
there is nothing to do. Newer Samsungs and every iPhone shoot HEIC, so this is
worth confirming early.

**RAW (`dng`, `cr2`, `nef`, `arw`, …).** Also `RASTER`. RAW files carry a
full-size embedded JPEG, but often megabytes into the file rather than in the
first 256 KB. Options, in order of preference: try `GetThumb` first (already the
fallback, so possibly already working); otherwise a larger head for this
extension group. Do not raise `USB_HEAD_BYTES` globally to fix RAW — it would
cost every photo tile.

**APK icons.** Fiddler already has `apk.rs`, and a phone's Download folder is
full of them. An APK is a zip, so the icon needs the central directory at the
*end* of the file — `read_range` takes an arbitrary offset, so read the tail,
parse the directory, then read just the icon entry. Two or three round trips,
no whole-file download. Self-contained and satisfying, but not on the critical
path for a camera roll.

**Audio album art.** ID3v2 puts the `APIC` frame at the *front* of an MP3, so
one head read gets it — the cheapest win here technically. The catch is that
audio has **no lane at all** right now (`mp3`, `m4a`, `flac` are in none of
`RASTER`, `QUICKLOOK`, `TEXT`), so it has no thumbnail even for local files.
That makes it a change to Fiddler's preview model generally, not a device
feature. Worth doing, but decide it on its own merits rather than smuggling it
in here.

## Not worth doing

- **Downloading whole media files to render locally.** A 322 MB video is on the
  test phone's camera roll. `GetThumb` exists precisely so this is unnecessary.
- **Raising `USB_HEAD_BYTES`.** Every photo tile pays for it. Fetch more only
  for the extensions that need it.
- **Rendering anything partial.** The guard in `usb_thumbnail` refuses rather
  than drawing a fragment, and that is deliberate: a picture fading to grey
  looks like a broken app, a glyph looks like a missing preview.

## Testing

**Without a phone.** `mtp-rs`'s `virtual-device` feature backs a fake device
with a local directory, and it is already a dev-dependency. The tests in
`mtp/mod.rs` (`Fake::new`, `Fake::crowded`) drive listings, byte-range reads and
the stage machine with no hardware. `plan_source` is pure and needs nothing.

**With a phone.** Unlock it and choose *File transfer* in the USB notification —
a phone in charge-only mode opens fine and reports zero storages, which is the
`AwaitingGrant` stage, not a failure.

**Looking at the result.** Render to a file and open it. A `#[test]` that writes
a PNG somewhere readable is the fastest way; that is how the grey-sliver bug was
finally caught, after a passing decode check had missed it.

## Constraints that will bite

**One connection per device, one PTP session.** All device I/O is serialised
onto a single worker thread in `mtp/mod.rs`. That is not a bottleneck to remove;
it is what the protocol requires. A slow route blocks every other device
operation behind it, which is why video does not read a head it cannot use.

**`ptpcamerad` takes the device.** macOS launches it at every PTP device and it
cannot transfer files from an Android — it holds the phone purely to deny it.
The app detects this (`Stage::Blocked`) and offers to quit it. When a probe
binary reports `ExclusiveAccess`, this is why; `pkill ptpcamerad` immediately
before running works, because it only re-claims on the next enumeration.

**No `stat` for a device object.** The thumbnail cache key is
(path, mtime, size, px) and there is nothing to stat. Listings record size and
mtime into a map that `MtpService::meta` reads, and `thumb::keyed_with` takes
them as arguments. A cache probe must never touch the bus — it runs for every
tile on screen before any work is queued.

**Android is not a USB host.** The whole module is `cfg(not(target_os =
"android"))`. Nothing here reaches the phone build.
