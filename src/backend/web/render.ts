/** Turning a file into a picture of itself, in a tab.
 *
 * The desktop build has four worker lanes and ImageIO behind it. Here there are
 * three things a browser can actually do — decode an image it already
 * understands, draw text onto a canvas, and rasterise a PDF page once pdf.js
 * has been fetched — and one honest answer for everything else: `null`, which
 * the UI already knows means "no preview" and caches as such. */

import { LINK_MARKS, parseShortcut, type LinkKind } from "../../preview/link";
import { routeOf } from "../../preview/route";
import { readBlob } from "./vfs";

/** Formats every target browser decodes. Deliberately narrower than
 * `route.ts`'s `IMAGE` set, which includes HEIC, PSD and camera raw — macOS
 * decodes those, we don't, and claiming otherwise just produces empty tiles. */
const WEB_IMAGE = new Set([
  "png", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "avif", "bmp", "ico", "svg",
]);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** Whether a tile is worth asking about at all — this becomes `Entry.thumbable`,
 * so getting it wrong means either blank tiles or work that never pays off. */
export function canThumb(name: string): boolean {
  if (WEB_IMAGE.has(extensionOf(name))) return true;
  const route = routeOf(name);
  return (
    route === "markdown" ||
    route === "code" ||
    route === "text" ||
    route === "pdf" ||
    route === "link"
  );
}

/** How many decodes run at once. Enough to keep a scrolling grid filling in,
 * few enough that a folder of large photos doesn't starve the main thread. */
export const MAX_CONCURRENT = 4;

export async function render(path: string, name: string, size: number): Promise<Blob | null> {
  const ext = extensionOf(name);
  if (WEB_IMAGE.has(ext)) return rasterise(await readBlob(path), size, ext === "svg");

  const route = routeOf(name);
  if (route === "pdf") return renderPdfCover(path, size);
  if (route === "link") return renderShortcut(path, size);
  if (route === "markdown" || route === "code" || route === "text") return renderText(path, size);
  return null;
}

// ------------------------------------------------------------------ images

async function rasterise(blob: Blob, size: number, isSvg: boolean): Promise<Blob | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();

    // An SVG with no intrinsic size reports 0×0; give it a square to draw into
    // rather than dividing by zero and producing nothing.
    const sw = img.naturalWidth || (isSvg ? size : 0);
    const sh = img.naturalHeight || (isSvg ? size : 0);
    if (sw === 0 || sh === 0) return null;

    const scale = Math.min(size / sw, size / sh, 1);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return toBlob(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --------------------------------------------------------------- shortcuts

/** Per-destination tile colours. Android's is its own green; the rest are the
 * neutral, slightly cool greys a download button tends to live on. */
const LINK_TILE: Record<LinkKind, [string, string]> = {
  repo: ["#2b3138", "#171b21"],
  macos: ["#5b626e", "#2b3038"],
  android: ["#3ddc84", "#1f9d5b"],
  web: ["#4a8fe7", "#2a5fb4"],
};

/** A shortcut looks like where it goes. Built as an SVG string and pushed
 * through the same rasteriser as any other image, so there is one code path
 * from "picture" to "tile". */
async function renderShortcut(path: string, size: number): Promise<Blob | null> {
  const blob = await readBlob(path);
  if (blob.size > 64 * 1024) return null;
  const shortcut = parseShortcut(await blob.text());
  if (!shortcut) return null;

  const [from, to] = LINK_TILE[shortcut.kind];
  // The mark is drawn on a 16-unit grid; 48 gives it a comfortable margin
  // inside a 96-unit tile.
  const marks = LINK_MARKS[shortcut.kind]
    .map((d) => `<path d="${d}"/>`)
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="t" x1="0" y1="0" x2="0.4" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="96" height="96" rx="20" fill="url(#t)"/>` +
    `<g transform="translate(24 24) scale(3)" fill="none" stroke="#ffffff" ` +
    `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${marks}</g>` +
    `</svg>`;

  return rasterise(new Blob([svg], { type: "image/svg+xml" }), size, true);
}

// -------------------------------------------------------------------- text

/** Roughly a page of text, drawn small. Not legible at tile sizes, and not
 * meant to be — what it carries is shape: indentation, blank lines, how long
 * the lines run. That's enough to tell a JSON blob from a README at a glance,
 * which is the whole job of a thumbnail. */
async function renderText(path: string, size: number): Promise<Blob | null> {
  const blob = await readBlob(path);
  const head = new Uint8Array(await blob.slice(0, 16 * 1024).arrayBuffer());
  if (head.includes(0)) return null;
  const text = new TextDecoder("utf-8").decode(head, { stream: true });
  if (text.trim().length === 0) return null;

  // Page proportions, so a text tile reads as a document next to a square photo.
  const w = Math.max(1, Math.round(size * 0.773));
  const h = size;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const pad = Math.max(2, Math.round(w * 0.08));
  const lineHeight = Math.max(1.5, h / 46);
  const fontSize = lineHeight * 0.78;
  ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#33373d";

  const lines = text.split("\n", 48);
  const maxWidth = w - pad * 2;
  for (let i = 0; i < lines.length; i++) {
    const y = pad + i * lineHeight;
    if (y + lineHeight > h - pad) break;
    // Tabs would otherwise collapse to nothing at this size, taking the
    // indentation — the most legible signal here — with them.
    const line = lines[i].replace(/\t/g, "  ").replace(/\r$/, "");
    if (line.trim().length === 0) continue;
    ctx.fillText(line, pad, y, maxWidth);
  }

  return toBlob(canvas);
}

// --------------------------------------------------------------------- pdf

async function renderPdfCover(path: string, size: number): Promise<Blob | null> {
  try {
    const { renderPage } = await import("./pdf");
    return await renderPage(path, 1, size);
  } catch {
    return null;
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
