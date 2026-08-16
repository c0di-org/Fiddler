import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import {
  clampImagePan,
  clampImageZoom,
  fittedImageSize,
  pinchImage,
  zoomImageAround,
  type Point,
  type Size,
} from "../preview/image-zoom";
import "./ZoomableImage.css";

interface Props {
  src: string;
  alt?: string;
  /** Lets Quick Look lazily ask for a more detailed render after the first zoom. */
  onZoomChange?: (zoom: number) => void;
}

type Gesture =
  | { kind: "pan"; pointer: number; start: Point; startPan: Point }
  | {
      kind: "pinch";
      startDistance: number;
      startMidpoint: Point;
      startZoom: number;
      startPan: Point;
    };

const EMPTY_SIZE: Size = { width: 0, height: 0 };
const ZERO: Point = { x: 0, y: 0 };
const ZOOM_STEP = 1.4;

/**
 * A fit-first image surface that becomes a canvas only when asked.
 *
 * Pointer events give us one implementation for mouse, pen and touch. A single
 * pointer pans once zoomed; two pointers pinch around their moving midpoint.
 * Wheel zoom is anchored under the cursor so inspecting a small detail does not
 * make it run away from the pointer.
 */
export function ZoomableImage({ src, alt = "", onZoomChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef<Point>(ZERO);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>(ZERO);
  const [hostSize, setHostSize] = useState<Size>(EMPTY_SIZE);
  const [fitted, setFitted] = useState<Size>(EMPTY_SIZE);

  const setView = useCallback((nextZoom: number, nextPan: Point) => {
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  }, []);

  const measure = useCallback(() => {
    const el = host.current;
    const img = image.current;
    if (!el || !img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
    const nextHost = { width: el.clientWidth, height: el.clientHeight };
    const nextFitted = fittedImageSize(nextHost, {
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
    setHostSize(nextHost);
    setFitted(nextFitted);
    const nextPan = clampImagePan(panRef.current, zoomRef.current, nextHost, nextFitted);
    if (nextPan.x !== panRef.current.x || nextPan.y !== panRef.current.y) {
      setView(zoomRef.current, nextPan);
    }
  }, [setView]);

  useEffect(() => {
    setView(1, ZERO);
    pointers.current.clear();
    gesture.current = null;
  }, [src, setView]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => onZoomChange?.(zoom), [zoom, onZoomChange]);

  const pointFromClient = useCallback((clientX: number, clientY: number): Point => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect) return ZERO;
    return {
      x: clientX - (rect.left + rect.width / 2),
      y: clientY - (rect.top + rect.height / 2),
    };
  }, []);

  const zoomAt = useCallback(
    (wanted: number, anchor: Point = ZERO) => {
      const result = zoomImageAround(
        panRef.current,
        zoomRef.current,
        wanted,
        anchor,
        hostSize,
        fitted
      );
      setView(result.zoom, result.pan);
    },
    [fitted, hostSize, setView]
  );

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(zoomRef.current * factor, pointFromClient(event.clientX, event.clientY));
  };

  const beginPinch = useCallback(() => {
    const points = [...pointers.current.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    gesture.current = {
      kind: "pinch",
      startDistance: distance(a, b),
      startMidpoint: midpoint(a, b),
      startZoom: zoomRef.current,
      startPan: panRef.current,
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    host.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromClient(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);

    if (pointers.current.size >= 2) {
      beginPinch();
    } else if (zoomRef.current > 1) {
      gesture.current = {
        kind: "pan",
        pointer: event.pointerId,
        start: point,
        startPan: panRef.current,
      };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    event.preventDefault();
    const point = pointFromClient(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    const active = gesture.current;

    if (active?.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const startDistance = Math.max(1, active.startDistance);
      const wanted = clampImageZoom(active.startZoom * (distance(a, b) / startDistance));
      const result = pinchImage(
        active.startPan,
        active.startZoom,
        wanted,
        active.startMidpoint,
        midpoint(a, b),
        hostSize,
        fitted
      );
      setView(result.zoom, result.pan);
      return;
    }

    if (active?.kind === "pan" && active.pointer === event.pointerId && zoomRef.current > 1) {
      const next = clampImagePan(
        {
          x: active.startPan.x + point.x - active.start.x,
          y: active.startPan.y + point.y - active.start.y,
        },
        zoomRef.current,
        hostSize,
        fitted
      );
      setView(zoomRef.current, next);
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (pointers.current.size >= 2) {
      beginPinch();
      return;
    }
    const remaining = [...pointers.current.entries()][0];
    if (remaining && zoomRef.current > 1) {
      gesture.current = {
        kind: "pan",
        pointer: remaining[0],
        start: remaining[1],
        startPan: panRef.current,
      };
    } else {
      gesture.current = null;
    }
  };

  const toggleZoom = (event: ReactPointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
    const wanted = zoomRef.current > 1.05 ? 1 : 2;
    zoomAt(wanted, pointFromClient(event.clientX, event.clientY));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      event.stopPropagation();
      zoomAt(zoomRef.current * ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      event.stopPropagation();
      zoomAt(zoomRef.current / ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      event.stopPropagation();
      zoomAt(1);
    }
  };

  const percent = Math.round(zoom * 100);

  return (
    <div
      ref={host}
      className={`zoom-image${zoom > 1.01 ? " zoom-image--zoomed" : ""}`}
      tabIndex={0}
      aria-label="Image preview"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={toggleZoom}
      onKeyDown={onKeyDown}
    >
      <img
        ref={image}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={measure}
        style={{
          width: fitted.width || undefined,
          height: fitted.height || undefined,
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
        }}
      />
      <div className="zoom-image-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => zoomAt(zoomRef.current / ZOOM_STEP)} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="zoom-image-level" onClick={() => zoomAt(1)} aria-label="Fit image">
          {zoom <= 1.01 ? "Fit" : `${percent}%`}
        </button>
        <button type="button" onClick={() => zoomAt(zoomRef.current * ZOOM_STEP)} aria-label="Zoom in">
          +
        </button>
      </div>
    </div>
  );
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
