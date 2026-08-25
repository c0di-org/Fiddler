/** Things drawn on top of a picture, rather than into it.
 *
 * A rectangle round the thing you are pointing at, an arrow, a line of text, a
 * highlighter over a sentence, a finger-drawn ring. They are kept as a list of
 * shapes in *unit* coordinates — 0 to 1 across whatever they sit on — and drawn
 * at whatever size that thing happens to be right now.
 *
 * That is what makes this the piece the PDF reader can share. A rectangle at
 * (0.2, 0.3) is the same rectangle over a 600-pixel preview, a 4,000-pixel
 * export, and a rasterised page of a document — so highlighting a sentence in a
 * PDF and circling something in a screenshot are one implementation rather than
 * two that drift.
 *
 * Nothing here touches the DOM or a file. It takes a canvas context and draws.
 */

export type ShapeKind = "rect" | "ellipse" | "line" | "arrow" | "ink" | "text";

export interface Shape {
  id: string;
  kind: ShapeKind;
  /** Corners for the box-ish kinds, the two ends for a line or arrow. Unit
   * coordinates, and deliberately not normalised: a line drawn right-to-left
   * has to keep its direction or its arrowhead ends up at the wrong end. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Freehand only: the path, unit coordinates, already smoothed. */
  points?: number[];
  /** Text only. */
  text?: string;
  /** Text size as a fraction of the picture's height, so it scales with it. */
  fontScale?: number;
  stroke: string | null;
  fill: string | null;
  /** Stroke width as a fraction of the picture's smaller side, for the same
   * reason the font size is: a 3-pixel line on a preview is a 3-pixel line on
   * the export, which is to say invisible. */
  width: number;
}

/** A highlighter is not a translucent pen. Alpha along a single stroke has to
 * be constant or crossing your own line leaves a dark knot where it crossed, so
 * the ink goes down opaque into a scratch layer and the layer is composited
 * once. `multiply` is what makes it read as ink on paper rather than paint. */
export const HIGHLIGHT_ALPHA = 0.4;

export function isHighlighter(shape: Shape): boolean {
  return shape.kind === "ink" && shape.fill === "highlight";
}

/** How far in unit coordinates a tap may miss and still count as a hit. Scaled
 * by the display size at the call site, because a finger's slack is measured in
 * millimetres on the glass, not in fractions of a photograph. */
export const HIT_SLACK = 0.02;

export interface DrawContext {
  width: number;
  height: number;
}

/** Draw the whole list. `selected` gets handles; pass null when exporting, so
 * that what is saved is the picture rather than the editor. */
export function drawShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  box: DrawContext,
  selected: string | null = null
) {
  for (const shape of shapes) {
    ctx.save();
    if (isHighlighter(shape)) {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.globalCompositeOperation = "multiply";
    }
    drawOne(ctx, shape, box);
    ctx.restore();
  }
  if (selected) {
    const shape = shapes.find((s) => s.id === selected);
    if (shape) drawHandles(ctx, shape, box);
  }
}

function strokeWidth(shape: Shape, box: DrawContext): number {
  return Math.max(1, shape.width * Math.min(box.width, box.height));
}

function drawOne(ctx: CanvasRenderingContext2D, shape: Shape, box: DrawContext) {
  const x0 = shape.x0 * box.width;
  const y0 = shape.y0 * box.height;
  const x1 = shape.x1 * box.width;
  const y1 = shape.y1 * box.height;
  const w = strokeWidth(shape, box);

  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = shape.stroke ?? "transparent";
  ctx.fillStyle = shape.fill && shape.fill !== "highlight" ? shape.fill : "transparent";

  switch (shape.kind) {
    case "rect": {
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0);
      const rh = Math.abs(y1 - y0);
      if (shape.fill) { ctx.fillRect(rx, ry, rw, rh); }
      if (shape.stroke) ctx.strokeRect(rx, ry, rw, rh);
      break;
    }
    case "ellipse": {
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      if (shape.fill) ctx.fill();
      if (shape.stroke) ctx.stroke();
      break;
    }
    case "line": {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      break;
    }
    case "arrow": {
      // The head is sized off the stroke rather than off the line's length, so
      // a long arrow and a short one look like the same pen.
      const head = Math.max(w * 3.2, 6);
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const back = head * 0.8;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 - Math.cos(angle) * back, y1 - Math.sin(angle) * back);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - Math.cos(angle - 0.42) * head, y1 - Math.sin(angle - 0.42) * head);
      ctx.lineTo(x1 - Math.cos(angle + 0.42) * head, y1 - Math.sin(angle + 0.42) * head);
      ctx.closePath();
      ctx.fillStyle = shape.stroke ?? "transparent";
      ctx.fill();
      break;
    }
    case "ink": {
      const pts = shape.points ?? [];
      if (pts.length < 4) {
        // A tap with the pen is a dot, not nothing.
        if (pts.length === 2) {
          ctx.beginPath();
          ctx.arc(pts[0] * box.width, pts[1] * box.height, w / 2, 0, Math.PI * 2);
          ctx.fillStyle = shape.stroke ?? "transparent";
          ctx.fill();
        }
        break;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0] * box.width, pts[1] * box.height);
      // Quadratic through the midpoints: the cheapest smoothing that turns a
      // touchscreen's jitter into something that looks drawn rather than
      // sampled, and it needs no lookahead.
      for (let i = 2; i < pts.length - 2; i += 2) {
        const cx = pts[i] * box.width;
        const cy = pts[i + 1] * box.height;
        const mx = (cx + pts[i + 2] * box.width) / 2;
        const my = (cy + pts[i + 3] * box.height) / 2;
        ctx.quadraticCurveTo(cx, cy, mx, my);
      }
      ctx.lineTo(pts[pts.length - 2] * box.width, pts[pts.length - 1] * box.height);
      ctx.stroke();
      break;
    }
    case "text": {
      const size = Math.max(8, (shape.fontScale ?? 0.05) * box.height);
      ctx.font = `600 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = "top";
      const lines = (shape.text ?? "").split("\n");
      const lineHeight = size * 1.25;
      if (shape.fill && shape.fill !== "highlight") {
        const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
        const pad = size * 0.3;
        ctx.fillRect(x0 - pad, y0 - pad, widest + pad * 2, lines.length * lineHeight + pad * 2);
      }
      ctx.fillStyle = shape.stroke ?? "#000";
      lines.forEach((line, i) => ctx.fillText(line, x0, y0 + i * lineHeight));
      break;
    }
  }
}

/** The bounding box of a shape, in unit coordinates. Selection, hit-testing and
 * the handles all want it, and a freehand stroke is the only one that has to
 * work for it. */
export function boundsOfShape(shape: Shape): { x: number; y: number; width: number; height: number } {
  if (shape.kind === "ink" && shape.points && shape.points.length >= 2) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < shape.points.length; i += 2) {
      minX = Math.min(minX, shape.points[i]);
      maxX = Math.max(maxX, shape.points[i]);
      minY = Math.min(minY, shape.points[i + 1]);
      maxY = Math.max(maxY, shape.points[i + 1]);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  return {
    x: Math.min(shape.x0, shape.x1),
    y: Math.min(shape.y0, shape.y1),
    width: Math.abs(shape.x1 - shape.x0),
    height: Math.abs(shape.y1 - shape.y0),
  };
}

/** The topmost shape under a point, or null. Later shapes are on top, so this
 * walks backwards — the thing you just drew is the thing you meant to grab. */
export function hitTest(shapes: Shape[], x: number, y: number, slack = HIT_SLACK): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const b = boundsOfShape(shapes[i]);
    if (
      x >= b.x - slack &&
      x <= b.x + b.width + slack &&
      y >= b.y - slack &&
      y <= b.y + b.height + slack
    ) {
      return shapes[i];
    }
  }
  return null;
}

/** Move a shape, points and all. */
export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  return {
    ...shape,
    x0: shape.x0 + dx,
    y0: shape.y0 + dy,
    x1: shape.x1 + dx,
    y1: shape.y1 + dy,
    points: shape.points?.map((n, i) => n + (i % 2 === 0 ? dx : dy)),
  };
}

/**
 * A shape's coordinates rewritten for a picture that has been cropped.
 *
 * Markup drawn before a crop has to stay where it was drawn *on the picture*,
 * which means its numbers have to change when the picture's frame does. The
 * alternative — flattening markup into the pixels the moment anything else
 * happens — is what makes other editors' annotations un-editable five seconds
 * after you draw them.
 */
export function reframeShape(
  shape: Shape,
  crop: { x: number; y: number; width: number; height: number }
): Shape {
  const fx = (n: number) => (n - crop.x) / crop.width;
  const fy = (n: number) => (n - crop.y) / crop.height;
  return {
    ...shape,
    x0: fx(shape.x0),
    y0: fy(shape.y0),
    x1: fx(shape.x1),
    y1: fy(shape.y1),
    points: shape.points?.map((n, i) => (i % 2 === 0 ? fx(n) : fy(n))),
  };
}

/** The same, for a turn or a mirror of the picture underneath. */
export function reorientShape(shape: Shape, rotation: 0 | 90 | 180 | 270, flip: "x" | "y" | null): Shape {
  const map = (x: number, y: number): [number, number] => {
    let [u, v] = [x, y];
    if (rotation === 90) [u, v] = [1 - v, u];
    else if (rotation === 180) [u, v] = [1 - u, 1 - v];
    else if (rotation === 270) [u, v] = [v, 1 - u];
    if (flip === "x") u = 1 - u;
    if (flip === "y") v = 1 - v;
    return [u, v];
  };
  const [nx0, ny0] = map(shape.x0, shape.y0);
  const [nx1, ny1] = map(shape.x1, shape.y1);
  const points: number[] = [];
  for (let i = 0; i < (shape.points?.length ?? 0); i += 2) {
    const [px, py] = map(shape.points![i], shape.points![i + 1]);
    points.push(px, py);
  }
  return { ...shape, x0: nx0, y0: ny0, x1: nx1, y1: ny1, points: shape.points ? points : undefined };
}

function drawHandles(ctx: CanvasRenderingContext2D, shape: Shape, box: DrawContext) {
  const b = boundsOfShape(shape);
  const x = b.x * box.width;
  const y = b.y * box.height;
  const w = b.width * box.width;
  const h = b.height * box.height;
  const pad = 4;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.strokeRect(x - pad - 1, y - pad - 1, w + pad * 2 + 2, h + pad * 2 + 2);
  ctx.restore();
}

/** Points close enough together to be noise are dropped as they arrive, which
 * keeps a long stroke from becoming a thousand-number array that has to be
 * re-drawn every frame. */
export function shouldRecordPoint(points: number[], x: number, y: number, minStep: number): boolean {
  if (points.length < 2) return true;
  const dx = x - points[points.length - 2];
  const dy = y - points[points.length - 1];
  return dx * dx + dy * dy >= minStep * minStep;
}
