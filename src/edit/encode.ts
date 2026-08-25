/** Choosing a format, and hitting a file size.
 *
 * The format question is smaller than it looks and gets asked at exactly one
 * moment — when someone presses Save — so the rules live here rather than being
 * spread across the toolbar.
 */

import { planForTarget, type Plan } from "./budget.ts";
import { exportSize, type EditDoc } from "./doc.ts";
import { renderAtScale, renderExport, type Source } from "./render.ts";

export type Format = "jpeg" | "png" | "webp";

export const FORMATS: Format[] = ["jpeg", "png", "webp"];

const MIME: Record<Format, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const EXTENSION: Record<Format, string> = { jpeg: "jpg", png: "png", webp: "webp" };

/** Which formats can hold the hole the wand punched. A JPEG cannot, and saying
 * so before the save rather than after is the difference between a choice and a
 * surprise. */
export function keepsTransparency(format: Format): boolean {
  return format !== "jpeg";
}

/** Whether the encoder has a quality knob at all. PNG does not, which means a
 * file-size target on a PNG can only be met by making the picture smaller — and
 * it will have to make it a lot smaller. */
export function hasQuality(format: Format): boolean {
  return format !== "png";
}

export function mimeOf(format: Format): string {
  return MIME[format];
}

/** The format a file already is, so that Save a Copy of a JPEG is a JPEG.
 * Anything the browser cannot write — HEIC, raw, TIFF — becomes a PNG, which is
 * the only lossless thing every target can encode. */
export function formatOf(name: string): Format {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg" || ext === "jpe") return "jpeg";
  if (ext === "webp") return "webp";
  return "png";
}

/** `photo.heic` saved as a PNG has to become `photo.png`, or the file lies
 * about itself and nothing will open it. */
export function renameFor(name: string, format: Format): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${EXTENSION[format]}`;
}

export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  format: Format,
  quality: number
): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, MIME[format], hasQuality(format) ? quality : undefined)
  );
  if (!blob) throw new Error(`This device could not write a ${format.toUpperCase()}`);
  return blob;
}

export interface Encoded {
  blob: Blob;
  width: number;
  height: number;
  /** Present only when a file-size target was being chased. */
  plan?: Plan;
}

/** A straight save at the picture's own size. */
export async function encodeDoc(
  source: Source,
  doc: EditDoc,
  format: Format,
  quality: number,
  matte: string | null
): Promise<Encoded> {
  const canvas = renderExport(source, doc, matte);
  return { blob: await encodeCanvas(canvas, format, quality), width: canvas.width, height: canvas.height };
}

/**
 * A save that has to come in under a size.
 *
 * The search in `budget.ts` does the deciding; this is what connects it to real
 * pixels. Each probe is a real render at a real scale followed by a real
 * encode, because the alternative — modelling how this picture compresses — is
 * wrong by an order of magnitude between a screenshot and a photograph of
 * leaves.
 *
 * The winning settings are then re-rendered rather than remembered from the
 * probe, which costs one more encode and means the bytes that reach the disk
 * are the bytes that were measured, not a second attempt at them.
 */
export async function encodeToFit(
  source: Source,
  doc: EditDoc,
  format: Format,
  targetBytes: number,
  matte: string | null,
  onProbe?: (n: number) => void
): Promise<Encoded> {
  let probes = 0;
  const plan = await planForTarget(
    exportSize(doc),
    targetBytes,
    async (scale, quality) => {
      onProbe?.(++probes);
      const canvas = renderAtScale(source, doc, scale, matte);
      const blob = await encodeCanvas(canvas, format, quality);
      // Let the frame breathe: a dozen encodes back to back on a phone is long
      // enough that a progress line which never repaints is worse than none.
      //
      // Deliberately a timer and not `requestAnimationFrame`. A browser that
      // isn't painting — an occluded window, a backgrounded app — stops firing
      // rAF entirely, and a search that yields to it then never takes its next
      // probe. The symptom is a save that sits on "Trying settings… (1)"
      // forever, which is precisely what happened the first time this ran.
      await new Promise((r) => setTimeout(r, 0));
      return blob.size;
    },
    // PNG has no quality to spend, so the search must go straight to trading
    // pixels rather than bisecting a knob that does nothing.
    hasQuality(format) ? {} : { maxQuality: 1, floorQuality: 1, scaleQuality: 1 }
  );

  const canvas = renderAtScale(source, doc, plan.scale, matte);
  const blob = await encodeCanvas(canvas, format, plan.quality);
  return { blob, width: canvas.width, height: canvas.height, plan };
}

/** Sizes the "fit into" field offers. Round numbers people are actually given
 * as limits, rather than powers of two. */
export const SIZE_PRESETS = [
  { label: "500 KB", bytes: 500 * 1024 },
  { label: "1 MB", bytes: 1024 * 1024 },
  { label: "2 MB", bytes: 2 * 1024 * 1024 },
  { label: "5 MB", bytes: 5 * 1024 * 1024 },
  { label: "10 MB", bytes: 10 * 1024 * 1024 },
];

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
