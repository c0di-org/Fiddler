import assert from "node:assert/strict";
import test from "node:test";

import {
  clampImagePan,
  clampImageZoom,
  fittedImageSize,
  MAX_IMAGE_ZOOM,
  MIN_IMAGE_ZOOM,
  pinchImage,
  zoomImageAround,
} from "./image-zoom.ts";

test("fittedImageSize only shrinks images that do not fit", () => {
  assert.deepEqual(
    fittedImageSize({ width: 1000, height: 800 }, { width: 400, height: 300 }),
    { width: 400, height: 300 }
  );
  assert.deepEqual(
    fittedImageSize({ width: 1000, height: 800 }, { width: 2000, height: 1000 }),
    { width: 1000, height: 500 }
  );
});

test("zoom is bounded and fit always recentres", () => {
  assert.equal(clampImageZoom(0.2), MIN_IMAGE_ZOOM);
  assert.equal(clampImageZoom(99), MAX_IMAGE_ZOOM);
  assert.deepEqual(
    clampImagePan(
      { x: 120, y: -80 },
      1,
      { width: 1000, height: 800 },
      { width: 1000, height: 500 }
    ),
    { x: 0, y: 0 }
  );
});

test("pan is clamped to the exposed image bounds", () => {
  assert.deepEqual(
    clampImagePan(
      { x: 900, y: -900 },
      2,
      { width: 1000, height: 800 },
      { width: 1000, height: 500 }
    ),
    { x: 500, y: -100 }
  );
});

test("pointer-centred zoom keeps the same image point under the pointer", () => {
  const result = zoomImageAround(
    { x: 0, y: 0 },
    1,
    2,
    { x: 200, y: 0 },
    { width: 1000, height: 800 },
    { width: 1000, height: 800 }
  );
  assert.equal(result.zoom, 2);
  assert.deepEqual(result.pan, { x: -200, y: 0 });
});

test("pinch can zoom and translate in one gesture", () => {
  const result = pinchImage(
    { x: 0, y: 0 },
    1,
    2,
    { x: 0, y: 0 },
    { x: 60, y: 20 },
    { width: 1000, height: 800 },
    { width: 1000, height: 800 }
  );
  assert.equal(result.zoom, 2);
  assert.deepEqual(result.pan, { x: 60, y: 20 });
});
