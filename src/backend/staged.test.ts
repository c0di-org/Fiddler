import assert from "node:assert/strict";
import { test } from "node:test";

import { base64, pieces, PIECE } from "./staged.ts";

/** Bytes that use the whole range, because base64's last two characters only
 * appear for the high bit patterns a photograph has and text never does. */
function noisy(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 12345;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

test("every tail length encodes the way Node's own base64 does", () => {
  // The three lengths mod 3 are the whole of the padding question, and a
  // decoder that gets one wrong loses the last byte or two of the file.
  for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 257]) {
    const bytes = noisy(length);
    assert.equal(base64(bytes), Buffer.from(bytes).toString("base64"), `${length} bytes`);
  }
});

test("a picture-sized buffer encodes without hitting an argument limit", () => {
  // `String.fromCharCode(...bytes)` on this many at once is what throws, and
  // the crash is a RangeError at save time on the largest photographs only.
  const bytes = noisy(3 * 1024 * 1024 + 7);
  assert.equal(base64(bytes), Buffer.from(bytes).toString("base64"));
});

test("the pieces are the file, in order and whole", () => {
  const bytes = noisy(PIECE * 2 + 13);
  const parts = pieces(bytes);
  assert.equal(parts.length, 3);
  assert.deepEqual(Buffer.concat(parts.map((p) => Buffer.from(p))), Buffer.from(bytes));
  // Each piece must decode on its own: a chunk boundary that fell inside a
  // base64 quad would be padded, and the file would gain bytes in the middle.
  const rejoined = Buffer.concat(parts.map((p) => Buffer.from(base64(p), "base64")));
  assert.deepEqual(rejoined, Buffer.from(bytes));
});

test("an empty file is still one message, not none", () => {
  assert.equal(pieces(new Uint8Array(0)).length, 1);
  assert.equal(base64(new Uint8Array(0)), "");
});
