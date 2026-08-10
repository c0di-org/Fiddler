import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import * as ipc from "../ipc";
import type { Entry, PeekItem } from "../types";
import { PEEK_LIMIT, peek, subscribe as subscribePeek } from "../folder-peek";
import { categoryOf } from "../glyph-category";
import { folderIconForName, type FolderIcon } from "../folder-icon";
import { isTextual, routeOf } from "../preview/route";
import { peek as peekThumb, subscribe as subscribeThumb, thumbPx } from "../thumbs";

/**
 * The icon shown when there's no image preview. Scales from a 20px list row up to
 * a 256px preview: the document sheet gains a coloured type band as it grows, the
 * way Finder's own generic icons do.
 *
 * Every gradient lives once in <GlyphDefs>, rendered at the app root, so a folder
 * of 40,000 files doesn't ship 40,000 copies of the same <linearGradient>.
 */

/** Below this the glyph is a list-row icon; above it, artwork worth a shadow. */
const LARGE = 40;

export function FileGlyph({ entry, size }: { entry: Entry; size: number }) {
  const isDir = entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir);

  if (isDir) {
    return <FolderGlyph size={size} repo={entry.isRepo} name={entry.name} path={entry.path} />;
  }

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={`${fileClass(entry.name)} glyph ${size >= LARGE ? "glyph-lg" : ""}`}
      aria-hidden="true"
    >
      <FileArt name={entry.name} size={size} />
    </svg>
  );
}

/** The classes the sheet's own paint hangs off, wherever it is drawn. */
const fileClass = (name: string) => `glyph-file cat-${categoryOf(name)}`;

/**
 * The document sheet, in the 48-unit space of whatever `<svg>` holds it. `size`
 * is the width it will actually occupy on screen, which is what decides how much
 * detail is worth drawing.
 */
function FileArt({
  name,
  size,
  tucked,
}: {
  name: string;
  size: number;
  /** The foot of the sheet is hidden, so the ruled lines down there are dropped
   *  rather than sliced in half by whatever covers it. */
  tucked?: boolean;
}) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  // The band is the only thing telling one file from another in a list row, so
  // it survives all the way down; only its lettering needs room to be legible.
  const showBand = ext.length > 0 && ext.length <= 6;
  // Lettering is worth drawing well before the sheet has room for ruled lines:
  // in a folder's fan each sheet is barely a third of the icon, and the type is
  // the whole reason it's there.
  const showText = showBand && size >= 28;
  const showLines = showBand && size >= 44 && !tucked;
  // Shrink the type text rather than truncating it — "SWIF" reads as a typo.
  const labelSize = ext.length <= 3 ? 9.4 : ext.length === 4 ? 8 : 6.6;

  return (
    <>
      {/* Sheet: rounded on three corners, folded on the fourth. */}
      <path
        d="M12 4h17.5L39 13.5V41a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"
        className="sheet-face"
      />
      <path d="M29.5 4 39 13.5h-6.5a3 3 0 0 1-3-3Z" className="fold" />

      {/* A colour band across the head of the sheet, hung off the fold's lower
          edge: readable at a glance across a grid, the thing carrying the file's
          type, and — being up here — the part still showing when a sheet is
          fanned out of a folder with its foot behind the flap. */}
      {showBand && <path d="M9 13.5h30v13H9Z" className="band" />}

      {showText && (
        <text
          x="24"
          y="23.3"
          textAnchor="middle"
          className="band-text"
          style={{ fontSize: labelSize }}
        >
          {ext.toUpperCase()}
        </text>
      )}

      {showLines && <path d="M15 32h18M15 38h12" className="lines" />}

      {!showBand && size >= 44 && <path d="M15 22h18M15 29h18M15 36h11" className="lines" />}
    </>
  );
}

export function FolderGlyph({
  size,
  repo,
  name,
  path,
}: {
  size: number;
  repo?: boolean;
  /** The folder's leaf name, used for familiar system-folder marks. */
  name?: string;
  /**
   * The folder itself. Given one, the icon fans the first few things inside it
   * out of its mouth; without one it stays a plain folder, which is what the
   * preview pane and Quick Look want — they show the contents themselves.
   */
  path?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  return (
    <svg
      ref={svgRef}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={`glyph glyph-folder ${size >= LARGE ? "glyph-lg" : ""}`}
      aria-hidden="true"
    >
      <FolderArt size={size} repo={repo} name={name}>
        {/* Between the panels, so the fan rises out of the pocket rather than
            sitting on the front of it. */}
        {path && size >= PEEK_MIN && <FolderPeek path={path} size={size} glyph={svgRef} />}
      </FolderArt>
    </svg>
  );
}

/**
 * The folder itself, in the 48-unit space of whatever `<svg>` holds it.
 * `children` are drawn inside the pocket — between the two panels.
 */
function FolderArt({
  size,
  repo,
  name,
  children,
}: {
  size: number;
  repo?: boolean;
  name?: string;
  children?: ReactNode;
}) {
  const icon = name ? folderIconForName(name) : null;
  return (
    <>
      {/* Back panel peeking above the front, which is what reads as "folder".
          The body runs y=13→43 against a x=3→45 width: a squatter box than that
          reads as an envelope. */}
      <path
        d="M3 11.5A4.5 4.5 0 0 1 7.5 7h10.2a3 3 0 0 1 2.2.96l3.9 4.29H40.5A4.5 4.5 0 0 1 45 16.75V20H3Z"
        fill="url(#g-folder-back)"
      />
      {children}
      <path
        d="M3 17.5A4.5 4.5 0 0 1 7.5 13h33a4.5 4.5 0 0 1 4.5 4.5v21a4.5 4.5 0 0 1-4.5 4.5h-33A4.5 4.5 0 0 1 3 38.5Z"
        fill="url(#g-folder-front)"
      />
      {/* Light catching the front panel's top edge — the whole illusion of depth. */}
      <path
        d="M3.9 17.5A3.6 3.6 0 0 1 7.5 13.9h33a3.6 3.6 0 0 1 3.6 3.6"
        fill="none"
        stroke="rgba(255,255,255,0.45)"
        strokeWidth="1.1"
      />
      {icon && size >= 16 && <FolderNameMark icon={icon} />}
      {repo && size >= 28 && (
        // A quiet branch mark on the folder face — present, never the subject.
        <g
          className="folder-repo-mark"
          transform={icon ? "translate(34 18) scale(0.46)" : "translate(30.5 21.5) scale(0.66)"}
        >
          <circle cx="3" cy="3" r="2.6" />
          <circle cx="3" cy="16" r="2.6" />
          <circle cx="15" cy="3" r="2.6" />
          <path d="M3 5.6v7.8" strokeWidth="2.4" />
          <path d="M12.4 3H8a5 5 0 0 0-5 5v1.6" strokeWidth="2.4" fill="none" />
        </g>
      )}
    </>
  );
}

/* ------------------------------------------------------------ folder peek */

/**
 * The first few things inside a folder, fanned out of its mouth and tucked
 * behind the front flap — so a folder says what it holds before you open it.
 *
 * Each one is drawn as the very thing it is: its own thumbnail if it has one,
 * otherwise the same glyph it wears in the grid, mini folders included. A folder
 * drawn here never fans out its own contents: one level is a glimpse, two is a
 * hall of mirrors in a 128px icon.
 */

/** Below this the items are three specks; the plain folder says more. */
const PEEK_MIN = 48;

/** A thumbnail's print, in folder units. Its lower half is behind the flap. */
const PEEK_CARD = { x: 16.5, y: 2.5, w: 15, h: 18 } as const;
/**
 * An icon is square and needs no crop, so it stands in the same slot without the
 * print's extra height — head aligned with a print's, so a fan of the two lines
 * up. What the flap takes is the sheet's foot; its type band is up at the head,
 * and stays showing.
 */
const PEEK_ICON = { x: 16.5, y: 2.5, size: 15 } as const;
/** The pivot the fan swings around, well below the flap's top edge. */
const PIVOT = { x: 24, y: 30 } as const;

/**
 * Where each item sits, by how many there are. The first takes the middle and is
 * drawn last, so what's at the front of the folder is on top of the stack.
 */
const FAN: readonly (readonly number[])[] = [[0], [-13, 13], [0, -24, 24]];

/** The folder's own `<svg>`, whose parent anchors the previews' requests. */
type GlyphRef = RefObject<SVGSVGElement | null>;

function FolderPeek({ path, size, glyph }: { path: string; size: number; glyph: GlyphRef }) {
  const items = useFolderPeek(path);
  const angles = FAN[items.length - 1];
  if (!angles) return null;

  return (
    <g className="folder-peek" aria-hidden="true">
      {items
        .map((item, i) => (
          <PeekItemArt key={item.path} item={item} angle={angles[i]} size={size} glyph={glyph} />
        ))
        .reverse()}
    </g>
  );
}

function PeekItemArt({
  item,
  angle,
  size,
  glyph,
}: {
  item: PeekItem;
  angle: number;
  size: number;
  glyph: GlyphRef;
}) {
  const src = usePeekThumb(item, size, glyph);

  return (
    <g transform={`rotate(${angle} ${PIVOT.x} ${PIVOT.y})`}>
      {src ? (
        <>
          <image
            href={ipc.fileSrc(src)}
            x={PEEK_CARD.x}
            y={PEEK_CARD.y}
            width={PEEK_CARD.w}
            height={PEEK_CARD.h}
            // Fill the print and crop, the way one photo in a stack is cropped
            // by the next. Letterboxing would show the folder through it.
            preserveAspectRatio="xMidYMid slice"
            clipPath="url(#g-peek-card)"
          />
          <rect
            className="peek-edge"
            x={PEEK_CARD.x}
            y={PEEK_CARD.y}
            width={PEEK_CARD.w}
            height={PEEK_CARD.h}
            rx="2"
          />
        </>
      ) : (
        // A nested <svg> gives the art its own 48-unit space, so the drawing the
        // grid uses lands in this slot unchanged, at the right scale.
        <svg
          x={PEEK_ICON.x}
          y={PEEK_ICON.y}
          width={PEEK_ICON.size}
          height={PEEK_ICON.size}
          viewBox="0 0 48 48"
          className={item.isDir ? "glyph-folder" : fileClass(item.name)}
        >
          {item.isDir ? (
            <FolderArt size={peekPx(size)} name={item.name} />
          ) : (
            <FileArt name={item.name} size={peekPx(size)} tucked />
          )}
        </svg>
      )}
    </g>
  );
}

/** What one fanned item actually measures on screen. */
const peekPx = (size: number) => (size * PEEK_ICON.size) / 48;

/** The folder's leading children, once the scheduler gets to them. */
function useFolderPeek(path: string): PeekItem[] {
  const [items, setItems] = useState<PeekItem[]>(() => peek(path) ?? []);

  useEffect(() => {
    setItems(peek(path) ?? []);
    return subscribePeek(path, setItems);
  }, [path]);

  return items.slice(0, PEEK_LIMIT);
}

/**
 * A fanned item's picture, if it has one worth showing this small.
 *
 * The request rides the same scheduler as the grid's own tiles, anchored to the
 * element hosting the folder icon: an item is on screen exactly when the folder
 * it fans out of is, and an SVG node is not something an IntersectionObserver
 * can measure.
 */
function usePeekThumb(item: PeekItem, size: number, glyph: GlyphRef): string | null {
  const want = thumbPx((size * PEEK_CARD.w) / 48);
  // A page of text renders to a grey smudge this small; its sheet says more.
  const worthIt = item.thumbable && !isTextual(routeOf(item.name));
  const [src, setSrc] = useState<string | null>(() =>
    worthIt ? peekThumb(item.path, want) ?? null : null
  );

  useEffect(() => {
    if (!worthIt) return;
    setSrc(peekThumb(item.path, want) ?? null);
    const host = glyph.current?.parentElement;
    if (!host) return;
    return subscribeThumb(item.path, want, host, setSrc);
  }, [item.path, want, worthIt, glyph]);

  return src;
}

/** A familiar, debossed mark on the face of named folders. */
function FolderNameMark({ icon }: { icon: FolderIcon }) {
  return (
    <g className="folder-name-mark" transform="translate(13.2 18.3) scale(1.35)">
      {icon === "android" && (
        <>
          <path d="M3 6.5h10v6.25a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M3.5 6.25a4.5 4.5 0 0 1 9 0ZM5 3 3.75 1.5M10.5 3l1.25-1.5" />
          <circle cx="6" cy="8.5" r=".7" className="folder-name-fill" />
          <circle cx="9.5" cy="8.5" r=".7" className="folder-name-fill" />
        </>
      )}
      {icon === "apps" && <><rect x="2.5" y="2.5" width="4" height="4" rx=".8" /><rect x="9.5" y="2.5" width="4" height="4" rx=".8" /><rect x="2.5" y="9.5" width="4" height="4" rx=".8" /><rect x="9.5" y="9.5" width="4" height="4" rx=".8" /></>}
      {icon === "archive" && <><path d="M2.5 5h11v9h-11z" /><path d="M2 2.5h12v2.5H2zM6 8.5h4" /></>}
      {icon === "audiobooks" && <><path d="M2.75 3.25h4.5A2.75 2.75 0 0 1 10 6v7.25a2.5 2.5 0 0 0-2.75-1.5h-4.5Z" /><path d="M13.25 3.25h-2.5M12.5 7v3M10.75 8.5h3.5" /></>}
      {icon === "backup" && <><path d="M4.25 5.75V2.5L2 4.75" /><path d="M4 4.5a5.5 5.5 0 1 1-1 6" /><path d="M8 5.5v3l2 1.5" /></>}
      {icon === "books" && <><path d="M2.5 3h4.75A2.75 2.75 0 0 1 10 5.75v7.75A2.75 2.75 0 0 0 7.25 12H2.5Z" /><path d="M13.5 3H12a2 2 0 0 0-2 2v8.5A2.75 2.75 0 0 1 12.75 12h.75Z" /></>}
      {icon === "cloud" && <path d="M4.75 12.5h7a3 3 0 0 0 .4-5.97A4.25 4.25 0 0 0 4 7.75a2.4 2.4 0 0 0 .75 4.75Z" />}
      {icon === "code" && <><path d="m6 4-3.5 4L6 12M10 4l3.5 4-3.5 4M9 2.75 7 13.25" /></>}
      {icon === "database" && <><ellipse cx="8" cy="3.75" rx="5" ry="2.25" /><path d="M3 3.75v8.5c0 1.25 2.25 2.25 5 2.25s5-1 5-2.25v-8.5M3 8c0 1.25 2.25 2.25 5 2.25S13 9.25 13 8" /></>}
      {icon === "design" && <><path d="m3 11.5-.75 2.25 2.25-.75 8.25-8.25-1.5-1.5Z" /><path d="m10.5 3.25 1.5 1.5M2.5 13.5h5" /></>}
      {icon === "documents" && <><path d="M4 2.25h5l3 3v8.5H4Z" /><path d="M9 2.25v3h3M6 8h4M6 10.5h4" /></>}
      {icon === "downloads" && <><path d="M8 2.5v7.25M5 7.5 8 10.5l3-3M3 13h10" /></>}
      {icon === "fonts" && <path d="m3 13 3.5-10h3L13 13M4.75 9.25h6.5" />}
      {icon === "games" && <><path d="M5.25 7h5.5c1.2 0 2.05.73 2.4 1.8l.45 1.45c.45 1.5-1.5 2.25-2.4 1.1l-.8-1.1H5.6l-.8 1.1c-.9 1.15-2.85.4-2.4-1.1l.45-1.45C3.2 7.73 4.05 7 5.25 7Z" /><path d="M5.25 8.5v2M4.25 9.5h2M11.5 9h.01M12.5 10h.01" /></>}
      {icon === "images" && <><rect x="2.25" y="3" width="11.5" height="10" rx="1.25" /><circle cx="5.25" cy="6" r="1" /><path d="m3.5 11 3.25-3 2.25 2 1.5-1.5 2 2" /></>}
      {icon === "media" && <><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="m6.5 5.5 3.5 2.5-3.5 2.5Z" /><path d="M4 3v10M12 3v10" /></>}
      {icon === "music" && <><path d="M10.5 3v7.5a2 2 0 1 1-1-1.73V5l-5 1v6a2 2 0 1 1-1-1.73V4.5Z" /></>}
      {icon === "notes" && <><path d="M3 2.5h9.5v11H3Z" /><path d="M5.25 5.5h5M5.25 8h5M5.25 10.5h3.25" /></>}
      {icon === "notifications" && <><path d="M4.25 10.75h7.5l-1.1-1.6V6.5a2.65 2.65 0 0 0-5.3 0v2.65Z" /><path d="M6.5 12a1.65 1.65 0 0 0 3 0M7.25 2.75h1.5" /></>}
      {icon === "phone" && <><rect x="4.5" y="2" width="7" height="12" rx="1.25" /><path d="M7 4h2M7.4 11.5h1.2" /></>}
      {icon === "photos" && <><rect x="2.25" y="5" width="11.5" height="8" rx="1.25" /><path d="M5.25 5 6.5 3.25h3L10.75 5" /><circle cx="8" cy="9" r="2" /></>}
      {icon === "podcasts" && <><circle cx="8" cy="8" r="5.25" /><circle cx="8" cy="8" r="1" className="folder-name-fill" /><path d="M8 5.25v-1M8 11.75v-1M5.25 8h-1M11.75 8h-1" /></>}
      {icon === "recordings" && <path d="M3 9v-2M5.5 12V4M8 14V2M10.5 12V4M13 9v-2" />}
      {icon === "ringtones" && <><path d="M3 9.75h2.25L8.5 12.5v-9L5.25 6.25H3Z" /><path d="M10.5 6.25a2.5 2.5 0 0 1 0 3.5M12.25 4.5a5 5 0 0 1 0 7" /></>}
      {icon === "settings" && <><circle cx="8" cy="8" r="2.25" /><path d="M8 2.5v1.25M8 12.25v1.25M2.5 8h1.25M12.25 8h1.25M4.1 4.1l.9.9M11 11l.9.9M11.9 4.1l-.9.9M5 11l-.9.9" /></>}
      {icon === "videos" && <><rect x="2.25" y="4" width="8.5" height="8" rx="1" /><path d="m10.75 6 3-1.5v7l-3-1.5ZM5.75 6.5l2.5 1.5-2.5 1.5Z" /></>}
      {icon === "work" && <><rect x="2.25" y="5.5" width="11.5" height="8" rx="1.25" /><path d="M6 5.5V4.25c0-.7.55-1.25 1.25-1.25h1.5c.7 0 1.25.55 1.25 1.25V5.5M2.25 8.5h11.5M6.75 8.5v1h2.5v-1" /></>}
    </g>
  );
}

/**
 * Every gradient the glyphs reference, emitted once per document. SVG paint
 * servers resolve document-wide, so `fill="url(#g-code)"` finds these from any
 * other <svg> on the page.
 */
export function GlyphDefs() {
  return (
    <svg className="glyph-defs" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="g-folder-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--folder-2)" />
          <stop offset="1" stopColor="var(--folder-3)" />
        </linearGradient>
        <linearGradient id="g-folder-front" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="var(--folder-1)" />
          <stop offset="1" stopColor="var(--folder-2)" />
        </linearGradient>
        <linearGradient id="g-sheet" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="var(--sheet-1)" />
          <stop offset="1" stopColor="var(--sheet-2)" />
        </linearGradient>

        {/* Every peek card is the same rectangle before its own rotation, so one
            clip serves all of them: a clip path is read in the user space of the
            element referencing it, and so turns with the card it crops. */}
        <clipPath id="g-peek-card">
          <rect x={PEEK_CARD.x} y={PEEK_CARD.y} width={PEEK_CARD.w} height={PEEK_CARD.h} rx="2" />
        </clipPath>

        <CatGradient id="g-code" from="#a78bfa" to="#6d28d9" />
        <CatGradient id="g-config" from="#a1a1aa" to="#5f5f68" />
        <CatGradient id="g-image" from="#4ade80" to="#16a34a" />
        <CatGradient id="g-media" from="#fb7185" to="#d61f60" />
        <CatGradient id="g-doc" from="#4facff" to="#0060df" />
        <CatGradient id="g-archive" from="#fbbf4d" to="#e07b00" />
        <CatGradient id="g-link" from="#2dd4bf" to="#0d8a80" />
        <CatGradient id="g-plain" from="#b4b4bb" to="#84848c" />
      </defs>
    </svg>
  );
}

function CatGradient({ id, from, to }: { id: string; from: string; to: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stopColor={from} />
      <stop offset="1" stopColor={to} />
    </linearGradient>
  );
}
