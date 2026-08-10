/** The browser half of the thumbnail protocol.
 *
 * `src/thumbs.ts` is written against a very specific backend, and it is worth
 * honouring rather than papering over with `Promise.all`:
 *
 *  - each `thumbnails()` call *replaces* the outstanding set; anything dropped
 *    from it must be abandoned, which is how leaving a folder stops its work;
 *  - the batch arrives sorted by distance from the middle of the viewport, and
 *    is expected to be rendered in that order;
 *  - cache hits come back from the call, misses arrive later on the event;
 *  - `null` is a real answer meaning "no preview exists", and gets remembered.
 *
 * Blob URLs stand in for the desktop's on-disk cache paths, which is why
 * `fileSrc` is the identity function on this backend. */

import type { ThumbReady, ThumbReq } from "../../types";
import { MAX_CONCURRENT, render } from "./render";
import { basename } from "./vfs";

/** Roughly a few screenfuls of grid at every size the UI asks for. Each entry
 * pins a decoded image in memory, so this is the memory ceiling, not a hint. */
const CACHE_CAP = 600;
/** Matches the desktop emitter's coalescing window. */
const COALESCE_MS = 24;

const keyOf = (req: ThumbReq) => `${req.size}:${req.path}`;

// ------------------------------------------------------------------- cache

/** Insertion-ordered, so the oldest key is simply the first one out of the Map.
 * Eviction has to revoke: a dropped blob URL that is never revoked keeps its
 * bytes for the life of the tab. */
const cache = new Map<string, string | null>();

function remember(key: string, src: string | null) {
  cache.set(key, src);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    if (evicted) URL.revokeObjectURL(evicted);
    cache.delete(oldest.value);
  }
}

/** Drops every cached size for a path. Called after a write or a delete, so an
 * edited file doesn't keep showing the picture it used to be. */
export function forget(path: string) {
  for (const key of [...cache.keys()]) {
    if (key.slice(key.indexOf(":") + 1) === path) {
      const src = cache.get(key);
      if (src) URL.revokeObjectURL(src);
      cache.delete(key);
    }
  }
}

// ------------------------------------------------------------------- queue

let queue: ThumbReq[] = [];
const inFlight = new Set<string>();
let running = 0;

const listeners = new Set<(ready: ThumbReady[]) => void>();
let outbox: ThumbReady[] = [];
let flushTimer: number | null = null;

export function onThumbs(fn: (ready: ThumbReady[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(ready: ThumbReady) {
  outbox.push(ready);
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const batch = outbox;
    outbox = [];
    if (batch.length === 0) return;
    for (const fn of listeners) fn(batch);
  }, COALESCE_MS);
}

export function thumbnails(wanted: ThumbReq[]): Promise<ThumbReady[]> {
  const hits: ThumbReady[] = [];
  const misses: ThumbReq[] = [];

  for (const req of wanted) {
    const key = keyOf(req);
    if (cache.has(key)) hits.push({ ...req, src: cache.get(key)! });
    else if (!inFlight.has(key)) misses.push(req);
  }

  // Replace rather than append. Work already started is allowed to finish —
  // it's nearly done and its answer is worth caching either way — but nothing
  // merely queued for the old viewport survives into the new one.
  queue = misses;
  pump();
  return Promise.resolve(hits);
}

/** The single-shot path used by the preview pane, Quick Look and inline
 * markdown images. It jumps the queue because something is waiting on it. */
export async function thumbnail(path: string, size: number): Promise<string | null> {
  const key = keyOf({ path, size });
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  return produce(path, size);
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const req = queue.shift()!;
    const key = keyOf(req);
    if (cache.has(key) || inFlight.has(key)) continue;

    running++;
    void produce(req.path, req.size)
      .then((src) => publish({ ...req, src }))
      .catch(() => publish({ ...req, src: null }))
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function produce(path: string, size: number): Promise<string | null> {
  const key = keyOf({ path, size });
  inFlight.add(key);
  try {
    const blob = await render(path, basename(path), size);
    const src = blob ? URL.createObjectURL(blob) : null;
    remember(key, src);
    return src;
  } catch {
    // A file that can't be rendered is remembered as unrenderable; retrying it
    // on every scroll would cost the same and fail the same way.
    remember(key, null);
    return null;
  } finally {
    inFlight.delete(key);
  }
}
