/** Mirrors `src-tauri/src/model.rs`. Keep the two in step. */

export type Kind = "dir" | "file" | "symlink";

/** Porcelain-v2 two-character status. `.` means "nothing on this side". */
export interface Code {
  index: string;
  worktree: string;
}

export interface Rollup {
  staged: number;
  modified: number;
  untracked: number;
  deleted: number;
  conflicted: number;
}

export interface Entry {
  name: string;
  path: string;
  kind: Kind;
  linkToDir: boolean;
  size: number;
  mtime: number;
  /** Unix seconds when the item was created, or its modified time as a fallback. */
  added: number;
  hidden: boolean;
  /** A preview can be produced for this file. */
  thumbable: boolean;
  isRepo: boolean;
  worktreeCount: number;
  branch: string | null;
  code: Code | null;
  rollup: Rollup | null;
  /** Client-only: a lightweight result from the bounded nearby fallback. */
  nearby?: boolean;
  /** Client-only relative location shown for a nearby result. */
  searchLocation?: string;
}

export interface WorktreeInfo {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  /** Lives outside the repo's own directory tree — the invisible ones. */
  external: boolean;
  isMain: boolean;
}

export interface DirListing {
  path: string;
  entries: Entry[];
  repoRoot: string | null;
  worktrees: WorktreeInfo[];
  statusPending: boolean;
  /** Set client-side when the directory could not be read at all. */
  error?: string;
}

/** Lightweight result from the bounded nearby-folder fallback. */
export interface NearbyEntry {
  name: string;
  path: string;
  kind: Kind;
  linkToDir: boolean;
  hidden: boolean;
  relativePath: string;
}

export interface NearbySearch {
  entries: NearbyEntry[];
  /** The backend reached its directory or entry budget. */
  truncated: boolean;
}

export interface ContentHit {
  name: string;
  line: number;
  snippet: string;
}

export interface ContentSearch {
  hits: ContentHit[];
  /** The backend reached a file, byte, or result budget. */
  truncated: boolean;
}

export interface RepoStatusPayload {
  root: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  rollup: Rollup;
}

export interface RepoInfo {
  root: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  rollup: Rollup;
  worktrees: WorktreeInfo[];
}

export interface Place {
  name: string;
  path: string;
  icon: string;
}

/** A Fiddler device visible on the local network. It is never browsable until paired. */
export interface PeerDevice {
  id: string;
  name: string;
  host: string;
  port: number;
  paired: boolean;
  platform: "android" | "macos" | "desktop" | "";
}

/** A storage on a USB device: internal memory, or an SD card. */
export interface UsbStorage {
  id: number;
  description: string;
  freeSpace: number;
  totalCapacity: number;
  removable: boolean;
}

/**
 * How far a USB device has got between being plugged in and being browsable.
 *
 * `awaitingGrant` is the one that matters: the phone is open and has told us its
 * model, but is exposing no storages because it's locked or still set to
 * charge-only. Other MTP apps report that as "device not detected", which is
 * both wrong and impossible to act on.
 */
export type UsbStage =
  | { stage: "connecting" }
  | { stage: "blocked"; owner: string | null; ownerPid: number | null }
  | { stage: "awaitingGrant" }
  | { stage: "ready" }
  | { stage: "failed"; message: string };

/** A device attached by cable. Unlike a PeerDevice there is nothing to pair. */
export type UsbDevice = UsbStage & {
  serial: string;
  name: string;
  vendorId: number;
  productId: number;
  storages: UsbStorage[];
  /** Negotiated link, named as cable packaging does: "USB 2.0", "USB 3.2 Gen 1". */
  link: string | null;
  linkMbps: number | null;
  /**
   * The link came up at USB 2.0 or slower. Not a claim about the cable: USB only
   * tells us the speed both ends agreed on, never which end was the limit.
   */
  throttled: boolean;
};

/** A chunk of a device folder, delivered while the rest is still being read. */
export interface EntryBatch {
  /** The folder these belong to; a batch for a folder you have left is dropped. */
  path: string;
  entries: Entry[];
  /** No more are coming — the folder ended, or the read was cancelled. */
  done: boolean;
}

export interface PairingInfo {
  id: string;
  name: string;
  root: string;
}

/** A device asking to browse this one. It can read nothing while it waits. */
export interface PairRequest {
  id: string;
  name: string;
  platform: PeerDevice["platform"];
}

/** The answer to asking a device to pair. The reply is a tap over there, so
 * `waiting` is the ordinary first result rather than a failure. */
export type PairOutcome = "paired" | "waiting" | "declined";

/** A user-pinned folder. Unlike Places, favorites are personal and reorderable. */
export interface Favorite {
  name: string;
  path: string;
}

export const emptyRollup: Rollup = {
  staged: 0,
  modified: 0,
  untracked: 0,
  deleted: 0,
  conflicted: 0,
};

export function rollupTotal(r: Rollup): number {
  return r.staged + r.modified + r.untracked + r.deleted + r.conflicted;
}

/** One tile's worth of want, in the order the backend should render it. */
export interface ThumbReq {
  path: string;
  size: number;
}

/** A finished tile. `src` is null when the file has no preview to give. */
export interface ThumbReady extends ThumbReq {
  src: string | null;
}

/** One child shown on the face of a folder's icon. */
export interface PeekItem {
  name: string;
  path: string;
  isDir: boolean;
  /** A preview can be produced for this file. */
  thumbable: boolean;
}

export interface Inspect {
  /** Leading text of a small, textual file. */
  text: string | null;
  /** Direct child count, for folders. */
  childCount: number | null;
  binary: boolean;
}

/** The front of a text file, however much of it we asked for. */
export interface TextHead {
  text: string;
  /** The file continues past what was read. */
  truncated: boolean;
  /** Size of the whole file on disk. */
  bytes: number;
  /** Lines in the part that was read. */
  lines: number;
  binary: boolean;
}

export interface PdfMeta {
  pages: number;
  /** First page's width over height, for holding the shape before it renders. */
  aspect: number;
}
