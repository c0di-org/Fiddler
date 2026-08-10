import { useRef, useState } from "react";

import type { Favorite } from "../types";

/** The touch equivalent of HTML drag-and-drop, which Android WebView omits. */
export interface FolderTouchDragHandlers {
  onStart: (folder: Favorite, x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onEnd: (x: number, y: number) => void;
  onCancel: () => void;
}

const HOLD_MS = 280;
const CANCEL_DISTANCE = 10;

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  timer: number;
  source: HTMLElement;
}

/**
 * Starts a folder drag after a short hold so an ordinary swipe can continue to
 * scroll. Android WebView renders a native-looking drag for `draggable`, but
 * does not consistently send drag-over/drop events to the page.
 */
export function useFolderTouchDrag(folder: Favorite | null, handlers?: FolderTouchDragHandlers) {
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);

  const clear = (cancel = false) => {
    const active = gesture.current;
    if (!active) return;
    window.clearTimeout(active.timer);
    if (active.source.hasPointerCapture(active.pointerId)) active.source.releasePointerCapture(active.pointerId);
    gesture.current = null;
    setDragging(false);
    if (cancel) handlers?.onCancel();
  };

  return {
    dragging,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (!folder || !handlers || event.pointerType !== "touch" || !event.isPrimary) return;
      const source = event.currentTarget;
      const active: Gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        timer: 0,
        source,
      };
      active.timer = window.setTimeout(() => {
        if (gesture.current !== active) return;
        active.dragging = true;
        source.setPointerCapture(active.pointerId);
        setDragging(true);
        handlers.onStart(folder, active.startX, active.startY);
      }, HOLD_MS);
      gesture.current = active;
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (!active.dragging) {
        if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > CANCEL_DISTANCE) clear();
        return;
      }
      event.preventDefault();
      handlers?.onMove(event.clientX, event.clientY);
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const wasDragging = active.dragging;
      clear();
      if (wasDragging) {
        event.preventDefault();
        handlers?.onEnd(event.clientX, event.clientY);
      }
    },
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => {
      const active = gesture.current;
      if (active?.pointerId === event.pointerId) clear(true);
    },
  };
}
