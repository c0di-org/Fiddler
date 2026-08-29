import { useCallback, useRef, useState } from "react";

import { clock } from "../audio/time";

/**
 * The timeline, dragged.
 *
 * A native `<input type="range">` would be less code and the wrong control:
 * it has no notion of a buffered region, its thumb is a fixed size that can't
 * grow under a finger, and on Android its track is a system-themed line that
 * ignores everything around it. This is the one place in Fiddler worth
 * hand-rolling a slider for, because on a phone it is a four-hour book being
 * addressed with a thumb.
 *
 * The value shown while dragging is local. Committing on every move would send
 * the decoder chasing a hundred seeks across a long file, and on Android that
 * is audible as a stutter that lasts as long as the drag.
 */
interface Props {
  at: number;
  duration: number;
  onSeek: (seconds: number) => void;
  /** Taller track and a visible knob — the full-screen player. */
  large?: boolean;
  /** Keyboard steps, which are the skip buttons' intervals. */
  step?: number;
  label?: string;
}

export function Scrubber({ at, duration, onSeek, large, step = 15, label = "Position" }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? at;
  const known = duration > 0;
  const fraction = known ? Math.min(1, Math.max(0, value / duration)) : 0;

  const positionFrom = useCallback(
    (clientX: number) => {
      const box = trackRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || duration <= 0) return null;
      return Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * duration;
    },
    [duration]
  );

  return (
    <div
      className={`scrubber${large ? " scrubber-large" : ""}${dragging !== null ? " scrubbing" : ""}`}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${clock(value)} of ${clock(duration)}`}
      tabIndex={known ? 0 : -1}
      onKeyDown={(e) => {
        if (!known) return;
        if (e.key === "ArrowRight") onSeek(Math.min(duration, at + step));
        else if (e.key === "ArrowLeft") onSeek(Math.max(0, at - step));
        else if (e.key === "Home") onSeek(0);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (!known || e.button !== 0) return;
        const to = positionFrom(e.clientX);
        if (to === null) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        setDragging(to);
      }}
      onPointerMove={(e) => {
        if (dragging === null) return;
        const to = positionFrom(e.clientX);
        if (to !== null) setDragging(to);
      }}
      onPointerUp={(e) => {
        if (dragging === null) return;
        const to = positionFrom(e.clientX) ?? dragging;
        setDragging(null);
        e.currentTarget.releasePointerCapture(e.pointerId);
        onSeek(to);
      }}
      onPointerCancel={() => setDragging(null)}
    >
      <div className="scrubber-track" ref={trackRef}>
        <div className="scrubber-fill" style={{ width: `${fraction * 100}%` }} />
        <div className="scrubber-knob" style={{ left: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}
