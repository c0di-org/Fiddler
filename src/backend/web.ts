/** The browser backend.
 *
 * Same interface as `tauri.ts`, no Rust behind it. The things it genuinely
 * can't do — git, Finder, Terminal, nearby devices — answer honestly rather
 * than pretending: empty lists and rejected promises, which the UI already
 * treats as "this feature isn't here" and hides accordingly (see
 * `platform.ts`). */

import { natural } from "../sort";
import type { Entry, PairingInfo, PdfMeta, RepoInfo } from "../types";
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

const backend: Backend = {
  // ------------------------------------------------------------ browsing

  async listDir(path, showHidden) {
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

  nearbyDevices: async () => [],

  nearbyPairingInfo: unavailable("Nearby devices") as () => Promise<PairingInfo>,

  pairNearbyDevice: unavailable("Pairing"),

  nearbyRequests: async () => [],

  respondNearbyRequest: unavailable("Pairing"),

  // A browser tab is not a USB host, so there is never a device to report and
  // never a stage to change. Empty and silent rather than `unavailable`: the
  // sidebar asks for these unprompted on every start, and a rejected promise
  // there would be an error nobody caused.
  usbDevices: async () => [],
  onUsbDevices: async () => () => {},
  onUsbEntries: async () => () => {},
  releaseUsbDevice: unavailable("USB devices"),

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

  copyPaths: (paths, destination) => vfs.copyInto(paths, destination),

  async movePaths(paths, destination) {
    const moved = await vfs.moveInto(paths, destination);
    // The originals are gone, so anything cached against those paths is now
    // about a file that isn't there — the same reason trashing forgets them.
    for (const path of paths) invalidate(path);
    return moved;
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

  // ------------------------------------------------- browser-only additions

  openFolder,

  importDropped,
};

export default backend;
