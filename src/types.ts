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

/**
 * What kind of thing a mounted volume is.
 *
 * `startup` never reaches the frontend — the backend leaves the boot volume out
 * of the list entirely — but it is named here because the classification is
 * shared, and because leaving it out would make "why is Macintosh HD missing?"
 * an unanswerable question from this side.
 */
export type VolumeKind = "startup" | "internal" | "removable" | "diskImage" | "network";

/**
 * Whether a mounted volume can actually be read.
 *
 * `locked` is the one that matters, and it is the same shape of problem as a
 * phone sitting on its lock screen: the disk is plainly there, and an app that
 * simply omitted it would leave someone staring at a drive they can see in
 * Finder and not here. macOS asks separately about removable volumes; Android
 * needs All files access.
 */
export type VolumeStage =
  | { stage: "ready" }
  | { stage: "locked" }
  | { stage: "unreadable"; message: string };

/** A mounted volume: an external drive, a card, a disk image, or a share. */
export type Volume = VolumeStage & {
  /** Stable enough to key a row on and to eject by. Not an address — `path` is. */
  id: string;
  name: string;
  /** The mount point. An ordinary local path, which is the whole reason volumes
   * needed no new address space the way `mtp://` did. */
  path: string;
  kind: VolumeKind;
  /** Writes will be refused by the kernel: a `.dmg` attached read-only, a locked
   * card, a share exported read-only. */
  readOnly: boolean;
  /** Bytes still writable here, and the size of the whole volume. Both zero
   * where the filesystem doesn't say. */
  freeSpace: number;
  totalCapacity: number;
  /** Fiddler can offer to put this away. False on Android, which has removable
   * storage and no way for an app to unmount it safely. */
  ejectable: boolean;
};

/** A process holding a volume open, as the system named it. */
export interface Holder {
  /** The command. A shell sitting in a folder on the disk is `zsh`, and saying
   * so is more use than naming a terminal app and being wrong about which
   * window. */
  name: string;
  pid: number;
}

/**
 * How an eject went.
 *
 * `busy` is an outcome rather than an error because it is the ordinary one —
 * something is nearly always still holding a disk you have just finished with —
 * and because it carries the two things an error string can't: who, and the
 * fact that nothing has happened to the volume yet.
 */
export type EjectOutcome =
  | { outcome: "ejected" }
  | { outcome: "busy"; holders: Holder[] };

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

/** A device holding access, in one direction or the other. */
export interface DeviceAccess {
  id: string;
  name: string;
  /** Empty where it was never recorded, or where the device isn't around to
   * say. Only decides which glyph is drawn. */
  platform: string;
  /** Unix seconds when access was granted; zero when it predates Fiddler
   * writing that down, and always zero for the outbound direction. */
  since: number;
  /** On the network right now. A device being away is not a reason to hide it —
   * an absent device holding a key is the case this list exists for. */
  online: boolean;
}

/** Both directions of nearby access, which are two different questions: who can
 * read the files on this machine, and whose files this machine kept a key to.
 * An answer about one says nothing about the other. */
export interface NearbyAccess {
  allowed: DeviceAccess[];
  trusted: DeviceAccess[];
  selfName: string;
}

/** A user-pinned folder. Unlike Places, favorites are personal and reorderable. */
export interface Favorite {
  name: string;
  path: string;
}

/** One item that went to the Trash, and where it went.
 *
 * The pair is what makes deletion undoable at all: the Trash renames what it
 * takes when the name is already in use, so the only way to put something back
 * is to have been told where it landed at the time. A backend that can't say —
 * Android, which has no Trash, and the browser, whose delete is a real delete —
 * reports nothing, and the UI offers no undo rather than a broken one. */
export interface Trashed {
  trashed: string;
  original: string;
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

/** How far a copy — or the kind of move that is really a copy — has got. Both
 * totals are zero until the survey that measures the work has finished: a
 * hundred thousand files take a moment just to count, and the status bar says
 * so rather than sitting at nothing. */
export interface TransferProgress {
  /** The number the renderer made up for this transfer, so Cancel names the
   * right one when two are in flight. */
  job: number;
  /** The word to lead with: "Copying" or "Moving". */
  verb: string;
  doneItems: number;
  totalItems: number;
  doneBytes: number;
  totalBytes: number;
  /** What is moving at this moment — the part a person actually reads. */
  name: string;
  /** Which pair of numbers the bar should follow. Decided by the backend,
   * because only it knows whether the bytes are really travelling: a clone
   * costs time per file and none per byte, and a copy across volumes is the
   * other way round. Following the wrong one gives a bar that lurches or one
   * that stalls. */
  byBytes: boolean;
}

/** `paths` is empty when `cancelled`, because a stopped transfer takes back
 * everything it wrote. Kept apart from a thrown error: one is a failure and the
 * other is the person getting exactly what they asked for. */
export interface TransferOutcome {
  paths: string[];
  cancelled: boolean;
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
