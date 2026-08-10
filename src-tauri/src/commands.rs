use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::content_search::{self, ContentSearch};
use crate::fs_scan::{self, ScanOpts};
use crate::git::status::RepoStatus;
use crate::git::{self, GitCache};
use crate::model::{DirListing, Entry, Kind, Place, RepoInfo, Rollup, WorktreeInfo};
#[cfg(not(target_os = "android"))]
use crate::mtp::{self, MtpService, UsbDevice};
use crate::nearby::{self, NearbySearch};
use crate::peers::{self, PairingInfo, PeerDevice, PeerService};
use crate::thumb_pool::{ThumbPool, ThumbReady, ThumbReq};
use crate::watcher::FsWatcher;

pub struct AppState {
    pub cache: Arc<GitCache>,
    pub watcher: Arc<FsWatcher>,
    pub thumbs: Arc<ThumbPool>,
    pub peers: Arc<PeerService>,
    #[cfg(not(target_os = "android"))]
    pub usb: Arc<MtpService>,
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
    if let Some((device, remote_path)) = peers::parse_remote_path(&path) {
        return state.peers.remote_listing(&device, &remote_path, show_hidden);
    }
    // A USB device listing crosses a cable and a worker thread, so it goes to the
    // blocking pool rather than parking the async executor behind a phone.
    #[cfg(not(target_os = "android"))]
    if mtp::path::parse(&path).is_some() {
        let usb = state.usb.clone();
        return tauri::async_runtime::spawn_blocking(move || usb.listing(&path, show_hidden))
            .await
            .map_err(|e| e.to_string())?;
    }
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
                    e.branch = st
                        .branch
                        .clone()
                        .or_else(|| st.head.clone())
                        .or(e.branch.take());
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
            repo_root: repo
                .as_ref()
                .map(|r| r.work_root.to_string_lossy().into_owned()),
            worktrees,
            status_pending,
        })
    })
    .await
    .map_err(|e| format!("listing task failed: {e}"))?
}

/// Devices discovered on the same local network. Presence alone grants no file access.
#[tauri::command]
pub fn nearby_devices(state: State<'_, AppState>) -> Vec<PeerDevice> { state.peers.devices() }

/// Devices attached by USB, each with the stage it has reached. Unlike
/// `nearby_devices` there is nothing to pair: the cable is the authorisation.
/// A device shows up here from the moment it enumerates, including while it is
/// still waiting to be unlocked, which is the point.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn usb_devices(state: State<'_, AppState>) -> Vec<UsbDevice> { state.usb.devices() }

/// Quit the process holding a USB device, when Fiddler recognises it.
///
/// macOS launches `ptpcamerad` at every phone that appears, and it holds the
/// device without being able to transfer a file from it — so the usual state of
/// a plugged-in Android is "claimed by something that cannot use it". The poll
/// loop reconnects on its own once it lets go, so this is the whole fix.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn release_usb_device(state: State<'_, AppState>, serial: String) -> Result<String, String> {
    let device = state
        .usb
        .devices()
        .into_iter()
        .find(|device| device.serial == serial)
        .ok_or("That device is no longer attached")?;
    match device.stage {
        mtp::Stage::Blocked { owner: Some(owner), owner_pid: Some(pid) } => {
            mtp::release(&owner, pid)
        }
        mtp::Stage::Blocked { .. } => {
            Err("Something is holding this device, but macOS didn't say what".into())
        }
        _ => Err("Nothing is holding this device".into()),
    }
}

/// Show this short code on the device that is being browsed for the first time.
#[tauri::command]
pub fn nearby_pairing_info(state: State<'_, AppState>) -> PairingInfo { state.peers.pairing_info() }

#[tauri::command]
pub fn pair_nearby_device(state: State<'_, AppState>, id: String, code: String) -> Result<(), String> { state.peers.pair(&id, &code) }

/// Scan just below the visible folder when its local search has no match. This
/// is deliberately a separate IPC route: normal typing never invokes it.
#[tauri::command]
pub async fn nearby_entries(
    path: String,
    show_hidden: bool,
    max_depth: u8,
) -> Result<NearbySearch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        nearby::scan(&PathBuf::from(path), show_hidden, max_depth)
    })
    .await
    .map_err(|e| format!("nearby search task failed: {e}"))?
}

/// Search the text contents of direct children the client has already listed.
/// The worker keeps its own byte and file limits; this never walks directories.
#[tauri::command]
pub async fn search_contents(
    path: String,
    names: Vec<String>,
    terms: Vec<String>,
) -> Result<ContentSearch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(content_search::search(&PathBuf::from(path), &names, &terms))
    })
    .await
    .map_err(|e| format!("content search task failed: {e}"))?
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
pub async fn repo_info(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<RepoInfo>, String> {
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
                .map(|rd| {
                    rd.flatten()
                        .filter(|e| e.file_name() != ".DS_Store")
                        .count() as u32
                })
                .ok();
            return Ok(Inspect {
                text: None,
                child_count: count,
                binary: false,
            });
        }

        const PEEK: usize = 8 * 1024;
        let mut buf = vec![0u8; PEEK];
        let mut f = std::fs::File::open(&p).map_err(|e| e.to_string())?;
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);

        // A NUL byte in the first block is the standard "this is binary" heuristic;
        // it's what `grep` and `git` both use.
        if buf.contains(&0) {
            return Ok(Inspect {
                text: None,
                child_count: None,
                binary: true,
            });
        }

        let text: String = String::from_utf8_lossy(&buf).chars().take(4000).collect();
        Ok(Inspect {
            text: Some(text),
            child_count: None,
            binary: false,
        })
    })
    .await
    .map_err(|e| format!("inspect task failed: {e}"))?
}

/// One child worth showing on the face of a folder's icon.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// A preview can be produced for this file.
    pub thumbable: bool,
}

/// The first few children of a folder, in the order the browser would show them.
///
/// Deliberately not `list_dir`: this runs for every folder icon on screen, so it
/// does one `read_dir`, no per-entry `stat`, no git probing, and keeps only the
/// `limit` leading names rather than materialising a listing of tens of
/// thousands of entries to throw all but three of them away.
#[tauri::command]
pub async fn folder_peek(
    path: String,
    show_hidden: bool,
    limit: usize,
) -> Result<Vec<PeekItem>, String> {
    // Peeking into a paired device's folder would cost a network round trip per
    // icon on screen. Remote folders keep the plain glyph.
    if peers::parse_remote_path(&path).is_some() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 4);

    tauri::async_runtime::spawn_blocking(move || {
        // Enough to order any folder a person assembled by hand. Past this the
        // leading names are a guess either way, and an icon is not worth the walk.
        const MAX_SCAN: usize = 4096;

        let rd = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
        let mut best: Vec<PeekItem> = Vec::with_capacity(limit + 1);

        for ent in rd.flatten().take(MAX_SCAN) {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name == ".DS_Store" || (!show_hidden && name.starts_with('.')) {
                continue;
            }
            let Ok(ft) = ent.file_type() else { continue };
            let child = ent.path();
            // `is_dir()` on the path is a `stat`, so it is spent only on symlinks.
            let is_dir = ft.is_dir() || (ft.is_symlink() && child.is_dir());

            // An insertion sort into a list of at most `limit`: the folder is
            // walked once and never held in memory beyond these few entries.
            if best.len() == limit && !precedes((is_dir, &name), &best[limit - 1]) {
                continue;
            }
            let at = best
                .iter()
                .position(|held| precedes((is_dir, &name), held))
                .unwrap_or(best.len());
            best.insert(
                at,
                PeekItem {
                    thumbable: !is_dir && crate::thumb::can_thumbnail(&child),
                    path: child.to_string_lossy().into_owned(),
                    name,
                    is_dir,
                },
            );
            best.truncate(limit);
        }

        Ok(best)
    })
    .await
    .map_err(|e| format!("folder peek task failed: {e}"))?
}

fn precedes(candidate: (bool, &str), held: &PeekItem) -> bool {
    fs_scan::display_cmp(candidate, (held.is_dir, &held.name)) == Ordering::Less
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
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
pub async fn read_text(
    state: State<'_, AppState>,
    path: String,
    max_bytes: usize,
) -> Result<TextHead, String> {
    if let Some((device, remote_path)) = peers::parse_remote_path(&path) {
        return state.peers.read_remote_text(&device, &remote_path, max_bytes);
    }
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
        f.take(cap as u64)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
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
        crate::page::meta(Path::new(&path)).map(|m| PdfMeta {
            pages: m.pages,
            aspect: m.aspect,
        })
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
    #[cfg(target_os = "android")]
    {
        // Android app sandboxes have a private home directory, which is not the
        // place a DeX user keeps projects. Fiddler is a file browser, so begin
        // at shared storage once the user grants All files access in Android's
        // settings screen (opened by MainActivity on first launch).
        let shared = PathBuf::from("/storage/emulated/0");
        return vec![
            Place {
                name: "Internal storage".into(),
                path: shared
                    .clone()
                    .into_os_string()
                    .to_string_lossy()
                    .into_owned(),
                icon: "home".into(),
            },
            Place {
                name: "Downloads".into(),
                path: shared.join("Download").to_string_lossy().into_owned(),
                icon: "download".into(),
            },
            Place {
                name: "Documents".into(),
                path: shared.join("Documents").to_string_lossy().into_owned(),
                icon: "doc".into(),
            },
            Place {
                name: "Projects".into(),
                path: shared.join("Projects").to_string_lossy().into_owned(),
                icon: "folder".into(),
            },
        ];
    }

    #[cfg(not(target_os = "android"))]
    {
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
}

#[tauri::command]
pub fn install_apk(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("apk"))
    {
        return Err("that file is not an APK".into());
    }
    crate::apk::install(&path)
}

#[tauri::command]
#[cfg(target_os = "macos")]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn reveal_in_finder(_path: String) -> Result<(), String> {
    Err("Reveal in Finder is only available on macOS".into())
}

#[tauri::command]
#[cfg(target_os = "macos")]
pub fn open_terminal_here(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Terminal"])
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn open_terminal_here(_path: String) -> Result<(), String> {
    Err("Opening a terminal is only available on macOS".into())
}

#[tauri::command]
pub fn create_folder(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> Result<String, String> {
    local_only(&parent)?;
    let target = safe_child(&parent, &name)?;
    std::fs::create_dir(&target).map_err(|e| e.to_string())?;
    state.cache.forget_discovery_under(Path::new(&parent));
    state.watcher.poke(Path::new(&parent));
    Ok(target.to_string_lossy().into_owned())
}

/// Create a UTF-8 text file without ever overwriting an existing item. Keeping
/// this separate from `write_text_file` makes the first save conservative: a
/// typo in a new filename cannot erase a neighbouring document.
#[tauri::command]
pub fn create_text_file(
    state: State<'_, AppState>,
    parent: String,
    name: String,
    text: String,
) -> Result<String, String> {
    local_only(&parent)?;
    let target = safe_child(&parent, &name)?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!("“{name}” already exists here"));
        }
        Err(e) => return Err(e.to_string()),
    }
    state.cache.forget_discovery_under(Path::new(&parent));
    state.watcher.poke(Path::new(&parent));
    Ok(target.to_string_lossy().into_owned())
}

/// Replace a text file through a sibling temporary file, then rename it into
/// place. Both Android's shared storage and desktop filesystems see either the
/// old complete document or the new complete document, never a partial save.
#[tauri::command]
pub fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> Result<(), String> {
    use std::io::Write;

    let target = PathBuf::from(&path);
    let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("that is not a regular file".into());
    }
    let parent = target.parent().ok_or("cannot write the filesystem root")?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid file name")?;
    let temp = parent.join(format!(".{file_name}.fiddler-save-{}", std::process::id()));
    if temp.exists() {
        return Err("a previous save is still being finalized; please try again".into());
    }

    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result?;
    state.cache.forget_discovery_under(parent);
    state.watcher.poke(parent);
    Ok(())
}

#[tauri::command]
pub fn rename_path(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    local_only(&path)?;
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

/// Copy items into a folder without overwriting anything already there. This is
/// intentionally the one transfer primitive the renderer needs: paste, a drop
/// target, and later a nearby-device stream can all call the same operation.
#[tauri::command]
pub async fn copy_paths(
    state: State<'_, AppState>,
    paths: Vec<String>,
    destination: String,
) -> Result<Vec<String>, String> {
    let cache = state.cache.clone();
    let watcher = state.watcher.clone();
    let peer_service = state.peers.clone();
    #[cfg(not(target_os = "android"))]
    let usb = state.usb.clone();

    // A copy is unbounded work — a folder of photos on disk, a video across a
    // USB cable — so none of it runs on the thread that draws the window.
    tauri::async_runtime::spawn_blocking(move || {
        // A phone on a cable is not a filesystem path: it has no `is_dir`, and
        // treating it as one is what used to answer "Paste destination is not a
        // folder" for a perfectly good folder on a device.
        #[cfg(not(target_os = "android"))]
        if mtp::path::parse(&destination).is_some() {
            return copy_onto_device(&usb, &paths, &destination);
        }
        if peers::parse_remote_path(&destination).is_some() || paths.iter().any(|path| peers::parse_remote_path(path).is_some()) {
            if peers::parse_remote_path(&destination).is_some() { return Err("Pasting onto Android is not ready yet".into()); }
            let destination = PathBuf::from(&destination);
            if !destination.is_dir() { return Err("Paste destination is not a folder".into()); }
            let mut copied = Vec::new();
            for source in paths {
                let (device, remote_path) = peers::parse_remote_path(&source).ok_or("Mixed local and remote copies are not supported")?;
                let name = Path::new(&remote_path).file_name().and_then(|name| name.to_str()).ok_or("Invalid file name")?;
                let target = copy_name(&destination, name);
                let bytes = peer_service.download(&device, &remote_path)?;
                std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
                copied.push(target.to_string_lossy().into_owned());
            }
            cache.forget_discovery_under(&destination);
            watcher.poke(&destination);
            return Ok(copied);
        }
        // Reading off a device is bounded byte-range work the copy path doesn't
        // do yet. Say that, rather than letting a `mtp://` string reach the
        // filesystem and come back as "No such file or directory".
        #[cfg(not(target_os = "android"))]
        if paths.iter().any(|path| mtp::path::parse(path).is_some()) {
            return Err("Copying files off a device isn't ready yet".into());
        }
        let destination = PathBuf::from(&destination);
        if !destination.is_dir() { return Err("Paste destination is not a folder".into()); }
        let mut copied = Vec::new();
        for source in paths {
            let source = PathBuf::from(source);
            let name = source.file_name().and_then(|name| name.to_str()).ok_or("Invalid file name")?;
            let target = copy_name(&destination, name);
            copy_tree(&source, &target)?;
            copied.push(target.to_string_lossy().into_owned());
        }
        cache.forget_discovery_under(&destination);
        watcher.poke(&destination);
        Ok(copied)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Paste onto a phone or camera over USB.
///
/// Sources have to be local. Two devices cannot be copied between directly —
/// each one has a single session, and neither can hold the other's bytes — so
/// say that up front rather than failing partway through the first file.
#[cfg(not(target_os = "android"))]
fn copy_onto_device(
    usb: &MtpService,
    paths: &[String],
    destination: &str,
) -> Result<Vec<String>, String> {
    let mut copied = Vec::new();
    for source in paths {
        if peers::parse_remote_path(source).is_some() || mtp::path::parse(source).is_some() {
            return Err("Copy that to the Mac first — Fiddler can't move files straight from one device to another".into());
        }
        copied.push(usb.upload(destination, Path::new(source))?);
    }
    Ok(copied)
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        std::fs::create_dir(target).map_err(|e| e.to_string())?;
        for child in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            copy_tree(&child.path(), &target.join(child.file_name()))?;
        }
    } else {
        std::fs::copy(source, target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_name(parent: &Path, name: &str) -> PathBuf {
    let first = parent.join(name);
    if !first.exists() { return first; }
    let file = Path::new(name);
    let stem = file.file_stem().and_then(|part| part.to_str()).unwrap_or(name);
    let extension = file.extension().and_then(|part| part.to_str()).map(|part| format!(".{part}")).unwrap_or_default();
    for number in 1..10_000 {
        let suffix = if number == 1 { " copy".to_string() } else { format!(" copy {number}") };
        let candidate = parent.join(format!("{stem}{suffix}{extension}"));
        if !candidate.exists() { return candidate; }
    }
    parent.join(format!("{stem} copy-{}{}", std::process::id(), extension))
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub fn trash_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    for path in &paths {
        local_only(path)?;
    }
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

#[tauri::command]
#[cfg(target_os = "android")]
pub fn trash_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    // Android does not expose a general-purpose Trash API for arbitrary paths.
    // The UI calls this only after an explicit permanent-delete confirmation.
    // Use `symlink_metadata` so deleting a symlink removes the link itself,
    // never the directory it happens to point at.
    if paths.is_empty() {
        return Ok(());
    }

    let mut parents = Vec::with_capacity(paths.len());
    for path in &paths {
        local_only(path)?;
        let target = Path::new(path);
        let parent = target.parent().ok_or("cannot delete the filesystem root")?;
        // Check every target before making any change. This avoids a stale
        // multi-selection partly succeeding just because one entry vanished.
        std::fs::symlink_metadata(target).map_err(|e| e.to_string())?;
        parents.push(parent.to_path_buf());
    }

    for path in &paths {
        let target = Path::new(path);
        let meta = std::fs::symlink_metadata(target).map_err(|e| e.to_string())?;
        if meta.file_type().is_dir() {
            std::fs::remove_dir_all(target).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(target).map_err(|e| e.to_string())?;
        }
    }

    for parent in parents {
        state.cache.forget_discovery_under(&parent);
        state.watcher.poke(&parent);
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
    rx.recv_timeout(std::time::Duration::from_millis(500))
        .ok()
        .flatten()
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

/// Where the mutating commands stop.
///
/// `create_folder`, `create_text_file`, `rename_path` and `trash_paths` are
/// `std::fs` calls, and neither `mtp://RFCY71NMVTA/65537/DCIM` nor
/// `fiddler://abc/Documents` is a path — `Path` reads them as relative, so they
/// resolve against the process's working directory and fail somewhere the
/// message can only confuse. The renderer already leaves those menu items out
/// on a device; this is what makes that a rule rather than an observation.
///
/// `copy_paths` is deliberately not on the list: it knows what a device is, and
/// pasting onto one goes over the cable rather than through `std::fs`.
fn local_only(path: &str) -> Result<(), String> {
    let space = if path.starts_with("mtp://") {
        "a connected device"
    } else if path.starts_with("fiddler://") {
        "a nearby device"
    } else {
        return Ok(());
    };
    Err(format!("Fiddler cannot change files on {space} yet"))
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
    fn the_mutating_commands_only_accept_real_paths() {
        assert!(local_only("/Users/codi/Developer").is_ok());
        // A local file is not disqualified by what it happens to be called.
        assert!(local_only("/Users/codi/notes on mtp://.txt").is_ok());
        assert_eq!(
            local_only("mtp://RFCY71NMVTA/65537/DCIM"),
            Err("Fiddler cannot change files on a connected device yet".into())
        );
        assert_eq!(
            local_only("fiddler://abc123/Documents"),
            Err("Fiddler cannot change files on a nearby device yet".into())
        );
    }

    #[test]
    fn safe_child_rejects_traversal() {
        assert!(safe_child("/tmp", "../etc").is_err());
        assert!(safe_child("/tmp", "..").is_err());
        assert!(safe_child("/tmp", "a/b").is_err());
        assert!(safe_child("/tmp", "  ").is_err());
        assert_eq!(
            safe_child("/tmp", "ok.txt").unwrap(),
            PathBuf::from("/tmp/ok.txt")
        );
    }
}
