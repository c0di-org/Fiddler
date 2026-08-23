/**
 * Where you were in each document, remembered between visits.
 *
 * A reader that always opens at page one is a reader you stop using for
 * anything longer than a receipt. This is the smallest thing that fixes it: a
 * recency-ordered list of `path → page`, in `localStorage` beside the session,
 * capped so a lifetime of PDFs can't grow without bound.
 *
 * The list is ordered most-recent-first and read back defensively — the stored
 * value comes from a previous version of Fiddler as often as from this one, and
 * a page number that no longer exists must not be able to open a document on
 * nothing.
 */

const STORAGE_KEY = "fiddler.reading";

/** Documents remembered. Past this the oldest is forgotten, not the biggest:
 * what you were reading last week is the thing you're least likely to reopen. */
export const READING_CAP = 80;

export interface Mark {
  path: string;
  /** 1-based, and clamped against the document's real length on open. */
  page: number;
}

/** A stored list, with anything unrecognised dropped rather than trusted. */
export function parseMarks(raw: unknown): Mark[] {
  if (!Array.isArray(raw)) return [];
  const marks: Mark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { path, page } = item as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0) continue;
    if (typeof page !== "number" || !Number.isFinite(page) || page < 1) continue;
    if (marks.some((m) => m.path === path)) continue;
    marks.push({ path, page: Math.floor(page) });
    if (marks.length >= READING_CAP) break;
  }
  return marks;
}

/** The list with `path` moved to the front at `page`. Page one is not a
 * position worth keeping: it's where the document opens anyway, and storing it
 * would push something you actually left off in out of the list. */
export function remember(marks: Mark[], path: string, page: number, cap = READING_CAP): Mark[] {
  const rest = marks.filter((m) => m.path !== path);
  if (page <= 1) return rest;
  return [{ path, page: Math.floor(page) }, ...rest].slice(0, cap);
}

/** Where to open this document, clamped to a document of `pages` pages. */
export function pageFor(marks: Mark[], path: string, pages: number): number {
  const mark = marks.find((m) => m.path === path);
  if (!mark) return 1;
  return Math.min(Math.max(1, mark.page), Math.max(1, pages));
}

export function loadMarks(): Mark[] {
  try {
    return parseMarks(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return [];
  }
}

export function saveMarks(marks: Mark[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch {
    // Reading must still work when storage is disabled or full.
  }
}

/** Read, update, write — the whole of what the reader needs. */
export function rememberPage(path: string, page: number) {
  saveMarks(remember(loadMarks(), path, page));
}
