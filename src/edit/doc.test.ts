import assert from "node:assert/strict";
import { test } from "node:test";

import { FULL } from "./geometry.ts";
import type { Shape } from "./markup.ts";
import {
  addShape,
  begin,
  canUndo,
  commit,
  crop,
  exportSize,
  flip,
  HISTORY_CAP,
  isEdited,
  naturalSize,
  newDoc,
  resizeTo,
  revise,
  rotate,
  uncrop,
  undo,
  type EditDoc,
  type MaskStep,
} from "./doc.ts";

const doc = () => newDoc("/p/photo.jpg", "photo.jpg", 4000, 3000);

const mark = (over: Partial<Shape> = {}): Shape => ({
  id: "m",
  kind: "rect",
  x0: 0.4,
  y0: 0.4,
  x1: 0.6,
  y1: 0.6,
  stroke: "#f00",
  fill: null,
  width: 0.004,
  ...over,
});

const maskStep = (frame = FULL): MaskStep => ({
  id: "k",
  kind: "erase",
  frame,
  mask: { width: 8, height: 8, source: null },
});

const near = (a: number, b: number, what = "") =>
  assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} vs ${b}`);

test("a fresh document has nothing to save", () => {
  assert.equal(isEdited(doc()), false);
  assert.deepEqual(naturalSize(doc()), { width: 4000, height: 3000 });
  assert.deepEqual(exportSize(doc()), { width: 4000, height: 3000 });
});

test("a quarter turn swaps the sides", () => {
  const turned = rotate(doc(), 1);
  assert.deepEqual(naturalSize(turned), { width: 3000, height: 4000 });
  assert.equal(isEdited(turned), true);
});

test("four quarter turns are no turn at all", () => {
  let d = doc();
  for (let i = 0; i < 4; i++) d = rotate(d, 1);
  assert.equal(d.orientation.rotation, 0);
  assert.deepEqual(naturalSize(d), { width: 4000, height: 3000 });
});

test("a crop cuts the size down and composes with the next one", () => {
  const half = crop(doc(), { x: 0, y: 0, width: 0.5, height: 0.5 });
  assert.deepEqual(naturalSize(half), { width: 2000, height: 1500 });
  const quarter = crop(half, { x: 0, y: 0, width: 0.5, height: 0.5 });
  assert.deepEqual(naturalSize(quarter), { width: 1000, height: 750 });
  near(quarter.crop.width, 0.25, "crop width");
});

test("cropping brings the markup with it", () => {
  // A mark in the middle of the picture must still be in the middle after the
  // middle half is cropped out — which means its numbers have to change.
  const withMark = addShape(doc(), mark());
  const cropped = crop(withMark, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  near(cropped.shapes[0].x0, 0.3, "x0");
  near(cropped.shapes[0].x1, 0.7, "x1");
});

test("cropping brings the wand's holes with it", () => {
  const withHole = { ...doc(), masks: [maskStep({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 })] };
  const cropped = crop(withHole, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  near(cropped.masks[0].frame.x, 0.3, "mask x");
  near(cropped.masks[0].frame.width, 0.4, "mask width");
});

test("turning brings the markup and the holes with it", () => {
  const d = { ...addShape(doc(), mark({ x0: 0, y0: 0, x1: 0.1, y1: 0.1 })), masks: [maskStep({ x: 0, y: 0, width: 0.2, height: 0.1 })] };
  const turned = rotate(d, 1);
  // Top-left goes to top-right, for both.
  near(turned.shapes[0].x0, 1, "shape x0");
  near(turned.masks[0].frame.x, 0.9, "mask x");
  near(turned.masks[0].frame.width, 0.1, "mask width");
});

test("a crop taken before a turn ends up on the same part of the picture", () => {
  // Crop the left third, then turn a quarter clockwise: the left third is now
  // the top third, so the crop has to have become the top third.
  const left = crop(doc(), { x: 0, y: 0, width: 1 / 3, height: 1 });
  const turned = rotate(left, 1);
  near(turned.crop.x, 0, "x");
  near(turned.crop.y, 0, "y");
  near(turned.crop.width, 1, "width");
  near(turned.crop.height, 1 / 3, "height");
});

test("a mirror moves the crop to the other side", () => {
  const left = crop(doc(), { x: 0, y: 0, width: 0.25, height: 1 });
  const mirrored = flip(left, "x");
  near(mirrored.crop.x, 0.75, "x");
  near(mirrored.crop.width, 0.25, "width");
});

test("mirroring twice is doing nothing", () => {
  const left = crop(doc(), { x: 0.1, y: 0.2, width: 0.25, height: 0.5 });
  const back = flip(flip(left, "x"), "x");
  near(back.crop.x, 0.1, "x");
  near(back.crop.y, 0.2, "y");
  assert.equal(back.orientation.flipX, false);
});

test("an explicit size wins over the natural one, and a crop retires it", () => {
  const sized = resizeTo(doc(), 1200, 900);
  assert.deepEqual(exportSize(sized), { width: 1200, height: 900 });
  // The typed size described a picture that no longer exists once it is cropped.
  const cropped = crop(sized, { x: 0, y: 0, width: 0.5, height: 1 });
  assert.equal(cropped.resize, null);
  assert.deepEqual(exportSize(cropped), { width: 2000, height: 3000 });
});

test("uncropping returns the whole frame", () => {
  const back = uncrop(crop(doc(), { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }));
  assert.deepEqual(back.crop, FULL);
  assert.deepEqual(naturalSize(back), { width: 4000, height: 3000 });
});

test("a degenerate crop is refused rather than producing a picture of nothing", () => {
  const d = doc();
  assert.equal(crop(d, { x: 0.5, y: 0.5, width: 0, height: 0.2 }), d);
  assert.equal(crop(d, { x: 2, y: 2, width: 1, height: 1 }), d);
});

test("undo walks back one step at a time and stops at the beginning", () => {
  let h = begin(doc());
  h = commit(h, rotate(h.present, 1));
  h = commit(h, crop(h.present, { x: 0, y: 0, width: 0.5, height: 1 }));
  assert.equal(canUndo(h), true);
  h = undo(h);
  assert.deepEqual(h.present.crop, FULL);
  assert.equal(h.present.orientation.rotation, 90);
  h = undo(h);
  assert.equal(h.present.orientation.rotation, 0);
  assert.equal(canUndo(h), false);
  assert.equal(undo(h).present.orientation.rotation, 0);
});

test("the stack is capped, and it is the oldest that goes", () => {
  let h = begin(doc());
  for (let i = 0; i < HISTORY_CAP + 10; i++) h = commit(h, rotate(h.present, 1));
  assert.equal(h.past.length, HISTORY_CAP);
  assert.equal(canUndo(h), true);
});

test("committing the same document twice does not fill the stack with nothing", () => {
  const h = begin(doc());
  assert.equal(commit(h, h.present), h);
});

test("a document is never mutated by a verb", () => {
  const before: EditDoc = doc();
  const snapshot = JSON.stringify(before);
  rotate(before, 1);
  crop(before, { x: 0, y: 0, width: 0.5, height: 0.5 });
  flip(before, "x");
  addShape(before, mark());
  resizeTo(before, 10, 10);
  assert.equal(JSON.stringify(before), snapshot);
});

test("a drag records one step, not one per pointer event", () => {
  // The gesture is recorded on the press and revised after it. Recording every
  // move turns a single freehand stroke into two hundred entries and empties a
  // twenty-deep stack, so ⌘Z walks back through the middle of one line.
  let h = begin(doc());
  h = commit(h, addShape(h.present, mark({ id: "stroke" })));
  for (let i = 0; i < 200; i++) {
    h = revise(h, addShape(h.present, mark({ id: `p${i}` })));
  }
  assert.equal(h.past.length, 1);
  h = undo(h);
  assert.equal(h.present.shapes.length, 0, "one undo removes the whole gesture");
});

test("revising never loses the step that was recorded before it", () => {
  let h = begin(doc());
  h = commit(h, rotate(h.present, 1));
  h = revise(h, crop(h.present, { x: 0, y: 0, width: 0.5, height: 1 }));
  assert.equal(h.past.length, 1);
  assert.equal(undo(h).present.orientation.rotation, 0);
});
