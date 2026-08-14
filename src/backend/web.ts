/** The browser backend.
 *
 * Same interface as `tauri.ts`, no Rust behind it. The things it genuinely
 * can't do — git, Finder, Terminal, nearby devices — answer honestly rather
 * than pretending: empty lists and rejected promises, which the UI already
 * treats as "this feature isn't here" and hides accordingly (see
 * `platform.ts`). */

import { natural } from "../sort";
import type { Entry, NearbyAccess, PairOutcome, PdfMeta, PeerDevice, RepoInfo, TransferProgress, UsbDevice, Volume } from "../types";
import * as fake from "./web/demo-device";
import { canThumb } from "./web/render";
import { nearbyEntries, searchContents } from "./web/search-fs";
import { importDropped, initMounts, openFolder, places } from "./web/session";
import { inspect, readText } from "./web/text";
import * as queue from "./web/thumb-queue";
import * as vfs from "./web/vfs";
import type { Backend } from "./types";

initMounts();

// -------------------------------------------------------------- listing

function toEntry(node: vfs.Node, parent: string): Entry {
  return {
    name: node.name,
    path: vfs.childPath(parent, node.name),
    kind: node.kind,
    linkToDir: false,
    size: node.size,
    mtime: node.mtime,
    added: node.added,
    hidden: node.name.startsWith("."),
    thumbable: node.kind === "file" && canThumb(node.name),
    // Git is deliberately absent here rather than faked. A file browser that
    // shows invented status dots is one you can't trust the rest of.
    isRepo: false,
    worktreeCount: 0,
    branch: null,
    code: null,
    rollup: null,
  };
}

// ------------------------------------------------------------- transfers

/** The Rust build carries these in `AppState` and speaks to the renderer over
 * Tauri events; in a tab both ends are here, so they are two plain collections
 * rather than anything cleverer. */
const transferJobs = new Map<number, { value: boolean }>();
const transferWatchers = new Set<(progress: TransferProgress) => void>();

// ---------------------------------------------------------------- media

/** Object URLs for files being streamed by `<audio>`/`<video>`. Held rather
 * than revoked per use: seeking re-reads the URL, so revoking on unmount would
 * break scrubbing, and the count here is bounded by how many media files one
 * person opens in a session. */
const mediaUrls = new Map<string, string>();
const MEDIA_CAP = 12;

async function mediaUrl(path: string): Promise<string> {
  const hit = mediaUrls.get(path);
  if (hit) return hit;

  const url = URL.createObjectURL(await vfs.readBlob(path));
  mediaUrls.set(path, url);
  while (mediaUrls.size > MEDIA_CAP) {
    const oldest = mediaUrls.keys().next();
    if (oldest.done) break;
    URL.revokeObjectURL(mediaUrls.get(oldest.value)!);
    mediaUrls.delete(oldest.value);
  }
  return url;
}

/** Everything cached about a file's contents, dropped together. Called after
 * any write so a saved file stops previewing as the file it used to be. */
function invalidate(path: string) {
  queue.forget(path);
  const media = mediaUrls.get(path);
  if (media) {
    URL.revokeObjectURL(media);
    mediaUrls.delete(path);
  }
  void import("./web/pdf").then((pdf) => pdf.forget(path)).catch(() => {});
}

const unavailable = (what: string) => () => Promise.reject(new Error(`${what} isn’t available in the browser`));

// ------------------------------------------------------- simulated devices
//
// The one place this backend performs rather than reports. Everything above is
// a real answer about a real (if in-memory) filesystem; the two devices below
// do not exist, and say so on every row they draw — see the reasoning at the
// top of `demo-device.ts`, and `Devices.md` in the demo tree, which is written
// for the person looking at it rather than for whoever is reading this.
//
// The state machines are here rather than in `demo-device.ts` because they are
// the part that has to match the Rust backend's shape: a stage that advances on
// its own and pushes to subscribers, and a pairing call whose ordinary first
// answer is "still waiting".

/** How long the cable spends connecting. Long enough to see the stage line
 * under the device name, short enough that nobody waits for a demo. */
const CONNECT_MS = 1_400;
/** How long the other device takes to "tap Allow". Two polls of `App.tsx`'s
 * pairing loop, so the waiting state is genuinely rendered. */
const ALLOW_MS = 1_800;

let phone: UsbDevice = fake.phoneAt("connecting");
const usbWatchers = new Set<(devices: UsbDevice[]) => void>();
let plugTimer: number | null = null;

/** Starts the connection the first time anything asks about devices, which is
 * on mount — so the stage advances while someone is reading the first folder,
 * exactly as a real cable does. */
function beginConnecting() {
  if (plugTimer !== null || phone.stage === "ready") return;
  plugTimer = setTimeout(() => {
    phone = fake.phoneAt("ready");
    usbWatchers.forEach((fn) => fn([phone]));
  }, CONNECT_MS) as unknown as number;
}

let peerPaired = false;
let pairingSince = 0;
/** Unix seconds when the peer was allowed, for the access sheet's "since". */
let pairedAt = 0;

const backend: Backend = {
  // ------------------------------------------------------------ browsing

  async listDir(path, showHidden) {
    // A device root lists its storages rather than a folder's contents, and
    // those entries can't be derived from the tree — see `storageListing`.
    const storages = fake.storageListing(path, phone);
    if (storages) return { path, entries: storages, repoRoot: null, worktrees: [], statusPending: false };

    const nodes = await vfs.listDir(path);
    const entries = nodes
      .filter((node) => showHidden || !node.name.startsWith("."))
      .map((node) => toEntry(node, path));
    return { path, entries, repoRoot: null, worktrees: [], statusPending: false };
  },

  nearbyEntries: (path, showHidden, maxDepth = 2) => nearbyEntries(path, showHidden, maxDepth),

  searchContents: (path, names, terms) => searchContents(path, names, terms),

  inspect: (path) => inspect(path),

  /** The first few things in a folder, for the fan of cards on its icon.
   * Ordered the way `folder_peek` in `commands.rs` orders them — folders first,
   * then natural by name — so an icon looks the same on both backends. */
  async folderPeek(path, showHidden, limit) {
    const capped = Math.min(Math.max(limit, 1), 4);
    const nodes = await vfs.listDir(path);
    return nodes
      .filter(
        (node) =>
          node.name !== ".DS_Store" && (showHidden || !node.name.startsWith("."))
      )
      .sort((a, b) => {
        const aDir = a.kind === "dir";
        const bDir = b.kind === "dir";
        return aDir === bDir ? natural(a.name, b.name) : aDir ? -1 : 1;
      })
      .slice(0, capped)
      .map((node) => ({
        name: node.name,
        path: vfs.childPath(path, node.name),
        isDir: node.kind === "dir",
        thumbable: node.kind === "file" && canThumb(node.name),
      }));
  },

  readText: (path, maxBytes) => readText(path, maxBytes),

  // ----------------------------------------------------------------- git

  repoInfo: async (): Promise<RepoInfo | null> => null,

  refreshRepo: async () => {},

  // Never fires. The UI's response to that is simply no branch chips and no
  // status dots, which is exactly right here.
  onRepoStatus: async () => () => {},

  // -------------------------------------------------------------- places

  sidebarPlaces: async () => places(),

  nearbyDevices: async (): Promise<PeerDevice[]> => [fake.peer(peerPaired)],

  nearbyPairingInfo: async () => ({ id: "web-tab", name: fake.SELF_NAME, root: "/" }),

  /** The half of pairing that happens over here. `waiting` is the honest first
   * answer on a real network too — the other half is a tap on that device — so
   * this waits rather than resolving at once and skipping the state the sidebar
   * exists to show. */
  async pairNearbyDevice(): Promise<PairOutcome> {
    if (peerPaired) return "paired";
    if (pairingSince === 0) pairingSince = Date.now();
    if (Date.now() - pairingSince < ALLOW_MS) return "waiting";
    peerPaired = true;
    pairedAt = Math.floor(Date.now() / 1000);
    pairingSince = 0;
    return "paired";
  },

  // Nothing out there to ask, so nothing ever arrives asking.
  nearbyRequests: async () => [],

  respondNearbyRequest: unavailable("Pairing"),

  /** Only the outbound direction is ever populated: this tab holds a key to the
   * other device once you pair, and nothing has been allowed *in* here because
   * there is nothing out there to allow in. */
  nearbyAccess: async (): Promise<NearbyAccess> => ({
    allowed: [],
    trusted: peerPaired
      ? [{ id: fake.PEER_ID, name: fake.PEER_NAME, platform: "macos", since: pairedAt, online: true }]
      : [],
    selfName: fake.SELF_NAME,
  }),

  // Withdrawing needs an inbound grant, and there are none to withdraw.
  withdrawNearbyDevice: unavailable("Withdrawing access"),

  /** Dropping this tab's own key. Real in the way that matters: the padlock
   * comes back, and the next open has to ask again. */
  forgetNearbyDevice: async () => {
    peerPaired = false;
    pairedAt = 0;
  },

  /** A browser tab is not a USB host. This one device is a demonstration and
   * every row that draws it says so — see the note above and `Devices.md`. */
  async usbDevices() {
    beginConnecting();
    return [phone];
  },

  async onUsbDevices(fn) {
    beginConnecting();
    usbWatchers.add(fn);
    return () => usbWatchers.delete(fn);
  },

  // A listing here is a map lookup rather than a round trip per object, so a
  // folder is whole by the time `listDir` resolves and there is never a
  // remainder to stream. The cost this stands in for is described in
  // `Devices.md`, which is the honest way to convey it.
  onUsbEntries: async () => () => {},

  // Never reached: the demo phone is never `blocked`, so the button that calls
  // this is never drawn.
  releaseUsbDevice: unavailable("Releasing a device"),

  /** A browser tab has no volumes.
   *
   * Deliberately not simulated, unlike the phone above. The two devices are a
   * demonstration of a section that would otherwise be an empty rectangle, and
   * every row they draw is labelled `demo`. A drive is different in the way
   * that matters: the whole point of the volume list is that it tells you what
   * is *actually attached to this machine right now*, and a tab genuinely
   * cannot know. An invented drive there would be the one kind of lie this
   * backend refuses — a claim about the person's own hardware. The section
   * simply doesn't appear, which is exactly what happens on a Mac with nothing
   * plugged in.
   *
   * The folder picker and drag-and-drop are the browser's real answer to
   * "point this at something of mine", and both are already offered. */
  volumes: async (): Promise<Volume[]> => [],

  // Never fires, because nothing here can be mounted or unmounted. The UI's
  // response to that is no section at all, which is right.
  onVolumes: async () => () => {},

  // Unreachable: nothing is listed, so no row exists to carry the control.
  ejectVolume: unavailable("Ejecting a volume"),

  // ------------------------------------------------------------ mutation

  async createFolder(parent, name) {
    const path = vfs.childPath(parent, vfs.validName(name));
    await vfs.mkdir(path);
    return path;
  },

  async createTextFile(parent, name, text) {
    const path = vfs.childPath(parent, vfs.validName(name));
    if (await vfs.stat(path)) throw new Error(`“${name}” already exists`);
    await vfs.writeBlob(path, new Blob([text], { type: "text/plain" }));
    return path;
  },

  async writeTextFile(path, text) {
    await vfs.writeBlob(path, new Blob([text], { type: "text/plain" }));
    invalidate(path);
  },

  async renamePath(path, newName) {
    const moved = await vfs.rename(path, newName);
    invalidate(path);
    return moved;
  },

  async copyPaths(paths, destination, job) {
    const cancelled = { value: false };
    transferJobs.set(job, cancelled);
    try {
      // Announced before the survey as well as during, because the survey is
      // itself a wait on a big enough tree.
      //
      // `byBytes` is false because every mount here is blobs in one tab: there
      // is no volume to cross, so the count of files is what the wait is made
      // of — the same answer the Rust side reaches for a clone.
      let progress: TransferProgress = {
        job,
        verb: "Copying",
        doneItems: 0,
        totalItems: 0,
        doneBytes: 0,
        totalBytes: 0,
        name: "",
        byBytes: false,
      };
      transferWatchers.forEach((fn) => fn(progress));
      const totals = await vfs.surveyCopy(paths);
      progress = { ...progress, totalItems: totals.items, totalBytes: totals.bytes };
      transferWatchers.forEach((fn) => fn(progress));

      return await vfs.copyInto(paths, destination, {
        cancelled: () => cancelled.value,
        report: (step) => {
          progress = { ...progress, ...step };
          transferWatchers.forEach((fn) => fn(progress));
        },
      });
    } finally {
      transferJobs.delete(job);
    }
  },

  async cancelTransfer(job) {
    const flag = transferJobs.get(job);
    if (flag) flag.value = true;
  },

  async onTransfer(fn) {
    transferWatchers.add(fn);
    return () => transferWatchers.delete(fn);
  },

  // No progress and no cancel, for the same reason the Rust build stays quiet
  // about a move within one volume: there is no second place for the bytes to
  // travel to, so it is over before there is anything to report.
  async movePaths(paths, destination) {
    const moved = await vfs.moveInto(paths, destination);
    // The originals are gone, so anything cached against those paths is now
    // about a file that isn't there — the same reason trashing forgets them.
    for (const path of paths) invalidate(path);
    return { paths: moved, cancelled: false };
  },

  // A tab has nowhere to put a deleted file, so this really is a delete and
  // reports nothing to put back. The empty answer is what stops the UI from
  // offering an undo it could not honour.
  async trashPaths(paths) {
    for (const path of paths) {
      await vfs.remove(path);
      invalidate(path);
    }
    return [];
  },

  restoreTrashed: unavailable("Undoing a delete"),

  onDirsChanged: async (fn) => vfs.onDirsChanged(fn),

  // ---------------------------------------------------------- previewing

  thumbnail: (path, size) => queue.thumbnail(path, size),

  thumbnails: (wanted) => queue.thumbnails(wanted),

  onThumbs: async (fn) => queue.onThumbs(fn),

  async pdfMeta(path): Promise<PdfMeta> {
    const pdf = await import("./web/pdf");
    return pdf.meta(path);
  },

  async pdfPage(path, page, maxPx) {
    const pdf = await import("./web/pdf");
    const blob = await pdf.renderPage(path, page, maxPx);
    if (!blob) throw new Error("That page couldn’t be rendered");
    return URL.createObjectURL(blob);
  },

  // Thumbnails and rendered pages already come back as object URLs, so there is
  // nothing left to convert.
  fileSrc: (path) => path,

  mediaUrl,

  // -------------------------------------------------------------- system

  // No web API exposes the OS accent. `tint.ts` reads null as "stay with the
  // fallback" and hides the System option, which is the behaviour we want.
  systemAccent: async () => null,

  revealInFinder: unavailable("Reveal in Finder"),

  openTerminalHere: unavailable("Open in Terminal"),

  /** A tab has no desktop behind it: "opening" a file here means downloading
   * it, which is never what ↵ should do to something readable. `caps.handOff`
   * is false for the same reason, so nothing asks — but the answer stands. */
  hasOpenHandler: async () => false,

  /** Links open in a tab. A file has nowhere to be "opened" to in a browser, so
   * the honest equivalent is handing the user the bytes. */
  async openExternal(target) {
    if (/^(https?|mailto):/i.test(target)) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    const blob = await vfs.readBlob(target);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = vfs.basename(target);
    link.click();
    // Revoking immediately can cancel the download in some browsers; a tick is
    // enough for it to have been claimed.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },

  installApk: unavailable("Installing apps"),

  /** A tab is not something the OS can hand a file to. Files arrive here by
   * being dragged onto the window instead — see `importDropped`. */
  async takeIncomingFiles() {
    return [];
  },

  async onIncomingFile() {
    return () => {};
  },

  // ------------------------------------------------- browser-only additions

  openFolder,

  importDropped,
};

export default backend;
