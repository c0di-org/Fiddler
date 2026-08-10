/** Reading files as text, with the same bounds the Rust side enforces.
 *
 * The limits here are not defensive dressing: `readText` is what decides
 * whether double-clicking a file opens the editor or hands it off, so a
 * disagreement about "is this text" between the two backends would show up as
 * two different apps. */

import type { Inspect, TextHead } from "../../types";
// Explicit `.ts` here and in `search-fs.ts`: these two and the modules under
// them are the part of the web backend that is pure enough to unit test, and
// `node --test` resolves specifiers itself rather than going through Vite.
import { listDir, readBlob, stat } from "./vfs.ts";

const MIN_READ = 1024;
const MAX_READ = 4 * 1024 * 1024;
/** What `inspect` peeks at for the preview pane's fallback text. */
const PEEK = 8 * 1024;

/** A NUL byte in the first block is the standard "this is binary" heuristic;
 * it's what `grep` and `git` both use, and what `commands.rs` uses. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** Decodes UTF-8, holding back a multi-byte sequence the read boundary split
 * rather than mangling it — `{ stream: true }` and no flush is exactly the
 * `valid_up_to` trim the Rust side does. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes, { stream: true });
}

/** Matches Rust's `str::lines().count()`: a trailing newline does not open a
 * final empty line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export async function readText(path: string, maxBytes: number): Promise<TextHead> {
  const node = await stat(path);
  if (!node) throw new Error(`No such file: ${path}`);
  if (node.kind === "dir") throw new Error("that is a folder");

  const blob = await readBlob(path);
  const cap = Math.min(Math.max(maxBytes, MIN_READ), MAX_READ);
  const head = new Uint8Array(await blob.slice(0, cap).arrayBuffer());

  if (looksBinary(head)) {
    return { text: "", truncated: false, bytes: blob.size, lines: 0, binary: true };
  }

  const text = decodeUtf8(head);
  return {
    text,
    truncated: blob.size > cap,
    bytes: blob.size,
    lines: countLines(text),
    binary: false,
  };
}

export async function inspect(path: string): Promise<Inspect> {
  const node = await stat(path);
  if (!node) throw new Error(`No such item: ${path}`);

  if (node.kind === "dir") {
    const children = await listDir(path);
    return {
      text: null,
      childCount: children.filter((c) => c.name !== ".DS_Store").length,
      binary: false,
    };
  }

  const blob = await readBlob(path);
  const head = new Uint8Array(await blob.slice(0, PEEK).arrayBuffer());
  if (looksBinary(head)) return { text: null, childCount: null, binary: true };

  return { text: decodeUtf8(head).slice(0, 4000), childCount: null, binary: false };
}
