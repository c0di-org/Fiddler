//! One `git status --porcelain=v2 -z` pass per repo, parsed into a lookup table
//! plus per-directory rollups. Cached and invalidated by the fs watcher, so the
//! cost is paid once per repo per change burst rather than once per navigation.

// On Android the subprocess half of this module is unreachable — status runs
// through `status_gix` there — but the model and `record` are shared.
#![cfg_attr(target_os = "android", allow(dead_code))]

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

use crate::model::{Code, Rollup};

#[derive(Debug, Default)]
pub struct RepoStatus {
    /// Repo-relative path (no leading slash, no trailing slash) -> status code.
    pub codes: HashMap<String, Code>,
    /// Repo-relative directory path -> rolled-up counts for everything beneath it.
    pub rollups: HashMap<String, Rollup>,
    /// Directories reported wholesale as ignored (`node_modules/`, `dist/`).
    /// Anything beneath one of these is ignored too, without git listing it.
    pub ignored_dirs: HashSet<String>,
    /// Directories reported wholesale as untracked.
    pub untracked_dirs: HashSet<String>,

    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
}

impl RepoStatus {
    /// Status for a repo-relative path. `is_dir` selects rollup vs. exact lookup.
    pub fn lookup(&self, rel: &str, is_dir: bool) -> (Option<Code>, Option<Rollup>) {
        if rel.is_empty() {
            let r = self.rollups.get("").copied();
            return (None, r.filter(|r| !r.is_empty()));
        }

        if is_dir {
            if self.ignored_dirs.contains(rel) || self.under_ignored(rel) {
                return (Some(Code::IGNORED), None);
            }
            if self.untracked_dirs.contains(rel) {
                return (Some(Code::UNTRACKED), None);
            }
            let r = self.rollups.get(rel).copied().filter(|r| !r.is_empty());
            return (None, r);
        }

        if let Some(c) = self.codes.get(rel) {
            return (Some(*c), None);
        }
        if self.under_ignored(rel) {
            return (Some(Code::IGNORED), None);
        }
        if self.under_untracked(rel) {
            return (Some(Code::UNTRACKED), None);
        }
        (None, None)
    }

    fn under_ignored(&self, rel: &str) -> bool {
        ancestors(rel).any(|a| self.ignored_dirs.contains(a))
    }

    fn under_untracked(&self, rel: &str) -> bool {
        ancestors(rel).any(|a| self.untracked_dirs.contains(a))
    }
}

/// Yields every proper ancestor of a repo-relative path, longest first.
/// `a/b/c.txt` -> `a/b`, `a`.
fn ancestors(rel: &str) -> impl Iterator<Item = &str> {
    rel.char_indices()
        .rev()
        .filter(|(_, c)| *c == '/')
        .map(move |(i, _)| &rel[..i])
}

/// Run git status for `work_root`. Blocking — call from a blocking pool.
pub fn compute(work_root: &Path) -> Result<RepoStatus, String> {
    let out = Command::new("git")
        // `--no-optional-locks` keeps us from writing the index while the user's own
        // git commands are running; a file browser must never take a repo lock.
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(work_root)
        .args([
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            // `traditional` collapses a fully-ignored directory to one entry instead
            // of listing every file under node_modules. Big win on JS repos.
            "--ignored=traditional",
            // `normal` collapses untracked directories the same way.
            "--untracked-files=normal",
        ])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    Ok(parse(&out.stdout))
}

pub fn parse(bytes: &[u8]) -> RepoStatus {
    let mut st = RepoStatus::default();
    // Paths are raw bytes; on macOS they are UTF-8 in practice and lossy conversion
    // keeps a weird filename from aborting the whole pass.
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0').filter(|f| !f.is_empty()).peekable();

    while let Some(field) = fields.next() {
        let mut chars = field.chars();
        let tag = chars.next().unwrap_or(' ');
        match tag {
            '#' => parse_header(field, &mut st),
            // `get` rather than a slice: a truncated field ("?" alone) would
            // otherwise panic, and with `panic = "abort"` one malformed line
            // of porcelain output is the whole process.
            '?' => {
                if let Some(path) = field.get(2..) {
                    record(&mut st, path, Code::UNTRACKED);
                }
            }
            '!' => {
                if let Some(path) = field.get(2..) {
                    record(&mut st, path, Code::IGNORED);
                }
            }
            '1' => {
                if let Some((code, path)) = parse_ordinary(field) {
                    record(&mut st, path, code);
                }
            }
            '2' => {
                // Rename/copy: with -z the original path is its own NUL-terminated field.
                let orig = fields.next();
                if let Some((code, path)) = parse_rename(field) {
                    record(&mut st, path, code);
                }
                let _ = orig;
            }
            'u' => {
                if let Some(path) = parse_unmerged(field) {
                    record(
                        &mut st,
                        path,
                        Code {
                            index: 'u',
                            worktree: 'u',
                        },
                    );
                }
            }
            _ => {}
        }
    }

    st
}

fn parse_header(field: &str, st: &mut RepoStatus) {
    let rest = field.trim_start_matches("# ");
    if let Some(v) = rest.strip_prefix("branch.head ") {
        if v == "(detached)" {
            st.detached = true;
        } else {
            st.branch = Some(v.to_string());
        }
    } else if let Some(v) = rest.strip_prefix("branch.oid ") {
        if v != "(initial)" && v.len() >= 7 {
            st.head = Some(v[..7].to_string());
        }
    } else if let Some(v) = rest.strip_prefix("branch.upstream ") {
        st.upstream = Some(v.to_string());
    } else if let Some(v) = rest.strip_prefix("branch.ab ") {
        // "+1 -2"
        for part in v.split_whitespace() {
            match part.as_bytes().first() {
                Some(b'+') => st.ahead = part[1..].parse().unwrap_or(0),
                Some(b'-') => st.behind = part[1..].parse().unwrap_or(0),
                _ => {}
            }
        }
    }
}

/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
fn parse_ordinary(field: &str) -> Option<(Code, &str)> {
    let mut it = field.splitn(9, ' ');
    it.next()?; // "1"
    let xy = it.next()?;
    for _ in 0..6 {
        it.next()?;
    }
    let path = it.next()?;
    Some((xy_to_code(xy)?, path))
}

/// `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`
fn parse_rename(field: &str) -> Option<(Code, &str)> {
    let mut it = field.splitn(10, ' ');
    it.next()?; // "2"
    let xy = it.next()?;
    for _ in 0..7 {
        it.next()?;
    }
    let path = it.next()?;
    Some((xy_to_code(xy)?, path))
}

/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
fn parse_unmerged(field: &str) -> Option<&str> {
    let mut it = field.splitn(11, ' ');
    for _ in 0..10 {
        it.next()?;
    }
    it.next()
}

fn xy_to_code(xy: &str) -> Option<Code> {
    let mut c = xy.chars();
    Some(Code {
        index: c.next()?,
        worktree: c.next()?,
    })
}

/// Also used by the gix-based status on Android, which synthesizes the same
/// `(path, code)` stream a porcelain parse produces.
pub(crate) fn record(st: &mut RepoStatus, path: &str, code: Code) {
    let is_dir = path.ends_with('/');
    let rel = path.trim_end_matches('/').to_string();
    if rel.is_empty() {
        return;
    }

    if code.is_ignored() {
        if is_dir {
            st.ignored_dirs.insert(rel);
        } else {
            st.codes.insert(rel, code);
        }
        // Ignored things never roll up — a folder holding node_modules reads as clean.
        return;
    }

    if code.is_untracked() && is_dir {
        st.untracked_dirs.insert(rel.clone());
    } else {
        st.codes.insert(rel.clone(), code);
    }

    // Credit every ancestor directory, plus the repo root (the "" key).
    let mut delta = Rollup::default();
    if code.is_conflicted() {
        delta.conflicted = 1;
    } else if code.is_untracked() {
        delta.untracked = 1;
    } else {
        if code.index == 'D' || code.worktree == 'D' {
            delta.deleted = 1;
        }
        if code.has_staged() {
            delta.staged = 1;
        }
        if code.has_unstaged() {
            delta.modified = 1;
        }
    }

    for anc in ancestors(&rel) {
        add(st.rollups.entry(anc.to_string()).or_default(), &delta);
    }
    add(st.rollups.entry(String::new()).or_default(), &delta);
}

fn add(dst: &mut Rollup, src: &Rollup) {
    dst.staged += src.staged;
    dst.modified += src.modified;
    dst.untracked += src.untracked;
    dst.deleted += src.deleted;
    dst.conflicted += src.conflicted;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nul(parts: &[&str]) -> Vec<u8> {
        parts.join("\0").into_bytes()
    }

    #[test]
    fn parses_branch_header() {
        let st = parse(&nul(&[
            "# branch.oid 4064d27aaaaaaaaaaa",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -3",
        ]));
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.head.as_deref(), Some("4064d27"));
        assert_eq!(st.ahead, 2);
        assert_eq!(st.behind, 3);
        assert!(!st.detached);
    }

    #[test]
    fn detached_head() {
        let st = parse(&nul(&["# branch.head (detached)"]));
        assert!(st.detached);
        assert!(st.branch.is_none());
    }

    #[test]
    fn ordinary_change_rolls_up_to_every_ancestor() {
        let st = parse(&nul(&[
            "1 .M N... 100644 100644 100644 aaa bbb src/audio/mixer.c",
        ]));
        assert_eq!(
            st.codes["src/audio/mixer.c"],
            Code {
                index: '.',
                worktree: 'M'
            }
        );
        assert_eq!(st.rollups["src/audio"].modified, 1);
        assert_eq!(st.rollups["src"].modified, 1);
        assert_eq!(st.rollups[""].modified, 1);
        assert_eq!(st.rollups["src"].staged, 0);
    }

    #[test]
    fn staged_and_unstaged_count_separately() {
        let st = parse(&nul(&["1 MM N... 100644 100644 100644 aaa bbb main.c"]));
        assert_eq!(st.rollups[""].staged, 1);
        assert_eq!(st.rollups[""].modified, 1);
    }

    #[test]
    fn rename_consumes_the_original_path_field() {
        // The orig path must not be parsed as its own record.
        let st = parse(&nul(&[
            "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.c",
            "old/name.c",
            "1 .M N... 100644 100644 100644 aaa bbb after.c",
        ]));
        assert!(st.codes.contains_key("new/name.c"));
        assert!(!st.codes.contains_key("old/name.c"));
        assert!(st.codes.contains_key("after.c"));
    }

    #[test]
    fn ignored_dirs_shadow_their_contents_without_rolling_up() {
        let st = parse(&nul(&[
            "! node_modules/",
            "1 .M N... 100644 100644 100644 a b src/x.c",
        ]));
        assert!(st.ignored_dirs.contains("node_modules"));
        let (code, _) = st.lookup("node_modules/left-pad/index.js", false);
        assert_eq!(code, Some(Code::IGNORED));
        // The repo root shows only the real change, not the ignored tree.
        assert_eq!(st.rollups[""].modified, 1);
        assert!(st.rollups.get("node_modules").is_none());
    }

    #[test]
    fn untracked_dir_collapses_to_one_entry() {
        let st = parse(&nul(&["? newfeature/"]));
        assert!(st.untracked_dirs.contains("newfeature"));
        let (code, _) = st.lookup("newfeature", true);
        assert_eq!(code, Some(Code::UNTRACKED));
        let (child, _) = st.lookup("newfeature/deep/file.rs", false);
        assert_eq!(child, Some(Code::UNTRACKED));
    }

    #[test]
    fn unmerged_paths_are_conflicts() {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        let st = parse(&nul(&[
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.c",
        ]));
        assert!(st.codes["src/conflict.c"].is_conflicted());
        assert_eq!(st.rollups["src"].conflicted, 1);
    }

    #[test]
    fn directory_lookup_returns_rollup_not_code() {
        let st = parse(&nul(&["1 .M N... 100644 100644 100644 a b src/x.c"]));
        let (code, rollup) = st.lookup("src", true);
        assert!(code.is_none());
        assert_eq!(rollup.unwrap().modified, 1);
    }

    #[test]
    fn clean_paths_have_no_status() {
        let st = parse(&nul(&["# branch.head main"]));
        assert_eq!(st.lookup("src/clean.c", false), (None, None));
        assert_eq!(st.lookup("src", true), (None, None));
    }
}
