import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyTransform,
  clampUnit,
  composeCrop,
  fitWithin,
  FULL,
  mirror,
  orientTransform,
  orientedSize,
  outputSize,
  cropToSourceRect,
  rectFromCorners,
  turn,
  UPRIGHT,
  type Orientation,
} from "./geometry.ts";

/**
 * Where each corner of the source lands in the output box.
 *
 * The whole point of `orientTransform` returning numbers instead of touching a
 * canvas: the question "does a quarter turn put the top-left at the top-right"
 * has an answer that can be asserted, rather than one that has to be looked at.
 */
function corners(o: Orientation, sw: number, sh: number, ow: number, oh: number) {
  const t = orientTransform(o, sw, sh, ow, oh);
  const at = (x: number, y: number) => {
    const p = applyTransform(t, x, y);
    return [Math.round(p.x), Math.round(p.y)] as const;
  };
  return {
    topLeft: at(0, 0),
    topRight: at(sw, 0),
    bottomRight: at(sw, sh),
    bottomLeft: at(0, sh),
  };
}

test("upright leaves every corner where it was", () => {
  const c = corners(UPRIGHT, 100, 60, 100, 60);
  assert.deepEqual(c.topLeft, [0, 0]);
  assert.deepEqual(c.topRight, [100, 0]);
  assert.deepEqual(c.bottomRight, [100, 60]);
  assert.deepEqual(c.bottomLeft, [0, 60]);
});

test("a quarter turn clockwise sends the top-left corner to the top-right", () => {
  // 100x60 turned a quarter is 60x100, and the corner that was at the top left
  // is now at the top right. Getting the sign wrong here turns it the other way
  // and every other test still passes.
  const c = corners({ rotation: 90, flipX: false, flipY: false }, 100, 60, 60, 100);
  assert.deepEqual(c.topLeft, [60, 0]);
  assert.deepEqual(c.topRight, [60, 100]);
  assert.deepEqual(c.bottomRight, [0, 100]);
  assert.deepEqual(c.bottomLeft, [0, 0]);
});

test("three quarter turns are one the other way", () => {
  const c = corners({ rotation: 270, flipX: false, flipY: false }, 100, 60, 60, 100);
  assert.deepEqual(c.topLeft, [0, 100]);
  assert.deepEqual(c.topRight, [0, 0]);
  assert.deepEqual(c.bottomRight, [60, 0]);
  assert.deepEqual(c.bottomLeft, [60, 100]);
});

test("a half turn puts the top-left at the bottom-right", () => {
  const c = corners({ rotation: 180, flipX: false, flipY: false }, 100, 60, 100, 60);
  assert.deepEqual(c.topLeft, [100, 60]);
  assert.deepEqual(c.bottomRight, [0, 0]);
});

test("a mirror swaps left for right and leaves top alone", () => {
  const c = corners({ rotation: 0, flipX: true, flipY: false }, 100, 60, 100, 60);
  assert.deepEqual(c.topLeft, [100, 0]);
  assert.deepEqual(c.topRight, [0, 0]);
  assert.deepEqual(c.bottomLeft, [100, 60]);
});

test("a mirror is applied to the view, not to the file", () => {
  // Turned a quarter and then mirrored, the corner that is visually on the left
  // must move to the right of the *output* box. Composing the mirror on the
  // inside of the rotation instead flips it vertically, which looks correct
  // until you have done both gestures.
  const c = corners({ rotation: 90, flipX: true, flipY: false }, 100, 60, 60, 100);
  assert.deepEqual(c.topLeft, [0, 0]);
  assert.deepEqual(c.topRight, [0, 100]);
});

test("every orientation fills the whole output box and none of it twice", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        const size = orientedSize(100, 60, rotation);
        const c = corners({ rotation, flipX, flipY }, 100, 60, size.width, size.height);
        const all = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft];
        const xs = all.map((p) => p[0]).sort((a, b) => a - b);
        const ys = all.map((p) => p[1]).sort((a, b) => a - b);
        const where = `${rotation} flipX:${flipX} flipY:${flipY}`;
        assert.deepEqual([xs[0], xs[3]], [0, size.width], where);
        assert.deepEqual([ys[0], ys[3]], [0, size.height], where);
        // Four distinct corners: a degenerate transform would collapse two.
        assert.equal(new Set(all.map((p) => p.join(","))).size, 4, where);
      }
    }
  }
});

test("turning right four times comes back", () => {
  let r = turn(0, 0);
  for (let i = 0; i < 4; i++) r = turn(r, 1);
  assert.equal(r, 0);
  assert.equal(turn(0, -1), 270);
  assert.equal(turn(270, 1), 0);
});

test("mirroring a turned picture toggles the other axis", () => {
  // In the file's frame it is the other mirror; the test is that the caller
  // never has to know that.
  assert.deepEqual(mirror(UPRIGHT, "x"), { rotation: 0, flipX: true, flipY: false });
  assert.deepEqual(mirror({ rotation: 90, flipX: false, flipY: false }, "x"), {
    rotation: 90,
    flipX: false,
    flipY: true,
  });
});

test("mirroring twice is doing nothing", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const start = { rotation, flipX: false, flipY: false };
    assert.deepEqual(mirror(mirror(start, "x"), "x"), start);
    assert.deepEqual(mirror(mirror(start, "y"), "y"), start);
  }
});

test("cropping a crop lands where the second rectangle was drawn", () => {
  // Take the right-hand half, then the right-hand half of that: the quarter at
  // the far right of the original.
  const half = { x: 0.5, y: 0, width: 0.5, height: 1 };
  const again = composeCrop(half, { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.deepEqual(again, { x: 0.75, y: 0, width: 0.25, height: 1 });
});

test("cropping the whole thing changes nothing", () => {
  const some = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  assert.deepEqual(composeCrop(some, FULL), some);
  assert.deepEqual(composeCrop(FULL, some), some);
});

test("a rectangle dragged up and to the left is still a rectangle", () => {
  assert.deepEqual(rectFromCorners(0.8, 0.9, 0.2, 0.1), {
    x: 0.2,
    y: 0.1,
    width: 0.6000000000000001,
    height: 0.8,
  });
});

test("a rectangle dragged off the edge is pulled back inside it", () => {
  const r = clampUnit({ x: -0.5, y: 0.8, width: 2, height: 2 });
  assert.deepEqual(r, { x: 0, y: 0.8, width: 1, height: 0.19999999999999996 });
});

test("the output size follows the turn and the crop", () => {
  assert.deepEqual(outputSize(4000, 3000, UPRIGHT, FULL), { width: 4000, height: 3000 });
  assert.deepEqual(outputSize(4000, 3000, { rotation: 90, flipX: false, flipY: false }, FULL), {
    width: 3000,
    height: 4000,
  });
  assert.deepEqual(
    outputSize(4000, 3000, UPRIGHT, { x: 0, y: 0, width: 0.5, height: 0.5 }),
    { width: 2000, height: 1500 }
  );
});

test("a picture already inside the budget is not enlarged to fill it", () => {
  const small = fitWithin(800, 600, 4_000_000);
  assert.deepEqual([small.width, small.height, small.scale], [800, 600, 1]);
});

test("a picture over the budget comes back under it, in proportion", () => {
  const big = fitWithin(8000, 6000, 1_000_000);
  assert.ok(big.width * big.height <= 1_000_000);
  assert.ok(Math.abs(big.width / big.height - 8000 / 6000) < 0.01);
});

test("the crop and the orientation transform cancel each other exactly", () => {
  // The property that matters, checked rather than hand-worked: take a crop
  // drawn on the *view*, ask which source pixels it means, then push those
  // pixels back through the transform that builds the view. They must land on
  // the crop that was drawn. A mirror composed on the wrong side of the
  // rotation passes every simpler test and fails this one.
  const srcW = 400;
  const srcH = 300;
  const drawn = { x: 0.1, y: 0.25, width: 0.4, height: 0.5 };

  for (const rotation of [0, 90, 180, 270] as const) {
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        const o = { rotation, flipX, flipY };
        const where = `${rotation} flipX:${flipX} flipY:${flipY}`;

        const sr = cropToSourceRect(drawn, o);
        // The sub-image those source pixels make, drawn into the view box.
        const sw = sr.width * srcW;
        const sh = sr.height * srcH;
        const view = orientedSize(srcW, srcH, rotation);
        const outW = view.width * drawn.width;
        const outH = view.height * drawn.height;

        const t = orientTransform(o, sw, sh, outW, outH);
        const box = [applyTransform(t, 0, 0), applyTransform(t, sw, sh)];
        const xs = box.map((p) => p.x).sort((a, b) => a - b);
        const ys = box.map((p) => p.y).sort((a, b) => a - b);

        // The sub-image fills the view box it was asked to fill, corner to
        // corner, whichever way round it went in.
        assert.ok(Math.abs(xs[0]) < 1e-6, `${where}: left ${xs[0]}`);
        assert.ok(Math.abs(ys[0]) < 1e-6, `${where}: top ${ys[0]}`);
        assert.ok(Math.abs(xs[1] - outW) < 1e-6, `${where}: right ${xs[1]} vs ${outW}`);
        assert.ok(Math.abs(ys[1] - outH) < 1e-6, `${where}: bottom ${ys[1]} vs ${outH}`);

        // And it is a real rectangle inside the source, not one that has
        // wandered outside it.
        assert.ok(sr.x >= -1e-9 && sr.y >= -1e-9, `${where}: ${JSON.stringify(sr)}`);
        assert.ok(sr.x + sr.width <= 1 + 1e-9, where);
        assert.ok(sr.y + sr.height <= 1 + 1e-9, where);
      }
    }
  }
});

test("an uncropped picture reads the whole source, however it is turned", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const sr = cropToSourceRect(FULL, { rotation, flipX: true, flipY: false });
    assert.deepEqual(sr, FULL, `rotation ${rotation}`);
  }
});
