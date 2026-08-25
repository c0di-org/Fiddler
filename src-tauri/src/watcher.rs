//! Filesystem watching with coalescing.
//!
//! Repo roots are watched recursively so a `git checkout` anywhere in the tree
//! invalidates one cached status; plain directories are watched shallowly so
//! browsing `~/Downloads` doesn't arm a recursive watch over everything below it.
//!
//! Raw events are noisy (a single `npm install` emits tens of thousands), so every
//! event is filtered against the repo's own ignore rules and then coalesced into a
//! per-repo dirty set that flushes on a quiet period.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::{AppHandle, Emitter};

use crate::git::GitCache;

/// Quiet period before a burst of filesystem events is turned into one refresh.
const DEBOUNCE: Duration = Duration::from_millis(220);
/// Upper bound on live watches, so a session that wanders across hundreds of
/// directories cannot exhaust the process's descriptor budget. Reaching it drops
/// the least recently visited watch rather than refusing new ones — going quiet
/// about the folder someone is actually looking at is the worse failure.
const MAX_WATCHES: usize = 192;

pub struct FsWatcher {
    inner: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<Watched>,
    dirty_tx: Sender<PathBuf>,
}

/// Live watches, in the order they were last asked for.
#[derive(Default)]
struct Watched {
    /// Paths currently watched, and whether the watch is recursive.
    modes: HashMap<PathBuf, bool>,
    /// The same paths, least recently visited first.
    order: Vec<PathBuf>,
}

impl Watched {
    fn touch(&mut self, dir: &Path) {
        if let Some(at) = self.order.iter().position(|p| p == dir) {
            let path = self.order.remove(at);
            self.order.push(path);
        }
    }

    fn insert(&mut self, dir: PathBuf, recursive: bool) {
        self.modes.insert(dir.clone(), recursive);
        self.order.retain(|p| p != &dir);
        self.order.push(dir);
    }

    /// The watch to give up when we're full: the oldest plain directory, or the
    /// oldest of anything if every watch is a repo. Never `keep`, which is the
    /// folder being opened right now.
    fn victim(&self, keep: &Path) -> Option<PathBuf> {
        let oldest = |recursive: bool| {
            self.order
                .iter()
                .find(|p| p.as_path() != keep && self.modes.get(*p) == Some(&recursive))
                .cloned()
        };
        oldest(false).or_else(|| oldest(true))
    }

    fn remove(&mut self, dir: &Path) {
        self.modes.remove(dir);
        self.order.retain(|p| p.as_path() != dir);
    }
}

impl FsWatcher {
    pub fn start(app: AppHandle, cache: Arc<GitCache>) -> Arc<Self> {
        let (raw_tx, raw_rx) = channel::<PathBuf>();
        let (dirty_tx, dirty_rx) = channel::<PathBuf>();

        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                for p in ev.paths {
                    let _ = raw_tx.send(p);
                }
            }
        })
        .ok();

        let me = Arc::new(FsWatcher {
            inner: Mutex::new(watcher),
            watched: Mutex::new(Watched::default()),
            dirty_tx,
        });

        // One thread merges raw notify events and explicit dirty pokes, then flushes
        // after DEBOUNCE of quiet.
        let cache_for_thread = cache.clone();
        std::thread::spawn(move || debounce_loop(app, cache_for_thread, raw_rx, dirty_rx));

        me
    }

    /// Watch `dir`. Recursive watches are used for repo roots only.
    pub fn watch(&self, dir: &Path, recursive: bool) {
        let mut watched = self.watched.lock().unwrap();

        // Already covered by this or a broader watch? Still worth marking as
        // visited, so the folder someone keeps returning to is never the one
        // given up when the budget runs out.
        match watched.modes.get(dir) {
            Some(&existing) if existing || !recursive => {
                watched.touch(dir);
                return;
            }
            _ => {}
        }
        if watched
            .modes
            .iter()
            .any(|(p, &rec)| rec && p != dir && dir.starts_with(p))
        {
            return;
        }

        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };

        let mut guard = self.inner.lock().unwrap();
        let Some(w) = guard.as_mut() else { return };

        while watched.modes.len() >= MAX_WATCHES {
            let Some(victim) = watched.victim(dir) else { break };
            let _ = w.unwatch(&victim);
            watched.remove(&victim);
        }

        if w.watch(dir, mode).is_ok() {
            watched.insert(dir.to_path_buf(), recursive);
        }
    }

    /// Force a refresh for a path without waiting for the filesystem to tell us —
    /// used right after Fiddler itself mutates the tree.
    pub fn poke(&self, path: &Path) {
        let _ = self.dirty_tx.send(path.to_path_buf());
    }
}

fn debounce_loop(
    app: AppHandle,
    cache: Arc<GitCache>,
    raw_rx: Receiver<PathBuf>,
    dirty_rx: Receiver<PathBuf>,
) {
    let mut pending: HashSet<PathBuf> = HashSet::new();

    loop {
        // Block until something happens, then drain everything that arrives during
        // the quiet window.
        let first = match raw_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(p) => Some(p),
            Err(RecvTimeoutError::Timeout) => dirty_rx.try_recv().ok(),
            // The notify watcher never constructed (inotify exhaustion,
            // SELinux) or died, so `raw_rx` answers Disconnected *instantly*
            // forever — spinning on it would pin a core, on a phone. Explicit
            // pokes are the only source left; park on those instead.
            Err(RecvTimeoutError::Disconnected) => match dirty_rx.recv() {
                Ok(p) => Some(p),
                // Both senders gone: the process is shutting down.
                Err(_) => return,
            },
        };
        let Some(first) = first else { continue };
        pending.insert(first);

        loop {
            let mut got_any = false;
            while let Ok(p) = raw_rx.try_recv() {
                pending.insert(p);
                got_any = true;
            }
            while let Ok(p) = dirty_rx.try_recv() {
                pending.insert(p);
                got_any = true;
            }
            if !got_any {
                std::thread::sleep(DEBOUNCE);
                // One more drain; if still nothing new, the burst is over.
                let mut late = false;
                while let Ok(p) = raw_rx.try_recv() {
                    pending.insert(p);
                    late = true;
                }
                while let Ok(p) = dirty_rx.try_recv() {
                    pending.insert(p);
                    late = true;
                }
                if !late {
                    break;
                }
            }
        }

        flush(&app, &cache, std::mem::take(&mut pending));
    }
}

fn flush(app: &AppHandle, cache: &Arc<GitCache>, paths: HashSet<PathBuf>) {
    let mut dirty_repos: HashSet<PathBuf> = HashSet::new();
    let mut dirty_dirs: HashSet<PathBuf> = HashSet::new();

    for path in paths {
        let dir = if path.is_dir() {
            path.clone()
        } else {
            match path.parent() {
                Some(p) => p.to_path_buf(),
                None => continue,
            }
        };

        match cache.resolve(&dir) {
            Some(repo) => {
                if is_noise(&path, &repo, cache) {
                    continue;
                }
                dirty_repos.insert(repo.work_root.clone());
                dirty_dirs.insert(dir);
            }
            None => {
                dirty_dirs.insert(dir);
            }
        }
    }

    for root in &dirty_repos {
        if !cache.begin_pass(root) {
            continue;
        }
        match cache.refresh_blocking(root) {
            Ok(st) => {
                let _ = app.emit(
                    "fiddler:repo-status",
                    crate::commands::repo_status_payload(root, &st),
                );
            }
            Err(_) => cache.invalidate(root),
        }
        cache.end_pass(root);
    }

    if !dirty_dirs.is_empty() {
        let list: Vec<String> = dirty_dirs
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let _ = app.emit("fiddler:dirs-changed", list);
    }
}

/// Filter out the two big sources of event spam: writes inside ignored directories
/// (`node_modules`, `target`, `dist`) and git's own scratch files.
fn is_noise(path: &Path, repo: &crate::git::discover::RepoPaths, cache: &GitCache) -> bool {
    if path.starts_with(&repo.git_dir) || path.starts_with(&repo.common_dir) {
        // Inside a git dir only a few files actually change what we display.
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let interesting = matches!(name, "HEAD" | "index" | "MERGE_HEAD" | "ORIG_HEAD")
            || path.components().any(|c| c.as_os_str() == "refs")
            || path.components().any(|c| c.as_os_str() == "worktrees");
        // `index.lock` churns on every git invocation and means nothing on its own.
        return !interesting || name.ends_with(".lock");
    }

    let Some(st) = cache.cached_status(&repo.work_root) else {
        return false;
    };
    let Ok(rel) = path.strip_prefix(&repo.work_root) else {
        return false;
    };
    let rel = rel.to_string_lossy();
    let (code, _) = st.lookup(&rel, path.is_dir());
    code.map(|c| c.is_ignored()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_least_recently_visited_plain_folder_is_given_up_first() {
        let mut watched = Watched::default();
        watched.insert(PathBuf::from("/repo"), true);
        watched.insert(PathBuf::from("/a"), false);
        watched.insert(PathBuf::from("/b"), false);

        assert_eq!(watched.victim(Path::new("/new")), Some(PathBuf::from("/a")));

        // Revisiting /a moves it to the back of the queue.
        watched.touch(Path::new("/a"));
        assert_eq!(watched.victim(Path::new("/new")), Some(PathBuf::from("/b")));

        // The folder being opened is never the one dropped.
        assert_eq!(watched.victim(Path::new("/b")), Some(PathBuf::from("/a")));
    }

    #[test]
    fn a_repo_watch_is_only_given_up_when_nothing_else_is_left() {
        let mut watched = Watched::default();
        watched.insert(PathBuf::from("/repo"), true);
        watched.insert(PathBuf::from("/other-repo"), true);
        watched.insert(PathBuf::from("/plain"), false);

        assert_eq!(watched.victim(Path::new("/new")), Some(PathBuf::from("/plain")));
        watched.remove(Path::new("/plain"));
        assert_eq!(watched.victim(Path::new("/new")), Some(PathBuf::from("/repo")));
    }

    #[test]
    fn removing_the_only_watch_leaves_nothing_to_give_up() {
        let mut watched = Watched::default();
        watched.insert(PathBuf::from("/only"), false);
        assert_eq!(watched.victim(Path::new("/only")), None);
    }
}
