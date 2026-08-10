import { useEffect, useMemo, useRef, useState } from "react";

import * as ipc from "../ipc";
import type { PdfMeta } from "../types";

/**
 * A PDF, a page at a time.
 *
 * Each page is rasterised at the size it will actually occupy — so the text is
 * sharp rather than a stretched thumbnail — and lands in the same on-disk cache
 * as every other preview, which is what makes going back a page instant. The
 * page after the one being read is fetched in the background as soon as the
 * current one arrives, so paging forward through a document never waits.
 *
 * The previous page stays on screen until the next one is decoded. Blanking
 * first would be honest about the work but reads as a flicker.
 */

/** Render sizes are snapped so that resizing the window mostly reuses the cache. */
const STEPS = [512, 768, 1024, 1400, 1800, 2400];

interface Props {
  path: string;
  /** Page changes are driven from the viewer's keyboard handling. */
  page: number;
  onPages: (pages: number) => void;
}

export function PdfView({ path, page, onPages }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState<PdfMeta | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 900, h: 700 });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setError(null);
    setMeta(null);
    ipc
      .pdfMeta(path)
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        onPages(m.pages);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path, onPages]);

  // Ask for the longest side in device pixels, rounded up to a shared step.
  const maxPx = useMemo(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const want = Math.max(box.w, box.h) * dpr;
    return STEPS.find((s) => s >= want) ?? STEPS[STEPS.length - 1];
  }, [box.w, box.h]);

  useEffect(() => {
    if (!meta) return;
    let alive = true;
    ipc
      .pdfPage(path, page, maxPx)
      .then((p) => {
        if (!alive) return;
        setSrc(p);
        // Warm the next page while this one is being read. The result is only
        // wanted in the cache, so nothing is done with it here.
        if (page < meta.pages) void ipc.pdfPage(path, page + 1, maxPx).catch(() => {});
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path, page, maxPx, meta]);

  return (
    <div className="pdf" ref={host}>
      {error ? (
        <div className="preview-none">This PDF couldn’t be rendered</div>
      ) : src ? (
        <img className="pdf-page" src={ipc.fileSrc(src)} alt="" draggable={false} />
      ) : (
        // Hold the page's shape so the frame doesn't jump when it lands.
        <div className="pdf-holding" style={{ aspectRatio: String(meta?.aspect ?? 0.773) }} />
      )}
    </div>
  );
}
