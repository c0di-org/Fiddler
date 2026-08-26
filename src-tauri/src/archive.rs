//! Making a zip, and taking one apart.
//!
//! Zip is the only archive format worth building in: it is what Finder's
//! Compress makes, what Android's share sheet accepts, and what arrives when a
//! download is more than one file. `tar.gz` reads on a Mac and is a mystery on
//! a phone; `7z` and `rar` are neither. So this module speaks one format in
//! both directions rather than half of several.
//!
//! It borrows `transfer.rs`'s vocabulary — `Progress`, `Stopped`, a cancel flag
//! read between chunks — because from the status bar's side compressing a
//! folder and copying it are the same event: a wait with a total, a name, and
//! a button that calls it off. What differs is what the bar should count.
//! `transfer.rs` has to choose, because a same-volume copy is a clone that
//! costs nothing per byte; here there is no such thing as a free byte. Every
//! one is read, deflated and written on the way in, and inflated and written on
//! the way out, so both directions report `by_bytes: true` and mean it.
//!
//! Bytes that will not shrink are stored rather than deflated — see
//! `already_compressed`. A JPEG through deflate is minutes of a phone's CPU
//! spent to save a fraction of a percent, and the photographs are exactly what
//! people zip.
//!
//! Coming out of an archive is the direction that needs care, because the names
//! inside one are written by whoever made it and this end has to assume they
//! are hostile. Two rules, both enforced here rather than trusted:
//!
//! - Every entry name goes through `enclosed_name`, so `../../.ssh/authorized_keys`
//!   is refused rather than followed. That is the whole of "zip slip".
//! - A symlink is only recreated when what it points at stays inside the folder
//!   being extracted into. A link to `/` is how an archive turns a later entry
//!   into a write anywhere on the disk, and it is never what a real archive of
//!   somebody's files contains.
//!
//! Both refuse the whole extraction rather than skipping the entry, because an
//! archive containing either one is broken or malicious, and quietly unpacking
//! the other 99 files of it is how someone ends up trusting the result.
//!
//! Where the extraction lands is Archive Utility's rule, and it is the right
//! one: an archive whose entries all sit under a single top-level name is
//! unpacked as that item, and one with several is given a folder named after
//! the archive to sit in. The alternative is `foo/foo/…` half the time and a
//! folder sprayed with forty loose files the other half.

use std::collections::HashSet;
use std::fs::{File, Metadata};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::transfer::{Progress, Stopped};

/// How much moves between looks at the cancel flag. Same size as the copy
/// engine's, and for the same reason: smaller reads the flag more often than
/// anyone can press it, larger makes Cancel wait.
const CHUNK: usize = 1 << 20;

/// Past this a zip needs the 64-bit header fields. The crate will do it on its
/// own once it overruns, but only if it wasn't told the size up front — and it
/// can't rewind a file it has already written, so the answer is decided before
/// the first byte instead.
const ZIP64: u64 = u32::MAX as u64;

/// What Finder's own Compress produces: one item keeps its name, several get a
/// generic one. The extension goes on the *whole* name — `report.pdf.zip` —
/// because `report.zip` would be a different file that no longer says what it
/// holds.
pub fn suggested_name(names: &[String]) -> String {
    match names {
        [only] => format!("{only}.zip"),
        _ => "Archive.zip".to_string(),
    }
}

/// Bytes that deflate cannot help. Every one of these formats is already
/// compressed — a JPEG, an MP4, an APK — and running them through deflate
/// costs the whole file's worth of CPU to save a fraction of a percent, on the
/// platform least able to spend it.
pub fn already_compressed(name: &str) -> bool {
    const DONE: &[&str] = &[
        "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "jp2",
        "mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba",
        "mp4", "m4v", "mov", "webm", "mkv", "avi", "3gp",
        "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "apk", "ipa", "jar",
        "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub",
        "woff", "woff2",
    ];
    let Some(dot) = name.rfind('.') else { return false };
    if dot == 0 {
        return false;
    }
    let ext = name[dot + 1..].to_ascii_lowercase();
    DONE.contains(&ext.as_str())
}

// ------------------------------------------------------------------ making one

/// Write `sources` into a zip at `target`, reporting as it goes.
///
/// `totals` comes from `transfer::survey`, which already counts a tree's items
/// and bytes and stops when the flag is set — the same survey a copy does, for
/// the same reason: a bar with no total is not a bar.
///
/// `target` must be a path that does not exist yet. Nothing else here would be
/// safe: an archive that is cancelled or fails part way is deleted outright,
/// and that is only a rollback if the file was this call's invention.
pub fn compress(
    sources: &[PathBuf],
    target: &Path,
    totals: (u64, u64),
    cancel: &AtomicBool,
    report: &mut dyn FnMut(&Progress),
) -> Result<(), Stopped> {
    let mut progress = Progress {
        total_items: totals.0,
        total_bytes: totals.1,
        // Nothing is cloned into an archive. Every byte is read and deflated,
        // so bytes are the honest measure of the wait.
        by_bytes: true,
        ..Progress::default()
    };

    match build(sources, target, cancel, &mut progress, report) {
        Ok(()) => Ok(()),
        Err(stopped) => {
            // A half-written zip is not a smaller zip, it is a file no reader
            // will open. Leaving one behind after a Cancel would look like the
            // archive was made.
            let _ = std::fs::remove_file(target);
            Err(stopped)
        }
    }
}

fn build(
    sources: &[PathBuf],
    target: &Path,
    cancel: &AtomicBool,
    progress: &mut Progress,
    report: &mut dyn FnMut(&Progress),
) -> Result<(), Stopped> {
    let file = File::create(target).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);

    // Two items with the same name would make two entries with one name, which
    // is an archive most readers unpack as whichever came last. A selection
    // normally comes from one folder and can't collide; a selection made from
    // search results spans the whole tree and can. Refusing is the only answer
    // that doesn't quietly lose a file.
    let mut taken: HashSet<String> = HashSet::new();

    for source in sources {
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .ok_or_else(|| Stopped::Failed("Invalid file name".to_string()))?;
        if !taken.insert(name.clone()) {
            return Err(Stopped::Failed(format!(
                "Two of these are called “{name}” — an archive can’t hold both"
            )));
        }
        add(&mut zip, source, &name, cancel, progress, report)?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Add one item under the name `entry`, and everything below it.
fn add(
    zip: &mut ZipWriter<File>,
    path: &Path,
    entry: &str,
    cancel: &AtomicBool,
    progress: &mut Progress,
    report: &mut dyn FnMut(&Progress),
) -> Result<(), Stopped> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Stopped::Cancelled);
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    progress.name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    // A link goes in as a link, before anything asks what it points at — the
    // same rule the copy engine follows, and for the same reason: following one
    // would store a second copy of the bytes, or fail outright where it points
    // at a folder. `node_modules/.bin` makes both routine.
    if metadata.file_type().is_symlink() {
        let destination = std::fs::read_link(path).map_err(|e| e.to_string())?;
        zip.add_symlink(entry, destination.to_string_lossy(), options(&metadata, false))
            .map_err(|e| e.to_string())?;
        progress.done_items += 1;
        report(progress);
        return Ok(());
    }

    if metadata.is_dir() {
        // Written even though the files below it imply it, because an empty
        // folder has no files below it to do the implying.
        zip.add_directory(entry, options(&metadata, false))
            .map_err(|e| e.to_string())?;
        progress.done_items += 1;
        report(progress);

        // Sorted rather than in `read_dir` order, which is the filesystem's
        // and arbitrary. Zipping the same folder twice should give the same
        // archive, and a reader listing it should show it the way Fiddler does.
        let mut children: Vec<PathBuf> = std::fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .map(|child| child.map(|child| child.path()))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        children.sort();

        for child in children {
            let name = child.file_name().map(|name| name.to_string_lossy().into_owned());
            let Some(name) = name else { continue };
            add(zip, &child, &format!("{entry}/{name}"), cancel, progress, report)?;
        }
        return Ok(());
    }

    let stored = already_compressed(entry);
    zip.start_file(entry, options(&metadata, !stored))
        .map_err(|e| e.to_string())?;

    let mut reader = File::open(path).map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Stopped::Cancelled);
        }
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        zip.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
        progress.done_bytes += read as u64;
        report(progress);
    }

    progress.done_items += 1;
    report(progress);
    Ok(())
}

/// Everything an entry carries besides its bytes: how to compress it, what its
/// permissions were, and when it was last written.
///
/// The timestamp is the reason `time` is a dependency at all. A zip stores an
/// MS-DOS date, `std` has no calendar to make one from a `SystemTime`, and the
/// default when nothing is set is 1980 — so an archive of today's photographs
/// would arrive at the other end dated before either platform existed. It is
/// written in UTC rather than local time, which is a few hours' skew and not
/// forty-five years': the local offset can't be read soundly from a process
/// with other threads in it, and this one always has.
fn options(metadata: &Metadata, deflate: bool) -> SimpleFileOptions {
    let mut options = SimpleFileOptions::default()
        .compression_method(if deflate {
            CompressionMethod::Deflated
        } else {
            CompressionMethod::Stored
        })
        .large_file(metadata.len() >= ZIP64);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The executable bit is the one that matters: a script that arrives
        // without it is an archive that silently didn't work. The crate keeps
        // the low nine bits and adds the file-type bits itself.
        options = options.unix_permissions(metadata.permissions().mode() & 0o777);
    }

    if let Some(when) = metadata.modified().ok().and_then(dos_time) {
        options = options.last_modified_time(when);
    }
    options
}

fn dos_time(when: std::time::SystemTime) -> Option<DateTime> {
    DateTime::try_from(time::OffsetDateTime::from(when)).ok()
}

fn system_time(when: DateTime) -> Option<std::time::SystemTime> {
    time::OffsetDateTime::try_from(when).ok().map(Into::into)
}

// --------------------------------------------------------------- opening one

/// What an archive holds, read from its central directory before a byte of it
/// is inflated. Cheap enough to ask before every extraction, which is what
/// gives the bar a total and the extraction a place to land.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contents {
    /// The single top-level name everything inside sits under, when there is
    /// one. `Some` means the archive already contains its own folder — or is a
    /// single loose file — and needs no wrapper; `None` means it would spray
    /// the destination and gets one.
    pub root: Option<String>,
    pub items: u64,
    /// Uncompressed, which is what the extraction is actually going to write.
    pub bytes: u64,
}

pub fn contents(archive: &Path) -> Result<Contents, String> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = ZipArchive::new(file).map_err(|e| readable(archive, e))?;

    let mut items = 0;
    let mut bytes = 0;
    let mut roots: HashSet<String> = HashSet::new();
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(|e| readable(archive, e))?;
        let name = entry.name().to_string();
        if junk(&name) {
            continue;
        }
        // The zip-slip check happens *here*, before extraction, and not only
        // because it is cheaper. The caller names the landing folder after the
        // root this returns, and the root of `../escaped.txt` is `..` — so an
        // archive that climbs out would have the caller name a folder outside
        // the destination, and then hand that name to a rollback whose whole
        // job is to delete it. Refusing the archive outright is the only
        // answer: it is broken or hostile either way.
        let Some(inside) = entry.enclosed_name().as_deref().map(lexical) else {
            return Err(escapes(archive, &name));
        };
        // Read off the tidied path rather than the raw name, so that `./foo/a`
        // and `foo/a` agree about what the root is — and so that what is
        // counted here is what `unpack` will actually strip. A name that tidies
        // away to nothing has no root to contribute.
        let Some(root) = inside.components().next() else { continue };
        roots.insert(root.as_os_str().to_string_lossy().into_owned());
        items += 1;
        if !entry.is_dir() {
            bytes += entry.size();
        }
    }

    let root = match roots.len() {
        1 => roots.into_iter().next(),
        _ => None,
    };
    Ok(Contents { root, items, bytes })
}

/// Unpack `archive` into `landing`, which must be a path that does not exist
/// yet — everything written goes inside it, which is what makes deleting it the
/// whole of the rollback.
///
/// `strip_root` drops the first component of every entry name, for the archive
/// that already carries its own folder: `foo/notes.md` from `foo.zip` becomes
/// `notes.md` inside a `landing` that is itself called `foo`. See `Contents`.
pub fn extract(
    archive: &Path,
    landing: &Path,
    strip_root: bool,
    totals: (u64, u64),
    cancel: &AtomicBool,
    report: &mut dyn FnMut(&Progress),
) -> Result<(), Stopped> {
    // Everything below is written inside `landing`, and if anything goes wrong
    // `landing` is deleted whole. Both of those are only safe for a path that
    // ends in a plain name this call is inventing — `file_name` is `None` for a
    // root and for anything ending in `..`, which is exactly the shape a
    // hostile archive would have talked the caller into.
    if landing.file_name().is_none() {
        return Err(Stopped::Failed(format!(
            "{} is not somewhere Fiddler will unpack an archive",
            landing.display()
        )));
    }

    let mut progress = Progress {
        total_items: totals.0,
        total_bytes: totals.1,
        by_bytes: true,
        ..Progress::default()
    };

    match unpack(archive, landing, strip_root, cancel, &mut progress, report) {
        Ok(()) => Ok(()),
        Err(stopped) => {
            undo(landing);
            Err(stopped)
        }
    }
}

/// Take back what a stopped extraction had written. Failures are swallowed on
/// purpose: something has already gone wrong, and a second message about the
/// cleanup would bury the first one about the cause.
fn undo(landing: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(landing) else {
        return;
    };
    let _ = if metadata.is_dir() {
        std::fs::remove_dir_all(landing)
    } else {
        std::fs::remove_file(landing)
    };
}

fn unpack(
    archive: &Path,
    landing: &Path,
    strip_root: bool,
    cancel: &AtomicBool,
    progress: &mut Progress,
    report: &mut dyn FnMut(&Progress),
) -> Result<(), Stopped> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = ZipArchive::new(file).map_err(|e| readable(archive, e))?;

    for index in 0..zip.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err(Stopped::Cancelled);
        }
        let mut entry = zip.by_index(index).map_err(|e| readable(archive, e))?;
        let name = entry.name().to_string();
        if junk(&name) {
            continue;
        }

        // The zip-slip check, and the only place this trusts the archive with a
        // path at all: `enclosed_name` returns nothing for an absolute path, a
        // drive letter, or one that climbs out with `..`.
        // `enclosed_name` is the refusal; `lexical` is what makes the path this
        // end works with the same one `contents` counted — `./a`, `a/./b` and
        // `a/b/../c` all come out written the one way, and every component that
        // is left is a plain name.
        let inside = entry
            .enclosed_name()
            .as_deref()
            .map(lexical)
            .ok_or_else(|| Stopped::Failed(escapes(archive, &name)))?;
        let relative = if strip_root { below_root(&inside) } else { inside };
        let target = if relative.as_os_str().is_empty() {
            landing.to_path_buf()
        } else {
            landing.join(&relative)
        };

        progress.name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();

        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            progress.done_items += 1;
            report(progress);
            continue;
        }

        // A zip does not have to list a folder before the files in it, and
        // plenty made by other tools don't list folders at all.
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        if entry.is_symlink() {
            let mut destination = String::new();
            entry.read_to_string(&mut destination).map_err(|e| e.to_string())?;
            if !stays_inside(&target, &destination, landing) {
                return Err(Stopped::Failed(format!(
                    "“{}” holds a link pointing outside the folder ({name} → {destination})",
                    display(archive)
                )));
            }
            link(&destination, &target)?;
            progress.done_items += 1;
            report(progress);
            continue;
        }

        let mut writer = File::create(&target).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; CHUNK];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(Stopped::Cancelled);
            }
            let read = entry.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
            progress.done_bytes += read as u64;
            report(progress);
        }

        // Both best-effort, and deliberately so. FAT and exFAT — the SD card
        // and the USB stick, which is exactly where a phone puts a big archive
        // — have neither a mode nor a way to be told one, and failing here
        // after every byte arrived would roll back a finished extraction over a
        // bit the filesystem cannot store.
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            // The low nine bits and no more. Everything above them is the file
            // type and the setuid bits, and an archive that arrived from
            // somewhere else does not get to set the second of those on a file
            // it is putting on this disk.
            let _ = writer.set_permissions(std::fs::Permissions::from_mode(mode & 0o777));
        }
        if let Some(when) = entry.last_modified().and_then(system_time) {
            let _ = writer.set_modified(when);
        }

        progress.done_items += 1;
        report(progress);
    }
    Ok(())
}

fn link(destination: &str, target: &Path) -> Result<(), Stopped> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(destination, target).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (destination, target);
        Err(Stopped::Failed("Links can’t be extracted here".to_string()))
    }
}

// ------------------------------------------------------------------ the rules

/// Everything below the first component: `foo/bar/baz.txt` → `bar/baz.txt`, and
/// `foo` (the folder entry itself) → nothing, which is the landing folder.
/// Reads the same components `contents` counted the root from.
fn below_root(relative: &Path) -> PathBuf {
    let mut parts = relative.components();
    parts.next();
    parts.as_path().to_path_buf()
}

/// macOS's bookkeeping, which every zip made in Finder carries: resource forks
/// and Finder info, under a folder nobody wants extracted. Skipped rather than
/// unpacked — and skipped *before* the roots are counted, or a perfectly
/// ordinary one-folder archive would look like it had two and get a wrapper it
/// doesn't need.
fn junk(name: &str) -> bool {
    name == "__MACOSX" || name.starts_with("__MACOSX/")
}

/// Whether a link at `at`, pointing at `destination`, still lands inside
/// `root`. Resolved textually rather than with the filesystem, because nothing
/// it names exists yet — and because the question is about what the *archive*
/// says, not about what happens to be on the disk.
fn stays_inside(at: &Path, destination: &str, root: &Path) -> bool {
    let pointed = Path::new(destination);
    let candidate = if pointed.is_absolute() {
        pointed.to_path_buf()
    } else {
        at.parent().unwrap_or(root).join(pointed)
    };
    lexical(&candidate).starts_with(lexical(root))
}

/// `..` and `.` removed by reading, not by asking the filesystem.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The one refusal both ends of the zip-slip check share.
fn escapes(archive: &Path, name: &str) -> String {
    format!(
        "“{}” holds an item that would be written outside the folder ({name})",
        display(archive)
    )
}

/// What went wrong with an archive, said in terms of the archive. The crate's
/// own errors are about central directories and magic numbers.
fn readable(archive: &Path, error: zip::result::ZipError) -> String {
    match error {
        zip::result::ZipError::FileNotFound => format!("“{}” is missing", display(archive)),
        zip::result::ZipError::UnsupportedArchive(why) => {
            format!("Fiddler can’t open “{}”: {why}", display(archive))
        }
        zip::result::ZipError::InvalidArchive(why) => {
            format!("“{}” isn’t a zip Fiddler can read: {why}", display(archive))
        }
        other => format!("Couldn’t read “{}”: {other}", display(archive)),
    }
}

fn display(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fiddler-zip-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tree(root: &Path) {
        std::fs::create_dir_all(root.join("inner")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join("a.txt"), "aaaa").unwrap();
        std::fs::write(root.join("inner/b.txt"), "bb").unwrap();
    }

    fn quiet() -> impl FnMut(&Progress) {
        |_: &Progress| {}
    }

    fn zip_up(sources: &[PathBuf], target: &Path) -> Vec<Progress> {
        let cancel = AtomicBool::new(false);
        let totals = crate::transfer::survey(sources, &cancel).unwrap();
        let mut seen = Vec::new();
        compress(sources, target, totals, &cancel, &mut |p| seen.push(p.clone())).unwrap();
        seen
    }

    fn unzip(archive: &Path, landing: &Path) {
        let held = contents(archive).unwrap();
        let cancel = AtomicBool::new(false);
        extract(
            archive,
            landing,
            held.root.is_some(),
            (held.items, held.bytes),
            &cancel,
            &mut quiet(),
        )
        .unwrap();
    }

    #[test]
    fn one_item_keeps_its_name_and_several_share_one() {
        assert_eq!(suggested_name(&["report.pdf".to_string()]), "report.pdf.zip");
        assert_eq!(suggested_name(&["Photos".to_string()]), "Photos.zip");
        assert_eq!(
            suggested_name(&["a.txt".to_string(), "b.txt".to_string()]),
            "Archive.zip"
        );
    }

    #[test]
    fn bytes_that_will_not_shrink_are_not_squeezed() {
        assert!(already_compressed("holiday.JPG"));
        assert!(already_compressed("clip.mp4"));
        assert!(already_compressed("inner.zip"));
        assert!(!already_compressed("notes.txt"));
        assert!(!already_compressed("Makefile"));
        // A dotfile's leading dot is not an extension.
        assert!(!already_compressed(".gitignore"));
    }

    #[test]
    fn a_folder_survives_the_round_trip_whole() {
        let dir = scratch("round-trip");
        let src = dir.join("Notes");
        tree(&src);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(src.join("run.sh"), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(src.join("run.sh"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        let archive = dir.join("Notes.zip");
        zip_up(&[src.clone()], &archive);

        // One top-level name, so it needs no wrapper of its own.
        let held = contents(&archive).unwrap();
        assert_eq!(held.root.as_deref(), Some("Notes"));

        let landing = dir.join("out");
        unzip(&archive, &landing);

        assert_eq!(std::fs::read_to_string(landing.join("a.txt")).unwrap(), "aaaa");
        assert_eq!(std::fs::read_to_string(landing.join("inner/b.txt")).unwrap(), "bb");
        // An empty folder has no files to imply it, so it is written outright.
        assert!(landing.join("empty").is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(landing.join("run.sh")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "the executable bit did not survive");
        }
    }

    #[test]
    fn what_was_written_today_is_not_dated_1980() {
        let dir = scratch("dates");
        let file = dir.join("a.txt");
        std::fs::write(&file, "aaaa").unwrap();
        let before = std::fs::metadata(&file).unwrap().modified().unwrap();

        let archive = dir.join("a.txt.zip");
        zip_up(&[file], &archive);
        let landing = dir.join("out.txt");
        unzip(&archive, &landing);

        let after = std::fs::metadata(&landing).unwrap().modified().unwrap();
        // MS-DOS timestamps count in two-second steps, so this is as close as
        // the format can carry.
        let drift = after.duration_since(before).unwrap_or_else(|e| e.duration());
        assert!(drift.as_secs() <= 2, "the timestamp drifted by {drift:?}");
    }

    #[test]
    fn several_loose_items_are_given_a_folder_and_one_is_not() {
        let dir = scratch("landing");
        std::fs::write(dir.join("a.txt"), "aaaa").unwrap();
        std::fs::write(dir.join("b.txt"), "bb").unwrap();

        let many = dir.join("Archive.zip");
        zip_up(&[dir.join("a.txt"), dir.join("b.txt")], &many);
        assert_eq!(contents(&many).unwrap().root, None);

        let one = dir.join("a.txt.zip");
        zip_up(&[dir.join("a.txt")], &one);
        assert_eq!(contents(&one).unwrap().root.as_deref(), Some("a.txt"));

        // The single-root case with the root stripped lands as the item itself
        // rather than as a folder holding it.
        let landing = dir.join("just-a.txt");
        unzip(&one, &landing);
        assert_eq!(std::fs::read_to_string(&landing).unwrap(), "aaaa");
    }

    #[test]
    fn the_survey_and_the_bar_agree_about_the_work() {
        let dir = scratch("progress");
        let src = dir.join("Notes");
        tree(&src);
        let archive = dir.join("Notes.zip");

        let seen = zip_up(&[src], &archive);
        let last = seen.last().unwrap();
        assert_eq!(last.done_items, last.total_items);
        assert_eq!(last.done_bytes, last.total_bytes);
        assert!(seen.iter().all(|p| p.by_bytes), "an archive has no free bytes");
        assert!(seen
            .iter()
            .all(|p| p.done_items <= p.total_items && p.done_bytes <= p.total_bytes));

        // And the other direction reports against what the archive says it holds.
        let held = contents(&archive).unwrap();
        assert_eq!(held.bytes, 6);
        let cancel = AtomicBool::new(false);
        let mut out = Vec::new();
        extract(
            &archive,
            &dir.join("out"),
            true,
            (held.items, held.bytes),
            &cancel,
            &mut |p| out.push(p.clone()),
        )
        .unwrap();
        let last = out.last().unwrap();
        assert_eq!(last.done_bytes, held.bytes);
    }

    #[test]
    fn a_cancelled_archive_is_not_left_half_written() {
        let dir = scratch("cancel-zip");
        let src = dir.join("Notes");
        tree(&src);
        let archive = dir.join("Notes.zip");

        let cancel = AtomicBool::new(false);
        let totals = crate::transfer::survey(&[src.clone()], &cancel).unwrap();
        let result = compress(&[src], &archive, totals, &cancel, &mut |_| {
            cancel.store(true, Ordering::Relaxed);
        });

        assert!(matches!(result, Err(Stopped::Cancelled)));
        assert!(!archive.exists(), "a cancelled compress left {archive:?} behind");
    }

    #[test]
    fn a_cancelled_extraction_takes_back_everything_it_wrote() {
        let dir = scratch("cancel-unzip");
        let src = dir.join("Notes");
        tree(&src);
        let archive = dir.join("Notes.zip");
        zip_up(&[src], &archive);

        let landing = dir.join("out");
        let held = contents(&archive).unwrap();
        let cancel = AtomicBool::new(false);
        let result = extract(
            &archive,
            &landing,
            true,
            (held.items, held.bytes),
            &cancel,
            &mut |_| cancel.store(true, Ordering::Relaxed),
        );

        assert!(matches!(result, Err(Stopped::Cancelled)));
        assert!(!landing.exists(), "a cancelled extraction left {landing:?} behind");
        // And the archive it was reading is untouched, so it can be tried again.
        assert!(archive.exists());
    }

    #[test]
    fn finders_own_bookkeeping_is_left_in_the_archive() {
        let dir = scratch("macosx");
        let archive = dir.join("Made by Finder.zip");
        {
            let mut zip = ZipWriter::new(File::create(&archive).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file("Notes/a.txt", plain).unwrap();
            zip.write_all(b"aaaa").unwrap();
            zip.start_file("__MACOSX/Notes/._a.txt", plain).unwrap();
            zip.write_all(b"\x00\x05\x16\x07").unwrap();
            zip.finish().unwrap();
        }

        // Two top-level names in the file, one that counts — so this is a
        // single-root archive and gets no wrapper.
        let held = contents(&archive).unwrap();
        assert_eq!(held.root.as_deref(), Some("Notes"));
        assert_eq!(held.items, 1);

        let landing = dir.join("Notes");
        unzip(&archive, &landing);
        assert_eq!(std::fs::read_to_string(landing.join("a.txt")).unwrap(), "aaaa");
        assert!(!dir.join("__MACOSX").exists());
        assert!(!landing.join("__MACOSX").exists());
    }

    #[test]
    fn an_entry_that_climbs_out_of_the_folder_is_refused() {
        let dir = scratch("slip");
        let archive = dir.join("evil.zip");
        {
            let mut zip = ZipWriter::new(File::create(&archive).unwrap());
            zip.start_file("../escaped.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"pwned").unwrap();
            zip.finish().unwrap();
        }

        // Refused before it is opened, which is the check that matters: the
        // top-level name of `../escaped.txt` is `..`, and a caller that named
        // its landing folder after that would be naming the *parent* of the
        // folder it meant — and then handing that name to the rollback.
        assert!(contents(&archive).is_err());

        let landing = dir.join("out");
        let cancel = AtomicBool::new(false);
        let result = extract(&archive, &landing, false, (1, 5), &cancel, &mut quiet());

        assert!(matches!(result, Err(Stopped::Failed(_))));
        assert!(!dir.join("escaped.txt").exists(), "zip slip wrote outside the folder");
        assert!(!landing.exists());
    }

    #[test]
    fn a_name_written_the_long_way_round_finds_the_same_root() {
        let dir = scratch("dotted");
        let archive = dir.join("dotted.zip");
        {
            let mut zip = ZipWriter::new(File::create(&archive).unwrap());
            // What a converter or a hand-rolled writer produces, and what a
            // naive read of the first component would call a root of ".".
            zip.start_file("./Notes/a.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"aaaa").unwrap();
            zip.finish().unwrap();
        }

        let held = contents(&archive).unwrap();
        assert_eq!(held.root.as_deref(), Some("Notes"));

        let landing = dir.join("out");
        unzip(&archive, &landing);
        assert_eq!(std::fs::read_to_string(landing.join("a.txt")).unwrap(), "aaaa");
    }

    #[test]
    fn a_name_that_climbs_and_comes_back_lands_where_it_resolves() {
        let dir = scratch("climbs");
        let archive = dir.join("odd.zip");
        {
            let mut zip = ZipWriter::new(File::create(&archive).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file("Notes/a.txt", plain).unwrap();
            zip.write_all(b"aaaa").unwrap();
            // Legal — it resolves to `b.txt`, inside the folder — but it is not
            // under `Notes`, so this archive has two roots and gets a wrapper.
            // Written the long way, stripping "Notes" would have left `../b.txt`
            // and put the file beside the folder it was meant to be in.
            zip.start_file("Notes/../b.txt", plain).unwrap();
            zip.write_all(b"bb").unwrap();
            zip.finish().unwrap();
        }

        let held = contents(&archive).unwrap();
        assert_eq!(held.root, None);

        let landing = dir.join("out");
        unzip(&archive, &landing);
        assert_eq!(std::fs::read_to_string(landing.join("Notes/a.txt")).unwrap(), "aaaa");
        assert_eq!(std::fs::read_to_string(landing.join("b.txt")).unwrap(), "bb");
        assert!(!dir.join("b.txt").exists(), "an entry landed outside the folder");
    }

    #[test]
    fn nothing_is_unpacked_into_a_path_that_is_not_a_name() {
        let dir = scratch("landing-guard");
        let src = dir.join("Notes");
        tree(&src);
        let archive = dir.join("Notes.zip");
        zip_up(&[src.clone()], &archive);

        // The shape a hostile archive would try to talk a caller into: a
        // landing path that resolves to somewhere that already exists and is
        // full of somebody's files. It is refused before anything is written,
        // and — the point of the guard — before the rollback could delete it.
        let cancel = AtomicBool::new(false);
        let result = extract(
            &archive,
            &dir.join("out").join(".."),
            true,
            (4, 6),
            &cancel,
            &mut quiet(),
        );

        assert!(matches!(result, Err(Stopped::Failed(_))));
        assert!(dir.exists(), "the guard let a rollback reach the folder above");
        assert!(src.join("a.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_the_folder_survives_and_one_pointing_out_is_refused() {
        let dir = scratch("links");
        let src = dir.join("Notes");
        tree(&src);
        std::os::unix::fs::symlink("inner", src.join("to-inner")).unwrap();
        let archive = dir.join("Notes.zip");
        zip_up(&[src], &archive);

        let landing = dir.join("out");
        unzip(&archive, &landing);
        assert_eq!(
            std::fs::read_link(landing.join("to-inner")).unwrap(),
            PathBuf::from("inner")
        );
        assert_eq!(std::fs::read_to_string(landing.join("to-inner/b.txt")).unwrap(), "bb");

        // The other kind: a link out of the folder is how an archive turns a
        // later entry into a write anywhere on the disk.
        let hostile = dir.join("hostile.zip");
        {
            let mut zip = ZipWriter::new(File::create(&hostile).unwrap());
            zip.add_symlink("out", "../../etc", SimpleFileOptions::default()).unwrap();
            zip.finish().unwrap();
        }
        let cancel = AtomicBool::new(false);
        let refused = extract(&hostile, &dir.join("hostile"), false, (1, 0), &cancel, &mut quiet());
        assert!(matches!(refused, Err(Stopped::Failed(_))));
        assert!(!dir.join("hostile").exists());
    }

    #[test]
    fn where_a_link_lands_is_decided_by_reading_it() {
        let root = Path::new("/tmp/out");
        // Beside itself, and below itself.
        assert!(stays_inside(&root.join("a"), "b", root));
        assert!(stays_inside(&root.join("deep/a"), "../b", root));
        // Out of the top, out by an absolute path, and out through the parent.
        assert!(!stays_inside(&root.join("a"), "../b", root));
        assert!(!stays_inside(&root.join("a"), "/etc/passwd", root));
        assert!(!stays_inside(&root.join("deep/a"), "../../../b", root));
    }

    #[test]
    fn two_items_of_the_same_name_are_refused_rather_than_merged() {
        let dir = scratch("clash");
        std::fs::create_dir_all(dir.join("one")).unwrap();
        std::fs::create_dir_all(dir.join("two")).unwrap();
        std::fs::write(dir.join("one/notes.md"), "first").unwrap();
        std::fs::write(dir.join("two/notes.md"), "second").unwrap();

        let archive = dir.join("Archive.zip");
        let cancel = AtomicBool::new(false);
        let sources = vec![dir.join("one/notes.md"), dir.join("two/notes.md")];
        let totals = crate::transfer::survey(&sources, &cancel).unwrap();
        let result = compress(&sources, &archive, totals, &cancel, &mut quiet());

        assert!(matches!(result, Err(Stopped::Failed(_))));
        assert!(!archive.exists());
    }

    #[test]
    fn something_that_is_not_an_archive_says_so_in_its_own_terms() {
        let dir = scratch("not-a-zip");
        let file = dir.join("photo.zip");
        std::fs::write(&file, "this is not a zip at all").unwrap();

        let error = contents(&file).unwrap_err();
        assert!(error.contains("photo.zip"), "{error}");
        assert!(!error.contains("central directory"), "{error}");
    }
}
