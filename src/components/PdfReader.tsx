import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as ipc from "../ipc";
import { caps } from "../platform";
import { loadMarks, pageFor, rememberPage } from "../reading";
import type { PdfMeta } from "../types";
import {
  Chevron,
  ChevronLeft,
  CloseIcon,
  ExpandIcon,
  ShrinkIcon,
  ShareIcon,
  SpreadIcon,
  SinglePageIcon,
  PageWidthIcon,
  PageFitIcon,
} from "./icons";

/**
 * The reader: a PDF as a book rather than as a file.
 *
 * Opening a PDF used to hand it to the operating system, which on a phone and
 * in a browser meant a toast apologising that it couldn't. This is the answer
 * to that — and to the more interesting question underneath it, which is why a
 * file browser that already rasterises any page of any PDF at any size was
 * still sending people to another application to read one.
 *
 * The shape is borrowed from the readers people already like:
 *
 * - **Paper, not a document view.** One page at a time, centred, with paper
 *   edges and a shadow. No scrollbars, no toolbar rail, no page gutter running
 *   off the bottom of the screen.
 * - **A spread when there's room.** Past a certain width two pages beat one
 *   enormous one, with the cover standing alone the way a real book's does.
 * - **The chrome gets out of the way.** Both bars fade after a few seconds of
 *   reading and come back on the first movement, tap or key.
 * - **It remembers.** Close a book on page 340 and it opens on page 340.
 *
 * Everything expensive is bounded: pages are rasterised by the backend at the
 * size they'll actually occupy, snapped to shared steps so resizing reuses the
 * cache, and a handful either side of the page being read is all that's held.
 * The page after this one is fetched while this one is being read, which is
 * what makes the turn instant rather than merely fast.
 */

/** Render sizes are snapped so that resizing the window mostly reuses the cache. */
const STEPS = [512, 768, 1024, 1400, 1800, 2400, 3200];

/** Rendered pages held at once. Two spreads either side of the one being read
 * is all a turn ever needs; more is a book kept in memory for no one. */
const CACHE = 14;

/** A spread needs both this much width and a landscape-ish window: two pages on
 * a narrow screen are two unreadable pages. */
const SPREAD_MIN_W = 940;
const SPREAD_MIN_RATIO = 1.15;

/** How long the chrome stays after the last sign of life. */
const CHROME_MS = 2600;

/** Matches `--turn` in the stylesheet, with a little slack: the ghost of the
 * outgoing page is dropped on a timer rather than on `animationend`, so that
 * reduced-motion — where no animation fires at all — still clears it. */
const TURN_MS = 420;

/** A drag has to beat both an absolute distance and a share of the page before
 * it counts as a turn, so a thumb resting on the paper doesn't move it. */
const SWIPE_PX = 56;
const SWIPE_SHARE = 0.14;

/** How far a finger has to travel before it has said which gesture it is.
 * Below this it hasn't said anything, and is still a tap. */
const SLOP = 8;

/** The band along the top of the page that reaches the controls, as a share of
 * the page and as a floor in pixels. Full width, so it can be hit without
 * aiming — the thing a middle third can never be. */
const TOP_BAND = 0.2;
const TOP_BAND_PX = 96;

/** A trackpad reports a page-turn's worth of scroll in a lot of small events. */
const WHEEL_STEP = 140;

type Fit = "page" | "width";

interface Spread {
  /** The 1-based pages on screen, left to right. */
  pages: number[];
  srcs: (string | null)[];
  /** Which way the reader was going, for the turn animation. */
  dir: 1 | -1;
  /** Bumped per turn so React remounts the paper and the animation replays. */
  turn: number;
  /** The spread being turned away from, held until the animation lands. */
  ghost: { pages: number[]; srcs: (string | null)[] } | null;
}

interface Props {
  path: string;
  name: string;
  onClose: () => void;
  /** Hand the file to the system's share sheet. Absent where there is none. */
  onShare?: () => void;
  /** Hand the file to whatever the desktop opens PDFs with. Absent in a
   * browser and on a phone, where there is nothing to hand it to. */
  onOpenExternal?: () => void;
}

export function PdfReader({ path, name, onClose, onShare, onOpenExternal }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const paperEl = useRef<HTMLDivElement>(null);

  const [meta, setMeta] = useState<PdfMeta | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [want, setWant] = useState(1);
  const [view, setView] = useState<Spread | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [wide, setWide] = useState(false);
  const [spread, setSpread] = useState<boolean | null>(null);
  const [fit, setFit] = useState<Fit>("page");
  const [full, setFull] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);

  const pages = meta?.pages ?? 1;
  const aspect = meta?.aspect ?? 0.773;
  const dir = useRef<1 | -1>(1);

  // ------------------------------------------------------------ the document

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setView(null);
    setFailed(null);
    ipc
      .pdfMeta(path)
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        // Where this document was left, clamped against the document that
        // actually came back — the file may be a shorter one by now.
        setWant(pageFor(loadMarks(), path, m.pages));
      })
      .catch((e) => alive && setFailed(String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  // The position is written on every turn rather than on close: a reader that
  // only remembers a tidy exit forgets every book you closed by quitting.
  useEffect(() => {
    if (meta) rememberPage(path, want);
  }, [path, want, meta]);

  // --------------------------------------------------------------- the shape

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    // `contentRect`, not the bounding box: the stage's padding is the margin
    // the page sits in, and counting it as room for paper is what makes a
    // page run off the top and bottom of the screen.
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setBox({ w: r.width, h: r.height });
      setWide(r.width >= SPREAD_MIN_W && r.width / Math.max(1, r.height) >= SPREAD_MIN_RATIO);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A window wide enough gets a spread until someone says otherwise; saying
  // otherwise sticks for the rest of the sitting. `null` is "nobody has said",
  // which is why it isn't just a boolean defaulted to false.
  const twoUp = wide && (spread ?? true) && pages > 1 && fit === "page";

  const leaves = useMemo(() => leavesOf(want, pages, twoUp), [want, pages, twoUp]);

  /** The paper, in CSS pixels. Worked out here rather than left to the layout
   * so the size asked of the renderer is exactly the size that gets drawn. */
  const paper = useMemo(() => {
    const across = aspect * leaves.length;
    if (box.w === 0 || box.h === 0) return { w: 0, h: 0 };
    if (fit === "width") return { w: box.w, h: box.w / across };
    const h = Math.min(box.h, box.w / across);
    return { w: h * across, h };
  }, [box, aspect, leaves.length, fit]);

  const maxPx = useMemo(() => {
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    const longest = Math.max(paper.w / leaves.length, paper.h) * dpr;
    return STEPS.find((s) => s >= longest) ?? STEPS[STEPS.length - 1];
  }, [paper.w, paper.h, leaves.length]);

  // -------------------------------------------------------------- the pages

  const cache = useRef(new Map<string, Promise<string | null>>());
  useEffect(() => {
    const held = cache.current;
    return () => held.clear();
  }, [path]);

  const ask = useCallback(
    (page: number, px: number) => {
      const key = `${page}@${px}`;
      const hit = cache.current.get(key);
      if (hit) return hit;
      const asked = ipc
        .pdfPage(path, page, px)
        .then((p) => ipc.fileSrc(p))
        .catch(() => null);
      cache.current.set(key, asked);
      while (cache.current.size > CACHE) {
        const oldest = cache.current.keys().next();
        if (oldest.done || oldest.value === key) break;
        cache.current.delete(oldest.value);
      }
      return asked;
    },
    [path]
  );

  // The spread on screen only changes once the new one has been rasterised.
  // Blanking first would be honest about the work and reads as a flicker; the
  // page you were on staying put until the next one is ready reads as paper.
  useEffect(() => {
    if (!meta || paper.w === 0) return;
    let alive = true;
    const holding = window.setTimeout(() => alive && setWaiting(true), 180);
    void Promise.all(leaves.map((n) => ask(n, maxPx))).then((srcs) => {
      window.clearTimeout(holding);
      if (!alive) return;
      setWaiting(false);
      setView((prev) => {
        // A resize re-renders the same pages at a sharper size. Swapping the
        // images in place is the whole change: bumping the turn would replay
        // the page-turn animation every time the window moved.
        const settled =
          prev && prev.pages.length === srcs.length && prev.pages.every((p, i) => p === leaves[i]);
        if (settled) {
          if (prev.srcs.every((s, i) => s === srcs[i])) return prev;
          return { ...prev, srcs };
        }
        return {
          pages: leaves,
          srcs,
          dir: dir.current,
          turn: (prev?.turn ?? 0) + 1,
          ghost: prev ? { pages: prev.pages, srcs: prev.srcs } : null,
        };
      });
    });
    return () => {
      alive = false;
      window.clearTimeout(holding);
    };
  }, [meta, leaves, maxPx, ask, paper.w]);

  // The page after the one being read, fetched while it's being read. This is
  // the whole reason a turn feels like paper rather than like a request.
  useEffect(() => {
    if (!view || !meta) return;
    const after = view.pages[view.pages.length - 1];
    const before = view.pages[0];
    const ahead = leavesOf(after + 1, pages, twoUp);
    const behind = before > 1 ? leavesOf(before - 1, pages, twoUp) : [];
    const idle = window.setTimeout(() => {
      for (const n of [...ahead, ...behind]) if (n >= 1 && n <= pages) void ask(n, maxPx);
    }, 60);
    return () => window.clearTimeout(idle);
  }, [view, meta, pages, twoUp, maxPx, ask]);

  // The ghost of the outgoing spread is dropped on a timer rather than on
  // `animationend`, so reduced motion — where nothing animates — still clears it.
  useEffect(() => {
    if (!view?.ghost) return;
    const done = window.setTimeout(
      () => setView((v) => (v && v.ghost ? { ...v, ghost: null } : v)),
      TURN_MS
    );
    return () => window.clearTimeout(done);
  }, [view?.turn, view?.ghost]);

  // --------------------------------------------------------------- turning

  const goTo = useCallback(
    (page: number) => {
      setWant((from) => {
        const to = Math.min(Math.max(1, page), pages);
        if (to !== from) dir.current = to > from ? 1 : -1;
        return to;
      });
    },
    [pages]
  );

  const step = useCallback(
    (delta: 1 | -1) => {
      const on = leaves;
      goTo(delta > 0 ? on[on.length - 1] + 1 : leavesOf(Math.max(1, on[0] - 1), pages, twoUp)[0]);
    },
    [leaves, goTo, pages, twoUp]
  );

  // ---------------------------------------------------------------- chrome

  const held = useRef(false);
  const hideTimer = useRef(0);
  // Mirrored in a ref so that a mouse crossing the window doesn't put a
  // `setState` call — however cheaply React bails out of it — on every frame.
  const showing = useRef(true);
  const show = useCallback((on: boolean) => {
    if (showing.current === on) return;
    showing.current = on;
    setChrome(on);
  }, []);
  const wake = useCallback(() => {
    show(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!held.current) show(false);
    }, CHROME_MS);
  }, [show]);

  useEffect(() => {
    wake();
    return () => window.clearTimeout(hideTimer.current);
  }, [wake]);

  /** Show or hide the controls, deliberately.
   *
   * A pointer has movement to ask with, so it gets the idle timer back. A
   * finger has only the tap it just made, and a timer would take the controls
   * away again while the thumb was still travelling towards them — so on
   * touch they stay until something says otherwise. */
  const toggleChrome = useCallback(
    (touch: boolean) => {
      if (showing.current) show(false);
      else if (touch) show(true);
      else wake();
    },
    [show, wake]
  );

  /** A turn asked for by hand, on the page itself. Reading is what the gesture
   * was for, so the controls that were covering the page get out of the way. */
  const turned = useCallback(
    (delta: 1 | -1, touch: boolean) => {
      step(delta);
      if (touch && showing.current) show(false);
    },
    [step, show]
  );

  const fullAvailable =
    typeof document !== "undefined" && typeof document.documentElement.requestFullscreen === "function";

  useEffect(() => {
    const changed = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      // Leaving the reader must not leave the whole app in full screen.
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const toggleFull = useCallback(() => {
    if (!fullAvailable) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen().catch(() => {});
  }, [fullAvailable]);

  // -------------------------------------------------------------- keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        // The scrubber is an input, and ← → on it are its own.
        if (e.key !== "Escape") return;
      }
      let handled = true;
      switch (e.key) {
        case "Escape":
          // The browser takes Escape out of full screen itself; closing the
          // book on the same press would lose your place in one keystroke.
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
          else onClose();
          break;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          step(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          step(-1);
          break;
        case "Home":
          goTo(1);
          break;
        case "End":
          goTo(pages);
          break;
        case "f":
        case "F":
          toggleFull();
          break;
        case "w":
        case "W":
          setFit((f) => (f === "page" ? "width" : "page"));
          break;
        case "d":
        case "D":
          if (wide) setSpread((s) => !(s ?? true));
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      wake();
    };
    // Capture, so the folder underneath never sees these.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, goTo, pages, onClose, toggleFull, wake, wide]);

  // ------------------------------------------------------------- the thumb

  const drag = useRef({
    id: -1,
    x: 0,
    y: 0,
    dx: 0,
    live: false,
    /** Past the slop, going sideways: this is a page being dragged. */
    moved: false,
    /** Past the slop, going up or down: this belongs to the scroller, not us. */
    vertical: false,
    touch: false,
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: 0,
      live: true,
      moved: false,
      vertical: false,
      touch: e.pointerType !== "mouse",
    };
    // So a fast swipe that leaves the paper still finishes as a turn.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Older WebViews without capture still get the tap and the short swipe.
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.live || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;

    // Which gesture this is gets decided once, and only once the finger has
    // gone far enough to have said anything. Deciding on the first pixel is
    // what made a tap unreliable: a thumb never lands and lifts on exactly the
    // same point, and three pixels of downward drift used to cancel the whole
    // gesture — no turn, and no controls either.
    if (!d.moved && !d.vertical) {
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) d.vertical = true;
      else if (Math.abs(dx) > SLOP) d.moved = true;
    }
    if (!d.moved) return;

    d.dx = dx;
    // Written straight to the element: a turn's worth of pointer events is not
    // a turn's worth of React renders.
    if (paperEl.current) {
      paperEl.current.style.transform = `translate3d(${dx * 0.42}px,0,0)`;
      paperEl.current.style.transition = "none";
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.live || e.pointerId !== d.id) return;
    d.live = false;
    const el = paperEl.current;
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
    // A drag that went up or down was the scroller's, and ends as nothing.
    if (d.vertical) return;

    if (d.moved) {
      const far = Math.max(SWIPE_PX, box.w * SWIPE_SHARE);
      if (Math.abs(d.dx) > far) turned(d.dx < 0 ? 1 : -1, d.touch);
      return;
    }

    const r = stage.current?.getBoundingClientRect();
    if (!r) return;
    // The controls live along the top of the page as well as down the middle.
    // A band the full width of the screen is a target you can hit without
    // aiming, which a middle third is not — and it is where every reader that
    // has solved this puts it.
    if (e.clientY - r.top < Math.max(TOP_BAND_PX, r.height * TOP_BAND)) {
      toggleChrome(d.touch);
      return;
    }
    const at = (e.clientX - r.left) / Math.max(1, r.width);
    if (at < 0.3) turned(-1, d.touch);
    else if (at > 0.7) turned(1, d.touch);
    else toggleChrome(d.touch);
  };

  const wheel = useRef({ acc: 0, at: 0 });
  const onWheel = (e: React.WheelEvent) => {
    // In fit-width the stage is a scroller and the wheel belongs to it.
    if (fit === "width") return;
    wake();
    const now = Date.now();
    if (now - wheel.current.at > 400) wheel.current.acc = 0;
    wheel.current.at = now;
    wheel.current.acc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(wheel.current.acc) >= WHEEL_STEP) {
      step(wheel.current.acc > 0 ? 1 : -1);
      wheel.current.acc = 0;
    }
  };

  // ----------------------------------------------------------------- render

  const shown = scrub ?? want;
  const last = leaves[leaves.length - 1];
  // While the scrubber is being dragged the number follows the thumb, not the
  // paper: the paper only moves when the thumb is let go.
  const label =
    scrub === null && leaves.length > 1 && last !== leaves[0]
      ? `${leaves[0]}–${last}`
      : String(shown);
  const progress = pages > 1 ? ((shown - 1) / (pages - 1)) * 100 : 100;

  if (failed) {
    return (
      <div className="reader" ref={root}>
        <div className="reader-sorry">
          <p>This PDF couldn’t be opened.</p>
          <p className="reader-sorry-why">{failed}</p>
          <div className="reader-sorry-do">
            {onOpenExternal && (
              <button onClick={onOpenExternal}>Open in another app</button>
            )}
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`reader${chrome ? "" : " bare"}${full ? " full" : ""}`}
      ref={root}
      // A pointer moving over the page is someone looking for the controls, so
      // the controls come back. Only a real pointer, though: a browser
      // synthesises a mouse move after every tap, and taking that as movement
      // meant the tap that asked for the chrome to go away brought it
      // straight back.
      onPointerMove={(e) => {
        if (e.pointerType === "mouse") wake();
      }}
    >
      <header className="reader-top" onMouseEnter={() => (held.current = true)} onMouseLeave={() => (held.current = false)}>
        <button className="reader-icon" onClick={onClose} title="Close (esc)" aria-label="Close">
          <CloseIcon size={15} />
        </button>
        <h1 className="reader-name" title={name}>
          {stem(name)}
        </h1>
        <div className="reader-tools">
          <button
            className="reader-icon"
            onClick={() => setFit((f) => (f === "page" ? "width" : "page"))}
            title={fit === "page" ? "Fit the width (w)" : "Fit the page (w)"}
            aria-label={fit === "page" ? "Fit the width" : "Fit the page"}
          >
            {fit === "page" ? <PageWidthIcon size={15} /> : <PageFitIcon size={15} />}
          </button>
          {wide && pages > 1 && (
            <button
              className="reader-icon"
              onClick={() => setSpread((s) => !(s ?? true))}
              title={twoUp ? "One page (d)" : "Two pages (d)"}
              aria-label={twoUp ? "One page" : "Two pages"}
            >
              {twoUp ? <SinglePageIcon size={15} /> : <SpreadIcon size={15} />}
            </button>
          )}
          {caps.share && onShare && (
            <button className="reader-icon" onClick={onShare} title="Share…" aria-label="Share">
              <ShareIcon size={15} />
            </button>
          )}
          {fullAvailable && (
            <button
              className="reader-icon"
              onClick={toggleFull}
              title={full ? "Leave full screen (f)" : "Full screen (f)"}
              aria-label={full ? "Leave full screen" : "Full screen"}
            >
              {full ? <ShrinkIcon size={15} /> : <ExpandIcon size={15} />}
            </button>
          )}
        </div>
      </header>

      <div
        className={`reader-stage${fit === "width" ? " scrolls" : ""}`}
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        {paper.w > 0 && (
          <div
            className="reader-paper"
            ref={paperEl}
            style={{ width: `${Math.round(paper.w)}px`, height: `${Math.round(paper.h)}px` }}
          >
            {view?.ghost && (
              <Sheets key={`ghost-${view.turn}`} className="reader-sheets ghost" spread={view.ghost} />
            )}
            {view ? (
              <Sheets
                key={view.turn}
                className="reader-sheets"
                spread={view}
                dir={view.dir}
                animate={!!view.ghost}
              />
            ) : (
              <div className="reader-sheets">
                <div className="reader-sheet holding" />
              </div>
            )}
          </div>
        )}
        {(waiting || (!view && !meta)) && <div className="reader-busy" aria-label="Opening" />}
      </div>

      <footer className="reader-bottom" onMouseEnter={() => (held.current = true)} onMouseLeave={() => (held.current = false)}>
        <button
          className="reader-icon"
          onClick={() => step(-1)}
          disabled={leaves[0] <= 1}
          title="Back a page"
          aria-label="Back a page"
        >
          <ChevronLeft size={15} />
        </button>
        <input
          className="reader-scrub"
          type="range"
          min={1}
          max={Math.max(1, pages)}
          value={shown}
          aria-label="Page"
          onInput={(e) => setScrub(Number(e.currentTarget.value))}
          onChange={(e) => {
            setScrub(null);
            goTo(Number(e.currentTarget.value));
          }}
          onPointerUp={() => setScrub(null)}
          onBlur={() => setScrub(null)}
        />
        <span className="reader-count">
          {label} <i>/</i> {pages}
        </span>
        <button
          className="reader-icon"
          onClick={() => step(1)}
          disabled={last >= pages}
          title="On a page"
          aria-label="On a page"
        >
          <Chevron size={15} />
        </button>
      </footer>

      {/* Always visible, chrome or no chrome: how far through you are is the one
          thing worth a permanent line on the screen. */}
      <div className="reader-rail" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

/** One or two pages of paper. Split out so the outgoing spread can be drawn
 * with the same markup while it's being turned away from. */
function Sheets({
  spread,
  className,
  dir,
  animate,
}: {
  spread: { pages: number[]; srcs: (string | null)[] };
  className: string;
  dir?: 1 | -1;
  animate?: boolean;
}) {
  return (
    <div
      className={className}
      data-dir={animate ? (dir === -1 ? "back" : "fwd") : undefined}
      data-two={spread.pages.length > 1 ? "" : undefined}
    >
      {spread.pages.map((page, i) => {
        const src = spread.srcs[i];
        return src ? (
          <img className="reader-sheet" key={page} src={src} alt="" draggable={false} />
        ) : (
          <div className="reader-sheet holding" key={page} />
        );
      })}
    </div>
  );
}

/**
 * The pages that belong on screen together.
 *
 * A book's cover stands alone, and after it the odd page is on the right — so a
 * spread is an even page and its successor. Getting this wrong is what makes a
 * two-up view feel like two unrelated pages rather than an opened book.
 */
export function leavesOf(page: number, pages: number, spread: boolean): number[] {
  const at = Math.min(Math.max(1, page), Math.max(1, pages));
  if (!spread || pages < 2) return [at];
  if (at === 1) return [1];
  const left = at % 2 === 0 ? at : at - 1;
  return left + 1 <= pages ? [left, left + 1] : [left];
}

/** A book is its title, not its filename. */
function stem(name: string): string {
  return name.replace(/\.pdf$/i, "");
}
