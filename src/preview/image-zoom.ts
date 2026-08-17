export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_IMAGE_ZOOM = 1;
export const MAX_IMAGE_ZOOM = 8;

export function clampImageZoom(zoom: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, zoom));
}

/**
 * The size an image occupies before the interactive transform is applied.
 * Small images keep their natural size; large ones shrink just enough to fit.
 */
export function fittedImageSize(host: Size, image: Size): Size {
  if (host.width <= 0 || host.height <= 0 || image.width <= 0 || image.height <= 0) {
    return { width: 0, height: 0 };
  }
  const fit = Math.min(1, host.width / image.width, host.height / image.height);
  return { width: image.width * fit, height: image.height * fit };
}

/** Keep a transformed image covering the viewport where it is larger than it. */
export function clampImagePan(pan: Point, zoom: number, host: Size, fitted: Size): Point {
  if (zoom <= MIN_IMAGE_ZOOM) return { x: 0, y: 0 };
  const maxX = Math.max(0, (fitted.width * zoom - host.width) / 2);
  const maxY = Math.max(0, (fitted.height * zoom - host.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

/**
 * Change zoom while keeping the image point under `anchor` under the same
 * finger/cursor. `anchor` is measured from the centre of the viewport.
 */
export function zoomImageAround(
  pan: Point,
  fromZoom: number,
  toZoom: number,
  anchor: Point,
  host: Size,
  fitted: Size
): { zoom: number; pan: Point } {
  const zoom = clampImageZoom(toZoom);
  if (zoom === MIN_IMAGE_ZOOM) return { zoom, pan: { x: 0, y: 0 } };
  const ratio = zoom / Math.max(MIN_IMAGE_ZOOM, fromZoom);
  const next = {
    x: anchor.x - (anchor.x - pan.x) * ratio,
    y: anchor.y - (anchor.y - pan.y) * ratio,
  };
  return { zoom, pan: clampImagePan(next, zoom, host, fitted) };
}

/** The same anchored transform as zoomImageAround, with a moving pinch centre. */
export function pinchImage(
  startPan: Point,
  startZoom: number,
  nextZoom: number,
  startMidpoint: Point,
  nextMidpoint: Point,
  host: Size,
  fitted: Size
): { zoom: number; pan: Point } {
  const zoom = clampImageZoom(nextZoom);
  if (zoom === MIN_IMAGE_ZOOM) return { zoom, pan: { x: 0, y: 0 } };
  const ratio = zoom / Math.max(MIN_IMAGE_ZOOM, startZoom);
  const next = {
    x: nextMidpoint.x - (startMidpoint.x - startPan.x) * ratio,
    y: nextMidpoint.y - (startMidpoint.y - startPan.y) * ratio,
  };
  return { zoom, pan: clampImagePan(next, zoom, host, fitted) };
}
