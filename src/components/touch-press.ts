import { useRef, useState } from "react";

import type { Favorite } from "../types";

/**
 * The long press: one gesture, two endings.
 *
 * A pointer has three verbs — click to choose, double-click to open,
 * right-click for everything else. A finger, until now, had one: tap opened,
 * and that was the whole vocabulary. Which meant a selection could never
 * survive under a finger, and every verb in Fiddler needs a selection. Copy,
 * Move, Rename, Trash, Share — the whole list was keyboard-only on a phone.
 *
 * So: hold still for `HOLD_MS` and the item is **taken**. That moment is the
 * gesture; a haptic tick and a selection say so while the finger is still
 * down. What happens after depends on what the finger does next:
 *
 *   - lift        → the selection stands, and taps now toggle rather than open
 *   - move        → it becomes a drag, for the things that can be dragged
 *
 * Movement *before* the threshold is a scroll and cancels the whole thing,
 * which is what lets this live on every cell of a scrolling grid.
 */
export interface FolderTouchDragHandlers {
  onStart: (folder: Favorite, x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onEnd: (x: number, y: number) => void;
  onCancel: () => void;
}

/**
 * Android's own long-press threshold is 500ms and the platform's muscle memory
 * is calibrated to it. The old 280 was fine when the only outcome was a drag
 * that the finger then had to travel to complete — as the trigger for a
 * selection it would fire on a merely unhurried tap, which is the one mistake
 * this gesture cannot afford to make.
 */
const HOLD_MS = 500;
/** Past this, the finger is scrolling and never meant to press at all. */
const CANCEL_DISTANCE = 10;
/** How far past the press a click may still arrive and need swallowing. */
const CLICK_GRACE_MS = 700;

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** The hold completed: this item is taken, whatever happens next. */
  landed: boolean;
  /** ...and the finger then moved, so it is a drag. */
  dragging: boolean;
  timer: number;
  source: HTMLElement;
}

/**
 * The click a completed press is about to produce, cancelled.
 *
 * `pointerup` is followed by a synthetic `click`, and the views open a file on
 * click. Without this, every long press would select an item and then
 * immediately open it — the exact behaviour the press exists to escape.
 * Capturing on `window` catches it before any handler in the tree, and the
 * timeout is for the press that ends over nothing and produces no click at all.
 */
function swallowNextClick() {
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, true), CLICK_GRACE_MS);
}

/** A short tick at the moment the press lands, which is what makes a long press
 * feel like something the app did rather than something it noticed. Absent on
 * desktop browsers and on iOS, where the call is simply not there. */
function tick() {
  navigator.vibrate?.(12);
}

export interface TouchPressOptions {
  /** The press landed. The item is taken; the host decides what that means. */
  onPress?: () => void;
  /** Where a press that then moves goes. Only folders have somewhere to go. */
  folder?: Favorite | null;
  drag?: FolderTouchDragHandlers;
}

export function useTouchPress({ onPress, folder = null, drag }: TouchPressOptions) {
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);

  const clear = (cancel = false) => {
    const active = gesture.current;
    if (!active) return;
    window.clearTimeout(active.timer);
    if (active.source.hasPointerCapture(active.pointerId)) {
      active.source.releasePointerCapture(active.pointerId);
    }
    const wasDragging = active.dragging;
    gesture.current = null;
    setDragging(false);
    if (cancel && wasDragging) drag?.onCancel();
  };

  return {
    dragging,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      if (!onPress && !(folder && drag)) return;
      const source = event.currentTarget;
      const active: Gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        landed: false,
        dragging: false,
        timer: 0,
        source,
      };
      active.timer = window.setTimeout(() => {
        if (gesture.current !== active) return;
        active.landed = true;
        tick();
        onPress?.();
        // Captured now rather than on the first move: the finger is already
        // down, and a capture taken mid-drag misses the moves that started it.
        if (folder && drag) {
          source.setPointerCapture(active.pointerId);
          setDragging(true);
          active.dragging = true;
          drag.onStart(folder, active.startX, active.startY);
        }
      }, HOLD_MS);
      gesture.current = active;
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (!active.landed) {
        // Still inside the hold: any real movement is a scroll, and the whole
        // gesture goes rather than becoming a press the finger has left behind.
        if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > CANCEL_DISTANCE) {
          clear();
        }
        return;
      }
      if (!active.dragging) return;
      event.preventDefault();
      drag?.onMove(event.clientX, event.clientY);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const { landed, dragging: wasDragging } = active;
      clear();
      if (!landed) return;
      // The press already did its work when it landed; all that is left is to
      // stop the tap that would otherwise follow it into the file.
      event.preventDefault();
      swallowNextClick();
      if (wasDragging) drag?.onEnd(event.clientX, event.clientY);
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (active?.pointerId !== event.pointerId) return;
      const landed = active.landed;
      clear(true);
      if (landed) swallowNextClick();
    },
  };
}
