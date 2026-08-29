import { useEffect, useRef, useState } from "react";

import { markFor, progressOf } from "../audio/positions";
import { useAudioMarks } from "../audio/use-player";
import * as ipc from "../ipc";
import { isTextual, routeOf } from "../preview/route";
import { peek, subscribe, thumbPx } from "../thumbs";
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
  const want = thumbPx(size);
  // Only files are routed by name. A folder called `assets.css` is not a
  // stylesheet, and whatever it has to show is worth showing at any size.
  const isFile = entry.kind === "file";
  const route = routeOf(entry.name);
  const worthIt = !isFile || size >= TEXT_FLOOR || !isTextual(route);
  // A shortcut's thumbnail is a rounded icon on transparency, not a rectangular
  // picture. It has to carry its own corners and its own shadow.
  const alpha = isFile && route === "link";
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
          className={`thumb-img${alpha ? " art-alpha" : ""}`}
          src={ipc.fileSrc(src)}
          alt=""
          draggable={false}
          // Keep image decoding off the thread that's handling the scroll.
          decoding="async"
        />
      ) : (
        <FileGlyph entry={entry} size={size} />
      )}
      {isFile && route === "audio" && <Heard path={entry.path} size={size} />}
    </div>
  );
}

/**
 * How much of this recording has been heard, drawn on its icon.
 *
 * The one thing a folder of forty chapters can't tell you by looking, and the
 * thing you most want to know: which ones are done. Cheap enough to be
 * unconditional — only audio files subscribe, and the marks store changes at
 * most once every ten seconds, against the player's four times a second.
 *
 * Two shapes, because 22px in a list row and 128px in the grid are different
 * problems. Small gets a dot, which is legible as "something" at any size;
 * large gets the bar, which is legible as "this much".
 */
function Heard({ path, size }: { path: string; size: number }) {
  const marks = useAudioMarks();
  const progress = progressOf(markFor(marks, path));
  if (progress === null || progress <= 0) return null;
  const done = progress >= 1;
  if (size < 40) {
    return <span className={`heard-dot${done ? " done" : ""}`} aria-hidden="true" />;
  }
  return (
    <span className={`heard-bar${done ? " done" : ""}`} aria-hidden="true">
      <span style={{ width: `${Math.round(progress * 100)}%` }} />
    </span>
  );
}
