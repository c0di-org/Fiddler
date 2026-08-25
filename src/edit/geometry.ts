/** Where the picture is, after it has been turned, mirrored and cropped.
 *
 * All four of those are recorded rather than performed: an edit is a small
 * description — a quarter-turn count, two mirror flags, a rectangle — and the
 * pixels are produced from it on demand. Which is what lets the same edit draw
 * a 600-pixel preview on screen and a 4,000-pixel export from the original
 * file, without the export inheriting the preview's resolution.
 *
 * Rectangles are in *unit* coordinates, 0 to 1, of whatever they describe. A
 * crop stays a crop when the source turns out to be twice the size the editor
 * was previewing, which is exactly the property that makes the above work.
 */

/** Quarter turns clockwise. */
export type Rotation = 0 | 90 | 180 | 270;

export interface UnitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL: UnitRect = { x: 0, y: 0, width: 1, height: 1 };

export interface Orientation {
  rotation: Rotation;
  /** Mirrored left-to-right, as seen *after* any rotation — because "flip
   * horizontal" means the thing on the screen, not the thing in the file. */
  flipX: boolean;
  flipY: boolean;
}

export const UPRIGHT: Orientation = { rotation: 0, flipX: false, flipY: false };

/** A quarter turn swaps the sides. */
export function orientedSize(
  width: number,
  height: number,
  rotation: Rotation
): { width: number; height: number } {
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** Turning right from where you already are. Kept as a function because the
 * modular arithmetic is the kind that is written wrong once per project. */
export function turn(rotation: Rotation, quarters: number): Rotation {
  return ((((rotation / 90 + quarters) % 4) + 4) % 4 * 90) as Rotation;
}

/**
 * A flip, applied to an orientation that may already be turned.
 *
 * The subtlety: mirroring the *view* of a picture that has been turned a
 * quarter is, in the file's own frame, the other mirror. Composing them by
 * simply toggling `flipX` gives an image that flips the wrong way as soon as
 * the person has also rotated, which is the sort of bug that only shows up
 * after two gestures and then looks like magic.
 */
export function mirror(o: Orientation, axis: "x" | "y"): Orientation {
  const swap = o.rotation % 180 !== 0;
  const which = swap ? (axis === "x" ? "y" : "x") : axis;
  return which === "x" ? { ...o, flipX: !o.flipX } : { ...o, flipY: !o.flipY };
}

/**
 * The affine transform that draws the source into an output box of `outWidth` ×
 * `outHeight`, oriented.
 *
 * Returned as the six numbers `setTransform` takes rather than applied to a
 * context, so that the arithmetic — which is the part that goes wrong — can be
 * checked by mapping corners in a test rather than by looking at a picture.
 *
 * Under this transform the source is drawn at `(0, 0, sourceWidth,
 * sourceHeight)` in its own upright frame and lands filling the output box.
 */
export function orientTransform(
  o: Orientation,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number
): [number, number, number, number, number, number] {
  // Scale first, in the source's own frame, so the source box fills whichever
  // side of the output box it ends up along.
  const along = o.rotation % 180 === 0 ? outWidth : outHeight;
  const across = o.rotation % 180 === 0 ? outHeight : outWidth;
  const sx = along / sourceWidth;
  const sy = across / sourceHeight;

  // Rotation about the centre of the output box.
  const rad = (o.rotation * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));

  // Mirrors act on the view, so they come after the rotation — which is to say
  // they multiply on the outside.
  const mx = o.flipX ? -1 : 1;
  const my = o.flipY ? -1 : 1;

  // [mirror] · [rotate] · [scale], then translated so the box starts at 0,0.
  const a = mx * cos * sx;
  const b = my * sin * sx;
  const c = mx * -sin * sy;
  const d = my * cos * sy;
  return [a, b, c, d, outWidth / 2 - (a * sourceWidth + c * sourceHeight) / 2, outHeight / 2 - (b * sourceWidth + d * sourceHeight) / 2];
}

/** Apply a transform to a point. Exists so the tests can say what they mean. */
export function applyTransform(
  t: [number, number, number, number, number, number],
  x: number,
  y: number
): { x: number; y: number } {
  return { x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5] };
}

/**
 * A crop inside a crop.
 *
 * `next` is expressed in unit coordinates of what is currently on screen — which
 * is already `existing` — so cropping twice has to compose rather than replace.
 * Getting this wrong means the second crop jumps, and it is only visible if
 * somebody crops twice without undoing in between.
 */
export function composeCrop(existing: UnitRect, next: UnitRect): UnitRect {
  return {
    x: existing.x + next.x * existing.width,
    y: existing.y + next.y * existing.height,
    width: next.width * existing.width,
    height: next.height * existing.height,
  };
}

/** Clamp a unit rectangle into the unit square, keeping it non-empty. */
export function clampUnit(rect: UnitRect): UnitRect {
  const x = Math.min(Math.max(0, rect.x), 1);
  const y = Math.min(Math.max(0, rect.y), 1);
  return {
    x,
    y,
    width: Math.min(Math.max(0, rect.width), 1 - x),
    height: Math.min(Math.max(0, rect.height), 1 - y),
  };
}

/** A rectangle from two corners, in either order — what a drag produces. */
export function rectFromCorners(x0: number, y0: number, x1: number, y1: number): UnitRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/**
 * The pixel size a picture ends up, given its source, its orientation and its
 * crop. The number the editor puts in the title bar, and the one an export uses
 * when nobody has asked for a specific size.
 */
export function outputSize(
  sourceWidth: number,
  sourceHeight: number,
  o: Orientation,
  crop: UnitRect
): { width: number; height: number } {
  const oriented = orientedSize(sourceWidth, sourceHeight, o.rotation);
  return {
    width: Math.max(1, Math.round(oriented.width * crop.width)),
    height: Math.max(1, Math.round(oriented.height * crop.height)),
  };
}

/**
 * Fit a box inside another, never enlarging. What "resize to at most 2048 on
 * the longest side" is, and what the working preview uses to decide how much
 * of a photograph it can afford to hold.
 */
export function fitWithin(
  width: number,
  height: number,
  maxPixels: number
): { width: number; height: number; scale: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  // Rounded down, not to nearest: rounding both sides up is enough to put an
  // 8000x6000 photo back over a one-megapixel budget, and the budget exists
  // because the number above it is where a phone stops being able to hold the
  // buffer at all.
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

/**
 * Which part of the *source* a crop refers to.
 *
 * The crop is drawn on what the person can see, which is the picture after it
 * has been turned and mirrored — so it is in the oriented frame, and the file
 * is not. This undoes the orientation to find the rectangle of original pixels
 * that has to be read.
 *
 * It has to agree exactly with `orientTransform`, and "exactly" is doing work
 * there: a version that is off by a mirror produces a crop that follows your
 * finger on screen and cuts the opposite side of the photograph. The test for
 * this composes the two and checks they cancel, rather than checking either
 * against a hand-worked example.
 */
export function cropToSourceRect(crop: UnitRect, o: Orientation): UnitRect {
  // Mirrors were applied last when building the view, so they come off first.
  let r = crop;
  if (o.flipX) r = { ...r, x: 1 - r.x - r.width };
  if (o.flipY) r = { ...r, y: 1 - r.y - r.height };
  // Then turn back the other way.
  return turnRect(r, turn(0, -(o.rotation / 90)));
}

/** A rectangle carried through a quarter turn of the thing it sits on. */
export function turnRect(rect: UnitRect, rotation: Rotation): UnitRect {
  switch (rotation) {
    case 90:
      return { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
    case 180:
      return {
        x: 1 - rect.x - rect.width,
        y: 1 - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
    case 270:
      return { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width };
    default:
      return rect;
  }
}
