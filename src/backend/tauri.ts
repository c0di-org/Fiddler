/** The desktop and Android backend: every call is a Rust command over Tauri IPC.
 *
 * This is the file that used to be `src/ipc.ts` verbatim; the bodies have not
 * changed, only their home. The web build never imports it, which is what keeps
 * `@tauri-apps/*` out of that bundle entirely. */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";

import type {
  ContentSearch,
  DirListing,
  EntryBatch,
  Inspect,
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
  UsbDevice,
} from "../types";
import type { Backend } from "./types";

const backend: Backend = {
  listDir: (path, showHidden) => invoke<DirListing>("list_dir", { path, showHidden }),

  nearbyEntries: (path, showHidden, maxDepth = 2) =>
    invoke<NearbySearch>("nearby_entries", { path, showHidden, maxDepth }),

  searchContents: (path, names, terms) =>
    invoke<ContentSearch>("search_contents", { path, names, terms }),

  inspect: (path) => invoke<Inspect>("inspect", { path }),

  folderPeek: (path, showHidden, limit) =>
    invoke<PeekItem[]>("folder_peek", { path, showHidden, limit }),

  readText: (path, maxBytes) => invoke<TextHead>("read_text", { path, maxBytes }),

  repoInfo: (path) => invoke<RepoInfo | null>("repo_info", { path }),

  refreshRepo: (root) => invoke<void>("refresh_repo", { root }),

  onRepoStatus: (fn) =>
    listen<RepoStatusPayload>("fiddler:repo-status", (e) => fn(e.payload)),

  sidebarPlaces: () => invoke<Place[]>("sidebar_places"),

  nearbyDevices: () => invoke<PeerDevice[]>("nearby_devices"),

  nearbyPairingInfo: () => invoke<PairingInfo>("nearby_pairing_info"),

  pairNearbyDevice: (id) => invoke<PairOutcome>("pair_nearby_device", { id }),

  nearbyRequests: () => invoke<PairRequest[]>("nearby_requests"),

  respondNearbyRequest: (id, allow) => invoke<void>("respond_nearby_request", { id, allow }),

  usbDevices: () => invoke<UsbDevice[]>("usb_devices"),

  onUsbDevices: (fn) => listen<UsbDevice[]>("fiddler:usb", (e) => fn(e.payload)),

  onUsbEntries: (fn) => listen<EntryBatch>("fiddler:usb-entries", (e) => fn(e.payload)),

  releaseUsbDevice: (serial) => invoke<string>("release_usb_device", { serial }),

  createFolder: (parent, name) => invoke<string>("create_folder", { parent, name }),

  createTextFile: (parent, name, text) =>
    invoke<string>("create_text_file", { parent, name, text }),

  writeTextFile: (path, text) => invoke<void>("write_text_file", { path, text }),

  renamePath: (path, newName) => invoke<string>("rename_path", { path, newName }),

  copyPaths: (paths, destination) => invoke<string[]>("copy_paths", { paths, destination }),

  movePaths: (paths, destination) => invoke<string[]>("move_paths", { paths, destination }),

  trashPaths: (paths) => invoke<void>("trash_paths", { paths }),

  onDirsChanged: (fn) => listen<string[]>("fiddler:dirs-changed", (e) => fn(e.payload)),

  thumbnail: (path, size) => invoke<string | null>("thumbnail", { path, size }),

  thumbnails: (wanted: ThumbReq[]) => invoke<ThumbReady[]>("thumbnails", { wanted }),

  onThumbs: (fn) => listen<ThumbReady[]>("fiddler:thumbs", (e) => fn(e.payload)),

  pdfMeta: (path) => invoke<PdfMeta>("pdf_meta", { path }),

  pdfPage: (path, page, maxPx) => invoke<string>("pdf_page", { path, page, maxPx }),

  fileSrc: (path) => convertFileSrc(path),

  mediaUrl: async (path) => convertFileSrc(path),

  systemAccent: () => invoke<[number, number, number] | null>("system_accent"),

  revealInFinder: (path) => invoke<void>("reveal_in_finder", { path }),

  openTerminalHere: (path) => invoke<void>("open_terminal_here", { path }),

  openExternal: (target) => openPath(target),

  installApk: (path) => invoke<void>("install_apk", { path }),
};

export default backend;
