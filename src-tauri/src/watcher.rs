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
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::{AppHandle, Emitter};

use crate::git::GitCache;

/// Quiet period before a burst of filesystem events is turned into one refresh.
const DEBOUNCE: Duration = Duration::from_millis(220);
/// Upper bound on live watches, so a session that wanders across hundreds of
/// directories cannot exhaust the process's descriptor budget.
const MAX_WATCHES: usize = 192;

pub struct FsWatcher {
    inner: Mutex<Option<RecommendedWatcher>>,
    /// Paths currently watched, and whether the watch is recursive.
    watched: Mutex<HashMap<PathBuf, bool>>,
    dirty_tx: Sender<PathBuf>,
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
            watched: Mutex::new(HashMap::new()),
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

        // Already covered by this or a broader watch?
        match watched.get(dir) {
            Some(&existing) if existing || !recursive => return,
            _ => {}
        }
        if watched
            .iter()
            .any(|(p, &rec)| rec && p != dir && dir.starts_with(p))
        {
            return;
        }
        if watched.len() >= MAX_WATCHES {
            return;
        }

        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };

        let mut guard = self.inner.lock().unwrap();
        if let Some(w) = guard.as_mut() {
            if w.watch(dir, mode).is_ok() {
                watched.insert(dir.to_path_buf(), recursive);
            }
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
            Err(_) => dirty_rx.try_recv().ok(),
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
