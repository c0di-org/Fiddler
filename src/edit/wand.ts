/** The magic wand.
 *
 * Tap a pixel and everything that looks like it comes with — the sky behind a
 * building, the white behind a scanned receipt, the flat grey behind a product
 * shot. Then keep dragging, and the reach grows or shrinks under your finger.
 * That second half is the whole tool: a tolerance slider you have to leave the
 * picture to touch is a tolerance slider nobody tunes, so the drag *is* the
 * slider and the result is drawn while you move.
 *
 * Which means this function's budget is not "fast enough to feel deliberate",
 * it is "fast enough to run every frame while a finger moves". Everything below
 * follows from that:
 *
 * - **Span fill, not per-pixel.** The stack holds horizontal runs, so a flat sky
 *   costs one push per row rather than one per pixel. On a 12 MP photo that is
 *   the difference between a fill and a stack overflow.
 * - **No allocation in the loop.** One typed array, sized once, which is both
 *   the answer and the record of where the fill has already been — a separate
 *   visited set would be a second pass over 12 million bytes for nothing.
 * - **Squared distances.** The comparison never takes a square root; the
 *   tolerance is squared once, on the way in.
 *
 * The metric is "redmean" rather than plain RGB distance. It costs one extra
 * multiply per channel and it is the difference between a tolerance that walks
 * evenly across a gradient sky and one that grabs half the frame the moment it
 * touches a blue that was already close to the seed in raw RGB.
 */

import { boundsOf, type Mask } from "./mask.ts";

/** Source pixels. Structurally an `ImageData`, declared separately so this
 * module — and its tests — never need a DOM. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** The largest squared distance this metric can report, which is black against
 * white: the two red weights always sum to `4 + 255/256` whatever the mean red
 * is, so the worst case is `(4 + 255/256 + 4) * 255²`. Tolerance is a fraction
 * of it, so the number the UI shows means the same thing on every picture.
 *
 * Written out rather than as a literal because it was a literal first, it was
 * wrong by one, and the only symptom was that a tolerance of exactly 1 selected
 * a single pixel instead of the whole photograph. */
const MAX_DISTANCE_SQ = (4 + 255 / 256 + 4) * 255 * 255;

export interface WandOptions {
  /** 0 = only this exact colour, 1 = the entire image. */
  tolerance: number;
  /** Contiguous is the wand; non-contiguous is "select every pixel in the
   * picture that looks like this", which is what you want for the white in a
   * scan that the staple interrupts. */
  contiguous?: boolean;
  /** Treat a transparent pixel as matching any other transparent pixel,
   * whatever its dead RGB happens to be. Without this, wanding the hole left by
   * a previous delete selects a checkerboard of whatever the encoder left
   * behind under the alpha. */
  matchAlpha?: boolean;
}

export function wandSelect(px: Pixels, seedX: number, seedY: number, opts: WandOptions): Mask {
  const { width, height, data } = px;
  const x0 = Math.floor(seedX);
  const y0 = Math.floor(seedY);
  const mask = new Uint8Array(width * height);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) {
    return { width, height, data: mask, bounds: null };
  }

  const seed = (y0 * width + x0) * 4;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const sa = data[seed + 3];
  const limit = opts.tolerance * opts.tolerance * MAX_DISTANCE_SQ;
  const matchAlpha = opts.matchAlpha ?? true;

  // Alpha is compared before colour and on its own scale, because a pixel that
  // is 10% opaque is not "nearly" the colour it claims to be — it is nearly not
  // there. Blending it against the seed first would be more correct and would
  // also make an eraser hole match every dark colour in the picture.
  const alphaSlack = opts.tolerance * 255;

  const matches = (i: number): boolean => {
    const a = data[i + 3];
    if (matchAlpha) {
      if (Math.abs(a - sa) > alphaSlack) return false;
      // Two transparent pixels match regardless of the garbage under them.
      if (a === 0 && sa === 0) return true;
    }
    const dr = data[i] - sr;
    const dg = data[i + 1] - sg;
    const db = data[i + 2] - sb;
    const rbar = (data[i] + sr) * 0.5;
    const d2 = (2 + rbar / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rbar) / 256) * db * db;
    return d2 <= limit;
  };

  if (opts.contiguous === false) {
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) if (matches(i)) mask[p] = 255;
    return { width, height, data: mask, bounds: boundsOf(mask, width, height) };
  }

  if (!matches(seed)) return { width, height, data: mask, bounds: null };

  // Span filling, in the form that has been proved not to miss a neck: the
  // stack holds a horizontal run plus the direction it was discovered in, and
  // popping one fills its row and pushes the runs above and below — including
  // the two overhang pieces that a run wider than its parent leaves behind.
  // Written out flat rather than recursively because the recursion depth on a
  // 12-megapixel sky is not a thing any engine will survive.
  const inside = (x: number, y: number): boolean => {
    const p = y * width + x;
    return mask[p] === 0 && matches(p * 4);
  };
  const set = (x: number, y: number) => {
    mask[y * width + x] = 255;
  };

  const stack: number[] = [x0, x0, y0, 1, x0, x0, y0 - 1, -1];
  while (stack.length > 0) {
    const dy = stack.pop() as number;
    const y = stack.pop() as number;
    const x2 = stack.pop() as number;
    let x1 = stack.pop() as number;
    if (y < 0 || y >= height) continue;

    let x = x1;
    if (inside(x, y)) {
      while (x > 0 && inside(x - 1, y)) {
        set(x - 1, y);
        x--;
      }
      if (x < x1) stack.push(x, x1 - 1, y - dy, -dy);
    }
    while (x1 <= x2) {
      while (x1 < width && inside(x1, y)) {
        set(x1, y);
        x1++;
      }
      if (x1 > x) stack.push(x, x1 - 1, y + dy, dy);
      if (x1 - 1 > x2) stack.push(x2 + 1, x1 - 1, y - dy, -dy);
      x1++;
      while (x1 < x2 && !inside(x1, y)) x1++;
      x = x1;
    }
  }

  return { width, height, data: mask, bounds: boundsOf(mask, width, height) };
}
