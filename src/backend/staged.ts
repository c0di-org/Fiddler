/** Getting a file's bytes to Rust on a platform whose IPC cannot carry a body.
 *
 * Tauri sends an `invoke` payload one of two ways. Where the WebView can be
 * asked to `fetch` a custom protocol, an `ArrayBuffer` goes as the request body
 * untouched — which is what `create_file` and `write_file` were written for.
 * Android cannot: Tauri's own IPC script disables that door with the comment
 * "on Android we never use it because Android does not have support to reading
 * the request body", and everything goes through `postMessage` instead, where
 * the whole message is a single JSON string.
 *
 * A `Uint8Array` in that string becomes an array of numbers — around four
 * characters per byte, so a 4 MB photograph is a 16 MB string to build, hand
 * across the bridge and parse back. That is the copying the raw body exists to
 * avoid, on the platform least able to afford it.
 *
 * So the picture goes in pieces: half a megabyte at a time, base64 in a small
 * JSON string, appended to a staging file by `stage_bytes`. The save command
 * then gets the name of that file instead of the bytes, and nothing larger than
 * one piece is ever a string at either end.
 */

/** How much of the picture travels in one message.
 *
 * Half a megabyte becomes a ~700 KB string, which a WebView builds and hands
 * over without noticing. Ten times that would halve the number of round trips
 * and put a 7 MB string on the bridge for the privilege — the wrong trade on a
 * phone. Ten times smaller would spend more time on round trips than on bytes.
 */
export const PIECE = 512 * 1024;

/** The pieces to send, in order. Always at least one, so that saving an empty
 * file still creates the staging file rather than sending nothing at all. */
export function pieces(bytes: Uint8Array, size = PIECE): Uint8Array[] {
  if (bytes.length === 0) return [bytes];
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    out.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
  }
  return out;
}

/** `btoa` takes a string whose code units are all bytes, and building that
 * string with `String.fromCharCode(...bytes)` throws on anything this size —
 * the argument list is the limit, not the string. So it is fed in mouthfuls. */
const MOUTHFUL = 0x8000;

export function base64(bytes: Uint8Array): string {
  let latin = "";
  for (let at = 0; at < bytes.length; at += MOUTHFUL) {
    latin += String.fromCharCode(...bytes.subarray(at, Math.min(at + MOUTHFUL, bytes.length)));
  }
  return btoa(latin);
}
