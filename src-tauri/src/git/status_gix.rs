//! Git status without a `git` binary, for the platform that has none.
//!
//! An Android app cannot shell out to git — there isn't one — so the
//! subprocess in `status.rs` can never run there, and the README's "git
//! without a git panel" was a pending flag that never resolved. This module
//! computes the same `RepoStatus` in-process with gitoxide: the two columns of
//! porcelain v2 reassembled from gix's two streams (HEAD→index and
//! index→worktree), collapsed untracked and ignored directories, the branch
//! headers, and ahead/behind counted by walking the graph.
//!
//! The desktop keeps the subprocess: `git status` there is the reference
//! implementation of itself, and `--no-optional-locks` plus decades of edge
//! cases are not worth re-litigating where the binary exists. This module is
//! oracle-tested against that subprocess's output — same fixture repo, both
//! engines, one expected `RepoStatus`.

use std::collections::HashMap;
use std::path::Path;

use gix::bstr::ByteSlice;

use super::status::{record, RepoStatus};
use crate::model::Code;

/// Compute status for `work_root` in-process. Blocking — call from a blocking
/// pool, like the subprocess it replaces.
pub fn compute(work_root: &Path) -> Result<RepoStatus, String> {
    let repo = gix::open(work_root).map_err(|e| format!("couldn't open the repository: {e}"))?;

    let mut st = RepoStatus::default();
    read_branch(&repo, &mut st);

    // The two porcelain columns for *tracked* paths, gathered separately and
    // merged by path. `.` is porcelain's "no change in this column".
    // Untracked and ignored dirwalk entries are kept out of this merge on
    // purpose: porcelain emits them as their own records — `git rm --cached`
    // produces both a `1 D.` and a `? path` for the same path, and folding
    // them into one code loses the staged deletion from the rollups.
    let mut columns: HashMap<String, (char, char)> = HashMap::new();
    let mut dirwalk: Vec<(String, bool, Code)> = Vec::new();
    let mut set = |path: String, index: Option<char>, worktree: Option<char>| {
        let slot = columns.entry(path).or_insert(('.', '.'));
        // A conflict is final: porcelain never pairs `u` with another letter,
        // so nothing may overwrite it. (gix filters conflicted paths out of
        // its tree→index diff, so this is insurance, not a reachable path.)
        if slot.0 == 'u' {
            return;
        }
        if let Some(c) = index {
            slot.0 = c;
        }
        if let Some(c) = worktree {
            slot.1 = c;
        }
    };

    let platform = repo
        .status(gix::progress::Discard)
        .map_err(|e| format!("couldn't begin a status pass: {e}"))?
        // Matches `--untracked-files=normal`: a wholly untracked directory is
        // one entry, not a listing of everything inside it.
        .untracked_files(gix::status::UntrackedFiles::Collapsed)
        // Matches `--ignored=traditional` the same way for node_modules/.
        .dirwalk_options(|options| {
            options.emit_ignored(Some(gix::dir::walk::EmissionMode::CollapseDirectory))
        })
        // The worktree column of porcelain v2 does no rename detection; only
        // the staged column does. Matching that keeps the oracle honest.
        .index_worktree_rewrites(None);

    let items = platform
        .into_iter(None)
        .map_err(|e| format!("couldn't walk the repository: {e}"))?;

    for item in items {
        let item = item.map_err(|e| format!("status failed part-way: {e}"))?;
        match item {
            gix::status::Item::IndexWorktree(change) => {
                index_worktree_columns(&change, &mut set, &mut dirwalk);
            }
            gix::status::Item::TreeIndex(change) => {
                tree_index_columns(&change, &mut set);
            }
        }
    }

    // Tracked changes first, then the dirwalk's untracked/ignored records —
    // the order porcelain prints them in, which matters for the one path that
    // appears in both (`git rm --cached`): the later `??` wins the code while
    // the rollup keeps both contributions, exactly like the parser.
    for (path, (index, worktree)) in columns {
        if index == '.' && worktree == '.' {
            continue;
        }
        record(&mut st, &path, Code { index, worktree });
    }
    for (path, is_dir, code) in dirwalk {
        // `record` reads a trailing slash as "this is a directory", which is
        // how porcelain spells collapsed untracked/ignored directories.
        if is_dir {
            record(&mut st, &format!("{path}/"), code);
        } else {
            record(&mut st, &path, code);
        }
    }

    Ok(st)
}

/// The porcelain `# branch.*` headers, from the refs themselves.
fn read_branch(repo: &gix::Repository, st: &mut RepoStatus) {
    let head_id = repo.head_id().ok();
    if let Some(id) = head_id {
        st.head = Some(id.to_string().chars().take(7).collect());
    }

    let Ok(mut head) = repo.head() else {
        return;
    };
    if head.is_detached() {
        st.detached = true;
    } else if let Some(name) = head.referent_name() {
        st.branch = Some(name.shorten().to_str_lossy().into_owned());

        // Upstream, and the two counts beside it. All best-effort: a branch
        // with no upstream simply has none, exactly like porcelain.
        if let Some(Ok(tracking)) = repo.branch_remote_tracking_ref_name(name, gix::remote::Direction::Fetch) {
            let tracking = tracking.to_owned();
            st.upstream = Some(
                tracking
                    .as_bstr()
                    .strip_prefix(b"refs/remotes/".as_slice())
                    .map(|s| s.as_bstr().to_str_lossy().into_owned())
                    .unwrap_or_else(|| tracking.as_bstr().to_str_lossy().into_owned()),
            );
            let local = head.peel_to_commit().ok().map(|c| c.id);
            let remote = repo
                .find_reference(tracking.as_ref())
                .ok()
                .and_then(|mut r| r.peel_to_id().ok())
                .map(|id| id.detach());
            if let (Some(local), Some(remote)) = (local, remote) {
                st.ahead = count_only_reachable_from(repo, local, remote);
                st.behind = count_only_reachable_from(repo, remote, local);
            }
        }
    }
}

/// Commits reachable from `tip` but not from `other` — one half of `branch.ab`.
fn count_only_reachable_from(
    repo: &gix::Repository,
    tip: gix::ObjectId,
    other: gix::ObjectId,
) -> i32 {
    repo.rev_walk(Some(tip))
        .with_hidden(Some(other))
        .all()
        .map(|walk| walk.take_while(|info| info.is_ok()).count() as i32)
        .unwrap_or(0)
}

/// The worktree column: index→worktree changes into `set`, untracked and
/// ignored dirwalk entries into `dirwalk` (their own records; see `compute`).
fn index_worktree_columns(
    change: &gix::status::index_worktree::Item,
    set: &mut impl FnMut(String, Option<char>, Option<char>),
    dirwalk: &mut Vec<(String, bool, Code)>,
) {
    use gix::status::index_worktree::Item;
    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};

    match change {
        Item::Modification { rela_path, status, .. } => {
            let path = rela_path.to_str_lossy().into_owned();
            match status {
                // Porcelain spells a conflict `u` in both columns; the real
                // stage details don't survive into a badge either way.
                EntryStatus::Conflict { .. } => {
                    set(path, Some('u'), Some('u'));
                }
                EntryStatus::Change(change) => {
                    let letter = match change {
                        Change::Removed => 'D',
                        Change::Type { .. } => 'T',
                        Change::Modification { .. } | Change::SubmoduleModification(_) => 'M',
                    };
                    set(path, None, Some(letter));
                }
                // A stat refresh the index owes itself, not a user-visible change.
                EntryStatus::NeedsUpdate(_) => {}
                // Porcelain: `1 .A` — added in intent, not yet in the tree.
                EntryStatus::IntentToAdd => set(path, None, Some('A')),
            }
        }
        Item::DirectoryContents { entry, .. } => {
            let path = entry.rela_path.to_str_lossy().into_owned();
            let is_dir = entry
                .disk_kind
                .is_some_and(|kind| matches!(kind, gix::dir::entry::Kind::Directory | gix::dir::entry::Kind::Repository));
            match entry.status {
                gix::dir::entry::Status::Untracked => dirwalk.push((path, is_dir, Code::UNTRACKED)),
                gix::dir::entry::Status::Ignored(_) => dirwalk.push((path, is_dir, Code::IGNORED)),
                _ => {}
            }
        }
        // Worktree rename detection is disabled to match porcelain (see
        // `index_worktree_rewrites(None)`), so this arm is dormant; if it ever
        // fires, the honest reading is a deletion plus an untracked arrival.
        Item::Rewrite { source, dirwalk_entry, .. } => {
            set(source.rela_path().to_str_lossy().into_owned(), None, Some('D'));
            dirwalk.push((
                dirwalk_entry.rela_path.to_str_lossy().into_owned(),
                false,
                Code::UNTRACKED,
            ));
        }
    }
}

/// The staged column: HEAD→index changes.
fn tree_index_columns(
    change: &gix::diff::index::Change,
    set: &mut impl FnMut(String, Option<char>, Option<char>),
) {
    use gix::diff::index::Change;

    match change {
        Change::Addition { location, .. } => {
            set(location.to_str_lossy().into_owned(), Some('A'), None);
        }
        Change::Deletion { location, .. } => {
            set(location.to_str_lossy().into_owned(), Some('D'), None);
        }
        Change::Modification {
            location,
            previous_entry_mode,
            entry_mode,
            ..
        } => {
            // Porcelain reports a *type* change (file ↔ symlink ↔ gitlink) as
            // `T`; a chmod — Blob ↔ BlobExecutable — is only ever `M`.
            let letter = if type_class(*previous_entry_mode) != type_class(*entry_mode) {
                'T'
            } else {
                'M'
            };
            set(location.to_str_lossy().into_owned(), Some(letter), None);
        }
        Change::Rewrite { location, copy, .. } => {
            set(
                location.to_str_lossy().into_owned(),
                Some(if *copy { 'C' } else { 'R' }),
                None,
            );
        }
    }
}

/// The kind classes porcelain's `T` actually distinguishes: an executable bit
/// flipping is a modification, not a type change.
fn type_class(mode: gix::index::entry::Mode) -> u8 {
    use gix::object::tree::EntryKind;
    match mode.to_tree_entry_mode().map(|m| m.kind()) {
        Some(EntryKind::Blob) | Some(EntryKind::BlobExecutable) => 0,
        Some(EntryKind::Link) => 1,
        Some(EntryKind::Commit) => 2,
        Some(EntryKind::Tree) => 3,
        None => 4,
    }
}
