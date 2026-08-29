/**
 * A folder of audio, read as a book.
 *
 * Nothing here talks to the player or to storage; it is the pure question
 * "given this folder listing, what is the book?" — which files are in it, in
 * what order, and what to put on the cover. Keeping it separate is what lets
 * the answer be tested, and the order is the part most worth testing: chapter
 * ten belongs after chapter nine, and a plain string sort puts it after chapter
 * one, which turns a twenty-hour book into a shuffled one.
 */

import { routeOf } from "../preview/route.ts";
import { natural } from "../sort.ts";
import type { Entry } from "../types.ts";

export interface Track {
  path: string;
  /** The file's name, extension and all — what the folder shows. */
  name: string;
  /** The folder it came from. Two files with the same name in different books
   * are different tracks, and this is what the player compares. */
  folder: string;
}

/** Cover names, in the order they win. The first four are the conventions every
 * ripper and every audiobook shop has agreed on; `art` and `artwork` are what
 * people type by hand. */
const COVER_NAMES = ["cover", "folder", "front", "album", "art", "artwork"];

export function isAudio(name: string): boolean {
  return routeOf(name) === "audio";
}

/** The folder's audio, in listening order.
 *
 * Sorted here rather than taking the view's order on purpose. The view can be
 * sorted by size, or by date, or reversed, and none of those is the order a
 * book is meant to be heard in — but all of them are orders someone might be
 * looking at when they tap chapter one.
 */
export function tracksIn(entries: Entry[], folder: string): Track[] {
  return entries
    .filter((e) => e.kind !== "dir" && !(e.kind === "symlink" && e.linkToDir) && isAudio(e.name))
    .sort((a, b) => natural(a.name, b.name))
    .map((e) => ({ path: e.path, name: e.name, folder }));
}

/**
 * The picture to show for this book, or null.
 *
 * A named cover wins outright. Failing that, a folder holding exactly one
 * picture is almost certainly holding its cover — and where there are several,
 * guessing would be worse than the typed glyph, because a wrong cover is a
 * confident lie about which book is playing.
 */
export function coverIn(entries: Entry[]): string | null {
  const images = entries.filter((e) => e.kind === "file" && routeOf(e.name) === "image");
  for (const wanted of COVER_NAMES) {
    const hit = images.find((e) => stem(e.name).toLowerCase() === wanted);
    if (hit) return hit.path;
  }
  return images.length === 1 ? images[0].path : null;
}

/** A file's name without its extension, which is what a chapter is called. */
export function trackTitle(name: string): string {
  return stem(name) || name;
}

/** The book's name: the folder it lives in. Where the file sits loose at the
 * root of a volume there is no book, and the honest answer is nothing. */
export function bookTitle(folder: string): string {
  const name = folder.replace(/\/+$/, "").split("/").pop() ?? "";
  return name;
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : cut === 0 ? "/" : "";
}
