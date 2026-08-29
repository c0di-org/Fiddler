/**
 * One audio element for the whole app, and everything that has to be true
 * around it.
 *
 * This is deliberately not a React component. A `<audio>` inside the preview
 * pane dies when the preview closes, and one inside a route dies when you walk
 * into a folder — which is the entire problem with playing an audiobook in a
 * file browser: the thing you are listening to is in a folder you have finished
 * looking at. So the element lives here, at module scope, outside the tree, and
 * the components that draw it subscribe. Navigating cannot stop it because
 * navigating does not touch it.
 *
 * The store is a hand-rolled one rather than a library: `subscribe` plus a
 * `snapshot` that only changes identity when something in it actually did,
 * which is exactly the shape `useSyncExternalStore` wants — and nothing else in
 * Fiddler needs a state library, so this isn't the place to introduce one.
 *
 * Three things this owns that a bare element does not:
 *
 * - **Where you were.** Persisted continuously while playing, not just on
 *   pause, because the way listening actually ends is the phone being locked
 *   and the app being reaped hours later. See `positions.ts`.
 * - **The queue.** A book is a folder, and reaching the end of chapter four
 *   means starting chapter five, unbroken. A player that stops between files is
 *   a player you have to hold.
 * - **The system.** On Android the transport controls are a notification and a
 *   pair of headphone buttons that Rust forwards in; on macOS and the web
 *   `navigator.mediaSession` does the same job. Both arrive here.
 */

import * as ipc from "../ipc";
import { bookTitle, trackTitle, type Track } from "./book";
import { loadMarks, markFor, noteProgress, resumeAt, saveMarks, type Mark } from "./positions";

export type { Track };

/** Stop after this much more *listening*, or at the end of what's playing.
 * `setMs` is what was asked for, so the sheet can show which button is on. */
export type Sleep = { kind: "in"; leftMs: number; setMs: number } | { kind: "chapter" };

export interface State {
  queue: Track[];
  index: number;
  track: Track | null;
  /** The folder's name — the book, as far as we can tell without tags. */
  book: string;
  playing: boolean;
  /** Between asking for a file and being able to play it. */
  loading: boolean;
  at: number;
  duration: number;
  rate: number;
  skipBack: number;
  skipForward: number;
  /** Something an `<img>` can load, once we've found one. */
  cover: string | null;
  error: string | null;
  sleep: Sleep | null;
}

const PREFS_KEY = "fiddler.audio.prefs";
const NOW_KEY = "fiddler.audio.now";

/** How much of a queue is worth writing down for the next launch. Past this,
 * the point is lost — nobody has one book with five hundred chapters, and
 * whatever produced the list is not something to restore into. */
const QUEUE_CAP = 500;

/** The speeds a button offers. Narrow at the bottom because nobody listens to
 * a book at half speed for long, and generous at the top because a slow
 * narrator at 2.5× is the entire reason speed controls exist. */
export const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Skips offered in the settings row. Back is shorter than forward by default
 * and that asymmetry is on purpose: you skip back because you missed something,
 * which is a sentence, and forward to get past something, which is a scene.
 *
 * Five, so the row doesn't wrap to leave one button stranded on a line of its
 * own on a phone. 45 is the one dropped: it is the only interval here that
 * isn't a round number of something. */
export const SKIPS = [10, 15, 20, 30, 60];

const MIN_RATE = 0.5;
const MAX_RATE = 3;

/** Position writes while playing. Ten seconds is the most you can lose to the
 * app being killed outright, and it is well under the run-up `positions.ts`
 * gives you back on the next resume — so the worst case is invisible. */
const PERSIST_EVERY_MS = 10_000;

/** The last few seconds before a sleep timer fires, spent fading out. Waking
 * up to a hard stop is worse than waking up to the fade, and the fade is also
 * the only warning anyone still awake gets. */
const FADE_MS = 8_000;

// ------------------------------------------------------------------ the store

let state: State = {
  queue: [],
  index: -1,
  track: null,
  book: "",
  playing: false,
  loading: false,
  at: 0,
  duration: 0,
  rate: 1,
  skipBack: 15,
  skipForward: 30,
  cover: null,
  error: null,
  sleep: null,
};

const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function snapshot(): State {
  return state;
}

function set(patch: Partial<State>) {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof State)[]) {
    if (!Object.is(state[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

// ------------------------------------------------------- the remembered marks
//
// A second, much quieter store. The player's own state changes several times a
// second while playing; the marks change every ten seconds at most. Folder
// tiles want the marks and would be repainting themselves four times a second
// if they had to take the player to get them.

let marks: Mark[] = [];
const markListeners = new Set<() => void>();

export function subscribeMarks(fn: () => void): () => void {
  markListeners.add(fn);
  return () => markListeners.delete(fn);
}

export function marksSnapshot(): Mark[] {
  return marks;
}

function setMarks(next: Mark[]) {
  if (next === marks) return;
  marks = next;
  saveMarks(marks);
  for (const fn of markListeners) fn();
}

/** How far through a recording someone got, for the ring on its icon. */
export function markOf(path: string): Mark | null {
  return markFor(marks, path);
}

// --------------------------------------------------------------- the element

let el: HTMLAudioElement | null = null;
/** Guards the gap between asking for a URL and getting one: tapping three
 * chapters quickly must not end with the third one's element playing the
 * first one's bytes. */
let loadToken = 0;
/** Set on load, applied once the file admits how long it is. */
let pendingSeek: number | null = null;
/**
 * Which track's bytes the element is actually holding.
 *
 * Not the same question as "which track is current", and the gap between them
 * is a data-loss bug: changing chapter sets the new track and *then* pauses the
 * element, and the pause fires a `pause` event whose handler writes
 * `currentTime` down — the old chapter's position, filed under the new
 * chapter's path. Which is to say, opening chapter five would silently push
 * chapter four's bookmark onto it. Positions are only written while these two
 * agree.
 */
let loadedPath: string | null = null;
let lastPersist = 0;
let sleepTicker: ReturnType<typeof setInterval> | null = null;
let sleepFading = false;

function audio(): HTMLAudioElement {
  if (el) return el;
  const node = new window.Audio();
  node.preload = "metadata";
  // Without this a book at 1.5× is a chipmunk reading a book at 1.5×. The
  // standard property is `preservesPitch`; the webkit-prefixed one is what the
  // macOS webview understood for years and costs nothing to keep setting.
  node.preservesPitch = true;
  (node as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
  node.addEventListener("loadedmetadata", () => {
    const duration = Number.isFinite(node.duration) ? node.duration : 0;
    if (pendingSeek !== null) {
      const to = Math.min(pendingSeek, Math.max(0, duration - 1));
      pendingSeek = null;
      if (to > 0) {
        try {
          node.currentTime = to;
        } catch {
          // A stream that refuses to be seeked plays from the top, which is
          // worse than resuming and better than not playing.
        }
      }
    }
    set({ duration, at: node.currentTime, loading: false });
    pushSystemState();
  });
  node.addEventListener("timeupdate", () => {
    set({ at: node.currentTime });
    maybePersist();
  });
  node.addEventListener("durationchange", () => {
    if (Number.isFinite(node.duration)) set({ duration: node.duration });
  });
  node.addEventListener("play", () => {
    set({ playing: true, error: null });
    pushSystemState();
  });
  node.addEventListener("pause", () => {
    // The pause that comes at the end of a file is the `ended` handler's, and
    // it has already written the position down as finished.
    if (!node.ended) persist();
    set({ playing: false });
    pushSystemState();
  });
  node.addEventListener("waiting", () => set({ loading: true }));
  node.addEventListener("playing", () => set({ loading: false }));
  node.addEventListener("ended", onEnded);
  node.addEventListener("error", () => {
    // Emptying the element on close raises one of these with nothing loaded.
    // An error about a file nobody asked for is worse than silence.
    if (!state.track || !loadedPath) return;
    set({
      loading: false,
      playing: false,
      error: state.track ? `Fiddler can’t play “${state.track.name}”` : "This file can’t be played",
    });
    pushSystemState();
  });
  el = node;
  return node;
}

// -------------------------------------------------------------------- opening

/** Start a book. `tracks` is the whole folder in listening order, `index` the
 * one that was tapped, `cover` a picture in the same folder or null. */
export function open(tracks: Track[], index: number, cover: string | null = null) {
  if (tracks.length === 0) return;
  const at = Math.min(Math.max(0, index), tracks.length - 1);
  // Tapping the chapter that is already loaded means "carry on", not "start
  // again". Reloading would resume from the mark, which is nearly the same
  // place — but only nearly, and the gap is a rewind nobody asked for.
  if (state.track?.path === tracks[at].path && loadedPath === tracks[at].path) {
    set({ queue: tracks, index: at, error: null });
    rememberNow(cover);
    if (!state.playing) void resume();
    return;
  }
  set({
    queue: tracks,
    index: at,
    track: tracks[at],
    book: bookTitle(tracks[at].folder),
    error: null,
  });
  void loadCover(cover);
  void load(at, true);
  rememberNow(cover);
}

/** The same book, a different chapter. */
export function goTo(index: number, autoplay = true) {
  if (index < 0 || index >= state.queue.length) return;
  persist();
  set({ index, track: state.queue[index], error: null });
  void load(index, autoplay);
  rememberNow(coverPath);
}

async function load(index: number, autoplay: boolean) {
  const track = state.queue[index];
  if (!track) return;
  const token = ++loadToken;
  const node = audio();
  // Before the pause, so the `pause` event it fires can't file the outgoing
  // chapter's position under the incoming one.
  loadedPath = null;
  node.pause();
  set({ loading: true, at: 0, duration: 0 });
  let url: string;
  try {
    url = await ipc.mediaUrl(track.path);
  } catch {
    if (token !== loadToken) return;
    set({ loading: false, error: `Fiddler can’t reach “${track.name}”` });
    return;
  }
  if (token !== loadToken) return;
  // Asked before the element is told anything, so the run-up is computed
  // against the position as it was left rather than against a fresh zero.
  pendingSeek = resumeAt(marks, track.path, 0, Date.now());
  node.src = url;
  loadedPath = track.path;
  node.playbackRate = state.rate;
  node.volume = 1;
  node.load();
  if (autoplay) {
    try {
      await node.play();
    } catch {
      // Autoplay refused, or the file was swapped out from under us. Either
      // way the controls are on screen and the next tap is the answer.
      if (token === loadToken) set({ loading: false, playing: false });
    }
  } else {
    set({ loading: false });
  }
}

// ---------------------------------------------------------------- the verbs

export function toggle() {
  if (!state.track) return;
  if (state.playing) pause();
  else void resume();
}

export function pause() {
  el?.pause();
}

export async function resume() {
  if (!state.track) return;
  const node = audio();
  // Restored from a previous launch: the queue is there but the element has
  // never been given a file. The first tap is what loads it.
  if (!node.src) {
    await load(state.index, true);
    return;
  }
  // A sleep timer that ran out faded the volume on its way down; pressing play
  // again is asking for the book back, not for a whisper.
  node.volume = 1;
  sleepFading = false;
  try {
    await node.play();
  } catch {
    set({ playing: false });
  }
}

export function seekTo(seconds: number) {
  const node = el;
  if (!node || !state.track) return;
  const limit = state.duration > 0 ? state.duration : Number.MAX_SAFE_INTEGER;
  const to = Math.min(Math.max(0, seconds), limit);
  try {
    node.currentTime = to;
  } catch {
    return;
  }
  set({ at: to });
  persist();
  pushSystemState();
}

/** The two big buttons. Clamped rather than spilling into the next chapter:
 * a skip is a correction inside what you are listening to, and landing in a
 * different file because you pressed forward twice is never what was meant. */
export function skip(delta: number) {
  if (!state.track) return;
  seekTo((el?.currentTime ?? state.at) + delta);
}

export function next() {
  if (state.index + 1 < state.queue.length) goTo(state.index + 1);
}

/**
 * Back a chapter — or, if you are already some way in, back to the top of this
 * one. Every physical transport control ever made behaves this way, and the
 * reason is that "previous" from four minutes in almost always means "start
 * this again".
 */
export function previous() {
  if ((el?.currentTime ?? state.at) > 5 || state.index === 0) {
    seekTo(0);
    return;
  }
  goTo(state.index - 1);
}

export function setRate(rate: number) {
  const next = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  set({ rate: next });
  if (el) el.playbackRate = next;
  savePrefs();
  pushSystemState();
}

export function setSkips(back: number, forward: number) {
  set({ skipBack: back, skipForward: forward });
  savePrefs();
  pushSystemState();
}

/** Put the player away: stop, forget the queue, take the bar off the screen.
 * The positions stay — closing the player is not saying you didn't listen. */
export function close() {
  persist();
  loadToken++;
  if (el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }
  setSleep(null);
  loadedPath = null;
  set({
    queue: [],
    index: -1,
    track: null,
    book: "",
    playing: false,
    loading: false,
    at: 0,
    duration: 0,
    cover: null,
    error: null,
  });
  // Cancels an in-flight cover fetch: without this, a thumbnail that resolves
  // after the player was closed paints a cover onto a bar that is no longer on
  // screen — and onto the next book if one is opened first.
  coverToken++;
  coverPath = null;
  try {
    localStorage.removeItem(NOW_KEY);
  } catch {
    // Nothing to do; the next open overwrites it anyway.
  }
  clearSystemState();
}

// --------------------------------------------------------------- sleep timer

export function setSleep(sleep: Sleep | null) {
  if (sleepTicker) {
    clearInterval(sleepTicker);
    sleepTicker = null;
  }
  sleepFading = false;
  if (el) el.volume = 1;
  set({ sleep });
  if (!sleep || sleep.kind === "chapter") return;
  let last = Date.now();
  sleepTicker = setInterval(() => {
    const now = Date.now();
    const step = now - last;
    last = now;
    const current = state.sleep;
    if (!current || current.kind !== "in") return;
    // Counts down listening, not wall-clock. Someone who pauses to talk for ten
    // minutes has not used ten minutes of their sleep timer.
    if (!state.playing) return;
    const leftMs = current.leftMs - step;
    if (leftMs <= 0) {
      setSleep(null);
      pause();
      return;
    }
    if (leftMs <= FADE_MS && el) {
      sleepFading = true;
      el.volume = Math.max(0, leftMs / FADE_MS);
    }
    set({ sleep: { ...current, leftMs } });
  }, 500);
}

/** Another quarter of an hour, for the case the timer is for: you woke up. */
export function extendSleep(ms: number) {
  const current = state.sleep;
  if (!current || current.kind !== "in") return;
  setSleep({ kind: "in", leftMs: current.leftMs + ms, setMs: current.setMs + ms });
  if (sleepFading && el) el.volume = 1;
}

// ----------------------------------------------------------------- the end

function onEnded() {
  const track = state.track;
  if (track) {
    const duration = state.duration || el?.duration || 0;
    setMarks(noteProgress(marks, track.path, duration || state.at, duration, Date.now()));
  }
  if (state.sleep?.kind === "chapter") {
    setSleep(null);
    set({ playing: false });
    pushSystemState();
    return;
  }
  if (state.index + 1 < state.queue.length) {
    goTo(state.index + 1, true);
    return;
  }
  set({ playing: false, at: state.duration });
  pushSystemState();
}

// -------------------------------------------------------------- persistence

function maybePersist() {
  const now = Date.now();
  if (now - lastPersist < PERSIST_EVERY_MS) return;
  persist();
}

function persist() {
  const track = state.track;
  const node = el;
  if (!track || !node || track.path !== loadedPath) return;
  lastPersist = Date.now();
  const duration = Number.isFinite(node.duration) ? node.duration : state.duration;
  setMarks(noteProgress(marks, track.path, node.currentTime, duration, lastPersist));
}

interface StoredNow {
  queue: Track[];
  index: number;
  cover: string | null;
}

let coverPath: string | null = null;

function rememberNow(cover: string | null) {
  coverPath = cover;
  try {
    const stored: StoredNow = {
      queue: state.queue.slice(0, QUEUE_CAP),
      index: state.index,
      cover,
    };
    localStorage.setItem(NOW_KEY, JSON.stringify(stored));
  } catch {
    // The bar simply won't come back on the next launch.
  }
}

function readPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return;
    const { rate, skipBack, skipForward } = raw as Record<string, unknown>;
    const patch: Partial<State> = {};
    if (typeof rate === "number" && Number.isFinite(rate)) {
      patch.rate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
    }
    if (typeof skipBack === "number" && SKIPS.includes(skipBack)) patch.skipBack = skipBack;
    if (typeof skipForward === "number" && SKIPS.includes(skipForward)) {
      patch.skipForward = skipForward;
    }
    set(patch);
  } catch {
    // Defaults are fine.
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ rate: state.rate, skipBack: state.skipBack, skipForward: state.skipForward })
    );
  } catch {
    // The setting lasts for this session only.
  }
}

/**
 * What was playing when Fiddler was last closed, brought back paused.
 *
 * Nothing is loaded and nothing plays — the bar simply reappears with the book
 * on it, and the first tap loads and resumes. That restraint is the point: an
 * app that starts making noise because it was opened is an app people learn to
 * be afraid of, and the browser would refuse the autoplay anyway.
 */
function restoreNow() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOW_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return;
    const { queue, index, cover } = raw as Record<string, unknown>;
    if (!Array.isArray(queue) || queue.length === 0) return;
    const tracks: Track[] = [];
    for (const item of queue) {
      if (!item || typeof item !== "object") continue;
      const { path, name, folder } = item as Record<string, unknown>;
      if (typeof path !== "string" || typeof name !== "string" || typeof folder !== "string") {
        continue;
      }
      tracks.push({ path, name, folder });
      if (tracks.length >= QUEUE_CAP) break;
    }
    if (tracks.length === 0) return;
    const at =
      typeof index === "number" && index >= 0 && index < tracks.length ? Math.floor(index) : 0;
    coverPath = typeof cover === "string" ? cover : null;
    set({
      queue: tracks,
      index: at,
      track: tracks[at],
      book: bookTitle(tracks[at].folder),
      at: resumeAt(marks, tracks[at].path, 0, Date.now()),
      duration: markFor(marks, tracks[at].path)?.duration ?? 0,
    });
    void loadCover(coverPath);
  } catch {
    // Starting with no bar is a perfectly good state.
  }
}

/** Its own counter rather than sharing the track's: a cover outlives the
 * chapter it was fetched for, so a chapter change must not be able to cancel
 * one, and opening a second book must. */
let coverToken = 0;

async function loadCover(path: string | null) {
  const token = ++coverToken;
  coverPath = path;
  if (!path) {
    set({ cover: null });
    return;
  }
  set({ cover: null });
  try {
    // The thumbnailer's copy first: a cover is often a 3000px scan, and the
    // notification and the bar both want something small.
    const thumb = await ipc.thumbnail(path, 512);
    const url = thumb ? ipc.fileSrc(thumb) : await ipc.mediaUrl(path);
    if (token !== coverToken) return;
    set({ cover: url });
  } catch {
    if (token === coverToken) set({ cover: null });
  }
}

// ------------------------------------------------------------- the system

/**
 * Tell the platform what is playing.
 *
 * Two audiences, and neither is optional for a book. `navigator.mediaSession`
 * is what puts a title on the Mac's Now Playing widget and on a browser's own
 * media controls. `ipc.setPlaybackState` is Android's, where it is load-bearing
 * in a way the other isn't: it is what keeps the process alive with the screen
 * off, and what puts the lock screen controls there at all.
 */
function pushSystemState() {
  const track = state.track;
  if (!track) return;
  const title = trackTitle(track.name);
  const subtitle = state.book;
  const ms = "mediaSession" in navigator ? navigator.mediaSession : null;
  if (ms) {
    try {
      ms.metadata = new window.MediaMetadata({
        title,
        artist: subtitle,
        album: subtitle,
        artwork: state.cover ? [{ src: state.cover }] : [],
      });
      ms.playbackState = state.playing ? "playing" : "paused";
      if (state.duration > 0 && typeof ms.setPositionState === "function") {
        ms.setPositionState({
          duration: state.duration,
          playbackRate: state.rate,
          position: Math.min(state.at, state.duration),
        });
      }
    } catch {
      // Older webviews have half of this. Half is still worth having.
    }
  }
  void ipc.setPlaybackState?.({
    playing: state.playing,
    title,
    subtitle,
    positionMs: Math.round(state.at * 1000),
    durationMs: Math.round(state.duration * 1000),
    speed: state.rate,
    artPath: coverPath,
    canPrevious: state.index > 0 || state.at > 5,
    canNext: state.index + 1 < state.queue.length,
    skipBack: state.skipBack,
    skipForward: state.skipForward,
  });
}

function clearSystemState() {
  const ms = "mediaSession" in navigator ? navigator.mediaSession : null;
  if (ms) {
    try {
      ms.metadata = null;
      ms.playbackState = "none";
    } catch {
      // Nothing to undo.
    }
  }
  void ipc.clearPlaybackState?.();
}

/** A transport press, from wherever it came: a notification button, a
 * headphone remote, a steering wheel. */
export function transport(action: string, value = 0) {
  switch (action) {
    case "play":
      void resume();
      break;
    case "pause":
      pause();
      break;
    case "toggle":
      toggle();
      break;
    case "next":
      next();
      break;
    case "previous":
      previous();
      break;
    case "forward":
      skip(state.skipForward);
      break;
    case "back":
      skip(-state.skipBack);
      break;
    case "seek":
      seekTo(value / 1000);
      break;
    case "stop":
      pause();
      break;
    // The notification was swiped away, which is how a phone says "I'm done
    // with this". Not a pause: the bar goes too, and the position is written
    // down on the way out.
    case "close":
      close();
      break;
    default:
      break;
  }
}

function wireMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const bind = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Not every webview knows every action; the ones it does still work.
    }
  };
  bind("play", () => transport("play"));
  bind("pause", () => transport("pause"));
  bind("previoustrack", () => transport("previous"));
  bind("nexttrack", () => transport("next"));
  bind("seekbackward", (d) => skip(-(d.seekOffset ?? state.skipBack)));
  bind("seekforward", (d) => skip(d.seekOffset ?? state.skipForward));
  bind("seekto", (d) => {
    if (typeof d.seekTime === "number") seekTo(d.seekTime);
  });
  bind("stop", () => transport("pause"));
}

/**
 * The transport keys on a real keyboard.
 *
 * `mediaSession` covers the *system's* controls, and on a Mac that includes the
 * function-row keys — but a Bluetooth keyboard on DeX reports them as ordinary
 * key events and nothing picks them up. Three lines, and the keyboard someone
 * has already plugged in to use Fiddler on a monitor becomes a remote.
 *
 * Deliberately not bound to space: space is Quick Look, everywhere in Fiddler,
 * and a folder is what is on screen when these keys are pressed.
 */
function wireMediaKeys() {
  window.addEventListener(
    "keydown",
    (event) => {
      if (!state.track) return;
      switch (event.key) {
        case "MediaPlayPause":
        case "MediaPlay":
        case "MediaPause":
          toggle();
          break;
        case "MediaTrackNext":
          next();
          break;
        case "MediaTrackPrevious":
          previous();
          break;
        case "MediaStop":
          pause();
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    true
  );
}

// ------------------------------------------------------------------- startup

let started = false;

/** Called once, from `main.tsx`. Everything here is cheap and none of it
 * touches the disk; the element itself is not built until something plays. */
export function start() {
  if (started) return;
  started = true;
  marks = loadMarks();
  readPrefs();
  restoreNow();
  wireMediaSession();
  wireMediaKeys();
  void ipc.onTransport?.((action, value) => transport(action, value));
  // The page going away is the last chance to write the position down, and on
  // a phone it is the *only* one that fires — `beforeunload` does not.
  window.addEventListener("pagehide", persist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persist();
  });
}
