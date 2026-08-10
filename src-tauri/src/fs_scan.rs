//! Directory listing. One `read_dir`, one `stat` per entry, one extra `stat` per
//! subdirectory to detect repo roots. No recursion and no allocation per component
//! beyond the entries themselves.

use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::git::{self, GitCache};
use crate::model::{Entry, Kind};

pub struct ScanOpts {
    pub show_hidden: bool,
}

pub fn scan(dir: &Path, opts: &ScanOpts, cache: &GitCache) -> Result<Vec<Entry>, String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut out: Vec<Entry> = Vec::with_capacity(64);

    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        let hidden = name.starts_with('.');
        if hidden && !opts.show_hidden {
            continue;
        }
        if name == ".DS_Store" {
            continue;
        }

        // `file_type()` comes straight from the directory entry on macOS — no stat.
        let ft = match ent.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let path = ent.path();
        let (kind, link_to_dir) = if ft.is_symlink() {
            (Kind::Symlink, path.is_dir())
        } else if ft.is_dir() {
            (Kind::Dir, true)
        } else {
            (Kind::File, false)
        };

        let (size, mtime, added) = match ent.metadata() {
            Ok(m) => {
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let added = m
                    .created()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(mtime);
                (m.len(), mtime, added)
            }
            Err(_) => (0, 0, 0),
        };

        // Only real directories can be repo roots; probing symlinks would follow
        // them out of the tree we are showing.
        let mut is_repo = false;
        let mut worktree_count = 0;
        let mut branch = None;
        if matches!(kind, Kind::Dir) {
            if let Some(paths) = git::discover::repo_at(&path) {
                is_repo = true;
                worktree_count = git::worktree_count(&paths.common_dir);
                let (head, br, _detached) = git::discover::read_head(&paths.git_dir);
                branch = br.or(head);
                // Seed the memo so expanding this repo skips the upward walk.
                cache.resolve(&path);
            }
        }

        out.push(Entry {
            name,
            path: path.to_string_lossy().into_owned(),
            kind,
            link_to_dir,
            size,
            mtime,
            added,
            hidden,
            thumbable: matches!(kind, Kind::File) && crate::thumb::can_thumbnail(&path),
            is_repo,
            worktree_count,
            branch,
            code: None,
            rollup: None,
        });
    }

    out.sort_by(cmp_entries);
    Ok(out)
}

/// Finder ordering: directories first, then a natural (digit-aware) case-insensitive
/// compare so `file2` sorts before `file10`.
fn cmp_entries(a: &Entry, b: &Entry) -> Ordering {
    let a_dir = matches!(a.kind, Kind::Dir) || (matches!(a.kind, Kind::Symlink) && a.link_to_dir);
    let b_dir = matches!(b.kind, Kind::Dir) || (matches!(b.kind, Kind::Symlink) && b.link_to_dir);
    display_cmp((a_dir, &a.name), (b_dir, &b.name))
}

/// The same ordering over just the two fields it actually reads, so a caller
/// holding nothing but a name and a kind — the folder peek — can sort the way
/// the listing will.
pub fn display_cmp(a: (bool, &str), b: (bool, &str)) -> Ordering {
    b.0.cmp(&a.0).then_with(|| natural_cmp(a.1, b.1))
}

pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let an = take_number(&mut ai);
                    let bn = take_number(&mut bi);
                    match an.cmp(&bn) {
                        Ordering::Equal => continue,
                        other => return other,
                    }
                }
                ai.next();
                bi.next();
                let (al, bl) = (ac.to_ascii_lowercase(), bc.to_ascii_lowercase());
                match al.cmp(&bl) {
                    Ordering::Equal => continue,
                    other => return other,
                }
            }
        }
    }
}

fn take_number(it: &mut std::iter::Peekable<std::str::Chars>) -> u128 {
    let mut n: u128 = 0;
    while let Some(c) = it.peek() {
        if let Some(d) = c.to_digit(10) {
            // Saturate rather than wrap on absurdly long digit runs.
            n = n.saturating_mul(10).saturating_add(d as u128);
            it.next();
        } else {
            break;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_is_digit_aware() {
        assert_eq!(natural_cmp("file2", "file10"), Ordering::Less);
        assert_eq!(natural_cmp("file10", "file2"), Ordering::Greater);
        assert_eq!(natural_cmp("a", "A"), Ordering::Equal);
        assert_eq!(natural_cmp("apple", "banana"), Ordering::Less);
        assert_eq!(natural_cmp("v1.9.0", "v1.10.0"), Ordering::Less);
    }

    #[test]
    fn display_order_puts_directories_first() {
        assert_eq!(display_cmp((true, "zeta"), (false, "alpha")), Ordering::Less);
        assert_eq!(display_cmp((false, "alpha"), (true, "zeta")), Ordering::Greater);
        assert_eq!(display_cmp((true, "a"), (true, "b")), Ordering::Less);
        assert_eq!(display_cmp((false, "img2.png"), (false, "img10.png")), Ordering::Less);
    }

    #[test]
    fn long_digit_runs_do_not_overflow() {
        let long = "9".repeat(60);
        // Just needs to terminate and be consistent.
        assert_eq!(natural_cmp(&long, &long), Ordering::Equal);
    }
}
