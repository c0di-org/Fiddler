//! USB devices that aren't running Fiddler: phones, cameras, e-readers, watches.
//!
//! The peer transport in `peers.rs` needs Fiddler on both ends and a pairing
//! code. This one needs a cable. Plugging in *is* the pairing.
//!
//! # Why there is a worker thread
//!
//! MTP allows exactly one connection per device, and a device has a single PTP
//! session — two overlapping operations on one phone is a protocol error, not a
//! race we can lock our way out of. So every byte of device I/O is funnelled
//! through one worker thread that owns the open devices and runs them on a
//! current-thread tokio runtime. Commands post a `Request` and block on a reply
//! channel. Serialisation isn't a compromise here; it's what the protocol wants.
//!
//! Device *state* is the exception: it lives in a mutex the poll loop writes and
//! the UI reads, so drawing the sidebar never waits on a phone.
//!
//! # The state machine
//!
//! The interesting part of this module is [`Stage`], and it exists because of
//! something the hardware showed us. A Samsung plugged in and left on the lock
//! screen enumerates, opens, and cheerfully reports its model — and then lists
//! zero storages. Every MTP app on macOS renders that as "device not detected",
//! which is both wrong and unactionable. It's a phone waiting to be unlocked.
//! `Stage` names each step so the sidebar can say what's actually true and
//! advance on its own when the user acts.

pub mod path;

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use mtp_rs::mtp::{MtpDevice, ObjectHandle, Storage};
use mtp_rs::CancelToken;

use crate::model::{DirListing, Entry, Kind};

/// How often the poll loop re-enumerates USB and re-checks a device that hasn't
/// granted access yet. Enumeration measured at ~1.7ms, so this is not a cost;
/// it's just faster than a person can notice.
const POLL: Duration = Duration::from_millis(1_200);

/// Where a device is in the sequence between "plugged in" and "browsable".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "camelCase")]
pub enum Stage {
    /// Enumerated on USB, session not open yet.
    Connecting,
    /// Another process holds the device. On macOS this is almost always
    /// `ptpcamerad`, which claims MTP/PTP devices on connection and then can't
    /// actually serve an Android phone, or a running Android File Transfer.
    #[serde(rename_all = "camelCase")]
    Blocked {
        /// The process holding it, when IORegistry named one.
        owner: Option<String>,
        owner_pid: Option<u32>,
    },
    /// Session open, device identified, but it exposes no storages: the phone is
    /// locked, or its USB mode is still "charging only". Not an error — a step.
    AwaitingGrant,
    /// Browsable.
    Ready,
    /// The device answered, but not in a way we could use.
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

/// A storage on a device (internal memory, SD card).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSnapshot {
    pub id: u64,
    pub description: String,
    pub free_space: u64,
    pub total_capacity: u64,
    /// Removable media, so the UI can draw an SD card rather than a phone.
    pub removable: bool,
}

/// What the UI needs to draw one USB device, without touching the device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDevice {
    /// USB serial. Stable across the whole connection sequence and readable
    /// before the device is opened, which is why `mtp://` is keyed on it.
    pub serial: String,
    /// Best available name: the MTP model once we have a session, else the USB
    /// product string.
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(flatten)]
    pub stage: Stage,
    pub storages: Vec<StorageSnapshot>,
    /// The negotiated USB link, in the terms people actually see on cable
    /// packaging: "USB 2.0" rather than nusb's `High`.
    pub link: Option<String>,
    /// Theoretical ceiling of that link, in Mb/s.
    pub link_mbps: Option<u32>,
    /// The link came up at USB 2.0 or below.
    ///
    /// This is deliberately *not* called "bad cable". All USB tells us is the
    /// speed both ends agreed on — we cannot see whether the phone, the cable,
    /// or the port is the limit. A modern phone on a USB 2.0 link is usually the
    /// cable (most USB-C cables in phone boxes are USB 2.0), but "usually" is
    /// not "provably", and the UI copy has to reflect that.
    pub throttled: bool,
}

/// The link as a person would name it, with its ceiling in Mb/s.
fn describe_link(speed: Option<mtp_rs::UsbSpeed>) -> (Option<String>, Option<u32>, bool) {
    use mtp_rs::UsbSpeed;
    match speed {
        Some(UsbSpeed::Low) => (Some("USB 1.0".into()), Some(2), true),
        Some(UsbSpeed::Full) => (Some("USB 1.1".into()), Some(12), true),
        Some(UsbSpeed::High) => (Some("USB 2.0".into()), Some(480), true),
        Some(UsbSpeed::Super) => (Some("USB 3.2 Gen 1".into()), Some(5_000), false),
        Some(UsbSpeed::SuperPlus) => (Some("USB 3.2 Gen 2".into()), Some(10_000), false),
        _ => (None, None, false),
    }
}

/// How many entries come back from the initial `list_dir` call.
///
/// Enough to fill a window, so a folder is drawn and scrollable before the rest
/// arrives, but not so many that the first paint waits on them. At roughly
/// 4.5ms per object this is about a fifth of a second.
const FIRST_BATCH: usize = 48;

/// After the first batch, entries are emitted at most this often. A folder of
/// 1348 photos would otherwise be 1348 IPC messages.
const BATCH_EVERY: Duration = Duration::from_millis(140);

/// A chunk of a folder, delivered while the rest is still being read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryBatch {
    /// The folder these belong to, so a late batch for a folder the person has
    /// already left can be dropped rather than drawn.
    pub path: String,
    pub entries: Vec<Entry>,
    /// No more are coming — either the folder ended or the read was cancelled.
    pub done: bool,
}

/// Device I/O, all of it serialised onto the worker thread.
enum Request {
    List {
        serial: String,
        storage: Option<u64>,
        rel: String,
        /// Flipped when the person navigates away. Checked before each object's
        /// metadata roundtrip, so leaving a 1348-photo folder stops the read
        /// within one roundtrip instead of running it to completion.
        cancel: CancelToken,
        reply: Sender<Result<(Vec<Entry>, bool), String>>,
    },
    ReadRange {
        serial: String,
        storage: u64,
        rel: String,
        offset: u64,
        len: u32,
        reply: Sender<Result<Vec<u8>, String>>,
    },
    /// Ask the device to draw the picture itself, via MTP's `GetThumb`.
    Thumbnail {
        serial: String,
        storage: u64,
        rel: String,
        reply: Sender<Result<Vec<u8>, String>>,
    },
}

/// Size and modification time for one object, remembered from its listing.
///
/// The thumbnail cache is keyed on (path, mtime, size, px), and for a local file
/// those last two come from a `stat`. There is no `stat` for an object on a
/// phone, and asking the device would put a USB round trip in front of every
/// cache *probe* — the one operation that has to stay free, because it runs for
/// every tile on screen before any work is queued. So listings record what they
/// already saw, and the probe reads a mutex.
pub type ObjectMeta = (u64, i64);

/// Entries remembered for the cache probe. A few large folders' worth; past that
/// the map is cleared rather than evicted one at a time, because the cost of
/// being wrong is one re-listing, not a wrong answer.
const META_CAP: usize = 20_000;

pub struct MtpService {
    jobs: Sender<Request>,
    devices: Arc<Mutex<Vec<UsbDevice>>>,
    meta: Arc<Mutex<HashMap<String, ObjectMeta>>>,
    /// The listing currently being read, if any.
    ///
    /// Held here rather than on the worker because the point is to cancel from
    /// *outside* it: the worker is busy walking the folder we want to abandon,
    /// so it cannot notice a new request until it stops.
    reading: Arc<Mutex<Option<CancelToken>>>,
}

/// The running service, for callers too far from `AppState` to be handed one.
///
/// `thumb::generate` runs on a pool worker with no application state at all, and
/// threading a handle down to it would mean widening four signatures that have
/// nothing else to do with USB.
static SERVICE: std::sync::OnceLock<Arc<MtpService>> = std::sync::OnceLock::new();

pub fn service() -> Option<&'static Arc<MtpService>> {
    SERVICE.get()
}

impl MtpService {
    pub fn start(app: AppHandle) -> Arc<Self> {
        let (jobs, inbox) = channel();
        let devices = Arc::new(Mutex::new(Vec::new()));
        let meta = Arc::new(Mutex::new(HashMap::new()));
        let service = Arc::new(MtpService {
            jobs,
            devices: devices.clone(),
            meta: meta.clone(),
            reading: Arc::new(Mutex::new(None)),
        });
        let _ = SERVICE.set(service.clone());

        thread::Builder::new()
            .name("fiddler-mtp".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    // Without a runtime there is no USB at all. The rest of
                    // Fiddler is unaffected, so log and leave the section empty
                    // rather than taking the app down.
                    Err(e) => {
                        eprintln!("mtp: no runtime, USB devices unavailable: {e}");
                        return;
                    }
                };
                runtime.block_on(Worker::new(app, devices, meta).run(inbox));
            })
            .ok();

        service
    }

    /// Currently attached devices and where each one is in the sequence. Reads a
    /// mutex, never the bus.
    pub fn devices(&self) -> Vec<UsbDevice> {
        self.devices.lock().map(|d| d.clone()).unwrap_or_default()
    }

    /// List one directory on a device. At the device root the listing is the
    /// device's storages, so a single-storage phone still has somewhere to land
    /// and a phone with an SD card gets a real choice.
    /// Returns as soon as the first screenful is known; the rest of the folder
    /// follows on `fiddler:usb-entries`. A folder of 1348 photos takes about six
    /// seconds to read in full — one metadata roundtrip per object — and waiting
    /// for all of it before drawing anything is the difference between a file
    /// browser and a progress bar.
    ///
    /// `status_pending` on the returned listing means "more is coming", which is
    /// the same signal a git status pass already uses.
    pub fn listing(&self, path: &str, _show_hidden: bool) -> Result<DirListing, String> {
        let parsed = path::parse(path).ok_or("Not a device path")?;

        // Abandon whatever folder we were reading. Navigation is the common
        // case here: open a camera roll, realise it's the wrong one, leave.
        let cancel = CancelToken::new();
        {
            let mut reading = self.reading.lock().map_err(|_| "USB state is poisoned")?;
            if let Some(previous) = reading.replace(cancel.clone()) {
                previous.cancel();
            }
        }

        let (tx, rx) = channel();
        self.jobs
            .send(Request::List {
                serial: parsed.serial.clone(),
                storage: parsed.storage,
                rel: parsed.rel.clone(),
                cancel,
                reply: tx,
            })
            .map_err(|_| "The USB service is not running")?;
        let (entries, more) = rx.recv().map_err(|_| "The USB service stopped responding")??;
        Ok(DirListing {
            path: path.to_string(),
            entries,
            repo_root: None,
            worktrees: Vec::new(),
            status_pending: more,
        })
    }

    /// Size and mtime for an object we have listed, without touching the device.
    ///
    /// Returns `None` for a path no listing has covered, which is the honest
    /// answer: we would have to go to the device to find out, and the caller is
    /// a cache probe that must not block.
    pub fn meta(&self, path: &str) -> Option<ObjectMeta> {
        self.meta.lock().ok()?.get(path).copied()
    }

    /// A bounded read, which is how previews and thumbnails work: a 4 MB photo
    /// costs 256 KB when all we need is the EXIF thumbnail inside it.
    pub fn read_range(&self, path: &str, offset: u64, len: u32) -> Result<Vec<u8>, String> {
        let parsed = path::parse(path).ok_or("Not a device path")?;
        let storage = parsed.storage.ok_or("That path has no storage")?;
        let (tx, rx) = channel();
        self.jobs
            .send(Request::ReadRange {
                serial: parsed.serial,
                storage,
                rel: parsed.rel,
                offset,
                len,
                reply: tx,
            })
            .map_err(|_| "The USB service is not running")?;
        rx.recv().map_err(|_| "The USB service stopped responding")?
    }

    /// The device's own thumbnail for an object, via MTP's `GetThumb`.
    ///
    /// The route of last resort, and the only one that works for video: an mp4
    /// keeps nothing an image decoder can use near the front of the file, so
    /// reading its head buys nothing. The phone can decode a frame, and does.
    ///
    /// Measured on a Galaxy Z Fold 7: 85-138ms for a video against 7-15ms for a
    /// still, because the device is decoding video to answer. Ten times the cost
    /// of the head route, which is why this is a fallback and not the default.
    pub fn device_thumbnail(&self, path: &str) -> Result<Vec<u8>, String> {
        let parsed = path::parse(path).ok_or("Not a device path")?;
        let storage = parsed.storage.ok_or("That path has no storage")?;
        let (tx, rx) = channel();
        self.jobs
            .send(Request::Thumbnail {
                serial: parsed.serial,
                storage,
                rel: parsed.rel,
                reply: tx,
            })
            .map_err(|_| "The USB service is not running")?;
        rx.recv().map_err(|_| "The USB service stopped responding")?
    }
}

/// One attached device, as the worker sees it.
struct Slot {
    device: Option<MtpDevice>,
    storages: Vec<Storage>,
    /// `(storage, rel)` -> handle. MTP addresses objects by opaque handle, not
    /// by path, so every listing seeds this and every later operation on a path
    /// resolves through it. Cleared whenever the device goes away.
    handles: HashMap<(u64, String), ObjectHandle>,
    snapshot: UsbDevice,
    /// When we last tried to open a device that was blocked, so a device held by
    /// another process doesn't turn into a retry storm.
    last_attempt: Option<Instant>,
}

struct Worker {
    app: AppHandle,
    devices: Arc<Mutex<Vec<UsbDevice>>>,
    meta: Arc<Mutex<HashMap<String, ObjectMeta>>>,
    slots: HashMap<String, Slot>,
}

impl Worker {
    fn new(
        app: AppHandle,
        devices: Arc<Mutex<Vec<UsbDevice>>>,
        meta: Arc<Mutex<HashMap<String, ObjectMeta>>>,
    ) -> Self {
        Worker { app, devices, meta, slots: HashMap::new() }
    }

    async fn run(mut self, inbox: Receiver<Request>) {
        loop {
            self.poll().await;
            // Serve requests until the next poll is due.
            //
            // This waits on the channel rather than spinning on `try_recv`,
            // which matters more than it looks: a screen of thumbnails is two
            // dozen sequential requests, and any per-request delay here is paid
            // two dozen times. A byte-range read takes ~9ms, so a 20ms poll gap
            // would have tripled the time a photo grid takes to fill.
            let deadline = Instant::now() + POLL;
            loop {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { break };
                match inbox.recv_timeout(remaining) {
                    Ok(request) => self.serve(request).await,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    // Every command handle is gone, so the app is shutting down.
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    }

    /// Re-enumerate USB and advance each device one step.
    async fn poll(&mut self) {
        let found = match MtpDevice::list_devices() {
            Ok(found) => found,
            Err(_) => Vec::new(),
        };

        // Drop slots for devices that were unplugged. Dropping the MtpDevice
        // closes the session, and the handle cache goes with it: handles are
        // only meaningful within one connection.
        let attached: Vec<String> =
            found.iter().filter_map(|d| d.serial_number.clone()).collect();
        self.slots.retain(|serial, _| attached.contains(serial));

        for info in found {
            let Some(serial) = info.serial_number.clone() else { continue };
            let (link, link_mbps, throttled) = describe_link(info.speed);
            let slot = self.slots.entry(serial.clone()).or_insert_with(|| Slot {
                device: None,
                storages: Vec::new(),
                handles: HashMap::new(),
                snapshot: UsbDevice {
                    serial: serial.clone(),
                    name: info
                        .product
                        .clone()
                        .or_else(|| info.manufacturer.clone())
                        .unwrap_or_else(|| "USB device".into()),
                    vendor_id: info.vendor_id,
                    product_id: info.product_id,
                    stage: Stage::Connecting,
                    storages: Vec::new(),
                    link: link.clone(),
                    link_mbps,
                    throttled,
                },
                last_attempt: None,
            });
            // Re-seat the link every poll: replugging into a different port or
            // cable renegotiates it without the device ever going away.
            slot.snapshot.link = link;
            slot.snapshot.link_mbps = link_mbps;
            slot.snapshot.throttled = throttled;
            advance(slot, &serial).await;
        }

        let next: Vec<UsbDevice> = self.slots.values().map(|s| s.snapshot.clone()).collect();
        let changed = {
            let mut current = self.devices.lock().unwrap();
            let changed = *current != next;
            if changed {
                *current = next.clone();
            }
            changed
        };
        // Only wake the UI when something actually moved, so an idle phone on a
        // desk costs nothing.
        if changed {
            let _ = self.app.emit("fiddler:usb", next);
        }
    }

    async fn serve(&mut self, request: Request) {
        match request {
            Request::List { serial, storage, rel, cancel, reply } => {
                let Some(slot) = self.slots.get_mut(&serial) else {
                    let _ = reply.send(Err("That device is not connected".into()));
                    return;
                };
                let app = self.app.clone();
                let mut emit = move |batch: EntryBatch| {
                    let _ = app.emit("fiddler:usb-entries", batch);
                };
                list(slot, &serial, storage, &rel, &cancel, reply, &mut emit, &self.meta).await;
            }
            Request::ReadRange { serial, storage, rel, offset, len, reply } => {
                let result = match self.slots.get_mut(&serial) {
                    Some(slot) => read_range(slot, storage, &rel, offset, len).await,
                    None => Err("That device is not connected".into()),
                };
                let _ = reply.send(result);
            }
            Request::Thumbnail { serial, storage, rel, reply } => {
                let result = match self.slots.get_mut(&serial) {
                    Some(slot) => device_thumbnail(slot, storage, &rel).await,
                    None => Err("That device is not connected".into()),
                };
                let _ = reply.send(result);
            }
        }
    }
}

/// Read one directory, answering with the first screenful and streaming the rest.
///
/// MTP has no bulk metadata call in this library — `GetObjectPropList` exists as
/// an opcode and nothing more — so a folder costs one roundtrip per object, and
/// a camera roll of 1348 photos takes about six seconds. Collecting all of that
/// before drawing anything turns a file browser into a progress bar, so the
/// first [`FIRST_BATCH`] entries go back through `reply` and everything after
/// arrives on `fiddler:usb-entries`.
///
/// Sends exactly one reply on `reply` in every path, including errors.
// The closing `flush!` updates the bookkeeping it shares with the in-loop
// flushes and then returns; those last writes are genuinely dead.
#[allow(unused_assignments)]
async fn list(
    slot: &mut Slot,
    serial: &str,
    storage: Option<u64>,
    rel: &str,
    cancel: &CancelToken,
    reply: Sender<Result<(Vec<Entry>, bool), String>>,
    // `emit` takes batches after the first one. It is a sink rather than an
    // `AppHandle` so the streaming behaviour — batch sizes, pacing, and what a
    // cancel does to the final batch — is testable without a Tauri app.
    emit: &mut dyn FnMut(EntryBatch),
    meta: &Arc<Mutex<HashMap<String, ObjectMeta>>>,
) {
    if !matches!(slot.snapshot.stage, Stage::Ready) {
        let _ = reply.send(Err(stage_message(&slot.snapshot)));
        return;
    }

    // The device root lists storages, so one phone with an SD card reads as two
    // places rather than a mode switch buried in a toolbar. Always a handful of
    // entries, already in hand — nothing to stream.
    let Some(storage_id) = storage else {
        let entries = slot.snapshot.storages.iter().map(|s| storage_entry(serial, s)).collect();
        let _ = reply.send(Ok((entries, false)));
        return;
    };
    let full_path = path::format(serial, storage_id, rel);

    // `Storage` isn't Clone, and the handle cache needs a mutable borrow at the
    // same time. Destructuring splits the slot into disjoint field borrows,
    // which the checker accepts where `slot.x` plus `&mut slot.y` would not.
    let Slot { storages, handles, .. } = slot;
    let Some(store) = storages.iter().find(|s| s.id().0 == storage_id) else {
        let _ = reply.send(Err("That storage is no longer attached".into()));
        return;
    };

    let parent = if rel.is_empty() {
        None
    } else {
        match resolve(store, handles, storage_id, rel).await {
            Ok(handle) => Some(handle),
            Err(e) => {
                let _ = reply.send(Err(e));
                return;
            }
        }
    };

    let mut listing = match store.list_objects_stream_with_cancel(parent, Some(cancel)).await {
        Ok(listing) => listing,
        // Navigating away cancels the read, and that is not a failure the
        // person caused or can act on. Answering with an error would put "the
        // operation was cancelled" in the folder they just left, and cache it
        // there. An empty answer is the honest one: we stopped, ask again.
        Err(mtp_rs::Error::Cancelled) => {
            let _ = reply.send(Ok((Vec::new(), false)));
            return;
        }
        Err(e) => {
            let _ = reply.send(Err(describe(e)));
            return;
        }
    };

    let mut batch: Vec<Entry> = Vec::new();
    let mut replied = false;
    let mut last_sent = Instant::now();

    // One reply, then events. `flush` owns that distinction so no path can send
    // twice or forget to send at all.
    macro_rules! flush {
        ($done:expr) => {{
            let done: bool = $done;
            if let Ok(mut map) = meta.lock() {
                if map.len() + batch.len() > META_CAP {
                    map.clear();
                }
                for entry in &batch {
                    map.insert(entry.path.clone(), (entry.size, entry.mtime));
                }
            }
            batch.sort_by(crate::fs_scan::cmp_entries);
            if replied {
                emit(EntryBatch { path: full_path.clone(), entries: std::mem::take(&mut batch), done });
            } else {
                let _ = reply.send(Ok((std::mem::take(&mut batch), !done)));
                replied = true;
            }
            last_sent = Instant::now();
        }};
    }

    loop {
        let item = match listing.next().await {
            Some(Ok(item)) => item,
            // A single unreadable object is skipped by the stream itself; an
            // error here ended the whole read, so close the folder out rather
            // than leaving the UI waiting for a batch that will never come.
            Some(Err(_)) | None => break,
        };
        let mtp_rs::mtp::ListingItem::Object(object) = item else { continue };

        let child_rel = format!("{rel}/{}", object.filename);
        handles.insert((storage_id, child_rel.clone()), object.handle);
        batch.push(entry_of(serial, storage_id, &child_rel, &object));

        // The first screenful goes back as the answer to `list_dir`; after that
        // batches are paced, so a big folder is a few dozen events, not 1348.
        if (!replied && batch.len() >= FIRST_BATCH)
            || (replied && !batch.is_empty() && last_sent.elapsed() >= BATCH_EVERY)
        {
            flush!(false);
        }
        if cancel.is_cancelled() {
            break;
        }
    }

    flush!(true);
}

/// A bounded read of one object. See [`list`] on why this is a free function.
async fn read_range(
    slot: &mut Slot,
    storage_id: u64,
    rel: &str,
    offset: u64,
    len: u32,
) -> Result<Vec<u8>, String> {
    let Slot { storages, handles, .. } = slot;
    let store = storages
        .iter()
        .find(|s| s.id().0 == storage_id)
        .ok_or("That storage is no longer attached")?;
    let handle = resolve(store, handles, storage_id, rel).await?;
    store.read_range(handle, offset, len).await.map_err(describe)
}

/// Ask the device for its own thumbnail. See [`MtpService::device_thumbnail`].
async fn device_thumbnail(
    slot: &mut Slot,
    storage_id: u64,
    rel: &str,
) -> Result<Vec<u8>, String> {
    let Slot { storages, handles, .. } = slot;
    let store = storages
        .iter()
        .find(|s| s.id().0 == storage_id)
        .ok_or("That storage is no longer attached")?;
    let handle = resolve(store, handles, storage_id, rel).await?;
    let bytes = store.thumbnail(handle).await.map_err(describe)?;
    // Plenty of objects have no thumbnail to give, and a device that answers
    // with nothing has answered. Treat it as a miss rather than as data.
    if bytes.is_empty() {
        return Err("the device has no thumbnail for this file".into());
    }
    Ok(bytes)
}

/// Move one device forward: open it, ask for storages, and decide which stage
/// that puts it in. Every branch here is a state the hardware actually produces.
async fn advance(slot: &mut Slot, serial: &str) {
    if slot.device.is_none() {
        // Back off after a block: something else owns the device and hammering
        // it neither helps nor tells us anything new.
        if let (Stage::Blocked { .. }, Some(at)) = (&slot.snapshot.stage, slot.last_attempt) {
            if at.elapsed() < Duration::from_secs(3) {
                return;
            }
        }
        slot.last_attempt = Some(Instant::now());
        match MtpDevice::open_by_serial(serial).await {
            Ok(device) => {
                let info = device.device_info();
                if !info.model.is_empty() {
                    slot.snapshot.name = info.model.clone();
                }
                slot.device = Some(device);
            }
            Err(e) => {
                slot.snapshot.stage = if e.is_exclusive_access() {
                    let (owner, owner_pid) = exclusive_owner(slot.snapshot.vendor_id, slot.snapshot.product_id);
                    Stage::Blocked { owner, owner_pid }
                } else {
                    Stage::Failed { message: describe(e) }
                };
                slot.snapshot.storages.clear();
                slot.storages.clear();
                return;
            }
        }
    }

    let Some(device) = slot.device.as_ref() else { return };
    match device.storages().await {
        Ok(storages) if storages.is_empty() => {
            // Session is open and the device identified itself, so this is a
            // phone declining to share, not a phone that isn't there.
            slot.snapshot.stage = Stage::AwaitingGrant;
            slot.snapshot.storages.clear();
            slot.storages.clear();
            slot.handles.clear();
        }
        Ok(storages) => {
            slot.snapshot.storages = storages.iter().map(snapshot_of).collect();
            slot.storages = storages;
            slot.snapshot.stage = Stage::Ready;
        }
        Err(e) => {
            // A device that vanishes mid-session comes back through
            // re-enumeration; drop the handle so the next poll reopens it.
            slot.device = None;
            slot.storages.clear();
            slot.handles.clear();
            slot.snapshot.storages.clear();
            slot.snapshot.stage = Stage::Failed { message: describe(e) };
        }
    }
}

/// Walk `rel` down from the storage root, caching every handle on the way, and
/// return the handle for the leaf. Listings normally populate this first, so the
/// walk is a cache hit; it exists for the case where a path arrives cold, e.g. a
/// thumbnail request that outlived a reconnect.
async fn resolve(
    store: &Storage,
    handles: &mut HashMap<(u64, String), ObjectHandle>,
    storage_id: u64,
    rel: &str,
) -> Result<ObjectHandle, String> {
    if let Some(handle) = handles.get(&(storage_id, rel.to_string())) {
        return Ok(*handle);
    }
    let mut parent = None;
    let mut walked = String::new();
    for name in rel.split('/').filter(|part| !part.is_empty()) {
        walked.push('/');
        walked.push_str(name);
        if let Some(handle) = handles.get(&(storage_id, walked.clone())) {
            parent = Some(*handle);
            continue;
        }
        let objects = store.list_objects(parent).await.map_err(describe)?;
        let found = objects
            .iter()
            .find(|o| o.filename == name)
            .ok_or_else(|| format!("{name} is no longer on the device"))?;
        for object in &objects {
            let sibling = format!(
                "{}/{}",
                walked.rsplit_once('/').map(|(head, _)| head).unwrap_or(""),
                object.filename
            );
            handles.insert((storage_id, sibling), object.handle);
        }
        parent = Some(found.handle);
    }
    parent.ok_or_else(|| "That path has no object".to_string())
}

fn snapshot_of(storage: &Storage) -> StorageSnapshot {
    let info = storage.info();
    StorageSnapshot {
        id: storage.id().0,
        description: if info.description.is_empty() {
            "Storage".into()
        } else {
            info.description.clone()
        },
        free_space: info.free_space,
        total_capacity: info.total_capacity,
        removable: matches!(
            info.storage_type,
            mtp_rs::mtp::StorageType::RemovableRam | mtp_rs::mtp::StorageType::RemovableRom
        ),
    }
}

/// A storage drawn as a directory, so the device root lists like any folder.
fn storage_entry(serial: &str, storage: &StorageSnapshot) -> Entry {
    Entry {
        name: storage.description.clone(),
        path: path::format(serial, storage.id, ""),
        kind: Kind::Dir,
        link_to_dir: false,
        size: storage.total_capacity.saturating_sub(storage.free_space),
        mtime: 0,
        added: 0,
        hidden: false,
        thumbable: false,
        is_repo: false,
        worktree_count: 0,
        branch: None,
        code: None,
        rollup: None,
    }
}

fn entry_of(serial: &str, storage: u64, rel: &str, object: &mtp_rs::mtp::ObjectInfo) -> Entry {
    let full = path::format(serial, storage, rel);
    let mtime = object.modified.as_ref().map(path::unix_seconds).unwrap_or(0);
    Entry {
        name: object.filename.clone(),
        kind: if object.is_folder() { Kind::Dir } else { Kind::File },
        link_to_dir: false,
        size: object.size,
        mtime,
        added: object.created.as_ref().map(path::unix_seconds).unwrap_or(mtime),
        // Android hides a folder from its own gallery with a `.nomedia` file,
        // not a dotted name, but dotfiles still read as hidden everywhere else.
        hidden: object.filename.starts_with('.'),
        thumbable: !object.is_folder() && crate::thumb::can_thumbnail(std::path::Path::new(&full)),
        is_repo: false,
        worktree_count: 0,
        branch: None,
        code: None,
        rollup: None,
        path: full,
    }
}

/// What to tell someone about a device that isn't ready. These are the strings
/// that replace "device not detected".
fn stage_message(device: &UsbDevice) -> String {
    match &device.stage {
        Stage::Connecting => format!("Connecting to {}…", device.name),
        Stage::AwaitingGrant => format!(
            "Unlock {} and choose “File transfer” when it asks what the cable is for",
            device.name
        ),
        Stage::Blocked { owner: Some(owner), .. } => {
            format!("{owner} is holding {} — quit it to continue", device.name)
        }
        Stage::Blocked { owner: None, .. } => {
            format!("Another app is holding {}", device.name)
        }
        Stage::Failed { message } => message.clone(),
        Stage::Ready => String::new(),
    }
}

fn describe(error: mtp_rs::Error) -> String {
    error.to_string()
}

/// Ask IORegistry which process has the device open. macOS records the owner of
/// an exclusively-held USB device, which turns "something else has it" into a
/// name a person can act on.
#[cfg(target_os = "macos")]
fn exclusive_owner(_vendor: u16, _product: u16) -> (Option<String>, Option<u32>) {
    let output = std::process::Command::new("ioreg")
        .args(["-c", "IOUSBHostDevice", "-w0", "-l"])
        .output()
        .ok();
    let Some(output) = output else { return (None, None) };
    let text = String::from_utf8_lossy(&output.stdout);
    let owners: Vec<&str> = text
        .lines()
        .filter(|line| line.contains("UsbExclusiveOwner"))
        .filter_map(|line| line.split('=').nth(1))
        .map(|value| value.trim().trim_matches('"'))
        .collect();
    pick_claimant(&owners)
}

#[cfg(not(target_os = "macos"))]
fn exclusive_owner(_vendor: u16, _product: u16) -> (Option<String>, Option<u32>) {
    (None, None)
}

/// Processes known to take an MTP device and not give it back.
///
/// `ptpcamerad` is macOS's own: it claims PTP/MTP devices on connection and
/// then cannot serve an Android phone, so it holds the device purely to deny
/// it. Android File Transfer does the same while it is running.
const CLAIMANTS: &[&str] = &["ptpcamerad", "Android File Transfer", "AndroidFileTransfer"];

/// Which of the recorded owners is actually standing in our way.
///
/// A phone with USB debugging on has several interfaces claimed at once — `adb`
/// holds its own, and macOS holds a serial one — and none of those block MTP.
/// Naming the wrong process would send someone to quit something irrelevant, so
/// only a known claimant counts.
fn pick_claimant(owners: &[&str]) -> (Option<String>, Option<u32>) {
    let found = owners
        .iter()
        .find(|owner| CLAIMANTS.iter().any(|name| owner.contains(name)));
    let Some(owner) = found else { return (None, None) };
    // The value reads "pid 5118, ptpcamerad".
    let pid = owner
        .split_once("pid ")
        .and_then(|(_, rest)| rest.split(',').next())
        .and_then(|digits| digits.trim().parse().ok());
    let name = owner
        .rsplit_once(',')
        .map(|(_, name)| name.trim().to_string())
        .unwrap_or_else(|| owner.to_string());
    (Some(name), pid)
}

/// Quit whatever is holding the device, when it is something we recognise.
///
/// Deliberately narrow. It will end `ptpcamerad` — a system daemon that launchd
/// brings straight back when something actually needs it — or Android File
/// Transfer, and nothing else. Fiddler should not be in the business of killing
/// arbitrary processes because they happen to be in the way.
pub fn release(owner: &str, pid: u32) -> Result<String, String> {
    if !CLAIMANTS.iter().any(|name| owner.contains(name)) {
        return Err(format!("Fiddler won't quit {owner} for you — quit it yourself to continue"));
    }
    let ended = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !ended {
        return Err(format!("Couldn't quit {owner}"));
    }
    Ok(owner.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mtp_rs::{register_virtual_device, unregister_virtual_device, VirtualDeviceConfig, VirtualStorageConfig};
    use std::fs;
    use std::path::PathBuf;

    /// A virtual device backed by a throwaway directory, so the listing path,
    /// the handle cache and the stage machine all run for real without a cable.
    struct Fake {
        dir: PathBuf,
        location: u64,
        serial: String,
    }

    impl Fake {
        fn new(name: &str) -> Fake {
            let dir = std::env::temp_dir().join(format!("fiddler-mtp-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join("DCIM/Camera")).unwrap();
            fs::create_dir_all(dir.join("Download")).unwrap();
            fs::write(dir.join("DCIM/Camera/IMG_0001.jpg"), b"\xFF\xD8\xFF\xE1 pretend jpeg body").unwrap();
            fs::write(dir.join("DCIM/Camera/IMG_0002.jpg"), b"second").unwrap();
            fs::write(dir.join("Download/notes.txt"), b"hello from the phone").unwrap();

            let serial = format!("VIRT-{name}");
            let config = VirtualDeviceConfig {
                manufacturer: "Fiddler".into(),
                model: "Test Phone".into(),
                serial: serial.clone(),
                storages: vec![VirtualStorageConfig {
                    description: "Internal storage".into(),
                    capacity: 64 * 1024 * 1024 * 1024,
                    backing_dir: dir.clone(),
                    read_only: false,
                }],
                watch_backing_dirs: false,
                event_poll_interval: Duration::ZERO,
                ..Default::default()
            };
            let info = register_virtual_device(&config);
            Fake { dir, location: info.location_id, serial }
        }

        /// A slot in the state the poll loop would have left it in.
        async fn slot(&self) -> Slot {
            let mut slot = Slot {
                device: None,
                storages: Vec::new(),
                handles: HashMap::new(),
                snapshot: UsbDevice {
                    serial: self.serial.clone(),
                    name: "unknown".into(),
                    vendor_id: 0,
                    product_id: 0,
                    stage: Stage::Connecting,
                    storages: Vec::new(),
                    link: None,
                    link_mbps: None,
                    throttled: false,
                },
                last_attempt: None,
            };
            advance(&mut slot, &self.serial).await;
            slot
        }
    }

    impl Fake {
        /// A device whose Camera folder holds `count` files, for exercising the
        /// paths that only appear once a folder outgrows one batch.
        fn crowded(name: &str, count: usize) -> Fake {
            let fake = Fake::new(name);
            for i in 0..count {
                fs::write(fake.dir.join(format!("DCIM/Camera/IMG_{i:04}.jpg")), b"x").unwrap();
            }
            fake
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            unregister_virtual_device(self.location);
            let _ = fs::remove_dir_all(&self.dir);
        }
    }


    /// Drive a listing to completion, returning everything it produced: the
    /// entries from the synchronous reply, the streamed batches, and whether
    /// the reply said more was coming.
    async fn drain(
        slot: &mut Slot,
        serial: &str,
        storage: Option<u64>,
        rel: &str,
        cancel: &CancelToken,
    ) -> (Vec<Entry>, Vec<EntryBatch>, bool) {
        let (tx, rx) = channel();
        let mut batches = Vec::new();
        let meta = Arc::new(Mutex::new(HashMap::new()));
        {
            let mut emit = |batch: EntryBatch| batches.push(batch);
            list(slot, serial, storage, rel, cancel, tx, &mut emit, &meta).await;
        }
        let (first, more) = rx.recv().expect("list must always reply").expect("listing failed");
        let mut all = first;
        for batch in &batches {
            all.extend(batch.entries.iter().cloned());
        }
        (all, batches, more)
    }

    /// The same, for a listing expected to fail.
    async fn drain_err(slot: &mut Slot, serial: &str, storage: Option<u64>, rel: &str) -> String {
        let (tx, rx) = channel();
        let meta = Arc::new(Mutex::new(HashMap::new()));
        let cancel = CancelToken::new();
        let mut emit = |_: EntryBatch| {};
        list(slot, serial, storage, rel, &cancel, tx, &mut emit, &meta).await;
        rx.recv().expect("list must always reply").unwrap_err()
    }

    #[tokio::test]
    async fn a_connected_device_reaches_ready_and_names_itself() {
        let fake = Fake::new("ready");
        let slot = fake.slot().await;
        assert_eq!(slot.snapshot.stage, Stage::Ready);
        // The USB product string is a placeholder until the session gives us the
        // real model; reaching Ready must have replaced it.
        assert_eq!(slot.snapshot.name, "Test Phone");
        assert_eq!(slot.snapshot.storages.len(), 1);
        assert_eq!(slot.snapshot.storages[0].description, "Internal storage");
    }

    #[tokio::test]
    async fn device_root_lists_storages_as_folders() {
        let fake = Fake::new("root");
        let mut slot = fake.slot().await;
        let (entries, _, _) = drain(&mut slot, &fake.serial, None, "", &CancelToken::new()).await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "Internal storage");
        assert!(matches!(entries[0].kind, Kind::Dir));
        // Navigating into it must produce a path the parser accepts.
        let parsed = path::parse(&entries[0].path).unwrap();
        assert_eq!(parsed.serial, fake.serial);
        assert!(parsed.storage.is_some());
        assert_eq!(parsed.rel, "");
    }

    #[tokio::test]
    async fn storage_root_lists_folders_first_with_addressable_paths() {
        let fake = Fake::new("listing");
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;

        let (entries, _, _) = drain(&mut slot, &fake.serial, Some(storage), "", &CancelToken::new()).await;
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["DCIM", "Download"]);
        assert_eq!(entries[0].path, format!("mtp://{}/{storage}/DCIM", fake.serial));

        // And the same call one level down, through the handle the listing cached.
        let (camera, _, _) = drain(&mut slot, &fake.serial, Some(storage), "/DCIM/Camera", &CancelToken::new()).await;
        let names: Vec<&str> = camera.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["IMG_0001.jpg", "IMG_0002.jpg"]);
        assert!(camera.iter().all(|e| matches!(e.kind, Kind::File)));
        // Photos must be marked previewable, or the grid stays full of glyphs.
        assert!(camera.iter().all(|e| e.thumbable));
        assert_eq!(camera[0].size, 22);
    }

    #[tokio::test]
    async fn a_cold_path_resolves_without_a_prior_listing() {
        // A thumbnail request can outlive the listing that cached its handle,
        // e.g. across a reconnect, so resolve() must be able to walk from the
        // storage root on its own.
        let fake = Fake::new("cold");
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;
        assert!(slot.handles.is_empty());

        let bytes = read_range(&mut slot, storage, "/Download/notes.txt", 0, 5).await.unwrap();
        assert_eq!(&bytes, b"hello");
        // The walk should have cached what it passed on the way down.
        assert!(slot.handles.contains_key(&(storage, "/Download".to_string())));
    }

    #[tokio::test]
    async fn a_bounded_read_returns_only_the_window_asked_for() {
        let fake = Fake::new("range");
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;
        let _ = drain(&mut slot, &fake.serial, Some(storage), "/Download", &CancelToken::new()).await;

        // This is the thumbnail trick: read the head of a file, not the file.
        let head = read_range(&mut slot, storage, "/Download/notes.txt", 0, 5).await.unwrap();
        assert_eq!(&head, b"hello");
        let middle = read_range(&mut slot, storage, "/Download/notes.txt", 6, 4).await.unwrap();
        assert_eq!(&middle, b"from");
    }

    #[tokio::test]
    async fn asking_for_more_bytes_than_a_file_has_returns_the_file() {
        // Thumbnails always ask for 256 KB, and most files on a phone are
        // smaller than that. If a read past EOF errored instead of clamping,
        // every small image would silently fall back to a grey glyph.
        let fake = Fake::new("eof");
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;

        let all = read_range(&mut slot, storage, "/Download/notes.txt", 0, 256 * 1024)
            .await
            .expect("a short file must not error on an oversized request");
        assert_eq!(&all, b"hello from the phone");

        // And a window that starts inside the file but runs off the end.
        let tail = read_range(&mut slot, storage, "/Download/notes.txt", 15, 4096).await.unwrap();
        assert_eq!(&tail, b"phone");
    }

    #[tokio::test]
    async fn a_listing_is_what_makes_a_thumbnail_key_available() {
        // The thumbnail cache probe reads sizes and mtimes out of a map the
        // listing fills, because there is no `stat` for an object on a phone
        // and a probe runs for every tile on screen.
        let fake = Fake::new("meta");
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;

        let (entries, _, _) = drain(&mut slot, &fake.serial, Some(storage), "/DCIM/Camera", &CancelToken::new()).await;
        let photo = entries.iter().find(|e| e.name == "IMG_0001.jpg").unwrap();
        assert!(photo.size > 0 && photo.thumbable);
        // Both halves of the key must survive the trip out of the listing.
        assert_eq!(photo.size, 22);
        assert_eq!(photo.path, format!("mtp://{}/{storage}/DCIM/Camera/IMG_0001.jpg", fake.serial));
    }

    #[tokio::test]
    async fn listing_a_device_that_has_not_granted_explains_rather_than_errors() {
        // The state the Samsung sat in on the bench: open, identified, no
        // storages. The message is the whole point of the stage existing.
        let fake = Fake::new("grant");
        let mut slot = fake.slot().await;
        slot.snapshot.stage = Stage::AwaitingGrant;
        slot.snapshot.name = "Galaxy Z Fold 7".into();

        let error = drain_err(&mut slot, &fake.serial, Some(1), "").await;
        assert!(error.contains("Unlock Galaxy Z Fold 7"), "{error}");
        assert!(error.contains("File transfer"), "{error}");
        assert!(!error.to_lowercase().contains("not detected"), "{error}");
    }


    #[tokio::test]
    async fn a_big_folder_answers_with_one_screenful_and_streams_the_rest() {
        // The whole point: a camera roll costs one metadata roundtrip per photo,
        // so the first call must come back with something drawable rather than
        // waiting for all of it.
        let fake = Fake::crowded("stream", 130);
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;

        let (all, batches, more) =
            drain(&mut slot, &fake.serial, Some(storage), "/DCIM/Camera", &CancelToken::new()).await;

        assert_eq!(all.len(), 130, "IMG_0001/0002 are among the generated names");
        assert!(more, "the reply must say more is coming");
        assert!(!batches.is_empty(), "the rest must arrive as batches");
        assert!(batches.last().unwrap().done, "the last batch closes the folder");
        assert_eq!(
            batches.iter().filter(|b| b.done).count(),
            1,
            "exactly one batch may be marked done"
        );
        // Every batch must name the folder it belongs to, so a batch that
        // arrives after the person has navigated away can be dropped.
        let expected = path::format(&fake.serial, storage, "/DCIM/Camera");
        assert!(batches.iter().all(|b| b.path == expected));
    }

    #[tokio::test]
    async fn a_small_folder_arrives_whole_with_nothing_left_to_stream() {
        let fake = Fake::new("small");
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;

        let (all, batches, more) =
            drain(&mut slot, &fake.serial, Some(storage), "/DCIM/Camera", &CancelToken::new()).await;

        assert_eq!(all.len(), 2);
        assert!(!more, "a folder that fits in one reply must not promise more");
        // Nothing is streamed: `more: false` on the reply is the completion
        // signal, so a small folder costs exactly one IPC message.
        assert!(batches.is_empty(), "a folder that fits in one reply emits no events");
    }

    #[tokio::test]
    async fn navigating_away_stops_the_read_instead_of_running_it_out() {
        // Leaving a folder mid-read is the common case, and the reason the
        // cancel token lives outside the worker: the worker is busy walking the
        // folder we want to abandon.
        let fake = Fake::crowded("cancel", 400);
        let mut slot = fake.slot().await;
        let storage = slot.snapshot.storages[0].id;

        let cancel = CancelToken::new();
        cancel.cancel();
        let (all, batches, _) =
            drain(&mut slot, &fake.serial, Some(storage), "/DCIM/Camera", &cancel).await;

        assert!(all.len() < 400, "a cancelled read must not deliver the whole folder");
        // And it must not report an error: leaving a folder is not a failure.
        // `drain` unwraps the reply, so reaching here at all is the assertion.
        assert!(
            batches.last().map(|b| b.done).unwrap_or(true),
            "any batch stream must still be closed"
        );
    }

    #[test]
    fn link_speeds_map_to_the_names_on_cable_packaging() {
        use mtp_rs::UsbSpeed;
        // The bench case: a Galaxy Z Fold 7 on a thin USB-C cable came up High.
        assert_eq!(
            describe_link(Some(UsbSpeed::High)),
            (Some("USB 2.0".into()), Some(480), true)
        );
        assert_eq!(
            describe_link(Some(UsbSpeed::Super)),
            (Some("USB 3.2 Gen 1".into()), Some(5_000), false)
        );
        assert_eq!(
            describe_link(Some(UsbSpeed::SuperPlus)),
            (Some("USB 3.2 Gen 2".into()), Some(10_000), false)
        );
        // Anything at or below USB 2.0 counts as throttled...
        assert!(describe_link(Some(UsbSpeed::Full)).2);
        assert!(describe_link(Some(UsbSpeed::Low)).2);
        // ...but a link the OS never reported must not produce a warning we
        // cannot back up.
        assert_eq!(describe_link(None), (None, None, false));
    }

    #[test]
    fn the_process_named_is_the_one_actually_in_the_way() {
        // Real output from a Galaxy with USB debugging on. Three interfaces are
        // claimed at once and only one of them blocks MTP — an earlier version
        // took the first line and would have told people to quit adb.
        let owners = [
            "pid 5492, adb",
            "pid 5118, ptpcamerad",
            "AppleUSBACMControl",
        ];
        assert_eq!(pick_claimant(&owners), (Some("ptpcamerad".into()), Some(5118)));

        // Order must not matter.
        let reversed = ["AppleUSBACMControl", "pid 5118, ptpcamerad", "pid 5492, adb"];
        assert_eq!(pick_claimant(&reversed), (Some("ptpcamerad".into()), Some(5118)));

        // Nothing we recognise: say nothing rather than accuse a bystander.
        assert_eq!(pick_claimant(&["pid 5492, adb"]), (None, None));
        assert_eq!(pick_claimant(&[]), (None, None));

        // An owner with no parseable pid still names the process, so the panel
        // can explain even when it cannot offer the button.
        let (name, pid) = pick_claimant(&["ptpcamerad"]);
        assert_eq!(name.as_deref(), Some("ptpcamerad"));
        assert_eq!(pid, None);
    }

    #[test]
    fn only_known_claimants_are_ever_quit() {
        // The button ends a system daemon that launchd restarts. It must never
        // become a way to kill whatever happens to hold a device.
        let refused = release("Final Cut Pro", 999_999).unwrap_err();
        assert!(refused.contains("won't quit Final Cut Pro"), "{refused}");
        assert!(refused.contains("quit it yourself"), "{refused}");
    }

    #[test]
    fn a_blocked_device_names_the_process_holding_it() {
        let mut device = UsbDevice {
            serial: "S".into(),
            name: "Pixel 9".into(),
            vendor_id: 0,
            product_id: 0,
            stage: Stage::Blocked { owner: Some("ptpcamerad".into()), owner_pid: Some(412) },
            storages: Vec::new(),
            link: None,
            link_mbps: None,
            throttled: false,
        };
        let message = stage_message(&device);
        assert!(message.contains("ptpcamerad"), "{message}");
        assert!(message.contains("Pixel 9"), "{message}");

        // Without a name we still say something true rather than nothing.
        device.stage = Stage::Blocked { owner: None, owner_pid: None };
        assert!(stage_message(&device).contains("Another app"));
    }
}
