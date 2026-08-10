//! Small, local-first peer transport for Fiddler devices.
//!
//! Discovery is broadcast-only and contains no filesystem information. A device
//! becomes usable only after someone on it has tapped Allow for the device
//! asking — two taps, one on each side, and no code to read out. Thereafter
//! every request carries an opaque per-device bearer token. There is
//! deliberately no cloud account or relay in this first transport.
//!
//! Discovery alone authorises nothing. A broadcast is trivial to forge on a
//! shared network, so it decides only what appears in the sidebar; the gate on
//! anyone's files is the tap.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::fs_scan::{self, ScanOpts};
use crate::git::GitCache;
use crate::model::{DirListing, Entry};

const DISCOVERY_PORT: u16 = 43_562;
const MAX_HTTP: usize = 512 * 1024 * 1024;
/// How long an unanswered ask stays on screen before it is dropped. Long enough
/// to walk to the other device, short enough that a stale card never lingers.
const ASK_TTL: u64 = 60;
/// Connections served at once. A file browser needs a handful; the cap is only
/// here so a host on the network can't spend our threads.
const MAX_CONNECTIONS: usize = 32;
/// Asks held at once, so a device that spams cannot bury a real one.
const MAX_ASKS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDevice {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub paired: bool,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub id: String,
    pub name: String,
    pub root: String,
}

/// A device asking to browse this one. It holds no access at all: this is a
/// question on someone's screen until they answer it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub id: String,
    pub name: String,
    pub platform: String,
}

/// What came back from asking a device to pair. The answer is a tap over there,
/// so `Waiting` is the normal first reply rather than a failure.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PairOutcome {
    Paired,
    Waiting,
    Declined,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    id: String,
    name: String,
    port: u16,
    #[serde(default)]
    visible: Vec<String>,
    #[serde(default)]
    platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KnownPeer {
    name: String,
    host: String,
    port: u16,
    token: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SavedPeers {
    id: String,
    #[serde(default)]
    name: String,
    known: BTreeMap<String, KnownPeer>,
    clients: BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct PeerService {
    state: Arc<Mutex<PeerState>>,
    config: PathBuf,
    root: PathBuf,
    cache: Arc<GitCache>,
    connections: Arc<AtomicUsize>,
}

struct PeerState {
    id: String,
    name: String,
    port: u16,
    known: BTreeMap<String, KnownPeer>,
    clients: BTreeMap<String, String>,
    seen: BTreeMap<String, SeenPeer>,
    asks: BTreeMap<String, Ask>,
}

/// One device's request to browse this one, and the answer if it has been given.
struct Ask {
    name: String,
    platform: String,
    /// When this was last touched — the request arriving, or being answered.
    at: u64,
    /// `None` until someone here taps Allow or Not now.
    decision: Option<bool>,
}

#[derive(Clone)]
struct SeenPeer {
    name: String,
    host: String,
    port: u16,
    seen_at: u64,
    mutual: bool,
    platform: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    token: String,
    root: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteListing {
    path: String,
    entries: Vec<Entry>,
}

impl PeerService {
    pub fn start(config_dir: PathBuf, cache: Arc<GitCache>) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        let config = config_dir.join("peers.json");
        let saved = fs::read(&config)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SavedPeers>(&bytes).ok())
            .unwrap_or_default();
        let id = if saved.id.is_empty() { Uuid::new_v4().to_string() } else { saved.id };
        let name = if saved.name.is_empty() { friendly_name(&id) } else { saved.name };
        let root = share_root();
        let service = Arc::new(Self {
            state: Arc::new(Mutex::new(PeerState {
                id,
                name,
                port: 0,
                known: saved.known,
                clients: saved.clients,
                seen: BTreeMap::new(),
                asks: BTreeMap::new(),
            })),
            config,
            root,
            cache,
            connections: Arc::new(AtomicUsize::new(0)),
        });

        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        service.state.lock().unwrap().port = listener.local_addr().map_err(|e| e.to_string())?.port();
        service.save();

        let server = service.clone();
        thread::spawn(move || server.serve(listener));
        let discover = service.clone();
        thread::spawn(move || discover.discover());
        Ok(service)
    }

    pub fn devices(&self) -> Vec<PeerDevice> {
        let now = now_secs();
        let mut st = self.state.lock().unwrap();
        let seen = st.seen.clone();
        let mut devices = Vec::new();
        for (id, peer) in seen {
            if id == st.id || !peer.mutual || now.saturating_sub(peer.seen_at) >= 8 { continue; }
            // A phone can get a new DHCP address, and the listener intentionally
            // chooses a fresh port at every launch. Discovery refreshes a trusted
            // device's route before anyone tries to open it.
            let paired = if let Some(known) = st.known.get_mut(&id) {
                known.host = peer.host.clone();
                known.port = peer.port;
                known.name = peer.name.clone();
                true
            } else { false };
            devices.push(PeerDevice { id, name: peer.name, host: peer.host, port: peer.port, paired, platform: peer.platform });
        }
        devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        devices
    }

    pub fn pairing_info(&self) -> PairingInfo {
        let st = self.state.lock().unwrap();
        PairingInfo { id: st.id.clone(), name: st.name.clone(), root: self.root.to_string_lossy().into_owned() }
    }

    /// Ask a device for permission to browse it.
    ///
    /// The answer is a tap on that device, so this returns as soon as the ask
    /// has been delivered and the caller polls until it stops being `Waiting`.
    /// Nothing is saved and nothing is readable until the answer is yes.
    pub fn pair(&self, id: &str) -> Result<PairOutcome, String> {
        let peer = self.state.lock().unwrap().seen.get(id).cloned().ok_or("That device is no longer nearby")?;
        let (local_id, local_name) = { let state = self.state.lock().unwrap(); (state.id.clone(), state.name.clone()) };
        let query = format!("deviceId={}&name={}&platform={}", enc(&local_id), enc(&local_name), enc(&platform_name()));
        let (status, body) = fetch(&peer.host, peer.port, &format!("/v1/pair?{query}"), None)?;
        match status {
            200 => {
                let reply: PairResponse = serde_json::from_slice(&body).map_err(|_| "The device returned an invalid pairing response")?;
                let mut st = self.state.lock().unwrap();
                st.known.insert(id.to_string(), KnownPeer { name: peer.name, host: peer.host, port: peer.port, token: reply.token });
                drop(st);
                self.save();
                Ok(PairOutcome::Paired)
            }
            202 => Ok(PairOutcome::Waiting),
            403 => Ok(PairOutcome::Declined),
            _ => Err(message(&body, "That device wouldn’t answer")),
        }
    }

    /// Devices currently asking to browse this one, for the prompt in the UI.
    pub fn requests(&self) -> Vec<PairRequest> {
        let now = now_secs();
        let mut st = self.state.lock().unwrap();
        st.asks.retain(|_, ask| now.saturating_sub(ask.at) < ASK_TTL);
        st.asks
            .iter()
            .filter(|(_, ask)| ask.decision.is_none())
            .map(|(id, ask)| PairRequest { id: id.clone(), name: ask.name.clone(), platform: ask.platform.clone() })
            .collect()
    }

    /// Answer one. The asking device is still polling `/v1/pair`, and collects
    /// a token on its next try if the answer was yes.
    pub fn respond(&self, id: &str, allow: bool) {
        let mut st = self.state.lock().unwrap();
        if let Some(ask) = st.asks.get_mut(id) {
            ask.decision = Some(allow);
            ask.at = now_secs();
        }
    }

    pub fn remote_listing(&self, device_id: &str, path: &str, show_hidden: bool) -> Result<DirListing, String> {
        let peer = self.known(device_id)?;
        let route = format!("/v1/list?path={}&hidden={}", enc(path), show_hidden as u8);
        let bytes = request(&peer.host, peer.port, &route, Some(&peer.token))?;
        let listing: RemoteListing = serde_json::from_slice(&bytes).map_err(|_| "The device returned an invalid folder listing")?;
        let base = remote_path(device_id, &listing.path);
        let entries = listing.entries.into_iter().map(|mut entry| {
            entry.path = remote_path(device_id, &entry.path);
            entry
        }).collect();
        Ok(DirListing { path: base, entries, repo_root: None, worktrees: vec![], status_pending: false })
    }

    pub fn read_remote_text(&self, device_id: &str, path: &str, max_bytes: usize) -> Result<crate::commands::TextHead, String> {
        let peer = self.known(device_id)?;
        let route = format!("/v1/text?path={}&max={}", enc(path), max_bytes.clamp(1024, 4 * 1024 * 1024));
        let bytes = request(&peer.host, peer.port, &route, Some(&peer.token))?;
        serde_json::from_slice(&bytes).map_err(|_| "The device returned invalid text".to_string())
    }

    /// Streams through the authenticated peer transport. The command layer writes
    /// this into a collision-free local name, so the remote device never needs
    /// access to the Mac filesystem.
    pub fn download(&self, device_id: &str, path: &str) -> Result<Vec<u8>, String> {
        let peer = self.known(device_id)?;
        request(&peer.host, peer.port, &format!("/v1/file?path={}", enc(path)), Some(&peer.token))
    }

    fn known(&self, id: &str) -> Result<KnownPeer, String> {
        self.state.lock().unwrap().known.get(id).cloned().ok_or_else(|| "Pair with this device first".to_string())
    }

    fn save(&self) {
        let st = self.state.lock().unwrap();
        let saved = SavedPeers { id: st.id.clone(), name: st.name.clone(), known: st.known.clone(), clients: st.clients.clone() };
        drop(st);
        let temp = self.config.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec(&saved) {
            if fs::write(&temp, bytes).is_ok() {
                // This file holds bearer tokens in both directions. Nobody but
                // this account has any business reading it.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(0o600));
                }
                let _ = fs::rename(temp, &self.config);
            }
        }
    }

    fn serve(self: Arc<Self>, listener: TcpListener) {
        loop {
            match listener.accept() {
                Ok((stream, from)) => {
                    if self.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                        self.connections.fetch_sub(1, Ordering::SeqCst);
                        continue; // Dropping the stream closes it.
                    }
                    let this = self.clone();
                    thread::spawn(move || {
                        this.handle(stream, from.ip());
                        this.connections.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(60)),
                Err(_) => thread::sleep(Duration::from_millis(250)),
            }
        }
    }

    fn handle(&self, mut stream: TcpStream, from: IpAddr) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
        let mut request_bytes = Vec::new();
        let mut chunk = [0u8; 2048];
        while request_bytes.len() < 16 * 1024 && !request_bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            let Ok(count) = stream.read(&mut chunk) else { return; };
            if count == 0 { return; }
            request_bytes.extend_from_slice(&chunk[..count]);
        }
        let text = String::from_utf8_lossy(&request_bytes);
        let mut lines = text.lines();
        let Some(first) = lines.next() else { return };
        let mut parts = first.split_whitespace();
        if parts.next() != Some("GET") { return write_http(&mut stream, 405, b"method not allowed"); }
        let Some(target) = parts.next() else { return };
        let auth = lines.find_map(|line| line.strip_prefix("Authorization: Bearer ").map(str::trim));
        let (route, query) = target.split_once('?').unwrap_or((target, ""));
        let q = query_map(query);
        let result = match route {
            "/v1/pair" => self.handle_pair(&q, from),
            "/v1/list" => self.handle_list(&q, auth),
            "/v1/text" => self.handle_text(&q, auth),
            "/v1/file" => self.handle_file(&q, auth),
            _ => Err((404, "not found".to_string())),
        };
        match result {
            Ok(body) => write_http(&mut stream, 200, &body),
            Err((code, message)) => write_http(&mut stream, code, message.as_bytes()),
        }
    }

    /// Take a request to browse this device, and answer with whatever the person
    /// holding it has decided so far.
    ///
    /// Nothing here grants access. The first call puts a card on screen and
    /// replies `202`; only a tap on Allow turns a later call into a token. The
    /// asking device polls, so waiting costs no held socket on either side.
    fn handle_pair(&self, q: &BTreeMap<String, String>, from: IpAddr) -> Result<Vec<u8>, (u16, String)> {
        let client = q.get("deviceId").filter(|x| !x.is_empty()).ok_or((400, "missing device id".to_string()))?;
        let now = now_secs();
        let mut st = self.state.lock().unwrap();

        // Only a device we can currently see, at the address we last saw it at.
        // The card names a device the user can point to in their own sidebar,
        // and an ask from something invisible is one nobody could make sense of.
        let seen = st.seen.get(client).cloned().filter(|peer| now.saturating_sub(peer.seen_at) < 8);
        let Some(peer) = seen.filter(|peer| peer.host == from.to_string()) else {
            return Err((404, "That device isn’t visible here".into()));
        };

        st.asks.retain(|id, ask| id == client || now.saturating_sub(ask.at) < ASK_TTL);

        match st.asks.get(client).and_then(|ask| ask.decision) {
            Some(true) => {
                let token = Uuid::new_v4().to_string();
                st.clients.insert(client.clone(), token.clone());
                // Forget the ask now it has been collected, so the same device
                // asking again later is a fresh question rather than an answer
                // it inherited from last week.
                st.asks.remove(client);
                drop(st);
                self.save();
                serde_json::to_vec(&PairResponse { token, root: self.root.to_string_lossy().into_owned() }).map_err(|e| (500, e.to_string()))
            }
            Some(false) => Err((403, "That device said no".into())),
            None => {
                if !st.asks.contains_key(client) && st.asks.len() >= MAX_ASKS {
                    return Err((429, "Too many devices are asking at once".into()));
                }
                let name = q.get("name").filter(|name| !name.is_empty()).cloned().unwrap_or_else(|| peer.name.clone());
                let platform = q.get("platform").cloned().unwrap_or_else(|| peer.platform.clone());
                st.asks.insert(client.clone(), Ask { name, platform, at: now, decision: None });
                // Not an error: the question is now on someone's screen.
                Err((202, "waiting".into()))
            }
        }
    }

    fn authorised(&self, auth: Option<&str>) -> bool {
        auth.is_some_and(|token| self.state.lock().unwrap().clients.values().any(|saved| saved == token))
    }

    fn handle_list(&self, q: &BTreeMap<String, String>, auth: Option<&str>) -> Result<Vec<u8>, (u16, String)> {
        if !self.authorised(auth) { return Err((401, "Pair this device before browsing it".into())); }
        let dir = self.safe_remote_path(q.get("path").map(String::as_str).unwrap_or(""))?;
        let hidden = q.get("hidden").is_some_and(|v| v == "1");
        let entries = fs_scan::scan(&dir, &ScanOpts { show_hidden: hidden }, &self.cache).map_err(|e| (403, e))?;
        serde_json::to_vec(&RemoteListing { path: dir.to_string_lossy().into_owned(), entries }).map_err(|e| (500, e.to_string()))
    }

    fn handle_text(&self, q: &BTreeMap<String, String>, auth: Option<&str>) -> Result<Vec<u8>, (u16, String)> {
        if !self.authorised(auth) { return Err((401, "Pair this device before reading it".into())); }
        let path = self.safe_remote_path(q.get("path").map(String::as_str).unwrap_or(""))?;
        let max = q.get("max").and_then(|x| x.parse().ok()).unwrap_or(512 * 1024);
        let head = text_head(&path, max).map_err(|e| (403, e))?;
        serde_json::to_vec(&head).map_err(|e| (500, e.to_string()))
    }

    fn handle_file(&self, q: &BTreeMap<String, String>, auth: Option<&str>) -> Result<Vec<u8>, (u16, String)> {
        if !self.authorised(auth) { return Err((401, "Pair this device before copying from it".into())); }
        let path = self.safe_remote_path(q.get("path").map(String::as_str).unwrap_or(""))?;
        if path.is_dir() { return Err((400, "Folder copies are not ready yet".into())); }
        fs::read(path).map_err(|e| (403, e.to_string()))
    }

    fn safe_remote_path(&self, wanted: &str) -> Result<PathBuf, (u16, String)> {
        let candidate = if wanted.is_empty() { self.root.clone() } else { PathBuf::from(wanted) };
        let canonical = candidate.canonicalize().map_err(|_| (404, "That item no longer exists".into()))?;
        if !canonical.starts_with(&self.root) { return Err((403, "That path is outside the shared storage".into())); }
        Ok(canonical)
    }

    fn discover(self: Arc<Self>) {
        let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)) { Ok(s) => s, Err(_) => return };
        let _ = socket.set_broadcast(true);
        let _ = socket.set_nonblocking(true);
        let mut last_sent = 0;
        let mut buffer = [0u8; 1024];
        loop {
            let now = now_secs();
            if now.saturating_sub(last_sent) >= 2 {
                let st = self.state.lock().unwrap();
                // Do not surface a device merely because a broadcast reached us.
                // A peer must explicitly advertise that it sees our ID too; that
                // makes discovery quiet on busy Wi-Fi and avoids false locations.
                let visible = st.seen.iter().filter_map(|(id, peer)| (now.saturating_sub(peer.seen_at) < 8).then_some(id.clone())).collect();
                let packet = serde_json::to_vec(&Discovery { id: st.id.clone(), name: st.name.clone(), port: st.port, visible, platform: platform_name() }).unwrap_or_default();
                drop(st);
                let _ = socket.send_to(&packet, SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), DISCOVERY_PORT));
                last_sent = now;
            }
            match socket.recv_from(&mut buffer) {
                Ok((count, from)) => if let Ok(packet) = serde_json::from_slice::<Discovery>(&buffer[..count]) {
                    let mut st = self.state.lock().unwrap();
                    if packet.id != st.id && packet.port != 0 {
                        let mutual = packet.visible.iter().any(|id| id == &st.id);
                        st.seen.insert(packet.id, SeenPeer { name: packet.name, host: from.ip().to_string(), port: packet.port, seen_at: now, mutual, platform: packet.platform });
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(120)),
                Err(_) => thread::sleep(Duration::from_millis(400)),
            }
        }
    }
}

pub fn parse_remote_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("fiddler://")?;
    let (id, value) = rest.split_once('/').unwrap_or((rest, ""));
    (!id.is_empty()).then(|| {
        let value = dec(value);
        (id.to_string(), if value.is_empty() { String::new() } else { format!("/{value}") })
    })
}

fn remote_path(id: &str, path: &str) -> String { format!("fiddler://{id}/{}", path.trim_start_matches('/')) }
/// Resolved once, because every incoming path is checked against it: a root that
/// still held a symlink would let `canonicalize` land outside what it names.
fn share_root() -> PathBuf {
    #[cfg(target_os = "android")]
    let root = PathBuf::from("/storage/emulated/0");
    #[cfg(not(target_os = "android"))]
    let root = dirs::home_dir().unwrap_or_default();
    root.canonicalize().unwrap_or(root)
}
/// A friendly, deterministic identity rather than a hostname or hardware model.
/// It is seeded by the installation UUID and persisted, so two nearby phones are
/// easy to tell apart without leaking a person's account or device name.
fn friendly_name(id: &str) -> String {
    const ADJECTIVES: &[&str] = &["Amber", "Brisk", "Cozy", "Dapper", "Ember", "Fuzzy", "Golden", "Happy", "Ivy", "Jolly", "Kind", "Lively", "Mellow", "Nimble", "Peachy", "Quiet", "Rosy", "Sunny", "Tidy", "Velvet"];
    const FRUITS: &[&str] = &["Apple", "Apricot", "Banana", "Berry", "Cherry", "Clementine", "Fig", "Grape", "Guava", "Kiwi", "Lemon", "Lychee", "Mango", "Melon", "Nectarine", "Papaya", "Peach", "Pear", "Plum", "Tangerine"];
    let bytes = Uuid::parse_str(id).map(|uuid| uuid.as_bytes().to_vec()).unwrap_or_else(|_| id.as_bytes().to_vec());
    let first = bytes.first().copied().unwrap_or(0) as usize % ADJECTIVES.len();
    let second = bytes.get(1).copied().unwrap_or(0) as usize % FRUITS.len();
    format!("{} {}", ADJECTIVES[first], FRUITS[second])
}
fn platform_name() -> String { #[cfg(target_os = "android")] { "android".into() } #[cfg(target_os = "macos")] { "macos".into() } #[cfg(not(any(target_os = "android", target_os = "macos")))] { "desktop".into() } }
fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

/// One request, with the status left for the caller to read. Pairing is the only
/// route where a non-200 is an answer rather than a failure.
fn fetch(host: &str, port: u16, route: &str, token: Option<&str>) -> Result<(u16, Vec<u8>), String> {
    let addr: SocketAddr = format!("{host}:{port}").parse().map_err(|_| "That device has an invalid address")?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|_| "Couldn’t reach that device. Keep Fiddler open on both devices.")?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(12)));
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let request = format!("GET {route} HTTP/1.1\r\nHost: {host}\r\n{auth}Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|_| "Couldn’t send the request")?;
    let mut bytes = Vec::new(); stream.take(MAX_HTTP as u64).read_to_end(&mut bytes).map_err(|_| "The device stopped responding")?;
    let header_end = bytes.windows(4).position(|w| w == b"\r\n\r\n").ok_or("Invalid response from device")?;
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let status = header.split_whitespace().nth(1).and_then(|code| code.parse().ok()).ok_or("Invalid response from device")?;
    Ok((status, bytes[header_end + 4..].to_vec()))
}

fn request(host: &str, port: u16, route: &str, token: Option<&str>) -> Result<Vec<u8>, String> {
    let (status, body) = fetch(host, port, route, token)?;
    if status != 200 { return Err(message(&body, "That device refused the request")); }
    Ok(body)
}

/// The device's own words when it sent any, rather than a status line the person
/// reading it can do nothing with.
fn message(body: &[u8], fallback: &str) -> String {
    let text = String::from_utf8_lossy(body).trim().to_string();
    if text.is_empty() { fallback.to_string() } else { text }
}

fn write_http(stream: &mut TcpStream, code: u16, body: &[u8]) {
    let reason = match code { 200 => "OK", 202 => "Accepted", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 405 => "Method Not Allowed", 429 => "Too Many Requests", _ => "Error" };
    let header = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(header.as_bytes()); let _ = stream.write_all(body);
}

fn query_map(query: &str) -> BTreeMap<String, String> { query.split('&').filter_map(|part| { let (k, v) = part.split_once('=')?; Some((dec(k), dec(v))) }).collect() }
fn enc(value: &str) -> String { value.bytes().flat_map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/') { vec![b as char] } else { format!("%{b:02X}").chars().collect() }).collect() }
fn dec(value: &str) -> String {
    let bytes = value.as_bytes(); let mut out = Vec::with_capacity(bytes.len()); let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).ok().and_then(|x| u8::from_str_radix(x, 16).ok());
            if let Some(value) = hex { out.push(value); at += 3; continue; }
        }
        out.push(if bytes[at] == b'+' { b' ' } else { bytes[at] }); at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn text_head(path: &Path, max_bytes: usize) -> Result<crate::commands::TextHead, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?; if meta.is_dir() { return Err("that is a folder".into()); }
    let cap = max_bytes.clamp(1024, 4 * 1024 * 1024); let mut bytes = Vec::new(); fs::File::open(path).map_err(|e| e.to_string())?.take(cap as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.contains(&0) { return Ok(crate::commands::TextHead { text: String::new(), truncated: false, bytes: meta.len(), lines: 0, binary: true }); }
    let text = match std::str::from_utf8(&bytes) { Ok(s) => s.to_owned(), Err(e) => String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned() };
    Ok(crate::commands::TextHead { lines: text.lines().count() as u32, truncated: (bytes.len() as u64) < meta.len(), bytes: meta.len(), binary: false, text })
}
