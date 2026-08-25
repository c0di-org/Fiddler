/** Turning an edit back into pixels.
 *
 * Every drawing path in the editor comes through here, and they all take the
 * output size as an argument: the preview asks for the size of the window, the
 * export asks for the size of the picture, and the "fit into 2 MB" search asks
 * for a dozen different sizes in a row. None of them is privileged, and none of
 * them is derived from another — which is why what gets saved is made from the
 * original file rather than from the thing that was on screen.
 */

import { cropToSourceRect, orientTransform } from "./geometry.ts";
import { drawShapes, type Shape } from "./markup.ts";
import { exportSize, type EditDoc, type MaskStep } from "./doc.ts";
import type { Mask } from "./mask.ts";

/** Anything `drawImage` accepts and that has a size we can ask for. */
export type Source = CanvasImageSource & { width: number; height: number };

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * The picture, oriented, cropped and with the wand's holes in it — everything
 * except the markup.
 *
 * The context is left with an identity transform on the way out, because the
 * two callers that draw shapes afterwards would otherwise inherit a rotation.
 */
export function drawPicture(
  ctx: CanvasRenderingContext2D,
  source: Source,
  doc: EditDoc,
  width: number,
  height: number
) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const sr = cropToSourceRect(doc.crop, doc.orientation);
  const sx = sr.x * doc.sourceWidth;
  const sy = sr.y * doc.sourceHeight;
  const sw = Math.max(1, sr.width * doc.sourceWidth);
  const sh = Math.max(1, sr.height * doc.sourceHeight);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // `orientTransform` maps a box of the sub-image's own size onto the output
  // box, so the sub-image is drawn at its natural size inside that transform
  // and the transform does the scaling.
  const t = orientTransform(doc.orientation, sw, sh, width, height);
  ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  for (const step of doc.masks) applyMask(ctx, step, width, height);
  ctx.restore();
}

function applyMask(
  ctx: CanvasRenderingContext2D,
  step: MaskStep,
  width: number,
  height: number
) {
  const image = step.mask.source as CanvasImageSource | null;
  if (!image) return;
  const x = step.frame.x * width;
  const y = step.frame.y * height;
  const w = step.frame.width * width;
  const h = step.frame.height * height;
  ctx.save();
  // A hole is punched with the mask's own alpha; a patch is simply drawn,
  // because the colour was baked into the mask when the step was made. Which
  // means both are one `drawImage` and neither needs a scratch canvas.
  ctx.globalCompositeOperation = step.kind === "erase" ? "destination-out" : "source-over";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, x, y, w, h);
  ctx.restore();
}

/** The picture with its markup on top: what the preview shows and what gets
 * saved. `selected` draws handles and must be null for an export. */
export function drawAll(
  ctx: CanvasRenderingContext2D,
  source: Source,
  doc: EditDoc,
  width: number,
  height: number,
  selected: string | null = null
) {
  drawPicture(ctx, source, doc, width, height);
  drawShapes(ctx, doc.shapes, { width, height }, selected);
}

/**
 * The picture at the size it will be saved, on a fresh canvas.
 *
 * `matte` is for the formats with no alpha channel: a JPEG cannot hold the hole
 * the wand punched, and a canvas's transparent pixels encode to black, so
 * saving a cut-out as a JPEG without this produces a photograph with a black
 * shape in it and no warning. White is the colour people expect there; the UI
 * offers the choice and says why.
 */
export function renderExport(source: Source, doc: EditDoc, matte: string | null): HTMLCanvasElement {
  const size = exportSize(doc);
  const canvas = makeCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This device could not provide a canvas to save into");
  if (matte) {
    ctx.fillStyle = matte;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  drawAll(ctx, source, doc, canvas.width, canvas.height, null);
  return canvas;
}

/** The same at an arbitrary scale, for the "fit into a file size" search, which
 * needs the real picture at a dozen sizes and never shows any of them. */
export function renderAtScale(
  source: Source,
  doc: EditDoc,
  scale: number,
  matte: string | null
): HTMLCanvasElement {
  const size = exportSize(doc);
  const canvas = makeCanvas(Math.max(1, size.width * scale), Math.max(1, size.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This device could not provide a canvas to save into");
  if (matte) {
    ctx.fillStyle = matte;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  drawAll(ctx, source, doc, canvas.width, canvas.height, null);
  return canvas;
}

// ------------------------------------------------------------------ masks

/**
 * A selection, turned into something `drawImage` can use.
 *
 * White where the mask covers for a hole, the chosen colour for a patch, with
 * the mask's coverage as the alpha — so a feathered edge stays feathered
 * through both. Trimmed to the selection's bounds rather than kept at full
 * size, which for the usual case (a wand on a background) is the difference
 * between a canvas the size of the photograph and one the size of the thing
 * selected.
 */
export function maskToCanvas(mask: Mask, colour: string | null): HTMLCanvasElement | null {
  const b = mask.bounds;
  if (!b) return null;
  const canvas = makeCanvas(b.width, b.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const rgb = colour ? parseColour(colour) : [255, 255, 255];
  const image = ctx.createImageData(b.width, b.height);
  const out = image.data;
  for (let y = 0; y < b.height; y++) {
    const from = (y + b.y) * mask.width + b.x;
    const to = y * b.width * 4;
    for (let x = 0; x < b.width; x++) {
      const i = to + x * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = mask.data[from + x];
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** `#rrggbb` to bytes. Deliberately narrow: the only colours that reach this
 * are the ones the editor's own palette offers. */
function parseColour(colour: string): [number, number, number] {
  const hex = colour.replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

/**
 * The edge of a selection, as a canvas to lay over the picture.
 *
 * Marching ants were the obvious thing and are the wrong thing here. A
 * permanently crawling dashed line is an accessibility problem that has to be
 * turned off for reduced motion, at which point the selection has no visible
 * boundary at all for exactly the people who most needed one. A tinted fill
 * with a hard outline says the same thing, holds still, reads on a phone, and
 * needs no preference to respect.
 */
export function selectionOverlay(mask: Mask, tint: string): HTMLCanvasElement | null {
  if (!mask.bounds) return null;
  const canvas = makeCanvas(mask.width, mask.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const [r, g, b] = parseColour(tint);
  const image = ctx.createImageData(mask.width, mask.height);
  const out = image.data;
  const { width, height, data } = mask;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const here = data[p] !== 0;
      if (!here) continue;
      // A boundary pixel is one with a neighbour outside — including the
      // canvas edge, so a selection running off the side is still outlined.
      const edge =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        data[p - 1] === 0 || data[p + 1] === 0 ||
        data[p - width] === 0 || data[p + width] === 0;
      const i = p * 4;
      out[i] = edge ? 255 : r;
      out[i + 1] = edge ? 255 : g;
      out[i + 2] = edge ? 255 : b;
      out[i + 3] = edge ? 235 : 70;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Read the pixels of a picture at a given size, for the wand to work on. */
export function samplePixels(
  source: Source,
  doc: EditDoc,
  width: number,
  height: number
): ImageData | null {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  drawPicture(ctx, source, doc, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Shapes drawn alone on a transparent canvas — used by nothing yet, and the
 * seam the PDF reader will need when its markup has to become a layer over a
 * page rather than part of a photograph. */
export function renderShapesOnly(shapes: Shape[], width: number, height: number): HTMLCanvasElement {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (ctx) drawShapes(ctx, shapes, { width, height }, null);
  return canvas;
}
