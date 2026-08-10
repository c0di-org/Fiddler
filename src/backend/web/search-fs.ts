/** The two bounded searches the UI falls back to when a name filter comes up
 * empty. Both mirror `content_search.rs` and `fs_scan.rs`, budgets included —
 * the point of the budgets is that a search on a huge folder stays interactive,
 * and that reasoning doesn't change because the loop moved into a tab. */

import type { ContentHit, ContentSearch, NearbyEntry, NearbySearch } from "../../types";
import { decodeUtf8, looksBinary } from "./text.ts";
import { childPath, listDir, readBlob, type Node } from "./vfs.ts";

const MAX_NEARBY_ENTRIES = 10_000;
const MAX_NEARBY_DIRS = 2_000;

const MAX_FILES = 512;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_HITS = 100;

const isHidden = (name: string) => name.startsWith(".");

/** Breadth-first so the shallow, more likely matches are the ones that survive
 * the budget. */
export async function nearbyEntries(
  root: string,
  showHidden: boolean,
  maxDepth: number
): Promise<NearbySearch> {
  const entries: NearbyEntry[] = [];
  let dirsVisited = 0;
  let truncated = false;

  let frontier: { path: string; relative: string }[] = [{ path: root, relative: "" }];

  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: { path: string; relative: string }[] = [];

    for (const dir of frontier) {
      if (dirsVisited >= MAX_NEARBY_DIRS || entries.length >= MAX_NEARBY_ENTRIES) {
        truncated = true;
        break;
      }
      dirsVisited++;

      let children: Node[];
      try {
        children = await listDir(dir.path);
      } catch {
        continue; // An unreadable folder shouldn't sink the whole search.
      }

      for (const child of children) {
        const hidden = isHidden(child.name);
        if (hidden && !showHidden) continue;
        if (entries.length >= MAX_NEARBY_ENTRIES) {
          truncated = true;
          break;
        }
        const relative = dir.relative ? `${dir.relative}/${child.name}` : child.name;
        const path = childPath(dir.path, child.name);
        // The root's own children are already on screen; only deeper things are
        // news, which is what makes this a *nearby* search rather than a re-list.
        if (depth > 0) {
          entries.push({
            name: child.name,
            path,
            kind: child.kind,
            linkToDir: false,
            hidden,
            relativePath: relative,
          });
        }
        if (child.kind === "dir" && depth < maxDepth) next.push({ path, relative });
      }
    }
    frontier = next;
  }

  return { entries, truncated };
}

export async function searchContents(
  root: string,
  names: string[],
  terms: string[]
): Promise<ContentSearch> {
  if (terms.length === 0) return { hits: [], truncated: false };

  const hits: ContentHit[] = [];
  let totalBytes = 0;
  let truncated = names.length > MAX_FILES;

  for (const name of names.slice(0, MAX_FILES)) {
    if (hits.length >= MAX_HITS) {
      truncated = true;
      break;
    }
    // The frontend only ever sends direct child names; enforce it here too, so
    // a term can never be used to read outside the folder being viewed.
    if (name.includes("/") || name === "." || name === "..") continue;

    let blob: Blob;
    try {
      blob = await readBlob(childPath(root, name));
    } catch {
      continue;
    }
    if (blob.size > MAX_FILE_BYTES) continue;
    if (totalBytes + blob.size > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    totalBytes += blob.size;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (looksBinary(bytes)) continue;

    const text = decodeUtf8(bytes);
    const folded = text.toLowerCase();
    if (!terms.every((term) => folded.includes(term))) continue;

    const first = folded.indexOf(terms[0]);
    const line = countNewlines(folded.slice(0, Math.max(first, 0))) + 1;
    hits.push({ name, line, snippet: compactSnippet(text.split("\n")[line - 1] ?? "") });
  }

  return { hits, truncated };
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** One line, whitespace collapsed, short enough to sit in a result tile. */
function compactSnippet(line: string): string {
  const compact = line.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...compact];
  return chars.length > 140 ? chars.slice(0, 140).join("") + "…" : compact;
}
