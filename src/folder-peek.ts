import * as ipc from "./ipc";
import type { PeekItem } from "./types";

/**
 * The leading children of every folder currently on screen, so its icon can show
 * what's inside.
 *
 * A folder icon asks for this the moment it mounts, and the views mount only what
 * is visible — but a flick of the trackpad still mounts hundreds of them on the
 * way past. So requests queue behind a few workers, newest first (that's where
 * the user stopped), and anything whose icon has since scrolled away is dropped
 * before it costs a `read_dir`.
 *
 * Subscriptions outlive their first answer: a folder whose contents change is
 * re-read and its icon repainted, without waiting to be scrolled off and back.
 */

/** Cards past the third stop reading as a fan and start reading as clutter. */
export const PEEK_LIMIT = 3;

type Sink = (items: PeekItem[]) => void;

const memo = new Map<string, PeekItem[]>();
/** A few large folders' worth of icons. Evicting costs a re-read, not a re-render. */
const MEMO_CAP = 4000;

/** Every icon currently on screen, by the folder it draws. */
const live = new Map<string, Set<Sink>>();
/** Paths waiting for a worker. The newest is served first, so it is a stack. */
const queue: string[] = [];
const pending = new Set<string>();
const inFlight = new Set<string>();
/** Folders that changed while we were already reading them. */
const stale = new Set<string>();
/** Enough to fill a screen of icons quickly, few enough to leave the disk to the
 *  thumbnails, which are what the eye is actually waiting on. */
const WORKERS = 3;

let showHidden = false;

/** What's already known for `path`, or `undefined` if we've never asked. */
export function peek(path: string): PeekItem[] | undefined {
  return memo.get(path);
}

/** Watch `path`'s leading children. Returns an unsubscribe. */
export function subscribe(path: string, sink: Sink): () => void {
  let sinks = live.get(path);
  if (!sinks) {
    sinks = new Set();
    live.set(path, sinks);
  }
  sinks.add(sink);

  const known = memo.get(path);
  if (known) sink(known);
  else request(path);

  return () => {
    const still = live.get(path);
    if (!still) return;
    still.delete(sink);
    // A queued path nobody wants any more is skipped when its turn comes, which
    // is cheaper than splicing it out of the middle.
    if (still.size === 0) live.delete(path);
  };
}

/** Re-read these folders: something inside them just changed. */
export function invalidate(paths: readonly string[]) {
  for (const path of paths) {
    memo.delete(path);
    if (live.has(path)) request(path);
  }
}

/** Follow the browser's own "show hidden files" setting. */
export function setShowHidden(v: boolean) {
  if (showHidden === v) return;
  showHidden = v;
  memo.clear();
  for (const path of live.keys()) request(path);
}

function request(path: string) {
  // A read already under way answers the folder as it was a moment ago, so a
  // change arriving now has to be picked up once that read lands.
  if (inFlight.has(path)) {
    stale.add(path);
    return;
  }
  if (pending.has(path)) return;
  pending.add(path);
  queue.push(path);
  pump();
}

function pump() {
  while (inFlight.size < WORKERS) {
    const path = queue.pop();
    if (path === undefined) return;
    pending.delete(path);
    if (!live.has(path)) continue;

    inFlight.add(path);
    void ipc
      .folderPeek(path, showHidden, PEEK_LIMIT)
      // An unreadable folder gets an empty fan rather than a retry on every
      // scroll past it.
      .catch(() => [] as PeekItem[])
      .then((items) => deliver(path, items));
  }
}

function deliver(path: string, items: PeekItem[]) {
  inFlight.delete(path);
  if (memo.size >= MEMO_CAP) forgetOldest();
  memo.set(path, items);

  const sinks = live.get(path);
  if (sinks) for (const sink of sinks) sink(items);

  if (stale.delete(path) && sinks) {
    memo.delete(path);
    request(path);
  }
  pump();
}

/** Drop the least recently added quarter. `Map` iterates in insertion order. */
function forgetOldest() {
  let drop = Math.floor(MEMO_CAP / 4);
  for (const key of memo.keys()) {
    if (drop-- <= 0) break;
    memo.delete(key);
  }
}
