/** PDF rasterisation, standing in for `page.rs` and Core Graphics.
 *
 * pdf.js is by far the largest thing in this build, so nothing imports it
 * statically: `render.ts` and `web.ts` both reach it through `await import()`,
 * which leaves it in its own chunk that is only fetched when someone actually
 * looks at a PDF. */

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import type { PdfMeta } from "../../types";
import { readBlob } from "./vfs";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Parsing a document is the expensive half, and `PdfView` pages through one
 * document at a time while prefetching the next page. Holding the most recent
 * few means paging is a render, not a re-parse. */
const DOC_CAP = 3;

/** The loading task is kept alongside the document because tearing one down —
 * which also stops its worker — goes through the task, not the proxy. */
interface Open {
  task: PDFDocumentLoadingTask;
  doc: PDFDocumentProxy;
}

const docs = new Map<string, Promise<Open>>();

function openDoc(path: string): Promise<Open> {
  const hit = docs.get(path);
  if (hit) return hit;

  const opening = (async (): Promise<Open> => {
    const blob = await readBlob(path);
    const data = new Uint8Array(await blob.arrayBuffer());
    const task = pdfjs.getDocument({ data });
    return { task, doc: await task.promise };
  })();

  docs.set(path, opening);
  // A document that fails to open must not be remembered as a rejected promise
  // forever — the file may simply have been mid-write.
  void opening.catch(() => docs.delete(path));

  while (docs.size > DOC_CAP) {
    const oldest = docs.keys().next();
    if (oldest.done || oldest.value === path) break;
    forget(oldest.value);
  }
  return opening;
}

/** Drops a cached document, stopping its worker. A saved-over PDF must not keep
 * rendering the file it used to be. */
export function forget(path: string) {
  const open = docs.get(path);
  if (!open) return;
  docs.delete(path);
  void open.then(({ task }) => task.destroy()).catch(() => {});
}

export async function meta(path: string): Promise<PdfMeta> {
  const { doc } = await openDoc(path);
  const page = await doc.getPage(1);
  const view = page.getViewport({ scale: 1 });
  return { pages: doc.numPages, aspect: view.width / view.height };
}

/** One page, fitted to `maxPx` on its longest side. */
export async function renderPage(
  path: string,
  page: number,
  maxPx: number
): Promise<Blob | null> {
  const { doc } = await openDoc(path);
  if (page < 1 || page > doc.numPages) return null;

  const target = await doc.getPage(page);
  const base = target.getViewport({ scale: 1 });
  const view = target.getViewport({ scale: maxPx / Math.max(base.width, base.height) });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(view.width));
  canvas.height = Math.max(1, Math.round(view.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Pages are composited onto white rather than transparency: a PDF page is
  // paper, and an unpainted background would read as a hole against a dark UI.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await target.render({ canvas, canvasContext: ctx, viewport: view }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
