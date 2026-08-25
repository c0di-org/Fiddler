//! Carrying bytes from one place to another, with a way to watch it and a way
//! to stop it. Used by a paste, by a drop, and by the one kind of move that is
//! not an entry rewrite — across volumes, where a move really is a copy.
//!
//! `std::fs::copy` is the right primitive and this does not replace it. On APFS
//! it lands on `fclonefileat`, which makes a same-volume copy of forty
//! gigabytes near-instant however many bytes are nominally involved — a chunked
//! read/write loop would trade that away for progress nobody would live long
//! enough to read. So the loop is kept for the one case that is genuinely slow:
//! a large file arriving on a *different* volume, where there is no clone to be
//! had and every byte really does travel. `strategy` is where that is decided.
//!
//! That same fact decides what the progress bar should count, which is not a
//! matter of taste. A clone costs a syscall per file and no time per byte, so on
//! one volume the wait tracks the *number* of files and a byte bar would lurch;
//! across volumes every byte travels, so the wait tracks *bytes* and a file bar
//! would stall through one big file. `by_bytes` carries that answer out to the
//! status bar rather than leaving it to guess.
//!
//! Cancelling is a flag rather than a killed thread, checked between files and,
//! in the chunked path, between chunks. What makes it a cancel rather than a
//! stop is the rollback: every target here is a path invented a moment ago by
//! the caller, so removing them can't touch anything that was already there —
//! and in a move, can't touch the originals, which is what lets a cancelled
//! move leave everything exactly where it was.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// How much a chunked copy moves before it looks up to see if it should stop.
const CHUNK: usize = 1 << 20;

/// Below this, a file is copied in one call even across volumes. The check
/// costs a syscall and the interruption it buys is shorter than the pause
/// between two frames.
const CHUNKED_MIN: u64 = 8 << 20;

/// What the caller learns as the transfer runs. Sizes are bytes; `name` is
/// whatever is moving at that moment, which is the part a person actually reads.
#[derive(Debug, Clone, Default)]
pub struct Progress {
    pub done_items: u64,
    pub total_items: u64,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub name: String,
    /// Which pair of numbers the bar should follow — see the module note. Both
    /// are always reported; this only says which one is the honest one here.
    pub by_bytes: bool,
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
    } else if !metadata.file_type().is_symlink() {
        // A link contributes no bytes: the copy recreates it rather than
        // moving what it points at, and counting the link text would leave
        // the bar promising bytes the transfer never sends.
        *bytes += metadata.len();
    }
    Ok(())
}

/// Recreate `source`'s link at `target`, pointing at the same place — relative
/// stays relative, absolute stays absolute, exactly as written.
fn copy_link(source: &Path, target: &Path) -> Result<(), Stopped> {
    let destination = std::fs::read_link(source).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&destination, target).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = destination;
        Err(Stopped::Failed(format!(
            "can’t copy the link {}",
            source.display()
        )))
    }
}

/// Whether any pair in `plan` has to cross volumes, which is what makes the
/// wait about bytes rather than about files. One crossing item is enough: it
/// will dominate everything the clones do around it.
pub fn crosses_volumes(plan: &[(PathBuf, PathBuf)]) -> bool {
    plan.iter()
        .any(|(source, target)| !same_volume(source, target.parent().unwrap_or(target)))
}

/// Copy `plan`'s pairs, reporting as it goes, and leave nothing behind if it
/// doesn't finish. `plan` is `(source, target)`, and every target must be a
/// path that does not yet exist — the rollback deletes them outright, and
/// nothing else.
pub fn run(
    plan: &[(PathBuf, PathBuf)],
    totals: (u64, u64),
    cancel: &AtomicBool,
    report: &mut dyn FnMut(&Progress),
) -> Result<Vec<String>, Stopped> {
    // Asked once per top-level item rather than per file: a volume can't change
    // under a transfer, and the answer decides every file below it.
    let same: Vec<bool> = plan
        .iter()
        .map(|(source, target)| same_volume(source, target.parent().unwrap_or(target)))
        .collect();

    let mut progress = Progress {
        total_items: totals.0,
        total_bytes: totals.1,
        // Settled before the first file so the bar never changes its mind about
        // what it is measuring half way along.
        by_bytes: same.iter().any(|one| !one),
        ..Progress::default()
    };
    let mut done = Vec::new();

    for ((source, target), same) in plan.iter().zip(same) {
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

/// Undo what this transfer made. Failures are swallowed on purpose: this runs while
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

    // A link is copied as a link, before anything asks what it points at.
    // `std::fs::copy` would follow it: a link to a directory fails the whole
    // transfer — after everything before it copied, so the rollback throws
    // that work away — and a link to a file quietly materializes as a second
    // copy of the bytes. `node_modules/.bin` alone makes both routine.
    if metadata.file_type().is_symlink() {
        copy_link(source, target)?;
        progress.done_items += 1;
        report(progress);
        return Ok(());
    }

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
    // Best-effort, deliberately: FAT and exFAT — exactly where files this big
    // land on Android, the SD card and the USB stick — refuse chmod, and
    // failing here after every byte arrived would roll back a finished copy
    // over a bit the filesystem cannot store.
    let _ = writer.set_permissions(permissions);
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
    fn a_cancelled_transfer_never_touches_the_source() {
        let dir = scratch("sources");
        let src = dir.join("src");
        tree(&src);
        let dst = dir.join("dst");

        // The half of a move that this module is responsible for. `move_paths`
        // deletes the originals only after a whole run comes back Ok, so the
        // guarantee it leans on is this one: a stopped run reaches for nothing
        // but the targets it was making.
        let cancel = AtomicBool::new(false);
        let totals = survey(&[src.clone()], &cancel).unwrap();
        let result = run(&[(src.clone(), dst)], totals, &cancel, &mut |_| {
            cancel.store(true, Ordering::Relaxed);
        });

        assert!(matches!(result, Err(Stopped::Cancelled)));
        assert_eq!(std::fs::read_to_string(src.join("inner/b.txt")).unwrap(), "bb");
        assert_eq!(std::fs::read_to_string(src.join("a.txt")).unwrap(), "aaaa");
    }

    #[test]
    fn the_bar_counts_files_on_one_volume_and_bytes_across_two() {
        let dir = scratch("unit");
        let src = dir.join("src");
        tree(&src);
        let dst = dir.join("dst");

        // Everything the tests can reach is on one volume, so this is the
        // same-volume answer; `crosses_volumes` is the pure statement of the
        // rule that produces the other one.
        let cancel = AtomicBool::new(false);
        let totals = survey(&[src.clone()], &cancel).unwrap();
        let mut units = Vec::new();
        run(&[(src.clone(), dst)], totals, &cancel, &mut |p| units.push(p.by_bytes)).unwrap();

        assert!(units.iter().all(|by_bytes| !by_bytes));
        assert!(!crosses_volumes(&[(src, dir.join("elsewhere"))]));
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

    #[cfg(unix)]
    #[test]
    fn a_link_is_copied_as_a_link_and_costs_no_bytes() {
        let dir = scratch("links");
        let src = dir.join("src");
        tree(&src);
        // One relative link to a folder, one absolute link to a file — the two
        // shapes `node_modules/.bin` and friends actually contain.
        std::os::unix::fs::symlink("inner", src.join("to-inner")).unwrap();
        std::os::unix::fs::symlink(src.join("a.txt"), src.join("to-a")).unwrap();
        let dst = dir.join("dst");

        let cancel = AtomicBool::new(false);
        let totals = survey(&[src.clone()], &cancel).unwrap();
        // Folder, a.txt, inner, inner/b.txt, and the two links as items —
        // but only the real files' bytes.
        assert_eq!(totals.0, 6);
        assert_eq!(totals.1, 6);

        run(&[(src.clone(), dst.clone())], totals, &cancel, &mut |_| {}).unwrap();

        assert_eq!(std::fs::read_link(dst.join("to-inner")).unwrap(), PathBuf::from("inner"));
        assert_eq!(std::fs::read_link(dst.join("to-a")).unwrap(), src.join("a.txt"));
        // The linked folder's contents were not duplicated through the link.
        assert_eq!(std::fs::read_to_string(dst.join("to-inner/b.txt")).unwrap(), "bb");
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
