//! Repo and worktree discovery by reading git's on-disk layout directly.
//!
//! Deliberately no subprocess: locating repos happens on every directory listing,
//! and spawning `git rev-parse` per folder would dominate the frame budget.

use std::fs;
use std::path::{Path, PathBuf};

use crate::model::WorktreeInfo;

#[derive(Debug, Clone)]
pub struct RepoPaths {
    /// Working directory root (the folder containing `.git`).
    pub work_root: PathBuf,
    /// This worktree's git dir (`<root>/.git`, or the linked dir under `worktrees/`).
    pub git_dir: PathBuf,
    /// The shared git dir. Equals `git_dir` for a primary worktree.
    pub common_dir: PathBuf,
}

impl RepoPaths {
    pub fn is_linked_worktree(&self) -> bool {
        self.git_dir != self.common_dir
    }
}

/// Resolve the `.git` entry of `dir` into a `RepoPaths`, or `None` if `dir` isn't a repo root.
pub fn repo_at(dir: &Path) -> Option<RepoPaths> {
    let dot_git = dir.join(".git");
    let meta = fs::symlink_metadata(&dot_git).ok()?;

    let git_dir = if meta.is_dir() {
        dot_git
    } else if meta.is_file() {
        // Linked worktree (or a submodule): `gitdir: <path>`, possibly relative.
        let raw = fs::read_to_string(&dot_git).ok()?;
        let target = raw.strip_prefix("gitdir:")?.trim();
        let p = PathBuf::from(target);
        if p.is_absolute() { p } else { dir.join(p) }
    } else {
        return None;
    };

    if !git_dir.is_dir() {
        return None;
    }

    // `commondir` points at the shared git dir for linked worktrees.
    let common_dir = match fs::read_to_string(git_dir.join("commondir")) {
        Ok(raw) => {
            let p = PathBuf::from(raw.trim());
            let joined = if p.is_absolute() { p } else { git_dir.join(p) };
            normalize(&joined)
        }
        Err(_) => git_dir.clone(),
    };

    Some(RepoPaths {
        work_root: dir.to_path_buf(),
        git_dir: normalize(&git_dir),
        common_dir,
    })
}

/// The primary working directory of the repo that `common_dir` belongs to.
pub fn main_work_root(common_dir: &Path) -> Option<PathBuf> {
    // For a normal repo the common dir is `<root>/.git`.
    if common_dir.file_name().map(|n| n == ".git").unwrap_or(false) {
        return common_dir.parent().map(|p| p.to_path_buf());
    }
    // Bare repo, or a git dir moved elsewhere. `core.worktree` would tell us, but a
    // bare repo has no main working tree at all — report none.
    None
}

/// Enumerate the linked worktrees recorded under `<common_dir>/worktrees/`.
///
/// This is the whole point of Fiddler: these live in places Finder will never show you
/// (`.claude/worktrees/` inside the repo, `~/.codex/worktrees/<hash>/`, `/tmp/...`).
pub fn linked_worktrees(common_dir: &Path, main_root: Option<&Path>) -> Vec<WorktreeInfo> {
    let dir = common_dir.join("worktrees");
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for ent in rd.flatten() {
        match ent.metadata() {
            Ok(m) if m.is_dir() => {}
            _ => continue,
        }
        let wt_git_dir = ent.path();
        let id = ent.file_name().to_string_lossy().into_owned();

        // `gitdir` holds the absolute path of the worktree's own `.git` *file*.
        let Ok(raw) = fs::read_to_string(wt_git_dir.join("gitdir")) else {
            continue;
        };
        let dot_git_file = PathBuf::from(raw.trim());
        let Some(work_path) = dot_git_file.parent().map(|p| p.to_path_buf()) else {
            continue;
        };

        let (head, branch, detached) = read_head(&wt_git_dir);
        let lock_path = wt_git_dir.join("locked");
        let locked = lock_path.exists();
        let lock_reason = if locked {
            fs::read_to_string(&lock_path)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        } else {
            None
        };

        let prunable = !work_path.exists();
        let external = match main_root {
            Some(root) => !work_path.starts_with(root),
            None => true,
        };

        let name = work_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| id.clone());

        out.push(WorktreeInfo {
            id,
            path: work_path.to_string_lossy().into_owned(),
            name,
            branch,
            head,
            detached,
            locked,
            lock_reason,
            prunable,
            external,
            is_main: false,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Read a git dir's HEAD into `(short oid, branch name, detached)`.
/// Only the symbolic form is cheap; for a detached HEAD we return the abbreviated oid.
pub fn read_head(git_dir: &Path) -> (Option<String>, Option<String>, bool) {
    let Ok(raw) = fs::read_to_string(git_dir.join("HEAD")) else {
        return (None, None, false);
    };
    let raw = raw.trim();
    if let Some(r) = raw.strip_prefix("ref:") {
        let full = r.trim();
        let short = full.strip_prefix("refs/heads/").unwrap_or(full).to_string();
        (None, Some(short), false)
    } else if raw.len() >= 7 {
        (Some(raw[..7].to_string()), None, true)
    } else {
        (None, None, true)
    }
}

/// Lexical path cleanup — resolves `.` and `..` without touching the filesystem,
/// so it stays cheap and does not follow symlinks.
pub fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
