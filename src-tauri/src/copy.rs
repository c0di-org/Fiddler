//! Copying, with a way to watch it and a way to stop it.
//!
//! `std::fs::copy` is the right primitive and this does not replace it. On APFS
//! it lands on `fclonefileat`, which makes a same-volume copy of forty
//! gigabytes near-instant however many bytes are nominally involved — a chunked
//! read/write loop would trade that away for progress nobody would live long
//! enough to read. So the loop is kept for the one case that is genuinely slow:
//! a large file arriving on a *different* volume, where there is no clone to be
//! had and every byte really does travel. `strategy` is where that is decided.
//!
//! Cancelling is a flag rather than a killed thread, checked between files and,
//! in the chunked path, between chunks. What makes it a cancel rather than a
//! stop is the rollback: every target here is a path `copy_name` invented a
//! moment ago, so removing them can't touch anything that was already there.
//! Without that, pressing Cancel on a half-finished paste would leave a mess
//! that only the person who pressed it could untangle.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// How much a chunked copy moves before it looks up to see if it should stop.
const CHUNK: usize = 1 << 20;

/// Below this, a file is copied in one call even across volumes. The check
/// costs a syscall and the interruption it buys is shorter than the pause
/// between two frames.
const CHUNKED_MIN: u64 = 8 << 20;

/// What the caller learns as the copy runs. Sizes are bytes; `name` is whatever
/// is being copied at that moment, which is the part a person actually reads.
#[derive(Debug, Clone, Default)]
pub struct Progress {
    pub done_items: u64,
    pub total_items: u64,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub name: String,
}

/// Told apart from an error because the person asked for it: nothing went
/// wrong, and nothing should be reported as though it had.
#[derive(Debug)]
pub enum Stopped {
    Cancelled,
    Failed(String),
}

impl From<String> for Stopped {
    fn from(message: String) -> Self {
        Stopped::Failed(message)
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Strategy {
    /// One call, and the platform does whatever it can — including not copying
    /// the bytes at all.
    Whole,
    /// Read and write in chunks so the flag gets looked at on the way.
    Chunked,
}

/// The one decision that trades interruptibility against the clone. Pure, so
/// the rule can be read and tested without a second volume to hand.
pub fn strategy(same_volume: bool, len: u64) -> Strategy {
    if same_volume || len < CHUNKED_MIN {
        Strategy::Whole
    } else {
        Strategy::Chunked
    }
}

/// What a copy is going to cost, walked before any of it happens.
///
/// This means reading the tree twice, which is worth saying out loud. The
/// alternative is a bar that fills to an unknown total, which is not a bar; and
/// the survey is metadata only, so it is a small fraction of the copy it is
/// describing — including the clone case, where it is a small fraction of very
/// little.
pub fn survey(sources: &[PathBuf], cancel: &AtomicBool) -> Result<(u64, u64), Stopped> {
    let mut items = 0;
    let mut bytes = 0;
    for source in sources {
        walk(source, cancel, &mut items, &mut bytes)?;
    }
    Ok((items, bytes))
}

fn walk(path: &Path, cancel: &AtomicBool, items: &mut u64, bytes: &mut u64) -> Result<(), Stopped> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Stopped::Cancelled);
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    *items += 1;
    if metadata.is_dir() {
        for child in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            walk(&child.path(), cancel, items, bytes)?;
        }
    } else {
        *bytes += metadata.len();
    }
    Ok(())
}

/// Copy `plan`'s pairs, reporting as it goes, and leave nothing behind if it
/// doesn't finish. `plan` is `(source, target)`, and every target must be a
/// path that does not yet exist — the rollback deletes them outright.
pub fn run(
    plan: &[(PathBuf, PathBuf)],
    totals: (u64, u64),
    cancel: &AtomicBool,
    report: &mut dyn FnMut(&Progress),
) -> Result<Vec<String>, Stopped> {
    let mut progress = Progress {
        total_items: totals.0,
        total_bytes: totals.1,
        ..Progress::default()
    };
    let mut done = Vec::new();

    for (source, target) in plan {
        // Asked once per top-level item rather than per file: a volume can't
        // change under a copy, and the answer decides every file below it.
        let same = same_volume(source, target.parent().unwrap_or(target));
        match copy_tree(source, target, same, cancel, &mut progress, report) {
            Ok(()) => done.push(target.to_string_lossy().into_owned()),
            Err(stopped) => {
                // The failed item's own partial tree is included, because the
                // path it was building is in `plan` whether or not it got far.
                rollback(plan);
                return Err(stopped);
            }
        }
    }
    Ok(done)
}

/// Undo what this copy made. Failures are swallowed on purpose: this runs while
/// something has already gone wrong, and a second message about the cleanup
/// would bury the first one about the cause.
fn rollback(plan: &[(PathBuf, PathBuf)]) {
    for (_, target) in plan {
        let Ok(metadata) = std::fs::symlink_metadata(target) else {
            continue;
        };
        let _ = if metadata.is_dir() {
            std::fs::remove_dir_all(target)
        } else {
            std::fs::remove_file(target)
        };
    }
}

fn copy_tree(
    source: &Path,
    target: &Path,
    same_volume: bool,
    cancel: &AtomicBool,
    progress: &mut Progress,
    report: &mut dyn FnMut(&Progress),
) -> Result<(), Stopped> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Stopped::Cancelled);
    }
    let metadata = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;

    progress.name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    if metadata.is_dir() {
        std::fs::create_dir(target).map_err(|e| e.to_string())?;
        progress.done_items += 1;
        report(progress);
        for child in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            copy_tree(
                &child.path(),
                &target.join(child.file_name()),
                same_volume,
                cancel,
                progress,
                report,
            )?;
        }
        return Ok(());
    }

    match strategy(same_volume, metadata.len()) {
        Strategy::Whole => {
            std::fs::copy(source, target).map_err(|e| e.to_string())?;
            progress.done_bytes += metadata.len();
        }
        Strategy::Chunked => copy_chunked(source, target, cancel, progress, report)?,
    }
    progress.done_items += 1;
    report(progress);
    Ok(())
}

/// The interruptible path. `std::fs::copy` carries permissions across on its
/// own; done by hand here, because a script that arrives without its executable
/// bit is a copy that silently didn't work.
fn copy_chunked(
    source: &Path,
    target: &Path,
    cancel: &AtomicBool,
    progress: &mut Progress,
    report: &mut dyn FnMut(&Progress),
) -> Result<(), Stopped> {
    let mut reader = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut writer = std::fs::File::create(target).map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; CHUNK];

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Stopped::Cancelled);
        }
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
        progress.done_bytes += read as u64;
        report(progress);
    }

    let permissions = reader
        .metadata()
        .map_err(|e| e.to_string())?
        .permissions();
    writer.set_permissions(permissions).map_err(|e| e.to_string())?;
    Ok(())
}

/// Same filesystem, and therefore a candidate for a clone rather than a copy.
/// Unknown counts as "not the same": guessing wrong that way costs a slower
/// copy, and guessing wrong the other way costs a copy that can't be stopped.
fn same_volume(source: &Path, destination: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (
            std::fs::metadata(source).map(|m| m.dev()),
            std::fs::metadata(destination).map(|m| m.dev()),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (source, destination);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fiddler-copy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tree(root: &Path) {
        std::fs::create_dir_all(root.join("inner")).unwrap();
        std::fs::write(root.join("a.txt"), "aaaa").unwrap();
        std::fs::write(root.join("inner/b.txt"), "bb").unwrap();
    }

    #[test]
    fn a_clone_is_preferred_until_the_bytes_have_to_travel() {
        // The whole point of the rule: same volume never chunks, however big.
        assert_eq!(strategy(true, 40 << 30), Strategy::Whole);
        // Small enough that stopping early would save nothing worth having.
        assert_eq!(strategy(false, CHUNKED_MIN - 1), Strategy::Whole);
        assert_eq!(strategy(false, CHUNKED_MIN), Strategy::Chunked);
    }

    #[test]
    fn the_survey_counts_every_item_and_every_byte() {
        let dir = scratch("survey");
        let src = dir.join("src");
        tree(&src);

        let (items, bytes) = survey(&[src], &AtomicBool::new(false)).unwrap();
        // The folder, a.txt, inner, inner/b.txt.
        assert_eq!(items, 4);
        assert_eq!(bytes, 6);
    }

    #[test]
    fn a_copy_reports_its_way_to_the_total_it_promised() {
        let dir = scratch("progress");
        let src = dir.join("src");
        tree(&src);
        let dst = dir.join("dst");

        let cancel = AtomicBool::new(false);
        let totals = survey(&[src.clone()], &cancel).unwrap();
        let mut seen: Vec<(u64, u64)> = Vec::new();
        let done = run(
            &[(src, dst.clone())],
            totals,
            &cancel,
            &mut |p| seen.push((p.done_items, p.done_bytes)),
        )
        .unwrap();

        assert_eq!(done, vec![dst.to_string_lossy().into_owned()]);
        assert_eq!(seen.last().copied(), Some(totals));
        // Never claims to have done more than it said it would.
        assert!(seen.iter().all(|(items, bytes)| *items <= totals.0 && *bytes <= totals.1));
        assert_eq!(std::fs::read_to_string(dst.join("inner/b.txt")).unwrap(), "bb");
    }

    #[test]
    fn cancelling_takes_back_what_it_had_already_written() {
        let dir = scratch("cancel");
        let src = dir.join("src");
        tree(&src);
        let dst = dir.join("dst");

        let cancel = AtomicBool::new(false);
        let totals = survey(&[src.clone()], &cancel).unwrap();
        // Stop the moment anything has landed, which is what pressing Cancel
        // part-way through amounts to.
        let result = run(&[(src, dst.clone())], totals, &cancel, &mut |_| {
            cancel.store(true, Ordering::Relaxed);
        });

        assert!(matches!(result, Err(Stopped::Cancelled)));
        assert!(!dst.exists(), "a cancelled copy left {dst:?} behind");
    }

    #[test]
    fn a_failure_part_way_leaves_nothing_half_copied() {
        let dir = scratch("failure");
        let good = dir.join("good");
        tree(&good);
        let missing = dir.join("gone");
        let dst = dir.join("dst");
        std::fs::create_dir(&dst).unwrap();

        let cancel = AtomicBool::new(false);
        // The second item can't be read, and by then the first has fully landed.
        let plan = vec![
            (good, dst.join("good")),
            (missing, dst.join("gone")),
        ];
        let result = run(&plan, (5, 6), &cancel, &mut |_| {});

        assert!(matches!(result, Err(Stopped::Failed(_))));
        assert!(!dst.join("good").exists(), "the item that succeeded was left behind");
        assert!(!dst.join("gone").exists());
    }

    #[test]
    fn a_chunked_copy_carries_the_bytes_and_the_permissions() {
        let dir = scratch("chunked");
        let src = dir.join("big.bin");
        let payload: Vec<u8> = (0..(CHUNK * 2 + 7)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &payload).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dst = dir.join("big-copy.bin");

        let mut progress = Progress::default();
        copy_chunked(&src, &dst, &AtomicBool::new(false), &mut progress, &mut |_| {}).unwrap();

        assert_eq!(std::fs::read(&dst).unwrap(), payload);
        assert_eq!(progress.done_bytes, payload.len() as u64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dst).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
    }

    #[test]
    fn a_chunked_copy_stops_between_chunks_rather_than_at_the_end() {
        let dir = scratch("chunked-cancel");
        let src = dir.join("big.bin");
        std::fs::write(&src, vec![7u8; CHUNK * 4]).unwrap();
        let dst = dir.join("big-copy.bin");

        let cancel = AtomicBool::new(false);
        let mut progress = Progress::default();
        let result = copy_chunked(&src, &dst, &cancel, &mut progress, &mut |_| {
            cancel.store(true, Ordering::Relaxed);
        });

        assert!(matches!(result, Err(Stopped::Cancelled)));
        // One chunk in, not four: the flag is read on the way through.
        assert_eq!(progress.done_bytes, CHUNK as u64);
    }
}
