/** The whole surface the UI needs from whatever is underneath it.
 *
 * Fiddler runs against two of these: a Tauri build talking to Rust over IPC,
 * and a browser build talking to a virtual filesystem in the tab. Vite picks
 * one at build time (see `@backend` in `vite.config.ts`); nothing above this
 * file knows which it got.
 *
 * Keeping the seam this narrow is what makes the web build possible at all —
 * the markdown parser, the highlighter, the sort and search code, and the
 * thumbnail scheduler are all plain TypeScript that never learns the
 * difference. */

import type {
  ContentSearch,
  DirListing,
  EjectOutcome,
  EntryBatch,
  Inspect,
  NearbyAccess,
  NearbySearch,
  PairOutcome,
  PairRequest,
  PairingInfo,
  PdfMeta,
  PeekItem,
  PeerDevice,
  Place,
  RepoInfo,
  RepoStatusPayload,
  TextHead,
  ThumbReady,
  ThumbReq,
  TransferOutcome,
  TransferProgress,
  Trashed,
  UsbDevice,
  Volume,
} from "../types";

/** Stops a subscription. Matches Tauri's `UnlistenFn` so the Tauri backend can
 * pass its own through untouched. */
export type Unlisten = () => void;

export interface Backend {
  // ------------------------------------------------------------- browsing

  listDir(path: string, showHidden: boolean): Promise<DirListing>;
  /** A hard-capped, no-symlink fallback used only after local search finds nothing. */
  nearbyEntries(path: string, showHidden: boolean, maxDepth?: number): Promise<NearbySearch>;
  searchContents(path: string, names: string[], terms: string[]): Promise<ContentSearch>;
  inspect(path: string): Promise<Inspect>;
  /** The leading children of a folder, for the fan of cards on its icon. */
  folderPeek(path: string, showHidden: boolean, limit: number): Promise<PeekItem[]>;
  /** The front of a text file, bounded by `maxBytes` and cut on a character. */
  readText(path: string, maxBytes: number): Promise<TextHead>;

  // ------------------------------------------------------------------ git

  repoInfo(path: string): Promise<RepoInfo | null>;
  refreshRepo(root: string): Promise<void>;
  onRepoStatus(fn: (p: RepoStatusPayload) => void): Promise<Unlisten>;

  // -------------------------------------------------------------- places

  sidebarPlaces(): Promise<Place[]>;
  nearbyDevices(): Promise<PeerDevice[]>;
  nearbyPairingInfo(): Promise<PairingInfo>;
  /** Ask a device for permission to browse it. Nobody's files move on the
   * strength of this call: the answer is a tap on that device, so the normal
   * first result is `waiting` and the caller asks again until it changes. */
  pairNearbyDevice(id: string): Promise<PairOutcome>;
  /** Devices asking to browse this one, waiting on an answer here. */
  nearbyRequests(): Promise<PairRequest[]>;
  /** Answer one of them. This is the only thing that grants a device access. */
  respondNearbyRequest(id: string, allow: boolean): Promise<void>;
  /** Everything currently holding access, in both directions. */
  nearbyAccess(): Promise<NearbyAccess>;
  /** Stop letting a device browse this one. Its token stops authorising at
   * once, and it becomes a stranger again if it asks a second time. */
  withdrawNearbyDevice(id: string): Promise<void>;
  /** Drop this device's own key to another one. Nothing changes over there. */
  forgetNearbyDevice(id: string): Promise<void>;

  /** Devices attached by cable, each with the stage it has reached. Always
   * empty where there is no USB host to speak MTP with — a browser tab, or the
   * Android build, which is the thing on the other end of the cable. */
  usbDevices(): Promise<UsbDevice[]>;
  /** Fires when a device's stage changes: plugged in, unlocked, granted,
   * unplugged. What lets the sidebar advance while someone is looking at their
   * phone rather than at Fiddler. */
  onUsbDevices(fn: (devices: UsbDevice[]) => void): Promise<Unlisten>;
  /** The rest of a device folder, after `listDir` returned its first screenful.
   * MTP costs a round trip per object, so a big folder is drawn as it is read. */
  onUsbEntries(fn: (batch: EntryBatch) => void): Promise<Unlisten>;
  /** Quit whatever is holding a device, when it's something we recognise.
   * Resolves with the name of what was quit. */
  releaseUsbDevice(serial: string): Promise<string>;

  /** Disks mounted right now: external drives, cards, disk images, shares.
   * Never the startup disk — that one is not somewhere you arrive by plugging
   * something in, and everything on it is already reachable from Places.
   * Always empty in a browser tab, which has no volumes to have. */
  volumes(): Promise<Volume[]>;
  /** Fires when something is mounted or unmounted, with the whole list. What
   * lets a drive appear in the sidebar the moment it is plugged in, and vanish
   * when it is pulled out, without anything here asking again. */
  onVolumes(fn: (volumes: Volume[]) => void): Promise<Unlisten>;
  /** Put a volume away.
   *
   * `force` is not a retry: an ordinary eject resolves `busy` and leaves the
   * volume exactly as it was, naming what is still holding it. Forcing one
   * takes it out from under whatever that was, so the answer to "should we"
   * belongs to the person whose files are on it — hence a parameter rather
   * than a second attempt. */
  ejectVolume(id: string, force: boolean): Promise<EjectOutcome>;

  // ------------------------------------------------------------ mutation

  createFolder(parent: string, name: string): Promise<string>;
  /** Creates a UTF-8 text file. The name is deliberately passed through whole so
   * callers can choose any normal extension: `.txt`, `.md`, `.json`, and so on. */
  createTextFile(parent: string, name: string, text: string): Promise<string>;
  /** Writes a text file atomically, so a save never leaves a half-written file. */
  writeTextFile(path: string, text: string): Promise<void>;
  renamePath(path: string, newName: string): Promise<string>;
  /** `job` is chosen by the caller, not returned by this call — the call does
   * not resolve until the copy is over, which is exactly the span in which
   * `cancelTransfer` needs something to name. */
  copyPaths(paths: string[], destination: string, job: number): Promise<TransferOutcome>;
  /** The same transfer, without leaving the originals behind. Separate from
   * `copyPaths` because within one volume it is an entry rewrite rather than a
   * copy, and because it must never overwrite: a name already taken at the
   * destination refuses the whole batch rather than moving part of it. Only a
   * move that has to cross volumes reports progress or can be stopped; the
   * rest are over before there is anything to say. */
  movePaths(paths: string[], destination: string, job: number): Promise<TransferOutcome>;
  /** Stop a running transfer, which then removes everything it had written —
   * and in a move, leaves the originals untouched. Doing nothing is the right
   * answer for a job that has already finished. */
  cancelTransfer(job: number): Promise<void>;
  /** Fires as a transfer runs, at most a handful of times a second. */
  onTransfer(fn: (progress: TransferProgress) => void): Promise<Unlisten>;
  /** Resolves with where each item landed, which is what lets the deletion be
   * undone. An empty answer means it happened but can't be walked back. */
  trashPaths(paths: string[]): Promise<Trashed[]>;
  /** Put trashed items back. Refuses rather than overwrites — undo has to be
   * the one operation that cannot itself lose anything. */
  restoreTrashed(items: Trashed[]): Promise<string[]>;
  /** Fires with the directories whose contents changed. Every mutation above is
   * expected to produce one of these — the UI does not refresh itself. */
  onDirsChanged(fn: (dirs: string[]) => void): Promise<Unlisten>;

  // ---------------------------------------------------------- previewing

  thumbnail(path: string, size: number): Promise<string | null>;
  /** Declare everything worth rendering right now; returns whatever was cached.
   * Each call *replaces* the outstanding set rather than adding to it. */
  thumbnails(wanted: ThumbReq[]): Promise<ThumbReady[]>;
  onThumbs(fn: (ready: ThumbReady[]) => void): Promise<Unlisten>;
  pdfMeta(path: string): Promise<PdfMeta>;
  /** One page, rasterised at `maxPx` on its longest side. Returns a cache path. */
  pdfPage(path: string, page: number, maxPx: number): Promise<string>;

  /** Turns a path the backend just handed us — a thumbnail, a rendered PDF page
   * — into something an `<img>` can load. Synchronous because the backend has
   * already done the work; this only re-labels the result. */
  fileSrc(path: string): string;

  /** A URL for streaming a real file the user chose, for `<audio>` and
   * `<video>`. Separate from `fileSrc` because it is the one case where nothing
   * has been materialised yet: on the web this has to read the file before it
   * can hand back a URL, so it cannot be synchronous. */
  mediaUrl(path: string): Promise<string>;

  // -------------------------------------------------------------- system

  /** The OS accent colour as sRGB bytes, or null where there isn't one to read. */
  systemAccent(): Promise<[number, number, number] | null>;
  revealInFinder(path: string): Promise<void>;
  openTerminalHere(path: string): Promise<void>;
  /** Hand a path or URL to whatever handles it outside Fiddler. */
  openExternal(target: string): Promise<void>;
  /** Is there anything out there registered to open this file?
   *
   * Asked before handing off, not after: opening is detached, so a refusal
   * never comes back — it becomes a system dialog. And when the answer is no,
   * the right response isn't an error, it's Fiddler's own editor. */
  hasOpenHandler(path: string): Promise<boolean>;
  /** Launch Android's package installer for a selected APK. */
  installApk(path: string): Promise<void>;

  /** Files another app has asked Fiddler to open, and clear the list.
   *
   * Drains rather than peeks, so it is safe to ask from more than one place —
   * at startup, and again on every `onIncomingFile`. Empty everywhere the OS
   * has no way to hand a running app a file. */
  takeIncomingFiles(): Promise<string[]>;

  /** One of those has arrived while Fiddler was already open. Carries no
   * payload: `takeIncomingFiles` is the list, and a signal that can't disagree
   * with it is a signal that can't be stale. */
  onIncomingFile(fn: () => void): Promise<Unlisten>;

  /** Claim the system Back gesture, or hand it back.
   *
   * Only Android has one to lend, and there it otherwise closes the app — so
   * walking three folders in and swiping back quits rather than going up.
   * Elsewhere this is accepted and ignored, because the front end's answer
   * ("I have history") is true everywhere and only one platform can spend it. */
  setBackEnabled(enabled: boolean): Promise<void>;

  /** The user pressed Back and we had asked for it. Payload-free for the same
   * reason `onIncomingFile` is: what to do with the press is decided from
   * front-end state, and a payload would only be a staler copy of it. */
  onBack(fn: () => void): Promise<Unlisten>;

  // --------------------------------------------------- browser-only additions
  //
  // Optional on purpose: their presence *is* the capability. The Tauri backend
  // simply doesn't have them, so `ipc.openFolder` is `undefined` there and the
  // UI that offers them never renders.

  /** Mount a folder the user picks, and return the path to navigate to. Null
   * when they cancelled. */
  openFolder?(): Promise<string | null>;

  /** Take in files and folders dropped onto the window, returning a path to
   * navigate to, or null if the drop held nothing usable. Must claim the
   * transfer's items synchronously — they don't survive the event. */
  importDropped?(transfer: DataTransfer): Promise<string | null>;
}
