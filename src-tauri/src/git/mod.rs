pub mod discover;
pub mod status;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use discover::RepoPaths;
use status::RepoStatus;

/// Beyond this many memoized path->repo answers we drop the table wholesale.
/// Browsing is strongly locality-biased, so a cold rebuild after a big walk is cheap.
const DISCOVERY_CAP: usize = 8192;

#[derive(Default)]
pub struct GitCache {
    /// Directory -> the repo containing it (`None` = memoized "not in a repo").
    discovery: Mutex<HashMap<PathBuf, Option<Arc<RepoPaths>>>>,
    /// Work root -> last computed status.
    statuses: Mutex<HashMap<PathBuf, Arc<RepoStatus>>>,
    /// Work roots with a status pass currently running, so bursts coalesce.
    inflight: Mutex<HashSet<PathBuf>>,
}

impl GitCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Find the repo containing `dir`, memoizing every directory walked on the way up.
    /// A miss costs one `stat` per ancestor; a hit costs a hash lookup.
    pub fn resolve(&self, dir: &Path) -> Option<Arc<RepoPaths>> {
        if let Some(hit) = self.discovery.lock().unwrap().get(dir) {
            return hit.clone();
        }

        let mut walked: Vec<PathBuf> = Vec::new();
        let mut cur = Some(dir);
        let mut found: Option<Arc<RepoPaths>> = None;

        while let Some(d) = cur {
            if let Some(hit) = self.discovery.lock().unwrap().get(d) {
                found = hit.clone();
                break;
            }
            if let Some(r) = discover::repo_at(d) {
                found = Some(Arc::new(r));
                break;
            }
            walked.push(d.to_path_buf());
            cur = d.parent();
        }

        let mut map = self.discovery.lock().unwrap();
        if map.len() > DISCOVERY_CAP {
            map.clear();
        }
        for d in walked {
            map.insert(d, found.clone());
        }
        if let Some(r) = &found {
            map.insert(r.work_root.clone(), Some(r.clone()));
        }
        found
    }

    pub fn cached_status(&self, work_root: &Path) -> Option<Arc<RepoStatus>> {
        self.statuses.lock().unwrap().get(work_root).cloned()
    }

    /// Cached status, computing it on this thread if absent. Blocking.
    pub fn status_blocking(&self, work_root: &Path) -> Result<Arc<RepoStatus>, String> {
        if let Some(hit) = self.cached_status(work_root) {
            return Ok(hit);
        }
        let fresh = Arc::new(status::compute(work_root)?);
        self.statuses
            .lock()
            .unwrap()
            .insert(work_root.to_path_buf(), fresh.clone());
        Ok(fresh)
    }

    /// Recompute unconditionally, replacing whatever is cached.
    pub fn refresh_blocking(&self, work_root: &Path) -> Result<Arc<RepoStatus>, String> {
        let fresh = Arc::new(status::compute(work_root)?);
        self.statuses
            .lock()
            .unwrap()
            .insert(work_root.to_path_buf(), fresh.clone());
        Ok(fresh)
    }

    /// Claim the right to run a status pass for `work_root`. Returns false if one
    /// is already running, so a burst of watcher events produces a single pass.
    pub fn begin_pass(&self, work_root: &Path) -> bool {
        self.inflight
            .lock()
            .unwrap()
            .insert(work_root.to_path_buf())
    }

    pub fn end_pass(&self, work_root: &Path) {
        self.inflight.lock().unwrap().remove(work_root);
    }

    pub fn invalidate(&self, work_root: &Path) {
        self.statuses.lock().unwrap().remove(work_root);
    }

    /// Forget a path's memoized repo association — used when directories are
    /// created, deleted or renamed under it.
    pub fn forget_discovery_under(&self, path: &Path) {
        let mut map = self.discovery.lock().unwrap();
        map.retain(|k, _| !k.starts_with(path));
    }
}

/// The linked worktrees of the repo rooted at `root`, if it is a repo root.
/// Reads only git's own metadata files — no subprocess, no object access.
pub fn worktrees_of(paths: &RepoPaths) -> Vec<crate::model::WorktreeInfo> {
    let main_root = discover::main_work_root(&paths.common_dir);
    discover::linked_worktrees(&paths.common_dir, main_root.as_deref())
}

/// Cheap count of linked worktrees: one `read_dir`, no parsing.
pub fn worktree_count(common_dir: &Path) -> u32 {
    std::fs::read_dir(common_dir.join("worktrees"))
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).count() as u32)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_memoizes_negative_answers() {
        let cache = GitCache::new();
        let tmp = std::env::temp_dir().join("fiddler-test-not-a-repo");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(cache.resolve(&tmp).is_none());
        // Second call must be served from the memo table.
        assert!(cache.discovery.lock().unwrap().contains_key(&tmp));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
