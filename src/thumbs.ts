import * as ipc from "./ipc";
import type { ThumbReady } from "./types";

/**
 * One scheduler for every thumbnail on screen.
 *
 * Tiles used to each own an IntersectionObserver and fire their own request the
 * moment they scrolled into range. In a folder of a few thousand files that
 * means thousands of observers and one IPC round trip per tile — and, worse, the
 * backend served them in the order they were asked for, so a flick of the
 * trackpad buried the tiles the user actually ended up looking at under every
 * tile they'd scrolled past on the way.
 *
 * Instead, everything funnels through here: one shared observer, and on each
 * change we hand the backend the complete set we want, ordered outward from the
 * middle of the viewport. That batch replaces the previous one, so work for tiles
 * that are no longer on screen is dropped rather than rendered into a cache
 * nobody is waiting on.
 */

type Sink = (src: string | null) => void;

interface Want {
  path: string;
  size: number;
  /**
   * Everyone waiting, grouped by the element whose position speaks for them. The
   * same file at the same size can be on screen in more than one place — a tile
   * and the folder icon it is fanned out of — and each of those places has its
   * own claim on how urgent it is.
   */
  els: Map<Element, Set<Sink>>;
}

/** Resolved thumbnails; `null` means "this file has no preview to give". */
const memo = new Map<string, string | null>();
/** Roughly a dozen large folders' worth. Old entries cost a re-request, not a re-render. */
const MEMO_CAP = 8000;

const wanted = new Map<string, Want>();
/** Wants currently on screen, by the anchors that put them there. */
const onScreen = new Map<string, Set<Element>>();
/**
 * The wants each observed element stands for. Usually one — a tile and its own
 * preview — but a folder icon anchors the previews of the children fanned out of
 * it to the single element the observer can actually measure.
 */
const keys = new WeakMap<Element, Set<string>>();

/** Requests are re-sent at most this often while a scroll is in flight. */
const INTERVAL_MS = 90;
/** Start a little before a tile arrives, so it's ready when it does. */
const MARGIN = "240px 0px";

const keyOf = (path: string, size: number) => `${size}:${path}`;

let observer: IntersectionObserver | null = null;
function watcher(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const held = keys.get(e.target);
        if (!held) continue;
        for (const key of held) {
          if (e.isIntersecting) {
            let anchors = onScreen.get(key);
            if (!anchors) onScreen.set(key, (anchors = new Set()));
            anchors.add(e.target);
          } else {
            const anchors = onScreen.get(key);
            if (!anchors) continue;
            anchors.delete(e.target);
            if (anchors.size === 0) onScreen.delete(key);
          }
        }
      }
      schedule();
    }, { rootMargin: MARGIN });
  }
  return observer;
}

/** A thumbnail already known this session, or `undefined` if we've never asked. */
export function peek(path: string, size: number): string | null | undefined {
  return memo.get(keyOf(path, size));
}

/**
 * Ask for `path` at `size`, tracking `el`'s position to decide how urgent it is.
 * Returns an unsubscribe.
 */
export function subscribe(path: string, size: number, el: Element, sink: Sink): () => void {
  const key = keyOf(path, size);
  const known = memo.get(key);
  if (known !== undefined) {
    sink(known);
    return () => {};
  }

  let want = wanted.get(key);
  if (!want) {
    want = { path, size, els: new Map() };
    wanted.set(key, want);
  }
  let sinks = want.els.get(el);
  if (!sinks) want.els.set(el, (sinks = new Set()));
  sinks.add(sink);
  anchor(el, key);

  return () => {
    const still = wanted.get(key);
    const held = still?.els.get(el);
    if (!still || !held) return;
    held.delete(sink);
    if (held.size > 0) return;

    still.els.delete(el);
    release(el, key);
    if (still.els.size === 0) {
      wanted.delete(key);
      onScreen.delete(key);
      schedule();
    }
  };
}

/** Start answering for `key` whenever `el` is on screen. */
function anchor(el: Element, key: string) {
  let held = keys.get(el);
  if (!held) {
    held = new Set();
    keys.set(el, held);
  }
  held.add(key);
  // Observing something already observed is a no-op beyond one extra callback.
  watcher().observe(el);
}

/** Drop `key` from `el`, and the element itself once nothing else needs it. */
function release(el: Element, key: string) {
  const held = keys.get(el);
  if (!held) return;
  held.delete(key);
  if (held.size === 0) watcher().unobserve(el);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let lastFlush = 0;
/** What we last told the backend, so an unchanged viewport costs nothing. */
let lastSent = "";

function schedule() {
  if (timer !== undefined) return;
  // Immediate when the view has been still, throttled while it's moving.
  const wait = Math.max(0, INTERVAL_MS - (performance.now() - lastFlush));
  timer = setTimeout(flush, wait);
}

function flush() {
  timer = undefined;
  lastFlush = performance.now();

  const live: Want[] = [];
  for (const [key, want] of wanted) {
    if (onScreen.has(key)) live.push(want);
  }

  // Order outward from the middle of the viewport: that's where the eye is, and
  // the backend renders in the order we hand it. Every rect is read before
  // anything is written, so this doesn't thrash layout. A want showing in more
  // than one place is as urgent as its nearest showing.
  const middle = window.innerHeight / 2;
  const urgency = new Map<Want, number>();
  for (const w of live) {
    let nearest = Infinity;
    for (const el of w.els.keys()) {
      const box = el.getBoundingClientRect();
      nearest = Math.min(nearest, Math.abs(box.top + box.height / 2 - middle));
    }
    urgency.set(w, nearest);
  }
  live.sort((a, b) => urgency.get(a)! - urgency.get(b)!);

  const batch = live.map((w) => ({ path: w.path, size: w.size }));
  const signature = batch.map((r) => keyOf(r.path, r.size)).join("\n");
  if (signature === lastSent) return;
  lastSent = signature;

  // An empty batch is worth sending: it tells the backend to stop rendering for
  // a folder the user has already left.
  void ipc.thumbnails(batch).then(deliverAll).catch(() => {});
}

function deliverAll(ready: ThumbReady[]) {
  for (const r of ready) deliver(r);
}

function deliver({ path, size, src }: ThumbReady) {
  const key = keyOf(path, size);
  if (memo.size >= MEMO_CAP) forgetOldest();
  memo.set(key, src);

  const want = wanted.get(key);
  if (!want) return;
  wanted.delete(key);
  onScreen.delete(key);
  for (const [el, sinks] of want.els) {
    release(el, key);
    for (const sink of sinks) sink(src);
  }
}

/** Ask for a device-pixel-accurate thumbnail, snapped so the cache stays shared. */
export function thumbPx(size: number) {
  const want = size * Math.min(2, window.devicePixelRatio || 1);
  return want <= 64 ? 64 : want <= 128 ? 128 : want <= 256 ? 256 : 512;
}

/** Drop the least recently added quarter. `Map` iterates in insertion order. */
function forgetOldest() {
  let drop = Math.floor(MEMO_CAP / 4);
  for (const key of memo.keys()) {
    if (drop-- <= 0) break;
    memo.delete(key);
  }
}

void ipc.onThumbs(deliverAll);
