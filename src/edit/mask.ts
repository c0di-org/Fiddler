/** A selection, and the pixels it covers.
 *
 * Every tool that selects — the wand, the rectangle, the lasso if one ever
 * arrives — produces one of these, and every verb that acts on a selection —
 * crop, delete, fill — takes one. Keeping the two ends apart behind a single
 * byte-per-pixel buffer is what stops "crop to the rectangle" and "crop to what
 * the wand found" from being two different pieces of code.
 *
 * The coverage byte is deliberately not a flag: feathering and anti-aliased
 * edges are the difference between a cut-out that looks made and one that looks
 * cut, and a boolean mask cannot express either.
 */

export interface Mask {
  width: number;
  height: number;
  /** 0 = outside, 255 = fully selected, between = partial coverage. */
  data: Uint8Array;
  /** Tight bounds of everything non-zero, in pixels. `null` when nothing is
   * selected — which is a real answer the callers act on, not an error. */
  bounds: Bounds | null;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function emptyMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height), bounds: null };
}

/** The bounds of everything selected. Computed by scanning rather than tracked
 * during the fill, because every producer would otherwise have to remember to
 * maintain it and one of them eventually wouldn't. */
export function boundsOf(data: Uint8Array, width: number, height: number): Bounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** A rectangle as a selection, clamped to the canvas. The rectangle tool and
 * "select all" are both this. */
export function rectMask(width: number, height: number, rect: Bounds): Mask {
  const x0 = Math.max(0, Math.min(width, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(height, Math.round(rect.y)));
  const x1 = Math.max(x0, Math.min(width, Math.round(rect.x + rect.width)));
  const y1 = Math.max(y0, Math.min(height, Math.round(rect.y + rect.height)));

  const data = new Uint8Array(width * height);
  for (let y = y0; y < y1; y++) data.fill(255, y * width + x0, y * width + x1);

  const w = x1 - x0;
  const h = y1 - y0;
  return { width, height, data, bounds: w > 0 && h > 0 ? { x: x0, y: y0, width: w, height: h } : null };
}

export type Combine = "replace" | "add" | "subtract" | "intersect";

/** Shift-click adds, ⌥-click subtracts — the two-modifier grammar every editor
 * shares, done once here rather than inside each tool. */
export function combine(base: Mask, next: Mask, how: Combine): Mask {
  if (how === "replace") return next;
  const data = new Uint8Array(base.data.length);
  for (let i = 0; i < data.length; i++) {
    const a = base.data[i];
    const b = next.data[i];
    data[i] = how === "add" ? Math.max(a, b) : how === "subtract" ? Math.max(0, a - b) : Math.min(a, b);
  }
  return { width: base.width, height: base.height, data, bounds: boundsOf(data, base.width, base.height) };
}

/** How many pixels are selected at all. The status line's number, and the
 * cheapest way for a caller to ask "is there a selection?". */
export function coverage(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] !== 0) n++;
  return n;
}
