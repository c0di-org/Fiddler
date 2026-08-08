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
  el: Element;
  sinks: Set<Sink>;
}

/** Resolved thumbnails; `null` means "this file has no preview to give". */
const memo = new Map<string, string | null>();
/** Roughly a dozen large folders' worth. Old entries cost a re-request, not a re-render. */
const MEMO_CAP = 8000;

const wanted = new Map<string, Want>();
const onScreen = new Set<string>();
const keys = new WeakMap<Element, string>();

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
        const key = keys.get(e.target);
        if (!key) continue;
        if (e.isIntersecting) onScreen.add(key);
        else onScreen.delete(key);
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
    want = { path, size, el, sinks: new Set() };
    wanted.set(key, want);
  }
  want.el = el;
  want.sinks.add(sink);
  keys.set(el, key);
  watcher().observe(el);

  return () => {
    watcher().unobserve(el);
    const still = wanted.get(key);
    if (!still) return;
    still.sinks.delete(sink);
    if (still.sinks.size === 0) {
      wanted.delete(key);
      onScreen.delete(key);
      schedule();
    }
  };
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
  // anything is written, so this doesn't thrash layout.
  const middle = window.innerHeight / 2;
  const urgency = new Map<Want, number>();
  for (const w of live) {
    const box = w.el.getBoundingClientRect();
    urgency.set(w, Math.abs(box.top + box.height / 2 - middle));
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
  watcher().unobserve(want.el);
  for (const sink of want.sinks) sink(src);
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
