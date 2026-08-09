import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { isTextual, routeOf } from "../preview/route";
import { peek, subscribe } from "../thumbs";
import type { Entry } from "../types";
import { FileGlyph } from "./FileGlyph";

/**
 * Lazily-loaded preview. Registering interest is all a tile does; ordering,
 * batching and cancellation all live in the scheduler, which can see the whole
 * viewport at once. Falls back to a typed glyph whenever there's no preview.
 */

interface Props {
  entry: Entry;
  /** Rendered box size in CSS pixels. */
  size: number;
}

/**
 * Below this, a page of text is a grey smudge and the typed glyph says more.
 * Pictures keep their thumbnail at any size — a photo still reads as a photo.
 */
const TEXT_FLOOR = 40;

export function Thumb({ entry, size }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const want = px(size);
  const worthIt = size >= TEXT_FLOOR || !isTextual(routeOf(entry.name));
  const [src, setSrc] = useState<string | null>(() =>
    worthIt ? (peek(entry.path, want) ?? null) : null
  );

  useEffect(() => {
    if (!entry.thumbable || !worthIt) return;
    const el = hostRef.current;
    if (!el) return;
    return subscribe(entry.path, want, el, setSrc);
  }, [entry.path, entry.thumbable, want, worthIt]);

  return (
    <div className="thumb" ref={hostRef} style={{ width: size, height: size }}>
      {src ? (
        <img
          className="thumb-img"
          src={convertFileSrc(src)}
          alt=""
          draggable={false}
          // Keep image decoding off the thread that's handling the scroll.
          decoding="async"
        />
      ) : (
        <FileGlyph entry={entry} size={size} />
      )}
    </div>
  );
}

/** Ask for a device-pixel-accurate thumbnail, snapped so the cache stays shared. */
function px(size: number) {
  const want = size * Math.min(2, window.devicePixelRatio || 1);
  return want <= 64 ? 64 : want <= 128 ? 128 : want <= 256 ? 256 : 512;
}
