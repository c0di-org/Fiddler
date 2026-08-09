use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::fs_scan::{self, ScanOpts};
use crate::git::status::RepoStatus;
use crate::git::{self, GitCache};
use crate::model::{DirListing, Entry, Kind, Place, RepoInfo, Rollup, WorktreeInfo};
use crate::thumb_pool::{ThumbPool, ThumbReady, ThumbReq};
use crate::watcher::FsWatcher;

pub struct AppState {
    pub cache: Arc<GitCache>,
    pub watcher: Arc<FsWatcher>,
    pub thumbs: Arc<ThumbPool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatusPayload {
    pub root: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub rollup: Rollup,
}

pub fn repo_status_payload(root: &Path, st: &RepoStatus) -> RepoStatusPayload {
    RepoStatusPayload {
        root: root.to_string_lossy().into_owned(),
        branch: st.branch.clone(),
        head: st.head.clone(),
        detached: st.detached,
        upstream: st.upstream.clone(),
        ahead: st.ahead,
        behind: st.behind,
        rollup: st.rollups.get("").copied().unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn list_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    show_hidden: bool,
) -> Result<DirListing, String> {
    let cache = state.cache.clone();
    let watcher = state.watcher.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&path);
        let mut entries = fs_scan::scan(&dir, &ScanOpts { show_hidden }, &cache)?;

        let repo = cache.resolve(&dir);
        let mut status_pending = false;
        let mut worktrees: Vec<WorktreeInfo> = Vec::new();

        if let Some(repo) = &repo {
            // Status for the repo we're inside: needed to badge what's on screen,
            // so it's worth blocking on the first pass.
            match cache.status_blocking(&repo.work_root) {
                // No event here on purpose: the badges are already baked into
                // `entries`, and emitting would make the client re-fetch the very
                // listing it is building.
                Ok(st) => apply_status(&mut entries, &repo.work_root, &st),
                Err(_) => status_pending = true,
            }
            watcher.watch(&repo.work_root, true);

            // Expanding a repo root reveals its worktrees as a synthetic child.
            if repo.work_root == dir && !repo.is_linked_worktree() {
                worktrees = git::worktrees_of(repo);
            }
        } else {
            watcher.watch(&dir, false);
        }

        // Child repos each own their status. Serve whatever is already cached and
        // compute the rest off the critical path so the listing paints immediately.
        let mut to_warm: Vec<PathBuf> = Vec::new();
        for e in entries.iter_mut() {
            if !e.is_repo {
                continue;
            }
            let child = PathBuf::from(&e.path);
            match cache.cached_status(&child) {
                Some(st) => {
                    e.branch = st.branch.clone().or_else(|| st.head.clone()).or(e.branch.take());
                    let r = st.rollups.get("").copied().unwrap_or_default();
                    e.rollup = (!r.is_empty()).then_some(r);
                }
                None => to_warm.push(child),
            }
        }

        for child in to_warm {
            let cache = cache.clone();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if !cache.begin_pass(&child) {
                    return;
                }
                if let Ok(st) = cache.status_blocking(&child) {
                    let _ = app.emit("fiddler:repo-status", repo_status_payload(&child, &st));
                }
                cache.end_pass(&child);
            });
        }

        Ok(DirListing {
            path: dir.to_string_lossy().into_owned(),
            entries,
            repo_root: repo.as_ref().map(|r| r.work_root.to_string_lossy().into_owned()),
            worktrees,
            status_pending,
        })
    })
    .await
    .map_err(|e| format!("listing task failed: {e}"))?
}

/// Badge each entry from the repo's cached status.
fn apply_status(entries: &mut [Entry], work_root: &Path, st: &RepoStatus) {
    for e in entries.iter_mut() {
        let Ok(rel) = Path::new(&e.path).strip_prefix(work_root) else {
            continue;
        };
        let rel = rel.to_string_lossy();
        let is_dir = matches!(e.kind, Kind::Dir);
        // A nested repo is a world of its own — its contents never belong to the
        // parent's status, and submodules would otherwise read as one giant change.
        if e.is_repo && is_dir {
            continue;
        }
        let (code, rollup) = st.lookup(&rel, is_dir);
        e.code = code;
        e.rollup = rollup;
    }
}

#[tauri::command]
pub async fn repo_info(state: State<'_, AppState>, path: String) -> Result<Option<RepoInfo>, String> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&path);
        let Some(repo) = git::discover::repo_at(&dir).map(Arc::new) else {
            return Ok(None);
        };
        let st = cache.status_blocking(&repo.work_root).ok();
        let worktrees = git::worktrees_of(&repo);
        let (head_oid, branch, detached) = git::discover::read_head(&repo.git_dir);

        Ok(Some(RepoInfo {
            root: repo.work_root.to_string_lossy().into_owned(),
            branch: st.as_ref().and_then(|s| s.branch.clone()).or(branch),
            head: st.as_ref().and_then(|s| s.head.clone()).or(head_oid),
            detached: st.as_ref().map(|s| s.detached).unwrap_or(detached),
            upstream: st.as_ref().and_then(|s| s.upstream.clone()),
            ahead: st.as_ref().map(|s| s.ahead).unwrap_or(0),
            behind: st.as_ref().map(|s| s.behind).unwrap_or(0),
            rollup: st
                .as_ref()
                .and_then(|s| s.rollups.get("").copied())
                .unwrap_or_default(),
            worktrees,
        }))
    })
    .await
    .map_err(|e| format!("repo task failed: {e}"))?
}

#[tauri::command]
pub async fn refresh_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<(), String> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root);
        if let Ok(st) = cache.refresh_blocking(&root) {
            let _ = app.emit("fiddler:repo-status", repo_status_payload(&root, &st));
        }
    });
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspect {
    /// Leading text of a small, textual file — the preview pane's fallback when
    /// there's no image to show.
    pub text: Option<String>,
    /// How many things are directly inside, for folders.
    pub child_count: Option<u32>,
    /// The file is there but isn't text and has no preview.
    pub binary: bool,
}

/// Peek at whatever is worth showing in the preview pane. Cheap by construction:
/// at most one `read_dir`, or the first few kilobytes of a file.
#[tauri::command]
pub async fn inspect(path: String) -> Result<Inspect, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;

        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;

        if meta.is_dir() {
            let count = std::fs::read_dir(&p)
                .map(|rd| rd.flatten().filter(|e| e.file_name() != ".DS_Store").count() as u32)
                .ok();
            return Ok(Inspect { text: None, child_count: count, binary: false });
        }

        const PEEK: usize = 8 * 1024;
        let mut buf = vec![0u8; PEEK];
        let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);

        // A NUL byte in the first block is the standard "this is binary" heuristic;
        // it's what `grep` and `git` both use.
        if buf.contains(&0) {
            return Ok(Inspect { text: None, child_count: None, binary: true });
        }

        let text: String = String::from_utf8_lossy(&buf).chars().take(4000).collect();
        Ok(Inspect { text: Some(text), child_count: None, binary: false })
    })
    .await
    .map_err(|e| format!("inspect task failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHead {
    pub text: String,
    /// The file continues past what we read.
    pub truncated: bool,
    /// Size of the whole file, so the reader can say how much it isn't showing.
    pub bytes: u64,
    /// Lines in the part we read.
    pub lines: u32,
    pub binary: bool,
}

/// Read the front of a text file for a preview.
///
/// Bounded on purpose: a preview of a 400MB log is still just the first screen
/// of it, and reading the rest would cost a stall the user never asked for. The
/// cut is made on a character boundary so the tail never arrives as a replacement
/// glyph.
#[tauri::command]
pub async fn read_text(path: String, max_bytes: usize) -> Result<TextHead, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;

        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            return Err("that is a folder".into());
        }

        let cap = max_bytes.clamp(1024, 4 * 1024 * 1024);
        // `take` + `read_to_end` rather than one `read`: a single read is
        // allowed to come back short, which would silently cut the preview.
        let mut buf = Vec::with_capacity(cap.min(meta.len() as usize + 1));
        let f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        f.take(cap as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        let n = buf.len();

        if buf.contains(&0) {
            return Ok(TextHead {
                text: String::new(),
                truncated: false,
                bytes: meta.len(),
                lines: 0,
                binary: true,
            });
        }

        // Trim back to the last whole character, so a multi-byte sequence split
        // by the read boundary is dropped rather than mangled.
        let text = match std::str::from_utf8(&buf) {
            Ok(s) => s.to_string(),
            Err(e) => String::from_utf8_lossy(&buf[..e.valid_up_to()]).into_owned(),
        };

        Ok(TextHead {
            lines: text.lines().count() as u32,
            truncated: (n as u64) < meta.len(),
            bytes: meta.len(),
            binary: false,
            text,
        })
    })
    .await
    .map_err(|e| format!("read task failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMeta {
    pub pages: u32,
    /// First page's width over height, so the viewer can hold the right shape
    /// open while the render is still in flight.
    pub aspect: f64,
}

#[tauri::command]
pub async fn pdf_meta(path: String) -> Result<PdfMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::page::meta(Path::new(&path)).map(|m| PdfMeta { pages: m.pages, aspect: m.aspect })
    })
    .await
    .map_err(|e| format!("pdf task failed: {e}"))?
}

/// Rasterise one page of a PDF at `max_px` on its longest side, returning the
/// cached image's path. Pages already rendered at this size cost a single `stat`.
#[tauri::command]
pub async fn pdf_page(path: String, page: u32, max_px: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::page::cached_render(Path::new(&path), page, max_px.clamp(64, 4096))
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("pdf task failed: {e}"))?
}

/// Declare the full set of tiles currently worth rendering, nearest-to-viewport
/// first. This supersedes the previous set, so anything scrolled past is
/// abandoned before it costs a decode. Whatever is already cached comes back
/// here; the rest arrives later on `fiddler:thumbs`.
#[tauri::command]
pub async fn thumbnails(
    state: State<'_, AppState>,
    wanted: Vec<ThumbReq>,
) -> Result<Vec<ThumbReady>, String> {
    let thumbs = state.thumbs.clone();
    // A cache probe is one `stat` per tile — cheap, but a viewport's worth of
    // them still doesn't belong on the async runtime's shoulders.
    tauri::async_runtime::spawn_blocking(move || thumbs.request(wanted))
        .await
        .map_err(|e| format!("thumbnail task failed: {e}"))
}

/// Path to a cached preview for a single file, generating it if needed. This is
/// the preview pane's route: one file, wanted right now, so it skips the queue.
#[tauri::command]
pub async fn thumbnail(path: String, size: u32) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !crate::thumb::can_thumbnail(&p) {
            return None;
        }
        crate::thumb::generate(&p, size)
            .ok()
            .map(|c| c.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("thumbnail task failed: {e}"))
}

#[tauri::command]
pub fn sidebar_places() -> Vec<Place> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut out = Vec::new();
    let mut push = |name: &str, p: PathBuf, icon: &str| {
        if p.is_dir() {
            out.push(Place {
                name: name.to_string(),
                path: p.to_string_lossy().into_owned(),
                icon: icon.to_string(),
            });
        }
    };

    push("Developer", home.join("Developer"), "code");
    push("Home", home.clone(), "home");
    push("Desktop", home.join("Desktop"), "desktop");
    push("Documents", home.join("Documents"), "doc");
    push("Downloads", home.join("Downloads"), "download");
    out
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_terminal_here(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Terminal"])
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, parent: String, name: String) -> Result<String, String> {
    let target = safe_child(&parent, &name)?;
    std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    state.cache.forget_discovery_under(Path::new(&parent));
    state.watcher.poke(Path::new(&parent));
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn rename_path(state: State<'_, AppState>, path: String, new_name: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let parent = src.parent().ok_or("cannot rename the filesystem root")?;
    let dst = safe_child(&parent.to_string_lossy(), &new_name)?;
    if dst.exists() {
        return Err(format!("“{new_name}” already exists here"));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    state.cache.forget_discovery_under(parent);
    state.watcher.poke(parent);
    Ok(dst.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn trash_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    // Always the Trash, never `remove_file` — a file browser must not make deletions
    // that the user cannot walk back.
    trash::delete_all(&paths).map_err(|e| e.to_string())?;
    for p in &paths {
        if let Some(parent) = Path::new(p).parent() {
            state.cache.forget_discovery_under(parent);
            state.watcher.poke(parent);
        }
    }
    Ok(())
}

/// The user's macOS accent colour (System Settings › Appearance), as sRGB bytes.
///
/// The obvious route — CSS's `AccentColor` system keyword — is supported by this
/// WebView but always answers the default blue, whatever the user has actually
/// chosen. So the real value is read from AppKit, which is also what makes
/// "Multicolour" and Graphite come out right rather than needing a lookup table.
#[tauri::command]
pub async fn system_accent(app: AppHandle) -> Option<[u8; 3]> {
    let (tx, rx) = std::sync::mpsc::channel();
    // NSColor is main-thread-only, and commands run off it.
    app.run_on_main_thread(move || {
        let _ = tx.send(read_accent());
    })
    .ok()?;
    // Bounded so a wedged event loop can't pin this worker; the caller treats a
    // miss as "no system accent" and carries on with the current colour.
    rx.recv_timeout(std::time::Duration::from_millis(500)).ok().flatten()
}

#[cfg(target_os = "macos")]
fn read_accent() -> Option<[u8; 3]> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    // SAFETY: all four selectors are read-only AppKit accessors, called on the
    // main thread, and each result is null-checked before it is used again.
    unsafe {
        let color: *mut AnyObject = msg_send![class!(NSColor), controlAccentColor];
        if color.is_null() {
            return None;
        }
        // controlAccentColor lives in a catalog colour space with no components;
        // it has to be converted before red/green/blueComponent are legal.
        let space: *mut AnyObject = msg_send![class!(NSColorSpace), sRGBColorSpace];
        if space.is_null() {
            return None;
        }
        let srgb: *mut AnyObject = msg_send![color, colorUsingColorSpace: space];
        if srgb.is_null() {
            return None;
        }

        let r: f64 = msg_send![srgb, redComponent];
        let g: f64 = msg_send![srgb, greenComponent];
        let b: f64 = msg_send![srgb, blueComponent];
        Some([channel(r), channel(g), channel(b)])
    }
}

#[cfg(not(target_os = "macos"))]
fn read_accent() -> Option<[u8; 3]> {
    None
}

#[cfg(target_os = "macos")]
fn channel(v: f64) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Join `name` onto `parent`, rejecting anything that would escape it.
fn safe_child(parent: &str, name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\0') || trimmed == "." || trimmed == ".." {
        return Err("Name cannot contain “/”".into());
    }
    Ok(Path::new(parent).join(trimmed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_child_rejects_traversal() {
        assert!(safe_child("/tmp", "../etc").is_err());
        assert!(safe_child("/tmp", "..").is_err());
        assert!(safe_child("/tmp", "a/b").is_err());
        assert!(safe_child("/tmp", "  ").is_err());
        assert_eq!(safe_child("/tmp", "ok.txt").unwrap(), PathBuf::from("/tmp/ok.txt"));
    }
}
