import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { confirmDialog } from "../confirm";
import {
  addMask,
  addShape,
  begin,
  canUndo,
  commit,
  crop as cropDoc,
  exportSize,
  flip as flipDoc,
  isEdited,
  naturalSize,
  newDoc,
  removeShape,
  replaceShape,
  revise,
  resizeTo,
  rotate as rotateDoc,
  undo as undoHistory,
  type EditDoc,
  type History,
} from "../edit/doc";
import {
  blobBytes,
  encodeDoc,
  encodeToFit,
  formatOf,
  FORMATS,
  hasQuality,
  keepsTransparency,
  renameFor,
  SIZE_PRESETS,
  type Format,
} from "../edit/encode";
import { clampUnit, rectFromCorners, type UnitRect } from "../edit/geometry";
import { boundsOfShape, hitTest, moveShape, shouldRecordPoint, type Shape, type ShapeKind } from "../edit/markup";
import { combine, coverage, rectMask, type Mask } from "../edit/mask";
import {
  drawAll,
  makeCanvas,
  maskToCanvas,
  samplePixels,
  selectionOverlay,
  type Source,
} from "../edit/render";
import { wandSelect } from "../edit/wand";
import { formatSize } from "../format";
import * as ipc from "../ipc";
import { locationCaps, refusal } from "../location";
import { keyHint, platform } from "../platform";
import type { Volume } from "../types";
import {
  CloseIcon,
  CropIcon,
  EraseIcon,
  FillIcon,
  FlipHIcon,
  FlipVIcon,
  HighlightIcon,
  MarqueeIcon,
  PenIcon,
  PointerIcon,
  ResizeIcon,
  RotateLeftIcon,
  RotateRightIcon,
  SaveIcon,
  ShapesIcon,
  TextIcon,
  UndoIcon,
  WandIcon,
} from "./icons";

/**
 * The picture editor.
 *
 * The shape of it is borrowed from Preview, because Preview got the important
 * thing right: editing a photograph is six or seven verbs, and an application
 * that presents forty is one you open a different application instead of. So
 * there is one strip of tools, one contextual line that changes with the tool,
 * and nothing else on screen but the picture.
 *
 * Three decisions are worth knowing about before reading further.
 *
 * **The document holds no pixels.** `edit/doc.ts` is a description — a turn, a
 * crop, some masks, some shapes — and every pixel on screen is produced from it
 * and the original file. Which means the preview can be six hundred pixels wide
 * because that is what the window has, while the file that gets saved is made
 * at the source's own resolution. An editor that mutates a buffer can only ever
 * save you what it was showing you.
 *
 * **The wand runs twice.** While a finger is down it runs on a small proxy so
 * the selection can follow the drag; when the finger lifts it runs again at the
 * working resolution. A single full-resolution pass would be somewhere around
 * three frames a second on a phone, which is not a drag, it is a series of
 * surprises.
 *
 * **Saving makes a new file.** Fiddler has no version history and its undo dies
 * with the window, so overwriting the original would be the one operation here
 * that cannot be taken back. Save a Copy is what the button does.
 */

/** How many pixels the wand is allowed to think about. Above this the fill
 * stops being instant and the mask stops being worth its memory; below it the
 * upscale to export resolution is soft enough to read as feathering. */
const WORKING_PX = 1_600_000;

/** And what it runs on while a finger is actually moving. */
const PROXY_PX = 480_000;

/** The most a decode is asked for when the webview can't read the file itself —
 * a HEIC from a phone camera, a raw file, a PSD. Matches the ceiling in
 * `thumb_mobile.rs`, which is where the number is really decided. */
const DECODE_MAX = 4096;

/** Colours the tools offer. Small on purpose: a palette with a colour wheel in
 * it is a palette people spend time in. */
const COLOURS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de", "#ffffff", "#111111"];

/** Stroke widths, as a fraction of the picture's short side. */
const WIDTHS = [0.003, 0.006, 0.012, 0.024];

type Tool = "pointer" | "marquee" | "wand" | "pen" | "highlighter" | "shape" | "text";

interface Props {
  path: string;
  name: string;
  /** Mounted volumes, so Save can say up front that this disk is read-only
   * rather than discovering it after twenty minutes of markup. */
  volumes?: Volume[];
  /** Bumped by the host to ask for a close it cannot perform itself — Android's
   * Back. A signal rather than a call, because the unsaved-changes question
   * lives in here and a host that closed the editor would step over it. */
  closeSignal?: number;
  onClose: () => void;
  onSaved: (path: string, name: string) => void;
}

export function ImageEditor({ path, name, volumes = [], closeSignal = 0, onClose, onSaved }: Props) {
  const [source, setSource] = useState<Source | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [tool, setTool] = useState<Tool>("marquee");
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rect");
  const [colour, setColour] = useState(COLOURS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [filled, setFilled] = useState(false);
  const [tolerance, setTolerance] = useState(0.12);
  const [contiguous, setContiguous] = useState(true);
  const [selection, setSelection] = useState<Mask | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "size" | "save">("none");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [textAt, setTextAt] = useState<{ x: number; y: number } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const picRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const doc = history?.present ?? null;
  const parent = useMemo(() => path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/", [path]);
  const at = locationCaps(parent, volumes);
  const writable = at.create;

  // --------------------------------------------------------------- loading

  useEffect(() => {
    let alive = true;
    setSource(null);
    setLoadError(null);
    void loadSource(path)
      .then((loaded) => {
        if (!alive) return;
        setSource(loaded);
        setHistory(begin(newDoc(path, name, loaded.width, loaded.height)));
      })
      .catch((e) => alive && setLoadError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [path, name]);

  // ------------------------------------------------------------- the stage

  const [box, setBox] = useState({ width: 0, height: 0 });

  /** A callback ref rather than an effect over `stageRef`, because the stage is
   * not on screen while the picture is still decoding — the editor is showing a
   * spinner instead. An effect with an empty dependency list runs once, finds
   * no stage, and never looks again, which leaves the picture drawn at a
   * canvas's default 300×150 for the rest of the session. */
  const observer = useRef<ResizeObserver | null>(null);
  const attachStage = useCallback((stage: HTMLDivElement | null) => {
    stageRef.current = stage;
    observer.current?.disconnect();
    if (!stage) return;
    // The *content* box, not the padding box. `clientHeight` includes the
    // stage's padding, and a picture sized to that is a picture whose bottom
    // edge is under the tool strip.
    const style = getComputedStyle(stage);
    setBox({
      width: stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    });
    observer.current = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width, height });
    });
    observer.current.observe(stage);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  /** The size the picture is drawn at: its own shape, fitted to the stage. */
  const view = useMemo(() => {
    if (!doc || box.width < 8 || box.height < 8) return { width: 0, height: 0 };
    const natural = naturalSize(doc);
    const scale = Math.min(box.width / natural.width, box.height / natural.height, 1);
    // Below a certain size the picture is unusable to work on, so a very small
    // one is allowed to grow to fill the stage rather than sitting in the middle
    // as a postage stamp.
    const grow = natural.width < box.width / 2 && natural.height < box.height / 2
      ? Math.min(box.width / natural.width, box.height / natural.height, 4)
      : scale;
    return {
      width: Math.max(1, Math.round(natural.width * grow)),
      height: Math.max(1, Math.round(natural.height * grow)),
    };
  }, [doc, box]);

  /** Redraw the picture whenever the edit or the size changes. Markup rides
   * along, because it is drawn from the same document. */
  useEffect(() => {
    const canvas = picRef.current;
    if (!canvas || !source || !doc || view.width < 1) return;
    canvas.width = view.width;
    canvas.height = view.height;
    const ctx = canvas.getContext("2d");
    if (ctx) drawAll(ctx, source, doc, view.width, view.height, selected);
  }, [source, doc, view, selected]);

  // ------------------------------------------------------- what the wand sees
  //
  // Two buffers: one at the resolution the mask is kept at, and a smaller one
  // that a live drag can afford to re-run on every frame. Both are thrown away
  // and remade whenever the picture underneath changes shape.

  const pixels = useRef<{ full: ImageData | null; proxy: ImageData | null }>({ full: null, proxy: null });
  useEffect(() => {
    pixels.current = { full: null, proxy: null };
  }, [doc?.crop, doc?.orientation, doc?.masks.length]);

  const workingPixels = useCallback(
    (which: "full" | "proxy"): ImageData | null => {
      if (!source || !doc) return null;
      const cached = pixels.current[which];
      if (cached) return cached;
      const natural = naturalSize(doc);
      const budget = which === "full" ? WORKING_PX : PROXY_PX;
      const scale = Math.min(1, Math.sqrt(budget / (natural.width * natural.height)));
      const made = samplePixels(
        source,
        doc,
        Math.max(1, Math.floor(natural.width * scale)),
        Math.max(1, Math.floor(natural.height * scale))
      );
      pixels.current[which] = made;
      return made;
    },
    [source, doc]
  );

  /** Every selection is kept at the full working resolution, whatever produced
   * it, so that the verbs downstream never have to ask which. */
  const selectionSize = useCallback(() => {
    const full = workingPixels("full");
    return full ? { width: full.width, height: full.height } : null;
  }, [workingPixels]);

  // -------------------------------------------------------------- overlays

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || view.width < 1) return;
    canvas.width = view.width;
    canvas.height = view.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, view.width, view.height);
    if (selection) {
      const tint = selectionOverlay(selection, "#0a84ff");
      if (tint) ctx.drawImage(tint, 0, 0, view.width, view.height);
    }
  }, [selection, view]);

  // ------------------------------------------------------------- the verbs

  /** A step, recorded. */
  const apply = useCallback((fn: (d: EditDoc) => EditDoc) => {
    setHistory((h) => (h ? commit(h, fn(h.present)) : h));
  }, []);

  /** The same change, not recorded — for the middle of a drag. The step was
   * recorded on the press; every pointer event after it revises. */
  const live = useCallback((fn: (d: EditDoc) => EditDoc) => {
    setHistory((h) => (h ? revise(h, fn(h.present)) : h));
  }, []);

  /** Anything that changes the picture's frame invalidates a selection made on
   * the old one — silently keeping it would put the hole somewhere else. */
  const applyAndClear = useCallback(
    (fn: (d: EditDoc) => EditDoc) => {
      apply(fn);
      setSelection(null);
      setSelected(null);
    },
    [apply]
  );

  const cropToSelection = useCallback(() => {
    if (!doc || !selection?.bounds) return;
    const b = selection.bounds;
    applyAndClear((d) =>
      cropDoc(d, {
        x: b.x / selection.width,
        y: b.y / selection.height,
        width: b.width / selection.width,
        height: b.height / selection.height,
      })
    );
  }, [doc, selection, applyAndClear]);

  const punchSelection = useCallback(
    (kind: "erase" | "fill") => {
      if (!doc || !selection?.bounds) return;
      const canvas = maskToCanvas(selection, kind === "fill" ? colour : null);
      if (!canvas) return;
      const b = selection.bounds;
      applyAndClear((d) =>
        addMask(d, {
          id: freshId(),
          kind,
          colour: kind === "fill" ? colour : undefined,
          frame: {
            x: b.x / selection.width,
            y: b.y / selection.height,
            width: b.width / selection.width,
            height: b.height / selection.height,
          },
          mask: { width: canvas.width, height: canvas.height, source: canvas },
        })
      );
    },
    [doc, selection, colour, applyAndClear]
  );

  const selectAll = useCallback(() => {
    const size = selectionSize();
    if (!size) return;
    setSelection(rectMask(size.width, size.height, { x: 0, y: 0, width: size.width, height: size.height }));
  }, [selectionSize]);

  // -------------------------------------------------------------- pointers

  const drag = useRef<Drag | null>(null);

  const pointAt = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const canvas = picRef.current;
      if (!canvas) return null;
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    },
    []
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!doc || busy) return;
    const at = pointAt(e);
    if (!at) return;

    if (tool === "text") {
      // Two things must not happen here, and both were found the hard way.
      //
      // The press must not take the focus. The field below auto-focuses the
      // moment it mounts, and the default action of the press then moves focus
      // onto the canvas a tick later — which fires the field's blur, which
      // closes it again. The symptom is a text tool that does nothing at all,
      // with no error anywhere, because every individual part of it worked.
      //
      // And the canvas must not capture the pointer, or the field never gets
      // it. Hence this branch sitting above the capture rather than below it.
      e.preventDefault();
      setTextAt(at);
      return;
    }

    (e.target as Element).setPointerCapture?.(e.pointerId);

    if (tool === "pointer") {
      const hit = hitTest(doc.shapes, at.x, at.y);
      setSelected(hit?.id ?? null);
      if (hit) {
        drag.current = { kind: "move", id: hit.id, from: at, origin: hit };
        // Replacing the shape with itself is a no-op that is still a new
        // document, which is exactly what "here is where the move started"
        // needs to be for undo to have somewhere to go back to.
        apply((d) => replaceShape(d, hit));
      }
      return;
    }

    if (tool === "wand") {
      const proxy = workingPixels("proxy");
      if (!proxy) return;
      drag.current = { kind: "wand", from: at, base: tolerance, seed: at };
      runWand(at, tolerance, "proxy");
      return;
    }

    if (tool === "marquee") {
      drag.current = { kind: "marquee", from: at, to: at, additive: e.shiftKey, subtractive: e.altKey };
      return;
    }

    if (tool === "pen" || tool === "highlighter") {
      const shape: Shape = {
        id: freshId(),
        kind: "ink",
        x0: at.x,
        y0: at.y,
        x1: at.x,
        y1: at.y,
        points: [at.x, at.y],
        stroke: colour,
        fill: tool === "highlighter" ? "highlight" : null,
        width: tool === "highlighter" ? Math.max(width * 3, 0.02) : width,
      };
      drag.current = { kind: "ink", shape };
      apply((d) => addShape(d, shape));
      return;
    }

    // A shape: created at zero size and grown by the drag, so that letting go
    // without moving leaves nothing behind rather than a dot.
    const shape: Shape = {
      id: freshId(),
      kind: shapeKind,
      x0: at.x,
      y0: at.y,
      x1: at.x,
      y1: at.y,
      stroke: colour,
      fill: filled ? colour : null,
      width,
    };
    drag.current = { kind: "shape", shape };
    apply((d) => addShape(d, shape));
  };

  const frame = useRef(0);
  const onPointerMove = (e: React.PointerEvent) => {
    const current = drag.current;
    if (!current || !doc) return;
    const at = pointAt(e);
    if (!at) return;

    switch (current.kind) {
      case "marquee": {
        current.to = at;
        drawMarquee(overlayRef.current, rectFromCorners(current.from.x, current.from.y, at.x, at.y));
        break;
      }
      case "wand": {
        // Sideways is more reach, back is less — the gesture Preview uses, and
        // the reason there is no tolerance slider to go and find.
        const next = Math.min(1, Math.max(0, current.base + (at.x - current.from.x) * 0.6));
        setTolerance(next);
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => runWand(current.seed, next, "proxy"));
        break;
      }
      case "ink": {
        const points = current.shape.points ?? [];
        if (!shouldRecordPoint(points, at.x, at.y, 0.004)) break;
        points.push(at.x, at.y);
        const grown = { ...current.shape, points: [...points] };
        current.shape = grown;
        live((d) => replaceShape(d, grown));
        break;
      }
      case "shape": {
        const grown = {
          ...current.shape,
          x1: e.shiftKey ? square(current.shape.x0, current.shape.y0, at).x : at.x,
          y1: e.shiftKey ? square(current.shape.x0, current.shape.y0, at).y : at.y,
        };
        current.shape = grown;
        live((d) => replaceShape(d, grown));
        break;
      }
      case "move": {
        const moved = moveShape(current.origin, at.x - current.from.x, at.y - current.from.y);
        live((d) => replaceShape(d, moved));
        break;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    // Release explicitly rather than relying on the implicit release. A capture
    // that outlives its gesture is invisible until the *next* one, which then
    // goes to the wrong element — and on touch that reads as the editor having
    // stopped responding.
    const target = e.target as Element;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);

    const current = drag.current;
    drag.current = null;
    if (!current || !doc) return;

    if (current.kind === "marquee") {
      const size = selectionSize();
      const rect = clampUnit(rectFromCorners(current.from.x, current.from.y, current.to.x, current.to.y));
      if (!size || rect.width < 0.002 || rect.height < 0.002) {
        setSelection(null);
        return;
      }
      const made = rectMask(size.width, size.height, {
        x: rect.x * size.width,
        y: rect.y * size.height,
        width: rect.width * size.width,
        height: rect.height * size.height,
      });
      setSelection((prev) =>
        prev && (current.additive || current.subtractive)
          ? combine(prev, made, current.subtractive ? "subtract" : "add")
          : made
      );
      return;
    }

    if (current.kind === "wand") {
      // The drag was a preview; this is the answer, at the resolution the mask
      // is actually kept at.
      runWand(current.seed, tolerance, "full");
      return;
    }

    if (current.kind === "shape") {
      // A click that never became a drag leaves nothing behind.
      const b = boundsOfShape(current.shape);
      if (b.width < 0.004 && b.height < 0.004) apply((d) => removeShape(d, current.shape.id));
    }
  };

  const runWand = useCallback(
    (seed: { x: number; y: number }, at: number, which: "full" | "proxy") => {
      const px = workingPixels(which);
      const size = selectionSize();
      if (!px || !size) return;
      const found = wandSelect(px, seed.x * px.width, seed.y * px.height, {
        tolerance: at,
        contiguous,
      });
      // Everything downstream expects a mask at the full working size, so a
      // proxy result is stretched rather than special-cased in four places.
      setSelection(px.width === size.width ? found : stretchMask(found, size.width, size.height));
    },
    [workingPixels, selectionSize, contiguous]
  );

  // --------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        if (e.key === "Escape") (target as HTMLInputElement).blur();
        return;
      }
      // Chords match on the lowercased key: with Shift held Chromium reports
      // "N" where WKWebView reports "n", and every Android WebView is Chromium.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && key === "z") { e.preventDefault(); setHistory((h) => (h ? undoHistory(h) : h)); return; }
      if (mod && key === "s") { e.preventDefault(); setPanel("save"); return; }
      if (mod && key === "a") { e.preventDefault(); selectAll(); return; }
      if (mod) return;

      if (key === "Escape") { e.preventDefault(); void askClose(); return; }
      if (key === "Enter" && selection) { e.preventDefault(); cropToSelection(); return; }
      if (key === "Backspace" || key === "Delete") {
        e.preventDefault();
        if (selected) apply((d) => removeShape(d, selected));
        else if (selection) punchSelection("erase");
        return;
      }
      const shortcut: Record<string, Tool> = { v: "pointer", m: "marquee", w: "wand", p: "pen", h: "highlighter", s: "shape", t: "text" };
      if (shortcut[key]) { e.preventDefault(); setTool(shortcut[key]); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, selected, cropToSelection, punchSelection, selectAll, apply]);

  const askClose = useCallback(async () => {
    if (!doc || !isEdited(doc)) {
      onClose();
      return;
    }
    const go = await confirmDialog({
      title: "Discard these edits?",
      detail: "Nothing has been saved yet, and the picture on disk is untouched.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (go) onClose();
  }, [doc, onClose]);

  const closeRef = useRef(askClose);
  closeRef.current = askClose;
  useEffect(() => {
    if (closeSignal > 0) void closeRef.current();
  }, [closeSignal]);

  // ----------------------------------------------------------------- saving

  const save = useCallback(
    async (format: Format, target: number | null, quality: number, matte: string | null) => {
      if (!source || !doc) return;
      setBusy(target ? "Finding the settings…" : "Saving…");
      setNote(null);
      try {
        const encoded = target
          ? await encodeToFit(source, doc, format, target, matte, (n) =>
              setBusy(`Trying settings… (${n})`)
            )
          : await encodeDoc(source, doc, format, quality, matte);

        setBusy("Writing…");
        const wanted = renameFor(name, format);
        const free = await ipc.freeName(parent, wanted);
        const written = await ipc.createFile(parent, free, await blobBytes(encoded.blob));

        // Three different things happened and they are worth three different
        // sentences. "Met the target" and "was already under it" get conflated
        // everywhere, and the conflation reads as the search having done
        // something clever with a number it never touched.
        const where = `${free} — ${encoded.width}×${encoded.height}, ${formatSize(encoded.blob.size, false)}`;
        if (encoded.plan && !encoded.plan.met) {
          setNote(`Saved ${where}. That is the smallest this picture would go.`);
        } else if (encoded.plan?.unchanged) {
          setNote(`Saved ${where} — already under the limit, so nothing was given up.`);
        } else {
          setNote(`Saved ${where}.`);
        }
        setPanel("none");
        onSaved(written, free);
      } catch (e) {
        setNote(String((e as Error)?.message ?? e));
      } finally {
        setBusy(null);
      }
    },
    [source, doc, name, parent, onSaved]
  );

  // ------------------------------------------------------------------ view

  if (loadError) {
    return (
      <div className="image-editor">
        <div className="ed-fail">
          <p>{loadError}</p>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  if (!doc || !source) {
    return (
      <div className="image-editor">
        <div className="ed-fail ed-loading" />
      </div>
    );
  }

  const out = exportSize(doc);
  const selectedPixels = selection ? coverage(selection) : 0;

  return (
    <div className="image-editor" data-tool={tool}>
      <header className="ed-bar">
        <button className="ed-icon" onClick={() => void askClose()} title="Close (Esc)" aria-label="Close">
          <CloseIcon size={15} />
        </button>
        <div className="ed-title">
          <span className="ed-name">{name}</span>
          <span className="ed-sub">
            {out.width} × {out.height}
            {doc.resize && " · resized"}
            {selectedPixels > 0 && ` · ${selectedPixels.toLocaleString()} px selected`}
          </span>
        </div>
        <button
          className="ed-icon"
          onClick={() => setHistory((h) => (h ? undoHistory(h) : h))}
          disabled={!history || !canUndo(history)}
          title={`Undo (${keyHint("⌘Z")})`}
          aria-label="Undo"
        >
          <UndoIcon size={15} />
        </button>
        <button
          className="ed-icon"
          onClick={() => setPanel((p) => (p === "size" ? "none" : "size"))}
          aria-pressed={panel === "size"}
          title="Size…"
          aria-label="Size"
        >
          <ResizeIcon size={15} />
        </button>
        <button
          className="ed-save"
          onClick={() => setPanel((p) => (p === "save" ? "none" : "save"))}
          disabled={!writable}
          title={writable ? `Save a copy (${keyHint("⌘S")})` : refusal(at, "save a copy here")}
        >
          <SaveIcon size={14} />
          Save a copy
        </button>
      </header>

      {/* The line that changes with the tool. One line, never two: an editor
          whose chrome grows as you pick things up is one that ends up mostly
          chrome on a phone. */}
      <div className="ed-context">
        {(tool === "pen" || tool === "highlighter" || tool === "shape" || tool === "text") && (
          <>
            <Swatches value={colour} onPick={setColour} />
            {tool !== "text" && <Widths value={width} onPick={setWidth} />}
            {tool === "shape" && (
              <div className="ed-group">
                {(["rect", "ellipse", "line", "arrow"] as ShapeKind[]).map((k) => (
                  <button
                    key={k}
                    className="ed-chip"
                    aria-pressed={shapeKind === k}
                    onClick={() => setShapeKind(k)}
                  >
                    {SHAPE_LABEL[k]}
                  </button>
                ))}
                <button className="ed-chip" aria-pressed={filled} onClick={() => setFilled((f) => !f)}>
                  Filled
                </button>
              </div>
            )}
          </>
        )}

        {tool === "wand" && (
          <div className="ed-group ed-wand-bar">
            <label className="ed-slider">
              Reach
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(tolerance * 100)}
                onChange={(e) => {
                  const next = Number(e.target.value) / 100;
                  setTolerance(next);
                }}
              />
              <b>{Math.round(tolerance * 100)}</b>
            </label>
            <button className="ed-chip" aria-pressed={contiguous} onClick={() => setContiguous(true)}>
              Touching
            </button>
            <button className="ed-chip" aria-pressed={!contiguous} onClick={() => setContiguous(false)}>
              Everywhere
            </button>
            <span className="ed-hint">Tap the picture, then drag sideways</span>
          </div>
        )}

        {tool === "marquee" && !selection && (
          <span className="ed-hint">Drag a rectangle. Shift adds to it, {keyHint("⌥")} takes away.</span>
        )}

        {selection && (
          <div className="ed-group ed-verbs">
            <button className="ed-chip strong" onClick={cropToSelection}>
              <CropIcon size={13} /> Crop
            </button>
            <button className="ed-chip" onClick={() => punchSelection("erase")}>
              <EraseIcon size={13} /> Delete
            </button>
            <button className="ed-chip" onClick={() => punchSelection("fill")}>
              <FillIcon size={13} /> Fill
            </button>
            <button className="ed-chip" onClick={() => setSelection(null)}>
              Deselect
            </button>
          </div>
        )}

        <div className="ed-group ed-turns">
          <button className="ed-icon" onClick={() => applyAndClear((d) => rotateDoc(d, -1))} title="Turn left" aria-label="Turn left">
            <RotateLeftIcon size={15} />
          </button>
          <button className="ed-icon" onClick={() => applyAndClear((d) => rotateDoc(d, 1))} title="Turn right" aria-label="Turn right">
            <RotateRightIcon size={15} />
          </button>
          <button className="ed-icon" onClick={() => applyAndClear((d) => flipDoc(d, "x"))} title="Mirror" aria-label="Mirror left to right">
            <FlipHIcon size={15} />
          </button>
          <button className="ed-icon" onClick={() => applyAndClear((d) => flipDoc(d, "y"))} title="Flip" aria-label="Flip top to bottom">
            <FlipVIcon size={15} />
          </button>
        </div>
      </div>

      <div
        className="ed-stage"
        ref={attachStage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="ed-paper" style={{ width: view.width, height: view.height }}>
          <canvas ref={picRef} className="ed-pic" />
          <canvas ref={overlayRef} className="ed-overlay" />
          {textAt && (
            <textarea
              ref={textRef}
              className="ed-text-entry"
              autoFocus
              style={{ left: `${textAt.x * 100}%`, top: `${textAt.y * 100}%` }}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value) {
                  apply((d) =>
                    addShape(d, {
                      id: freshId(),
                      kind: "text",
                      x0: textAt.x,
                      y0: textAt.y,
                      x1: textAt.x,
                      y1: textAt.y,
                      text: value,
                      fontScale: 0.05,
                      stroke: colour,
                      fill: null,
                      width: 0,
                    })
                  );
                }
                setTextAt(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.stopPropagation(); setTextAt(null); }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
              }}
            />
          )}
        </div>
      </div>

      <nav className="ed-tools" aria-label="Tools">
        <ToolButton tool="pointer" now={tool} set={setTool} label="Move things" hint="V"><PointerIcon size={17} /></ToolButton>
        <ToolButton tool="marquee" now={tool} set={setTool} label="Select a rectangle" hint="M"><MarqueeIcon size={17} /></ToolButton>
        <ToolButton tool="wand" now={tool} set={setTool} label="Select what looks alike" hint="W"><WandIcon size={17} /></ToolButton>
        <ToolButton tool="shape" now={tool} set={setTool} label="Draw a shape" hint="S"><ShapesIcon size={17} /></ToolButton>
        <ToolButton tool="text" now={tool} set={setTool} label="Add text" hint="T"><TextIcon size={17} /></ToolButton>
        <ToolButton tool="pen" now={tool} set={setTool} label="Draw freehand" hint="P"><PenIcon size={17} /></ToolButton>
        <ToolButton tool="highlighter" now={tool} set={setTool} label="Highlight" hint="H"><HighlightIcon size={17} /></ToolButton>
      </nav>

      {panel === "size" && (
        <SizePanel doc={doc} onApply={(w, h) => { apply((d) => resizeTo(d, w, h)); setPanel("none"); }} onClose={() => setPanel("none")} />
      )}

      {panel === "save" && (
        <SavePanel
          name={name}
          doc={doc}
          onClose={() => setPanel("none")}
          onSave={save}
        />
      )}

      {(busy || note) && (
        <div className="ed-status" role="status">
          {busy ?? note}
          {!busy && note && (
            <button className="ed-chip" onClick={() => setNote(null)}>Dismiss</button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: "Box",
  ellipse: "Oval",
  line: "Line",
  arrow: "Arrow",
  ink: "Ink",
  text: "Text",
};

function ToolButton({
  tool,
  now,
  set,
  label,
  hint,
  children,
}: {
  tool: Tool;
  now: Tool;
  set: (t: Tool) => void;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className="ed-tool"
      aria-pressed={now === tool}
      onClick={() => set(tool)}
      title={`${label} (${hint})`}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className="ed-swatches" role="group" aria-label="Colour">
      {COLOURS.map((c) => (
        <button
          key={c}
          className="ed-swatch"
          style={{ background: c }}
          aria-pressed={value === c}
          aria-label={c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

function Widths({ value, onPick }: { value: number; onPick: (w: number) => void }) {
  return (
    <div className="ed-widths" role="group" aria-label="Thickness">
      {WIDTHS.map((w, i) => (
        <button key={w} className="ed-width" aria-pressed={value === w} aria-label={`Thickness ${i + 1}`} onClick={() => onPick(w)}>
          <i style={{ height: 1 + i * 2.5 }} />
        </button>
      ))}
    </div>
  );
}

/** Dimensions, with the ratio locked unless it is deliberately let go. */
function SizePanel({
  doc,
  onApply,
  onClose,
}: {
  doc: EditDoc;
  onApply: (w: number, h: number) => void;
  onClose: () => void;
}) {
  const natural = naturalSize(doc);
  const current = exportSize(doc);
  const [w, setW] = useState(String(current.width));
  const [h, setH] = useState(String(current.height));
  const [locked, setLocked] = useState(true);
  const ratio = natural.width / natural.height;

  const setWidthField = (value: string) => {
    setW(value);
    const n = Number(value);
    if (locked && n > 0) setH(String(Math.max(1, Math.round(n / ratio))));
  };
  const setHeightField = (value: string) => {
    setH(value);
    const n = Number(value);
    if (locked && n > 0) setW(String(Math.max(1, Math.round(n * ratio))));
  };

  return (
    <div className="ed-panel" role="dialog" aria-label="Size">
      <h3>Size</h3>
      <div className="ed-fields">
        <label>
          Width
          <input type="number" min={1} value={w} onChange={(e) => setWidthField(e.target.value)} />
        </label>
        <label>
          Height
          <input type="number" min={1} value={h} onChange={(e) => setHeightField(e.target.value)} />
        </label>
        <button className="ed-chip" aria-pressed={locked} onClick={() => setLocked((l) => !l)}>
          {locked ? "Ratio locked" : "Ratio free"}
        </button>
      </div>
      <div className="ed-group">
        {[0.75, 0.5, 0.25].map((f) => (
          <button
            key={f}
            className="ed-chip"
            onClick={() => {
              setW(String(Math.max(1, Math.round(natural.width * f))));
              setH(String(Math.max(1, Math.round(natural.height * f))));
            }}
          >
            {f * 100}%
          </button>
        ))}
        <button
          className="ed-chip"
          onClick={() => {
            setW(String(natural.width));
            setH(String(natural.height));
          }}
        >
          Original
        </button>
      </div>
      <p className="ed-note">
        The picture is made again from the original file at whatever size you ask for, so
        enlarging past {natural.width} × {natural.height} is the only thing here that costs
        sharpness.
      </p>
      <footer>
        <button className="ed-chip" onClick={onClose}>Cancel</button>
        <button className="ed-chip strong" onClick={() => onApply(Number(w) || 1, Number(h) || 1)}>
          Set size
        </button>
      </footer>
    </div>
  );
}

/** Format, and the thing this editor exists for: a file size you can name. */
function SavePanel({
  name,
  doc,
  onClose,
  onSave,
}: {
  name: string;
  doc: EditDoc;
  onClose: () => void;
  onSave: (format: Format, target: number | null, quality: number, matte: string | null) => void;
}) {
  const [format, setFormat] = useState<Format>(() => {
    const own = formatOf(name);
    // A cut-out saved back as a JPEG loses the hole, so a picture with one
    // starts on a format that can hold it.
    return doc.masks.some((m) => m.kind === "erase") && own === "jpeg" ? "png" : own;
  });
  const [quality, setQuality] = useState(0.9);
  const [fit, setFit] = useState(false);
  const [targetKB, setTargetKB] = useState(1024);
  const [matte, setMatte] = useState("#ffffff");

  const holes = doc.masks.some((m) => m.kind === "erase");
  const loses = holes && !keepsTransparency(format);
  const out = exportSize(doc);

  return (
    <div className="ed-panel ed-save-panel" role="dialog" aria-label="Save a copy">
      <h3>Save a copy</h3>
      <p className="ed-note">
        {renameFor(name, format)} — a new file beside the original, which is left exactly as it is.
      </p>

      <div className="ed-group">
        {FORMATS.map((f) => (
          <button key={f} className="ed-chip" aria-pressed={format === f} onClick={() => setFormat(f)}>
            {f.toUpperCase()}
          </button>
        ))}
      </div>

      <label className="ed-check">
        <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
        Fit into a file size
      </label>

      {fit ? (
        <>
          <div className="ed-group">
            {SIZE_PRESETS.map((p) => (
              <button
                key={p.label}
                className="ed-chip"
                aria-pressed={targetKB === Math.round(p.bytes / 1024)}
                onClick={() => setTargetKB(Math.round(p.bytes / 1024))}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="ed-fields">
            At most
            <input
              type="number"
              min={10}
              value={targetKB}
              onChange={(e) => setTargetKB(Math.max(10, Number(e.target.value) || 10))}
            />
            KB
          </label>
          <p className="ed-note">
            {hasQuality(format)
              ? "Quality goes first, and only then the dimensions — so the picture stays as big as it can."
              : "A PNG has no quality to give up, so hitting a size means making the picture smaller. Often much smaller."}
          </p>
        </>
      ) : (
        hasQuality(format) && (
          <label className="ed-slider wide">
            Quality
            <input
              type="range"
              min={30}
              max={100}
              value={Math.round(quality * 100)}
              onChange={(e) => setQuality(Number(e.target.value) / 100)}
            />
            <b>{Math.round(quality * 100)}</b>
          </label>
        )
      )}

      {loses && (
        <div className="ed-warn">
          A {format.toUpperCase()} cannot hold the part you deleted. It will be filled with
          <input type="color" value={matte} onChange={(e) => setMatte(e.target.value)} aria-label="Fill colour" />
          instead. PNG and WebP keep it clear.
        </div>
      )}

      <p className="ed-note">Saving at {out.width} × {out.height}.</p>

      <footer>
        <button className="ed-chip" onClick={onClose}>Cancel</button>
        <button
          className="ed-chip strong"
          onClick={() => onSave(format, fit ? targetKB * 1024 : null, quality, loses ? matte : null)}
        >
          Save
        </button>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ plumbing

type Drag =
  | { kind: "marquee"; from: Point; to: Point; additive: boolean; subtractive: boolean }
  | { kind: "wand"; from: Point; base: number; seed: Point }
  | { kind: "ink"; shape: Shape }
  | { kind: "shape"; shape: Shape }
  | { kind: "move"; id: string; from: Point; origin: Shape };

interface Point {
  x: number;
  y: number;
}

let counter = 0;
function freshId(): string {
  return `s${++counter}`;
}

/** Constrain a drag to a square, for Shift. */
function square(x0: number, y0: number, at: Point): Point {
  const side = Math.max(Math.abs(at.x - x0), Math.abs(at.y - y0));
  return { x: x0 + Math.sign(at.x - x0) * side, y: y0 + Math.sign(at.y - y0) * side };
}

function drawMarquee(canvas: HTMLCanvasElement | null, rect: UnitRect) {
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const x = rect.x * canvas.width;
  const y = rect.y * canvas.height;
  const w = rect.width * canvas.width;
  const h = rect.height * canvas.height;
  ctx.fillStyle = "rgba(10,132,255,0.16)";
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.strokeRect(x - 0.5, y - 0.5, w + 2, h + 2);
}

/** A proxy-sized mask, stretched to the size everything downstream expects.
 * Nearest-neighbour on purpose: this is a live preview of a selection, and a
 * smoothing pass over a million bytes every frame is the one cost this path
 * cannot afford. The committed mask is computed at full size anyway. */
function stretchMask(mask: Mask, width: number, height: number): Mask {
  const data = new Uint8Array(width * height);
  const sx = mask.width / width;
  const sy = mask.height / height;
  for (let y = 0; y < height; y++) {
    const from = Math.min(mask.height - 1, Math.floor(y * sy)) * mask.width;
    const to = y * width;
    for (let x = 0; x < width; x++) {
      data[to + x] = mask.data[from + Math.min(mask.width - 1, Math.floor(x * sx))];
    }
  }
  const b = mask.bounds;
  return {
    width,
    height,
    data,
    bounds: b
      ? {
          x: Math.floor(b.x / sx),
          y: Math.floor(b.y / sy),
          width: Math.max(1, Math.ceil(b.width / sx)),
          height: Math.max(1, Math.ceil(b.height / sy)),
        }
      : null,
  };
}

/**
 * The picture's pixels, by whatever route this platform has to them.
 *
 * The first try is the file itself, which is what every target can do for the
 * formats a webview decodes. The fallback is the thumbnail pipeline, which on
 * macOS is ImageIO and on Android is `ImageDecoder` — between them that is
 * HEIC, camera raw, PSD and TIFF, none of which a webview will touch. The
 * fallback caps out at `DECODE_MAX`, and that ceiling is real: editing a HEIC
 * means editing it at 4096 on the long side.
 */
async function loadSource(path: string): Promise<Source> {
  try {
    const url = await ipc.mediaUrl(path);
    const direct = await imageFrom(url);
    if (direct) return direct;
  } catch {
    // Fall through: a file the webview refuses is exactly what the next path is for.
  }
  const rendered = await ipc.thumbnail(path, DECODE_MAX).catch(() => null);
  if (rendered) {
    const via = await imageFrom(ipc.fileSrc(rendered));
    if (via) return via;
  }
  throw new Error(
    platform === "web"
      ? "This browser cannot decode this picture, so there is nothing to edit."
      : "This picture could not be decoded for editing."
  );
}

function imageFrom(url: string): Promise<Source | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) return resolve(null);
      // The layout width of a detached image is its natural width, but saying so
      // explicitly costs nothing and means the renderer's `width` is never the
      // CSS one by accident.
      img.width = img.naturalWidth;
      img.height = img.naturalHeight;
      resolve(img as unknown as Source);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Kept for the export path's benefit: a canvas the same shape as the view, so
 * a caller can hand `drawAll` somewhere to draw without owning a DOM node. */
export function scratchCanvas(width: number, height: number): HTMLCanvasElement {
  return makeCanvas(width, height);
}
