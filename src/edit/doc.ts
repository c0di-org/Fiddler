/** An edit, as a description of itself.
 *
 * Nothing here holds pixels. An edit is a quarter-turn count, two mirror flags,
 * a crop rectangle, a list of holes punched in the picture, a list of shapes
 * drawn on it, and optionally a size to come out at. The pixels are produced
 * from that on demand, by `render.ts`.
 *
 * Which is the whole reason for the shape. The preview on screen is six hundred
 * pixels wide because that is what the window has; the file that gets saved is
 * four thousand, made from the original bytes rather than from the preview. The
 * two are the same description rendered twice. An editor that mutates a buffer
 * instead can only ever save you what it was showing you.
 *
 * The one exception is a mask — the wand's selection, punched out or filled in.
 * That genuinely is pixels, and it is kept at the resolution the wand ran at
 * and scaled up when it is used. Scaling a mask up softens its edge, which for
 * a cut-out is not a defect: it is the feathering a hard mask would need adding
 * anyway.
 */

import {
  clampUnit,
  composeCrop,
  FULL,
  mirror,
  outputSize,
  turn,
  turnRect,
  UPRIGHT,
  type Orientation,
  type Rotation,
  type UnitRect,
} from "./geometry.ts";
import { reframeShape, reorientShape, type Shape } from "./markup.ts";

/** A hole in the picture, or a patch of colour on it. The mask is a canvas —
 * one channel would do, but a canvas is what both the wand's output and the
 * renderer's input want, and converting twice to save three bytes a pixel is
 * not a trade worth making on the platform where it matters. */
export interface MaskStep {
  id: string;
  /** `erase` takes the pixels away, leaving transparency; `fill` replaces them. */
  kind: "erase" | "fill";
  /** Unit coordinates of the *cropped, oriented* picture, so it survives a
   * later crop the same way markup does. */
  frame: UnitRect;
  colour?: string;
  /** Coverage, 0–255 per pixel, at whatever size the wand ran at. */
  mask: MaskImage;
}

/** Just enough of a canvas to draw from, declared here so this module and its
 * tests never need a DOM. */
export interface MaskImage {
  width: number;
  height: number;
  /** The thing `drawImage` will be given. */
  source: unknown;
}

export interface EditDoc {
  /** The file this came from, and its real pixel size. */
  path: string;
  name: string;
  sourceWidth: number;
  sourceHeight: number;
  orientation: Orientation;
  crop: UnitRect;
  masks: MaskStep[];
  shapes: Shape[];
  /** An explicit output size, when someone has asked for one. Null means "the
   * size the crop makes it". */
  resize: { width: number; height: number } | null;
}

export function newDoc(path: string, name: string, width: number, height: number): EditDoc {
  return {
    path,
    name,
    sourceWidth: width,
    sourceHeight: height,
    orientation: UPRIGHT,
    crop: FULL,
    masks: [],
    shapes: [],
    resize: null,
  };
}

/** Whether anything at all has been done. What decides between "Close" and
 * "Discard changes?", and whether Save has anything to save. */
export function isEdited(doc: EditDoc): boolean {
  return (
    doc.orientation.rotation !== 0 ||
    doc.orientation.flipX ||
    doc.orientation.flipY ||
    doc.crop.width < 1 ||
    doc.crop.height < 1 ||
    doc.masks.length > 0 ||
    doc.shapes.length > 0 ||
    doc.resize !== null
  );
}

/** The size the picture is right now, before any explicit resize. */
export function naturalSize(doc: EditDoc): { width: number; height: number } {
  return outputSize(doc.sourceWidth, doc.sourceHeight, doc.orientation, doc.crop);
}

/** The size it will be saved at. */
export function exportSize(doc: EditDoc): { width: number; height: number } {
  return doc.resize ?? naturalSize(doc);
}

// --------------------------------------------------------------- the verbs
//
// Each returns a new document. Turning and cropping both move the ground under
// anything already drawn on the picture, so each is responsible for bringing
// the markup and the masks with it — which is the part that would otherwise be
// forgotten at one of the four call sites.

export function rotate(doc: EditDoc, quarters: number): EditDoc {
  const rotation = turn(doc.orientation.rotation, quarters) as Rotation;
  const step = (((quarters % 4) + 4) % 4) * 90 as Rotation;
  // The crop is expressed in the oriented frame, so it turns with it.
  const crop = turnRect(doc.crop, step);
  return {
    ...doc,
    orientation: { ...doc.orientation, rotation },
    crop,
    shapes: doc.shapes.map((s) => reorientShape(s, step, null)),
    masks: doc.masks.map((m) => ({ ...m, frame: turnRect(m.frame, step) })),
  };
}

export function flip(doc: EditDoc, axis: "x" | "y"): EditDoc {
  return {
    ...doc,
    orientation: mirror(doc.orientation, axis),
    crop: flipRect(doc.crop, axis),
    shapes: doc.shapes.map((s) => reorientShape(s, 0, axis)),
    masks: doc.masks.map((m) => ({ ...m, frame: flipRect(m.frame, axis) })),
  };
}

/** `rect` is in unit coordinates of what is on screen now. */
export function crop(doc: EditDoc, rect: UnitRect): EditDoc {
  const next = clampUnit(rect);
  if (next.width <= 0 || next.height <= 0) return doc;
  return {
    ...doc,
    crop: composeCrop(doc.crop, next),
    shapes: doc.shapes.map((s) => reframeShape(s, next)),
    masks: doc.masks.map((m) => ({ ...m, frame: reframeRect(m.frame, next) })),
    // A crop changes the natural size, so an explicit one no longer means what
    // it meant when it was typed.
    resize: null,
  };
}

export function uncrop(doc: EditDoc): EditDoc {
  // Undo is the way back to a previous crop; this is the way back to none,
  // which is a different and much rarer wish. Markup that was reframed by the
  // crop is left alone rather than un-reframed — the arithmetic is invertible
  // but the intent is not: a mark drawn on the cropped picture belongs to what
  // it was drawn on.
  return { ...doc, crop: FULL, resize: null };
}

export function resizeTo(doc: EditDoc, width: number, height: number): EditDoc {
  return {
    ...doc,
    resize: { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) },
  };
}

export function clearResize(doc: EditDoc): EditDoc {
  return { ...doc, resize: null };
}

export function addMask(doc: EditDoc, step: MaskStep): EditDoc {
  return { ...doc, masks: [...doc.masks, step] };
}

export function addShape(doc: EditDoc, shape: Shape): EditDoc {
  return { ...doc, shapes: [...doc.shapes, shape] };
}

export function replaceShape(doc: EditDoc, shape: Shape): EditDoc {
  return { ...doc, shapes: doc.shapes.map((s) => (s.id === shape.id ? shape : s)) };
}

export function removeShape(doc: EditDoc, id: string): EditDoc {
  return { ...doc, shapes: doc.shapes.filter((s) => s.id !== id) };
}

// ------------------------------------------------------------- rectangles

function flipRect(rect: UnitRect, axis: "x" | "y"): UnitRect {
  return axis === "x"
    ? { ...rect, x: 1 - rect.x - rect.width }
    : { ...rect, y: 1 - rect.y - rect.height };
}

function reframeRect(rect: UnitRect, crop: UnitRect): UnitRect {
  return {
    x: (rect.x - crop.x) / crop.width,
    y: (rect.y - crop.y) / crop.height,
    width: rect.width / crop.width,
    height: rect.height / crop.height,
  };
}

// -------------------------------------------------------------------- undo

/** Twenty deep, in memory, gone when the editor closes — the same bargain
 * `undo.ts` strikes for the file browser, and for the same reason: a stack that
 * survives a quit is a promise about a file that may not have survived it.
 *
 * Snapshots rather than inverses, because a document is a handful of numbers
 * and some shared references. The masks inside it are never mutated, so twenty
 * snapshots hold one copy of each mask between them, not twenty. */
export const HISTORY_CAP = 20;

export interface History {
  past: EditDoc[];
  present: EditDoc;
}

export function begin(doc: EditDoc): History {
  return { past: [], present: doc };
}

export function commit(history: History, next: EditDoc): History {
  if (next === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_CAP),
    present: next,
  };
}

/**
 * Change what is on screen without recording a step.
 *
 * What a drag does between the press and the release. A freehand stroke fires a
 * pointer event every few milliseconds, and recording each one turns a single
 * gesture into two hundred history entries — so the stack, which is twenty
 * deep, holds nothing but the last fifth of one line, and ⌘Z walks backwards
 * through it a point at a time instead of removing the stroke.
 *
 * The step is recorded once, on the press, describing the state before the
 * gesture. Everything after that revises.
 */
export function revise(history: History, next: EditDoc): History {
  return { past: history.past, present: next };
}

export function undo(history: History): History {
  if (history.past.length === 0) return history;
  return { past: history.past.slice(0, -1), present: history.past[history.past.length - 1] };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}
