use serde::Serialize;

/// A two-character git status code, porcelain-v2 style.
/// `index` is the staged side, `worktree` the unstaged side.
/// Sentinel codes we add on top of git's own: `?` untracked, `!` ignored, `u` unmerged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Code {
    pub index: char,
    pub worktree: char,
}

impl Code {
    pub const UNTRACKED: Code = Code {
        index: '?',
        worktree: '?',
    };
    pub const IGNORED: Code = Code {
        index: '!',
        worktree: '!',
    };

    pub fn is_ignored(&self) -> bool {
        self.index == '!'
    }
    pub fn is_untracked(&self) -> bool {
        self.index == '?'
    }
    pub fn is_conflicted(&self) -> bool {
        self.index == 'u'
    }
    pub fn has_staged(&self) -> bool {
        !matches!(self.index, '.' | '?' | '!' | 'u')
    }
    pub fn has_unstaged(&self) -> bool {
        !matches!(self.worktree, '.' | '?' | '!' | 'u')
    }
}

/// Rolled-up counts for a directory: how many things below it are in each state.
/// Ignored entries deliberately do not roll up — a folder containing `node_modules`
/// should not read as "3 ignored things inside".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Rollup {
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub deleted: u32,
    pub conflicted: u32,
}

impl Rollup {
    pub fn is_empty(&self) -> bool {
        *self == Rollup::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
    Symlink,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    /// For symlinks: does the target resolve to a directory? Drives navigability.
    pub link_to_dir: bool,
    pub size: u64,
    /// Unix seconds. 0 when unavailable.
    pub mtime: i64,
    /// Unix seconds when the item was created. Falls back to `mtime` on filesystems
    /// which do not expose a creation time.
    pub added: i64,
    pub hidden: bool,
    /// A preview can be produced for this file, so the UI can request one instead
    /// of asking about every file it draws.
    pub thumbable: bool,
    /// This directory is itself the root of a git worktree (has a `.git`).
    pub is_repo: bool,
    /// Number of *linked* worktrees this repo has, if it is one. Drives the
    /// "⑂ Worktrees (n)" synthetic child in the tree.
    pub worktree_count: u32,
    /// Short branch/HEAD label, only populated for repo roots.
    pub branch: Option<String>,
    pub code: Option<Code>,
    pub rollup: Option<Rollup>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// The directory name git knows it by (`.git/worktrees/<id>`).
    pub id: String,
    /// Absolute path to the worktree's working directory.
    pub path: String,
    /// Last path component, for display.
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    /// The working directory no longer exists on disk — `git worktree prune` would remove it.
    pub prunable: bool,
    /// The worktree lives outside the repo's own directory tree (e.g. `~/.codex/worktrees`,
    /// `/tmp/...`). These are the ones that are effectively invisible in Finder.
    pub external: bool,
    /// True for the primary working directory of the repo.
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub rollup: Rollup,
    pub worktrees: Vec<WorktreeInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<Entry>,
    /// Repo that contains `path`, if any.
    pub repo_root: Option<String>,
    /// Populated when `path` is itself a repo root: the linked worktrees to hang
    /// off a synthetic "⑂ Worktrees" node. Excludes the main worktree.
    pub worktrees: Vec<WorktreeInfo>,
    /// Set when a git status pass was still running; the listing is valid but
    /// unbadged, and a `fiddler:status` event will follow.
    pub status_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub path: String,
    pub icon: String,
}
