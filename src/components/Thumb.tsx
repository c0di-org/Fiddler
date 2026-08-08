import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as ipc from "../ipc";
import type { Entry } from "../types";
import { FileGlyph } from "./FileGlyph";

/**
 * Lazily-loaded preview. Only files scrolled into view ask the backend for a
 * thumbnail, and each result is remembered for the session so scrolling back is
 * instant. Falls back to a typed glyph whenever there's no meaningful preview.
 */

const memo = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function load(path: string, size: number): Promise<string | null> {
  const key = `${size}:${path}`;
  if (memo.has(key)) return Promise.resolve(memo.get(key)!);

  let p = inflight.get(key);
  if (!p) {
    p = ipc
      .thumbnail(path, size)
      .then((r) => r ?? null)
      .catch(() => null)
      .then((r) => {
        memo.set(key, r);
        inflight.delete(key);
        return r;
      });
    inflight.set(key, p);
  }
  return p;
}

interface Props {
  entry: Entry;
  /** Rendered box size in CSS pixels. */
  size: number;
}

export function Thumb({ entry, size }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(() => {
    const hit = memo.get(`${px(size)}:${entry.path}`);
    return hit ?? null;
  });

  useEffect(() => {
    if (!entry.thumbable || src) return;
    const el = hostRef.current;
    if (!el) return;

    let alive = true;
    const io = new IntersectionObserver(
      (items) => {
        if (!items.some((i) => i.isIntersecting)) return;
        io.disconnect();
        void load(entry.path, px(size)).then((r) => {
          if (alive && r) setSrc(r);
        });
      },
      // Start a little before the tile is on screen so it's ready on arrival.
      { rootMargin: "220px" }
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [entry.path, entry.thumbable, size, src]);

  return (
    <div className="thumb" ref={hostRef} style={{ width: size, height: size }}>
      {src ? (
        <img className="thumb-img" src={convertFileSrc(src)} alt="" draggable={false} />
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
