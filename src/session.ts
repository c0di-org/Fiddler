/** What Fiddler remembers between launches, other than favourites and the tint.
 *
 * Six view preferences and the folder you were last in. Favourites and the
 * accent already persisted, and so did the list view's column widths and order
 * — this is the rest of the same idea, and it lives in `localStorage` next to
 * them rather than in a file, so the browser build gets it for nothing.
 *
 * Everything read back is validated rather than trusted. The stored value comes
 * from a previous version of Fiddler as often as from this one, and a sort key
 * that no longer exists must not be able to leave the list unsortable.
 */

import type { SortKey, ViewMode } from "./store/tree.ts";

const STORAGE_KEY = "fiddler.session";

/** Matches the zoom slider in the status bar. A saved size outside it would
 * leave the slider pinned to an end that doesn't match what's drawn. */
export const MIN_ICON = 56;
export const MAX_ICON = 224;

export interface Session {
  view: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  iconSize: number;
  showHidden: boolean;
  previewOpen: boolean;
  /** The folder to reopen, or "" for the build's usual starting place. */
  path: string;
}

export const defaultSession: Session = {
  view: "icons",
  sortKey: "name",
  sortAsc: true,
  iconSize: 112,
  showHidden: false,
  previewOpen: false,
  path: "",
};

const VIEWS: ViewMode[] = ["icons", "list"];
const SORT_KEYS: SortKey[] = ["name", "kind", "size", "modified", "added"];

/**
 * A stored session, with anything unrecognised replaced by its default.
 *
 * A device path is never restored. `mtp://` and `fiddler://` addresses only
 * exist while the cable is plugged in or the other machine is awake and still
 * willing, so reopening one would mean starting inside a folder that cannot be
 * read and having to explain why — for a folder nobody asked to go back to.
 */
export function parseSession(raw: unknown): Session {
  if (!raw || typeof raw !== "object") return defaultSession;
  const saved = raw as Record<string, unknown>;
  const path = typeof saved.path === "string" ? saved.path : "";
  return {
    view: pick(saved.view, VIEWS, defaultSession.view),
    sortKey: pick(saved.sortKey, SORT_KEYS, defaultSession.sortKey),
    sortAsc: typeof saved.sortAsc === "boolean" ? saved.sortAsc : defaultSession.sortAsc,
    iconSize:
      typeof saved.iconSize === "number" && Number.isFinite(saved.iconSize)
        ? Math.min(MAX_ICON, Math.max(MIN_ICON, Math.round(saved.iconSize)))
        : defaultSession.iconSize,
    showHidden: typeof saved.showHidden === "boolean" ? saved.showHidden : defaultSession.showHidden,
    previewOpen:
      typeof saved.previewOpen === "boolean" ? saved.previewOpen : defaultSession.previewOpen,
    path: restorable(path) ? path : "",
  };
}

/** Is this a folder worth reopening on the next launch? */
export function restorable(path: string): boolean {
  return path.length > 0 && !path.startsWith("mtp://") && !path.startsWith("fiddler://");
}

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

export function loadSession(): Session {
  try {
    return parseSession(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return defaultSession;
  }
}

export function saveSession(session: Session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Browsing must still work when storage is disabled or full.
  }
}
