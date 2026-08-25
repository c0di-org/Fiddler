import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundsOfShape,
  hitTest,
  moveShape,
  reframeShape,
  reorientShape,
  shouldRecordPoint,
  type Shape,
} from "./markup.ts";

const shape = (over: Partial<Shape> = {}): Shape => ({
  id: "a",
  kind: "rect",
  x0: 0.2,
  y0: 0.2,
  x1: 0.6,
  y1: 0.5,
  stroke: "#f00",
  fill: null,
  width: 0.005,
  ...over,
});

test("a shape drawn backwards still has a positive box", () => {
  const b = boundsOfShape(shape({ x0: 0.6, y0: 0.5, x1: 0.2, y1: 0.2 }));
  assert.deepEqual([b.x, b.y], [0.2, 0.2]);
  assert.ok(Math.abs(b.width - 0.4) < 1e-9 && Math.abs(b.height - 0.3) < 1e-9);
});

test("a freehand stroke's box is the ink, not its endpoints", () => {
  // The endpoints of a drawn loop are next to each other; using them would give
  // a box of nearly nothing and make the stroke impossible to select.
  const ink = shape({ kind: "ink", x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5, points: [0.5, 0.5, 0.1, 0.9, 0.9, 0.2, 0.5, 0.5] });
  const b = boundsOfShape(ink);
  assert.deepEqual([b.x, b.y], [0.1, 0.2]);
  assert.ok(Math.abs(b.width - 0.8) < 1e-9 && Math.abs(b.height - 0.7) < 1e-9);
});

test("the shape you just drew is the one a tap grabs", () => {
  const under = shape({ id: "under" });
  const over = shape({ id: "over" });
  assert.equal(hitTest([under, over], 0.4, 0.3)?.id, "over");
  assert.equal(hitTest([under, over], 0.95, 0.95), null);
});

test("a tap just outside a thin line still finds it", () => {
  const line = shape({ kind: "line", x0: 0.2, y0: 0.5, x1: 0.8, y1: 0.5 });
  assert.equal(hitTest([line], 0.5, 0.51)?.id, "a");
  assert.equal(hitTest([line], 0.5, 0.8), null);
});

test("moving a stroke moves its ink too", () => {
  const ink = shape({ kind: "ink", points: [0.1, 0.1, 0.2, 0.2] });
  const moved = moveShape(ink, 0.1, -0.05);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  [0.2, 0.05, 0.3, 0.15].forEach((want, i) => near(moved.points![i], want));
  near(moved.x0, 0.3);
});

test("markup stays where it was drawn when the picture is cropped", () => {
  // A rectangle in the middle of the picture, cropped to the middle half: it
  // must still surround the same thing, which means its numbers have to grow.
  const middle = shape({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 });
  const after = reframeShape(middle, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.ok(Math.abs(after.x0 - 0.3) < 1e-9);
  assert.ok(Math.abs(after.x1 - 0.7) < 1e-9);
});

test("markup follows a quarter turn", () => {
  // The top-left corner of the picture goes to the top right, so a mark at the
  // top left has to go with it.
  const corner = shape({ x0: 0, y0: 0, x1: 0.1, y1: 0.1 });
  const turned = reorientShape(corner, 90, null);
  assert.ok(Math.abs(turned.x0 - 1) < 1e-9);
  assert.ok(Math.abs(turned.y0 - 0) < 1e-9);
});

test("markup follows a mirror", () => {
  const left = shape({ x0: 0.1, y0: 0.5, x1: 0.2, y1: 0.6 });
  const flipped = reorientShape(left, 0, "x");
  assert.ok(Math.abs(flipped.x0 - 0.9) < 1e-9);
  assert.ok(Math.abs(flipped.y0 - 0.5) < 1e-9);
});

test("four quarter turns put markup back where it started", () => {
  let s = shape({ x0: 0.13, y0: 0.29, x1: 0.44, y1: 0.71 });
  const start = { ...s };
  for (let i = 0; i < 4; i++) s = reorientShape(s, 90, null);
  for (const k of ["x0", "y0", "x1", "y1"] as const) {
    assert.ok(Math.abs(s[k] - start[k]) < 1e-9, `${k}: ${s[k]} vs ${start[k]}`);
  }
});

test("a pen resting still does not record a thousand identical points", () => {
  const pts = [0.5, 0.5];
  assert.equal(shouldRecordPoint(pts, 0.5001, 0.5001, 0.01), false);
  assert.equal(shouldRecordPoint(pts, 0.52, 0.5, 0.01), true);
  assert.equal(shouldRecordPoint([], 0.5, 0.5, 0.01), true);
});
