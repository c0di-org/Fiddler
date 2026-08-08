//! Deciding *which* thumbnails to render, and in what order.
//!
//! The old scheme took each tile's request as it scrolled into view and served
//! them first-come-first-served. In a folder with thousands of files that is
//! close to the worst possible order: a flick of the trackpad queues every tile
//! it crosses, and the handful actually under the user's eyes end up at the back
//! of a queue hundreds deep.
//!
//! So the frontend doesn't ask for tiles one at a time. On every change it sends
//! the complete set it currently wants, nearest-to-viewport first, and that batch
//! *replaces* the queue. Work already scrolled past is dropped before we spend a
//! decode on it, and the queue depth stays bounded by what's on screen rather
//! than by how far the user has scrolled.
//!
//! Two lanes, because the two rendering paths have very different shapes: ImageIO
//! decodes are CPU-bound and sized to the machine, while Quick Look mostly waits
//! on another process and would otherwise let a slow PDF block a folder of JPEGs.

use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Results are announced in batches on this interval. Hundreds of individual
/// events would cost more in IPC than the rendering they're reporting.
const COALESCE: Duration = Duration::from_millis(24);

/// One tile's worth of want.
#[derive(Debug, Clone, Deserialize)]
pub struct ThumbReq {
    pub path: String,
    pub size: u32,
}

/// A finished tile. `src` is `None` when the file has no preview to give, which
/// the frontend caches so it stops asking.
#[derive(Debug, Clone, Serialize)]
pub struct ThumbReady {
    pub path: String,
    pub size: u32,
    pub src: Option<String>,
}

fn key(path: &str, size: u32) -> String {
    format!("{size}:{path}")
}

#[derive(Default)]
struct Queue {
    raster: VecDeque<ThumbReq>,
    quicklook: VecDeque<ThumbReq>,
    /// Keys currently queued or being rendered, so a re-sent batch doesn't
    /// duplicate work that's already under way.
    claimed: HashSet<String>,
    /// Files that have already failed once. Retrying them on every scroll would
    /// mean paying the full Quick Look timeout over and over.
    failed: HashSet<String>,
}

impl Queue {
    /// Replace the queue with `wanted`, returning everything that needs no work.
    fn admit(&mut self, wanted: Vec<ThumbReq>) -> Vec<ThumbReady> {
        // Anything still queued was wanted for a viewport that has since moved.
        // Drop it — the incoming batch is the current truth. Jobs a worker has
        // already picked up stay claimed, so they aren't started twice.
        self.raster.clear();
        self.quicklook.clear();

        let mut hits = Vec::new();
        for req in wanted {
            let k = key(&req.path, req.size);
            let path = Path::new(&req.path);

            let settled = if self.failed.contains(&k) {
                Some(None)
            } else if let Some(hit) = crate::thumb::cached(path, req.size) {
                Some(Some(hit.to_string_lossy().into_owned()))
            } else if !crate::thumb::can_thumbnail(path) {
                Some(None)
            } else {
                None
            };

            if let Some(src) = settled {
                hits.push(ThumbReady { path: req.path, size: req.size, src });
                continue;
            }
            if !self.claimed.insert(k) {
                continue;
            }
            if crate::thumb::is_raster(path) {
                self.raster.push_back(req);
            } else {
                self.quicklook.push_back(req);
            }
        }
        hits
    }
}

pub struct ThumbPool {
    queue: Mutex<Queue>,
    /// Signals workers that there is something to pick up.
    work: Condvar,
    outbox: Mutex<Vec<ThumbReady>>,
    /// Signals the emitter that results are waiting.
    ready: Condvar,
    app: AppHandle,
}

impl ThumbPool {
    pub fn start(app: AppHandle) -> Arc<Self> {
        let pool = Arc::new(ThumbPool {
            queue: Mutex::new(Queue::default()),
            work: Condvar::new(),
            outbox: Mutex::new(Vec::new()),
            ready: Condvar::new(),
            app,
        });

        // Raster work is CPU-bound, so it scales with the machine. Quick Look
        // work is mostly waiting on another process, so a fixed handful of
        // threads keeps that pipeline full without competing for cores.
        let raster_workers = num_cpus::get().clamp(2, 8);
        for _ in 0..raster_workers {
            spawn_worker(pool.clone(), Lane::Raster);
        }
        for _ in 0..6 {
            spawn_worker(pool.clone(), Lane::QuickLook);
        }
        spawn_emitter(pool.clone());

        pool
    }

    /// Take a new set of wanted tiles, superseding whatever was queued before.
    /// Returns the ones already on disk, so the common case of revisiting a
    /// folder resolves in the same round trip that asked.
    pub fn request(&self, wanted: Vec<ThumbReq>) -> Vec<ThumbReady> {
        let mut q = self.queue.lock().unwrap();
        let hits = q.admit(wanted);
        let waiting = q.raster.len() + q.quicklook.len();
        drop(q);
        if waiting > 0 {
            self.work.notify_all();
        }
        hits
    }

    /// Block until this lane has something to render.
    fn take(&self, lane: Lane) -> ThumbReq {
        let mut q = self.queue.lock().unwrap();
        loop {
            let next = match lane {
                Lane::Raster => q.raster.pop_front(),
                Lane::QuickLook => q.quicklook.pop_front(),
            };
            if let Some(req) = next {
                return req;
            }
            q = self.work.wait(q).unwrap();
        }
    }

    fn finish(&self, req: ThumbReq, src: Option<String>) {
        let k = key(&req.path, req.size);
        {
            let mut q = self.queue.lock().unwrap();
            q.claimed.remove(&k);
            if src.is_none() {
                q.failed.insert(k);
            }
        }
        self.outbox
            .lock()
            .unwrap()
            .push(ThumbReady { path: req.path, size: req.size, src });
        self.ready.notify_one();
    }
}

#[derive(Clone, Copy)]
enum Lane {
    Raster,
    QuickLook,
}

fn spawn_worker(pool: Arc<ThumbPool>, lane: Lane) {
    std::thread::spawn(move || loop {
        let req = pool.take(lane);
        let src = crate::thumb::generate(Path::new(&req.path), req.size)
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        pool.finish(req, src);
    });
}

/// Drains finished work to the frontend, pausing briefly first so a burst of
/// completions travels as one event rather than a hundred.
fn spawn_emitter(pool: Arc<ThumbPool>) {
    std::thread::spawn(move || loop {
        {
            let mut out = pool.outbox.lock().unwrap();
            while out.is_empty() {
                out = pool.ready.wait(out).unwrap();
            }
        }
        std::thread::sleep(COALESCE);
        let batch = std::mem::take(&mut *pool.outbox.lock().unwrap());
        if !batch.is_empty() {
            let _ = pool.app.emit("fiddler:thumbs", batch);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(path: &str) -> ThumbReq {
        ThumbReq { path: path.into(), size: 128 }
    }

    fn queued(q: &Queue) -> (Vec<&str>, Vec<&str>) {
        (
            q.raster.iter().map(|r| r.path.as_str()).collect(),
            q.quicklook.iter().map(|r| r.path.as_str()).collect(),
        )
    }

    #[test]
    fn a_new_batch_replaces_the_last_one() {
        let mut q = Queue::default();
        q.admit(vec![req("/nope/a.png"), req("/nope/b.png")]);
        assert_eq!(queued(&q).0, ["/nope/a.png", "/nope/b.png"]);

        // The viewport moved. Nothing from the old batch should survive.
        q.admit(vec![req("/nope/z.png")]);
        assert_eq!(queued(&q).0, ["/nope/z.png"]);
    }

    #[test]
    fn order_within_a_batch_is_preserved() {
        let mut q = Queue::default();
        q.admit(vec![req("/nope/1.png"), req("/nope/2.png"), req("/nope/3.png")]);
        assert_eq!(queued(&q).0, ["/nope/1.png", "/nope/2.png", "/nope/3.png"]);
    }

    #[test]
    fn the_two_lanes_are_kept_apart() {
        let mut q = Queue::default();
        q.admit(vec![req("/nope/photo.jpg"), req("/nope/paper.pdf"), req("/nope/clip.mov")]);
        let (raster, ql) = queued(&q);
        assert_eq!(raster, ["/nope/photo.jpg"]);
        assert_eq!(ql, ["/nope/paper.pdf", "/nope/clip.mov"]);
    }

    #[test]
    fn files_with_no_preview_are_settled_rather_than_queued() {
        let mut q = Queue::default();
        let hits = q.admit(vec![req("/nope/notes.txt"), req("/nope/Makefile")]);
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.src.is_none()));
        assert_eq!(queued(&q).0.len() + queued(&q).1.len(), 0);
    }

    #[test]
    fn work_already_under_way_is_not_queued_twice() {
        let mut q = Queue::default();
        q.admit(vec![req("/nope/a.png")]);
        // A worker takes the job; it stays claimed while it renders.
        q.raster.pop_front();

        q.admit(vec![req("/nope/a.png")]);
        assert!(queued(&q).0.is_empty(), "in-flight work must not be re-queued");

        // Once it finishes and is unclaimed, asking again is allowed.
        q.claimed.remove(&key("/nope/a.png", 128));
        q.admit(vec![req("/nope/a.png")]);
        assert_eq!(queued(&q).0, ["/nope/a.png"]);
    }

    #[test]
    fn a_repeat_within_one_batch_is_deduped() {
        let mut q = Queue::default();
        q.admit(vec![req("/nope/a.png"), req("/nope/a.png")]);
        assert_eq!(queued(&q).0, ["/nope/a.png"]);
    }

    #[test]
    fn failures_are_remembered_so_we_stop_retrying() {
        let mut q = Queue::default();
        q.failed.insert(key("/nope/broken.pdf", 128));

        let hits = q.admit(vec![req("/nope/broken.pdf")]);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].src.is_none());
        assert!(queued(&q).1.is_empty(), "a known-bad file must not be retried");
    }

    #[test]
    fn the_same_file_at_two_sizes_is_two_jobs() {
        let mut q = Queue::default();
        q.admit(vec![
            ThumbReq { path: "/nope/a.png".into(), size: 64 },
            ThumbReq { path: "/nope/a.png".into(), size: 256 },
        ]);
        assert_eq!(queued(&q).0.len(), 2);
    }
}
