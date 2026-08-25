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

  nearbyAccess: () => invoke<NearbyAccess>("nearby_access"),

  withdrawNearbyDevice: (id) => invoke<void>("withdraw_nearby_device", { id }),

  forgetNearbyDevice: (id) => invoke<void>("forget_nearby_device", { id }),

  usbDevices: () => invoke<UsbDevice[]>("usb_devices"),

  onUsbDevices: (fn) => listen<UsbDevice[]>("fiddler:usb", (e) => fn(e.payload)),

  onUsbEntries: (fn) => listen<EntryBatch>("fiddler:usb-entries", (e) => fn(e.payload)),

  releaseUsbDevice: (serial) => invoke<string>("release_usb_device", { serial }),

  volumes: () => invoke<Volume[]>("volumes"),

  onVolumes: (fn) => listen<Volume[]>("fiddler:volumes", (e) => fn(e.payload)),

  ejectVolume: (id, force) => invoke<EjectOutcome>("eject_volume", { id, force }),

  createFolder: (parent, name) => invoke<string>("create_folder", { parent, name }),

  createTextFile: (parent, name, text) =>
    invoke<string>("create_text_file", { parent, name, text }),

  writeTextFile: (path, text) => invoke<void>("write_text_file", { path, text }),

  // The bytes go as the request body rather than inside the JSON payload: a
  // photograph is megabytes, and base64 through the bridge would inflate it by
  // a third and copy it three times on the platform least able to afford that.
  // Headers are ASCII, so every name travels percent-encoded; `text_header` in
  // `commands.rs` is the other half.
  createFile: (parent, name, bytes) =>
    invoke<string>("create_file", bytes, {
      headers: { "x-parent": encodeURIComponent(parent), "x-name": encodeURIComponent(name) },
    }),

  writeFile: (path, bytes) =>
    invoke<void>("write_file", bytes, {
      headers: { "x-path": encodeURIComponent(path) },
    }),

  freeName: (parent, name) => invoke<string>("free_name", { parent, name }),

  renamePath: (path, newName) => invoke<string>("rename_path", { path, newName }),

  copyPaths: (paths, destination, job) =>
    invoke<TransferOutcome>("copy_paths", { paths, destination, job }),

  movePaths: (paths, destination, job) =>
    invoke<TransferOutcome>("move_paths", { paths, destination, job }),

  cancelTransfer: (job) => invoke<void>("cancel_transfer", { job }),

  onTransfer: (fn) => listen<TransferProgress>("fiddler:transfer", (e) => fn(e.payload)),

  trashPaths: (paths) => invoke<Trashed[]>("trash_paths", { paths }),

  restoreTrashed: (items) => invoke<string[]>("restore_trashed", { items }),

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

  hasOpenHandler: (path) => invoke<boolean>("has_open_handler", { path }),

  installApk: (path) => invoke<void>("install_apk", { path }),

  takeIncomingFiles: () => invoke<string[]>("take_opened_files"),

  onIncomingFile: (fn) => listen("fiddler:opened-file", () => fn()),

  sharePaths: (paths) => invoke<void>("share_paths", { paths }),

  setBackEnabled: (enabled) => invoke<void>("set_back_enabled", { enabled }),

  onBack: (fn) => listen("fiddler:back", () => fn()),
};

export default backend;
