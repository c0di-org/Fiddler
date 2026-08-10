import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DirListing,
  Inspect,
  NearbySearch,
  PdfMeta,
  Place,
  RepoInfo,
  RepoStatusPayload,
  TextHead,
  ThumbReady,
  ThumbReq,
} from "./types";

export const listDir = (path: string, showHidden: boolean) =>
  invoke<DirListing>("list_dir", { path, showHidden });

/** A hard-capped, no-symlink fallback used only after local search finds nothing. */
export const nearbyEntries = (path: string, showHidden: boolean, maxDepth = 2) =>
  invoke<NearbySearch>("nearby_entries", { path, showHidden, maxDepth });

export const repoInfo = (path: string) => invoke<RepoInfo | null>("repo_info", { path });

export const refreshRepo = (root: string) => invoke<void>("refresh_repo", { root });

export const sidebarPlaces = () => invoke<Place[]>("sidebar_places");

/** The OS accent colour as sRGB bytes, or null where there isn't one to read. */
export const systemAccent = () => invoke<[number, number, number] | null>("system_accent");

export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });

export const openTerminalHere = (path: string) => invoke<void>("open_terminal_here", { path });

export const createFolder = (parent: string, name: string) =>
  invoke<string>("create_folder", { parent, name });

/** Creates a UTF-8 text file. The name is deliberately passed through whole so
 * callers can choose any normal extension: `.txt`, `.md`, `.json`, and so on. */
export const createTextFile = (parent: string, name: string, text: string) =>
  invoke<string>("create_text_file", { parent, name, text });

/** Writes a text file atomically, so a save never leaves a half-written file. */
export const writeTextFile = (path: string, text: string) =>
  invoke<void>("write_text_file", { path, text });

export const renamePath = (path: string, newName: string) =>
  invoke<string>("rename_path", { path, newName });

export const trashPaths = (paths: string[]) => invoke<void>("trash_paths", { paths });

export const onRepoStatus = (fn: (p: RepoStatusPayload) => void) =>
  listen<RepoStatusPayload>("fiddler:repo-status", (e) => fn(e.payload));

export const onDirsChanged = (fn: (dirs: string[]) => void) =>
  listen<string[]>("fiddler:dirs-changed", (e) => fn(e.payload));

export const thumbnail = (path: string, size: number) =>
  invoke<string | null>("thumbnail", { path, size });

/** Declare everything worth rendering right now; returns whatever was cached. */
export const thumbnails = (wanted: ThumbReq[]) =>
  invoke<ThumbReady[]>("thumbnails", { wanted });

export const onThumbs = (fn: (ready: ThumbReady[]) => void) =>
  listen<ThumbReady[]>("fiddler:thumbs", (e) => fn(e.payload));

export const inspect = (path: string) => invoke<Inspect>("inspect", { path });

/** The front of a text file, bounded by `maxBytes` and cut on a character. */
export const readText = (path: string, maxBytes: number) =>
  invoke<TextHead>("read_text", { path, maxBytes });

export const pdfMeta = (path: string) => invoke<PdfMeta>("pdf_meta", { path });

/** One page, rasterised at `maxPx` on its longest side. Returns a cache path. */
export const pdfPage = (path: string, page: number, maxPx: number) =>
  invoke<string>("pdf_page", { path, page, maxPx });
