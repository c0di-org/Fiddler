import assert from "node:assert/strict";
import { test } from "node:test";

import { boundsOf, combine, coverage, rectMask } from "./mask.ts";
import { wandSelect, type Pixels } from "./wand.ts";

/** A picture from a string map, one character per pixel. Reading a test's
 * expectation off a picture beats reading it off an array of 4,000 bytes. */
function picture(rows: string[], palette: Record<string, [number, number, number, number]>): Pixels {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => {
    assert.equal(row.length, width, "every row must be the same width");
    [...row].forEach((ch, x) => {
      const rgba = palette[ch];
      assert.ok(rgba, `no colour for '${ch}'`);
      data.set(rgba, (y * width + x) * 4);
    });
  });
  return { width, height, data };
}

const PALETTE: Record<string, [number, number, number, number]> = {
  ".": [255, 255, 255, 255],
  "#": [0, 0, 0, 255],
  "~": [250, 250, 250, 255], // white, but not exactly
  " ": [0, 0, 0, 0],
};

/** The mask back as a picture, so a failure prints something legible. */
function show(mask: { width: number; height: number; data: Uint8Array }): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.height; y++) {
    let row = "";
    for (let x = 0; x < mask.width; x++) row += mask.data[y * mask.width + x] ? "*" : ".";
    out.push(row);
  }
  return out;
}

test("wand takes the region the seed is in and stops at the edge", () => {
  const px = picture(
    [
      "....##....",
      "....##....",
      "....##....",
      "....##....",
    ],
    PALETTE
  );
  const mask = wandSelect(px, 0, 0, { tolerance: 0.1 });
  assert.deepEqual(show(mask), ["****......", "****......", "****......", "****......"]);
  assert.deepEqual(mask.bounds, { x: 0, y: 0, width: 4, height: 4 });
});

test("a contiguous fill does not cross to a matching region it cannot reach", () => {
  const px = picture(["..#..", "..#..", "..#.."], PALETTE);
  const mask = wandSelect(px, 4, 1, { tolerance: 0.1 });
  assert.deepEqual(show(mask), ["...**", "...**", "...**"]);
});

test("non-contiguous takes every matching pixel in the picture", () => {
  const px = picture(["..#..", "..#..", "..#.."], PALETTE);
  const mask = wandSelect(px, 4, 1, { tolerance: 0.1, contiguous: false });
  assert.deepEqual(show(mask), ["**.**", "**.**", "**.**"]);
});

test("a run wider than its parent is followed back up and out", () => {
  // The overhang case: the fill enters the wide row through the neck, and the
  // parts of it that sit outside the neck have to be found from below. A fill
  // that only ever scans the parent's own span misses the two ends.
  const px = picture(
    [
      "#######",
      "###.###",
      ".......",
      "###.###",
      "#######",
    ],
    PALETTE
  );
  const mask = wandSelect(px, 3, 1, { tolerance: 0.1 });
  assert.deepEqual(show(mask), [".......", "...*...", "*******", "...*...", "......."]);
});

test("a spiral is walked all the way in", () => {
  // Every span in this one is reached from exactly one direction, so a fill
  // with a broken overhang case stops part way round.
  const px = picture(
    [
      "#########",
      "#.......#",
      "#.#####.#",
      "#.#...#.#",
      "#.#.#.#.#",
      "#.#.#.#.#",
      "#.###.#.#",
      "#.....#.#",
      "#######.#",
    ],
    PALETTE
  );
  const mask = wandSelect(px, 7, 7, { tolerance: 0.1 });
  // Every white pixel in the spiral is connected to the entrance, so all of
  // them come; the two black walls stay out.
  let white = 0;
  for (let i = 3; i < px.data.length; i += 4) if (px.data[i - 3] === 255) white++;
  assert.equal(coverage(mask), white);
});

test("tolerance is what decides whether a near-white joins", () => {
  const px = picture(["..~..", "..~..", "..~.."], PALETTE);
  const tight = wandSelect(px, 0, 0, { tolerance: 0.0 });
  assert.deepEqual(show(tight), ["**...", "**...", "**..."]);
  const loose = wandSelect(px, 0, 0, { tolerance: 0.02 });
  assert.deepEqual(show(loose), ["*****", "*****", "*****"]);
});

test("transparent pixels match each other whatever is under the alpha", () => {
  const px: Pixels = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 0]) };
  const mask = wandSelect(px, 0, 0, { tolerance: 0 });
  assert.deepEqual(show(mask), ["**"]);
});

test("an opaque pixel does not match a transparent one of the same colour", () => {
  const px: Pixels = { width: 2, height: 1, data: new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 0]) };
  const mask = wandSelect(px, 0, 0, { tolerance: 0 });
  assert.deepEqual(show(mask), ["*."]);
});

test("a seed outside the picture selects nothing rather than throwing", () => {
  const px = picture(["..", ".."], PALETTE);
  assert.equal(coverage(wandSelect(px, -1, 0, { tolerance: 1 })), 0);
  assert.equal(coverage(wandSelect(px, 0, 9, { tolerance: 1 })), 0);
});

test("tolerance 1 takes the whole picture", () => {
  const px = picture(["#.#", ".#.", "#.#"], PALETTE);
  assert.equal(coverage(wandSelect(px, 1, 1, { tolerance: 1 })), 9);
});

test("a rectangle is clamped to the canvas", () => {
  const mask = rectMask(10, 10, { x: -5, y: 8, width: 20, height: 20 });
  assert.deepEqual(mask.bounds, { x: 0, y: 8, width: 10, height: 2 });
  assert.equal(coverage(mask), 20);
});

test("a rectangle entirely outside selects nothing", () => {
  assert.equal(rectMask(4, 4, { x: 10, y: 10, width: 2, height: 2 }).bounds, null);
});

test("shift adds, option subtracts, and both keep the bounds honest", () => {
  const a = rectMask(10, 10, { x: 0, y: 0, width: 4, height: 4 });
  const b = rectMask(10, 10, { x: 6, y: 6, width: 4, height: 4 });
  const added = combine(a, b, "add");
  assert.deepEqual(added.bounds, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(coverage(added), 32);

  const cut = combine(added, rectMask(10, 10, { x: 0, y: 0, width: 4, height: 4 }), "subtract");
  assert.deepEqual(cut.bounds, { x: 6, y: 6, width: 4, height: 4 });

  const both = combine(a, rectMask(10, 10, { x: 2, y: 2, width: 6, height: 6 }), "intersect");
  assert.deepEqual(both.bounds, { x: 2, y: 2, width: 2, height: 2 });
});

test("an empty mask has no bounds", () => {
  assert.equal(boundsOf(new Uint8Array(16), 4, 4), null);
});
