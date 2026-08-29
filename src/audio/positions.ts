/**
 * Where you were in each recording, remembered between visits.
 *
 * `reading.ts` does this for documents, and the argument is the same one twice:
 * a reader that always opens at page one is a reader you stop using, and a
 * player that always starts at zero is useless for anything longer than a
 * ringtone. What's different is that audio has no pages. A position is a
 * fractional second on a timeline nobody can see, so being approximately right
 * is worse here than it is in a book — landing thirty seconds late in a
 * chapter means missing a paragraph and never knowing it happened.
 *
 * So this stores more than `reading.ts` does. It keeps the duration, because
 * "97% of the way through" is the only way to know a recording was *finished*
 * rather than abandoned, and a finished one must open at the start next time.
 * And it keeps a timestamp, because how long you were away is the best single
 * predictor of how much you'll need to hear again: a position resumed after
 * lunch needs a couple of seconds of run-up, and one resumed after a week
 * needs half a minute.
 *
 * Read back defensively for the same reason the session is: the stored value
 * comes from a previous version of Fiddler as often as from this one, and a
 * position past the end of a file that has since been replaced must not be
 * able to open a book on silence.
 */

const STORAGE_KEY = "fiddler.audio.marks";

/** Recordings remembered. Larger than the reading cap because a book is not
 * one file — a folder of eighty chapters is one book, and forgetting the early
 * ones would lose the only record that they were ever heard. */
export const MARK_CAP = 600;

/** Below this a recording is a sound effect, not something you're partway
 * through, and reopening it a second in is an annoyance rather than a service. */
export const WORTH_REMEMBERING = 90;

/** And below this you haven't got anywhere yet. Storing it would push a book
 * you really are in the middle of out of the list. */
export const WORTH_STORING = 20;

/** Close enough to the end to count as heard. Most recordings finish with
 * credits, a copyright notice, or the reader saying "end of chapter" — stopping
 * there is finishing, and the next visit should start at the beginning. */
export const NEARLY_DONE = 25;

export interface Mark {
  path: string;
  /** Seconds from the start. */
  at: number;
  /** Total length in seconds, or 0 when it was never learned. */
  duration: number;
  /** Epoch milliseconds when this was last written. */
  updated: number;
  /** Heard to the end. Kept rather than deleted so the folder can show it. */
  done: boolean;
}

/**
 * How far to rewind, given how long ago you stopped.
 *
 * This is the whole difference between a position and a *place*. Coming back to
 * a book after a night's sleep and being dropped mid-sentence is disorienting
 * in a way that a book with a physical bookmark never is, because a bookmark
 * sits at the top of a paragraph and your eye finds the thread on its own. Ears
 * have no equivalent, so the run-up has to be given to them.
 *
 * The tiers are deliberately coarse. A continuous function would be no more
 * accurate — nobody knows the right answer to a second — and it would make the
 * behaviour impossible to predict, which for something that happens on every
 * single resume is the property that matters most.
 */
export function rewindFor(awayMs: number): number {
  if (!Number.isFinite(awayMs) || awayMs < 0) return 0;
  const away = awayMs / 1000;
  if (away < 30) return 0; // Paused to answer someone. Carry straight on.
  if (away < 10 * 60) return 3; // Out of the room.
  if (away < 4 * 3600) return 10; // Later the same day.
  if (away < 3 * 86400) return 20; // Tomorrow, or the day after.
  return 30; // Long enough that the last thing you heard is gone.
}

/** A stored list, with anything unrecognised dropped rather than trusted. */
export function parseMarks(raw: unknown): Mark[] {
  if (!Array.isArray(raw)) return [];
  const marks: Mark[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { path, at, duration, updated, done } = item as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0) continue;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) continue;
    if (seen.has(path)) continue;
    const length =
      typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : 0;
    // A position past the end is a file that changed under us. Keep the entry
    // — it still records that the thing was played — but not the impossible
    // number, which would otherwise resume every visit at the last second.
    if (length > 0 && at > length) continue;
    seen.add(path);
    marks.push({
      path,
      at,
      duration: length,
      updated:
        typeof updated === "number" && Number.isFinite(updated) && updated > 0 ? updated : 0,
      done: done === true,
    });
    if (marks.length >= MARK_CAP) break;
  }
  return marks;
}

export function markFor(marks: Mark[], path: string): Mark | null {
  return marks.find((m) => m.path === path) ?? null;
}

/**
 * The list with this recording's position brought to the front.
 *
 * Returns the list unchanged where there is nothing worth recording, which is
 * the case that keeps the store useful: a folder skimmed by tapping through
 * twenty files would otherwise evict the book you are actually listening to.
 */
export function noteProgress(
  marks: Mark[],
  path: string,
  at: number,
  duration: number,
  now: number,
  cap = MARK_CAP
): Mark[] {
  if (!Number.isFinite(at) || at < 0) return marks;
  const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const rest = marks.filter((m) => m.path !== path);

  // Too short to be worth a bookmark at all. Forgotten rather than left behind:
  // this file was just played, so whatever stale position it carried is gone.
  // Note this comes *before* asking whether it finished — a twelve-second alert
  // tone is inside `NEARLY_DONE` of its own end from the moment it starts, and
  // calling that "finished" would put a tick on every sound effect in a folder.
  if (length > 0 && length < WORTH_REMEMBERING) return rest;

  const done = length > 0 && at >= length - NEARLY_DONE;
  if (!done && at < WORTH_STORING) return rest;

  const mark: Mark = {
    path,
    at: done ? (length || at) : at,
    duration: length,
    updated: now,
    done,
  };
  return [mark, ...rest].slice(0, cap);
}

/**
 * Where to start this recording, given what we know about it now.
 *
 * `duration` is what the file itself just said, which beats whatever was
 * stored: a recording that was replaced by a shorter one must not open past its
 * own end. Zero means it hasn't loaded yet, in which case the stored length is
 * the best guess available.
 */
export function resumeAt(marks: Mark[], path: string, duration: number, now: number): number {
  const mark = markFor(marks, path);
  if (!mark) return 0;
  // Heard to the end. Opening it again means starting it again — anything else
  // would be a file that can only ever play its last twenty seconds.
  if (mark.done) return 0;
  const length = duration > 0 ? duration : mark.duration;
  if (length > 0 && length < WORTH_REMEMBERING) return 0;
  const back = rewindFor(now - mark.updated);
  const at = Math.max(0, mark.at - back);
  if (length > 0) {
    // Never resume inside the tail we would immediately call finished.
    return Math.min(at, Math.max(0, length - NEARLY_DONE));
  }
  return at;
}

/**
 * The chapter of this book you were last in.
 *
 * A book is a folder, and this is the one question a folder of audio can be
 * asked that a single file can't: not "where in this file", but "which file".
 * Derived from the marks rather than stored separately, because two records of
 * the same fact are two records that can disagree — and the way they'd disagree
 * is a book that reopens on a chapter you finished last month.
 *
 * `paths` is the folder's own list, so a mark left by a file that has since
 * been deleted or moved can't name a chapter that isn't there.
 */
export function lastPlayed(marks: Mark[], paths: string[]): string | null {
  const inFolder = new Set(paths);
  let best: Mark | null = null;
  for (const mark of marks) {
    if (!inFolder.has(mark.path)) continue;
    if (!best || mark.updated > best.updated) best = mark;
  }
  if (!best) return null;
  // The last thing you heard, finished, in a book with more of it to go: the
  // chapter you want is the next one, not the one you just completed.
  if (best.done) {
    const next = paths[paths.indexOf(best.path) + 1];
    return next ?? best.path;
  }
  return best.path;
}

/** How far through, as a fraction, for the ring drawn on the file's icon.
 * Null where there is nothing honest to draw. */
export function progressOf(mark: Mark | null): number | null {
  if (!mark) return null;
  if (mark.done) return 1;
  if (mark.duration <= 0) return null;
  return Math.min(1, Math.max(0, mark.at / mark.duration));
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
    // Listening must still work when storage is disabled or full.
  }
}
