import { useCallback, useEffect, useRef, useState } from "react";

import { trackTitle } from "../audio/book";
import { markFor, progressOf } from "../audio/positions";
import { clock, span } from "../audio/time";
import { useAudioMarks } from "../audio/use-player";
import { formatSize } from "../format";
import * as ipc from "../ipc";
import { kindOf } from "../kind";
import { LINK_LABEL, parseShortcut, type Shortcut } from "../preview/link";
import { caps, platform } from "../platform";
import { isTextual, routeOf } from "../preview/route";
import type { Entry, TextHead } from "../types";
import { CodeView } from "./CodeView";
import { FileGlyph, FolderGlyph } from "./FileGlyph";
import { BookIcon, Chevron, ChevronLeft, LinkMark, MoreIcon, PlayIcon, ShareIcon, WandIcon } from "./icons";
import { MarkdownView } from "./MarkdownView";
import { PdfView } from "./PdfView";
import { ZoomableImage } from "./ZoomableImage";

/** A shortcut that needs more than this is not a shortcut. */
const LINK_BYTES = 8 * 1024;

/**
 * The big look: space bar over a selected file.
 *
 * The preview pane answers "what is this?" in a column narrow enough to live
 * beside the folder. This answers "what's in it?" — a README rendered, a source
 * file highlighted, a PDF you can page through — without leaving the browser or
 * waiting for an application to launch.
 *
 * Arrow keys move through the folder, so holding one is a way to flip through a
 * directory of documents. That only works if opening a file is cheap, which is
 * the whole reason the readers underneath are bounded and cached.
 */

/** How much of a text file the reader gets. Past this, nobody is reading. */
const HEAD_BYTES = 512 * 1024;

/**
 * Longest side for a picture at this size. Everything goes through a render
 * rather than loading the original: ImageIO decodes a 40-megapixel photo
 * straight to this size, where handing the file to the webview would make it
 * expand the whole thing first.
 */
const PICTURE_PX = 2048;
/** A sharper render is fetched only after zoom begins, so fit-to-window stays cheap. */
const PICTURE_DETAIL_PX = 4096;

interface Props {
  entry: Entry;
  /** Position in the folder, for the counter and the arrow keys. */
  index: number;
  total: number;
  onStep: (delta: number) => void;
  onClose: () => void;
  /** Hand this file to the system's share sheet. Absent where there is none. */
  onShare?: () => void;
  /** The full menu for this file. Quick Look covers the view that would
   * otherwise be right-clicked for it, so without this the verbs are simply
   * unreachable from here — and on a phone here is where a tap lands you. */
  onMore?: (x: number, y: number) => void;
  /** Promote this file to the full-screen reader. Only ever passed for the
   * routes that have one, which today means PDFs. */
  onRead?: () => void;
  /** Take this picture into the editor. Passed only for the image route, and
   * the reason Quick Look now has two promotions rather than one: a document is
   * something you go on to read, and a photograph is something you go on to
   * change, and neither is the other. */
  onEdit?: () => void;
  /** Hand this recording to the player that outlives the preview. Passed only
   * for the audio route, and absent where there is no folder behind the file
   * to make a queue out of. */
  onPlay?: () => void;
}

export function QuickLook({ entry, index, total, onStep, onClose, onShare, onMore, onRead, onEdit, onPlay }: Props) {
  const route = routeOf(entry.name);
  const isDir = entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => setPage(1), [entry.path]);

  const step = useCallback(
    (delta: number) => {
      // Inside a multi-page PDF the arrows page the document first, and only
      // move on to the next file once you reach the end of it.
      if (route === "pdf" && pages > 1) {
        const next = page + delta;
        if (next >= 1 && next <= pages) {
          setPage(next);
          return;
        }
      }
      onStep(delta);
    },
    [route, page, pages, onStep]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || isSpaceKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        step(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        step(-1);
      } else if (e.key === "Enter" && onEdit) {
        // A picture's better destination is the editor, on every platform —
        // including the two that have nowhere else to send it.
        e.preventDefault();
        e.stopPropagation();
        onEdit();
      } else if (e.key === "Enter" && onRead) {
        // A PDF has somewhere better to go than the desktop: its own reader,
        // on every platform including the two with no desktop to go to.
        e.preventDefault();
        e.stopPropagation();
        onRead();
      } else if (e.key === "Enter" && platform !== "android") {
        // Tauri's opener accepts file paths on desktop, but Android's plugin
        // only accepts URLs. Keeping a dead Enter/Open affordance is worse than
        // leaving the file in Fiddler, where Share and More still work.
        e.preventDefault();
        e.stopPropagation();
        void ipc.openExternal(entry.path);
      }
    };
    // Capture, so the browser's own shortcuts see these last.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, step, entry.path, onRead, onEdit]);

  return (
    <div className="ql-scrim" onClick={onClose}>
      <div className="ql" onClick={(e) => e.stopPropagation()}>
        <header className="ql-bar">
          <button className="ql-close" onClick={onClose} title="Close (space)" aria-label="Close">
            ✕
          </button>
          <div className="ql-title">
            <span className="ql-name">{entry.name}</span>
            <span className="ql-sub">
              {kindOf(entry)}
              {!isDir && ` · ${formatSize(entry.size, false)}`}
              {route === "pdf" && pages > 1 && ` · page ${page} of ${pages}`}
              {total > 1 && ` · ${index + 1} of ${total}`}
            </span>
          </div>
          {/* On a phone this bar is where a tap lands you, which makes it the
              one place a file is reliably in your hands — so the verb everyone
              reaches for next belongs here rather than three gestures back in
              the grid. Folders are left out: neither sheet takes one. */}
          {caps.share && onShare && !isDir && (
            <button className="ql-share" onClick={onShare} title="Share…" aria-label="Share">
              <ShareIcon size={17} />
            </button>
          )}
          {onMore && (
            <button
              className="ql-more"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onMore(r.left, r.bottom + 4);
              }}
              title="More…"
              aria-label="More actions"
            >
              <MoreIcon size={17} />
            </button>
          )}
          {onEdit ? (
            <button className="ql-open ql-read" onClick={onEdit}>
              <WandIcon size={13} />
              Edit
            </button>
          ) : onRead ? (
            <button className="ql-open ql-read" onClick={onRead}>
              <BookIcon size={13} />
              Read
            </button>
          ) : (
            platform !== "android" && (
              <button className="ql-open" onClick={() => void ipc.openExternal(entry.path)}>
                Open
              </button>
            )
          )}
        </header>

        <div
          className="ql-body"
          // Flipping through a folder of documents is the feature's stated
          // purpose, and until now a finger had no way to do it: prev/next
          // were arrow keys only. A horizontal flick steps files (and pages,
          // inside a PDF — `step` already prefers the document).
          onPointerDown={(e) => {
            if (e.pointerType !== "touch" || !e.isPrimary) return;
            swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
          }}
          onPointerUp={(e) => {
            const start = swipe.current;
            swipe.current = null;
            if (!start || start.id !== e.pointerId) return;
            const target = e.target as HTMLElement;
            // A zoomed picture pans, a media scrubber scrubs, and a wide code
            // or CSV preview scrolls sideways; none of those horizontal drags
            // mean "next file".
            if (target.closest('[data-zoomed="true"], video, audio')) return;
            if (pansHorizontally(target)) return;
            const dx = e.clientX - start.x;
            const dy = e.clientY - start.y;
            if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
            step(dx < 0 ? 1 : -1);
          }}
          onPointerCancel={() => {
            swipe.current = null;
          }}
        >
          <Body entry={entry} route={route} isDir={isDir} page={page} onPages={setPages} onPlay={onPlay} />
          {total > 1 && (
            // The same steps, visible: on a tablet the swipe needs something
            // that says it exists, and a mouse on DeX has no arrow keys under
            // its hand. Hidden on fine pointers by CSS.
            <>
              <button
                className="ql-step prev"
                onClick={() => step(-1)}
                disabled={index <= 0 && !(route === "pdf" && page > 1)}
                aria-label="Previous file"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="ql-step next"
                onClick={() => step(1)}
                disabled={index >= total - 1 && !(route === "pdf" && page < pages)}
                aria-label="Next file"
              >
                <Chevron size={18} />
              </button>
            </>
          )}
          {route === "pdf" && pages > 1 && (
            // Paging used to be arrow keys and nothing else, which on a phone
            // is not a way through a document at all.
            <div className="ql-pager">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Back a page"
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                {page} <i>/</i> {pages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
                aria-label="On a page"
              >
                <Chevron size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Body({
  entry,
  route,
  isDir,
  page,
  onPages,
  onPlay,
}: {
  entry: Entry;
  route: ReturnType<typeof routeOf>;
  isDir: boolean;
  page: number;
  onPages: (n: number) => void;
  onPlay?: () => void;
}) {
  if (isDir) {
    return <Folder entry={entry} />;
  }

  if (route === "pdf") {
    return <PdfView path={entry.path} page={page} onPages={onPages} />;
  }

  if (route === "image" || route === "art") {
    return <Picture entry={entry} />;
  }

  if (route === "audio") return <Audio entry={entry} onPlay={onPlay} />;

  if (route === "video") return <Video entry={entry} />;

  if (route === "link") return <Link entry={entry} />;

  if (isTextual(route)) {
    return <Text entry={entry} route={route} />;
  }

  // Extensions are only hints. A surprising number of useful files have an
  // in-house suffix (or none at all), so give any non-binary file the same
  // bounded reader as .txt rather than making Quick Look a dead end.
  return <Text entry={entry} route="text" />;
}

/** Whether anything between the touch and the viewer body scrolls sideways —
 * in which case the drag was that scroll, not a step to the next file. */
function pansHorizontally(from: HTMLElement | null): boolean {
  for (let node = from; node && !node.classList.contains("ql-body"); node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}

function isSpaceKey(e: KeyboardEvent) {
  // Some Android/DeX keyboards still report the legacy key value. `code` is
  // layout-independent and catches physical space bars that report neither.
  return e.key === " " || e.key === "Spacebar" || e.key === "Space" || e.code === "Space";
}

/**
 * A folder, at the size the window can give it.
 *
 * It asks for a thumbnail the same way everything else does. Today nothing
 * answers for a directory and it falls through to the glyph — but a folder that
 * has a cover, whether that's a custom icon or something composed from what's
 * inside it, will show it here at full size without this needing to change.
 */
function Folder({ entry }: { entry: Entry }) {
  const [cover, setCover] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [children, setChildren] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setCover(null);
    setCount(null);
    setChildren([]);
    setLoaded(false);
    void ipc
      .thumbnail(entry.path, PICTURE_PX)
      .then((p) => alive && setCover(p))
      .catch(() => {});
    void ipc
      .inspect(entry.path)
      .then((i) => alive && setCount(i.childCount))
      .catch(() => {});
    // A folder's Quick Look is a compact, visual answer to "what's in here?".
    // The regular scan already filters Finder detritus and gives us the same
    // icons as the main browser, so keep the preview faithful to the folder.
    void ipc
      .listDir(entry.path, false)
      .then((listing) => {
        if (!alive) return;
        setChildren(listing.entries.slice(0, 20));
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [entry.path]);

  return (
    <div className="ql-folder">
      <div className="ql-folder-art">
        {cover ? (
          <img src={ipc.fileSrc(cover)} alt="" draggable={false} />
        ) : (
          // Drawn big and scaled down by CSS, so it fills whatever the window has
          // rather than sitting at one fixed size in the middle of it.
          <FolderGlyph size={512} repo={entry.isRepo} name={entry.name} />
        )}
        {count !== null && (
          <p className="ql-note">
            {count} item{count === 1 ? "" : "s"}
          </p>
        )}
      </div>

      <section className="ql-folder-contents" aria-label="Folder contents">
        {children.length > 0 ? (
          <div className="ql-folder-grid">
            {children.map((child) => (
              <div className="ql-folder-item" key={child.path} title={child.name}>
                <FileGlyph entry={child} size={72} />
                <span>{child.name}</span>
              </div>
            ))}
          </div>
        ) : (
          loaded && <p className="ql-note">This folder is empty</p>
        )}
      </section>
    </div>
  );
}

function Picture({ entry }: { entry: Entry }) {
  const [src, setSrc] = useState<string | null>(null);
  const [detailRequested, setDetailRequested] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setDetailRequested(false);
    void ipc
      .thumbnail(entry.path, PICTURE_PX)
      .then((p) => alive && setSrc(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [entry.path]);

  useEffect(() => {
    if (!detailRequested) return;
    let alive = true;
    void ipc
      .thumbnail(entry.path, PICTURE_DETAIL_PX)
      .then((p) => {
        if (alive && p) setSrc(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [detailRequested, entry.path]);

  const requestDetail = useCallback((zoom: number) => {
    if (zoom > 1.05) setDetailRequested(true);
    // Tells the swipe handler above that horizontal drags are pans now.
    setZoomed(zoom > 1.02);
  }, []);

  if (!src) {
    return (
      <div className="ql-plain">
        <FileGlyph entry={entry} size={200} />
        <p className="ql-note">This file has no image preview</p>
      </div>
    );
  }
  return (
    <div className="ql-picture" data-zoomed={zoomed ? "true" : undefined}>
      <ZoomableImage
        src={ipc.fileSrc(src)}
        resetKey={entry.path}
        onZoomChange={requestDetail}
      />
    </div>
  );
}

/** A shortcut is the one file whose whole content is a destination, so the
 * preview *is* the button. The URL is shown in full above it: following a link
 * you can't see first is a thing to be asked, not assumed. */
function Link({ entry }: { entry: Entry }) {
  const [shortcut, setShortcut] = useState<Shortcut | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setShortcut(undefined);
    void ipc
      .readText(entry.path, LINK_BYTES)
      .then((head) => alive && setShortcut(parseShortcut(head.text)))
      .catch(() => alive && setShortcut(null));
    return () => {
      alive = false;
    };
  }, [entry.path]);

  if (shortcut === undefined) return <div className="ql-empty" />;

  if (!shortcut) {
    return (
      <div className="ql-empty">
        <FileGlyph entry={entry} size={160} />
        <p>This shortcut doesn’t point anywhere Fiddler will open</p>
      </div>
    );
  }

  const title = entry.name.replace(/\.(url|webloc)$/i, "");

  return (
    <div className="ql-link">
      <LinkMark kind={shortcut.kind} size={92} className="link-mark" />
      <h2>{title}</h2>
      <p className="ql-link-kind">{LINK_LABEL[shortcut.kind]}</p>
      <button className="ql-link-go" onClick={() => void ipc.openExternal(shortcut.url)}>
        Open in a new tab
      </button>
      <p className="ql-link-url">{shortcut.url}</p>
    </div>
  );
}

/** Media is the one preview whose source isn't something the backend already
 * rendered for us — it's the file itself, streamed. On the desktop that URL is
 * there for the asking; in a browser the bytes have to be read first, so both
 * go through the same await rather than the web build growing a special case. */
function useMediaUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    void ipc
      .mediaUrl(path)
      .then((resolved) => alive && setUrl(resolved))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}

/**
 * Audio in Quick Look, which is a door rather than a player.
 *
 * There used to be a bare `<audio controls>` here, and it was the wrong shape
 * in a way no amount of styling fixes: the element dies with the preview, so
 * pressing play and then pressing Escape — or the arrow key that moves to the
 * next file, which is what Quick Look is *for* — stopped the sound. A preview
 * of a four-hour recording that can only play while you stare at it is not a
 * preview of a recording.
 *
 * So this says what the file is, says where you got to, and hands it to the
 * player that outlives the preview. One button.
 */
function Audio({ entry, onPlay }: { entry: Entry; onPlay?: () => void }) {
  const marks = useAudioMarks();
  const mark = markFor(marks, entry.path);
  const done = progressOf(mark);
  const resume = mark && !mark.done ? mark.at : 0;

  return (
    <div className="ql-media ql-audio">
      <FileGlyph entry={entry} size={180} />
      <div className="ql-audio-name">{trackTitle(entry.name)}</div>
      {mark && mark.duration > 0 && (
        <>
          <div className="ql-audio-bar">
            <span style={{ width: `${Math.round((done ?? 0) * 100)}%` }} />
          </div>
          <div className="ql-audio-note">
            {mark.done
              ? `Finished · ${clock(mark.duration)}`
              : `${clock(resume)} of ${clock(mark.duration)} · ${span(mark.duration - resume)} left`}
          </div>
        </>
      )}
      {onPlay && (
        <button className="ql-audio-play" onClick={onPlay}>
          <PlayIcon size={15} />
          {resume > 0 ? `Resume from ${clock(resume)}` : "Play"}
        </button>
      )}
    </div>
  );
}

function Video({ entry }: { entry: Entry }) {
  const src = useMediaUrl(entry.path);
  return (
    <div className="ql-media ql-video">
      {src && (
        <video controls preload="metadata" src={src}>
          This device can’t play this video format.
        </video>
      )}
    </div>
  );
}

function Text({ entry, route }: { entry: Entry; route: "markdown" | "code" | "text" }) {
  const [head, setHead] = useState<TextHead | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setHead(null);
    setFailed(false);
    ipc
      .readText(entry.path, HEAD_BYTES)
      .then((h) => alive && setHead(h))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [entry.path]);

  if (failed) return <div className="ql-plain ql-note">This file couldn’t be read</div>;
  if (!head) return <div className="ql-plain" />;
  if (head.binary) {
    return (
      <div className="ql-plain">
        <FileGlyph entry={entry} size={200} />
        <p className="ql-note">This file isn’t text</p>
      </div>
    );
  }

  return (
    <>
      {route === "markdown" ? (
        <div className="ql-doc">
          <MarkdownView path={entry.path} source={head.text} />
        </div>
      ) : (
        <CodeView name={entry.name} text={head.text} wrap={route === "text"} gutter={route === "code"} />
      )}
      {head.truncated && (
        <div className="ql-truncated">
          Showing the first {formatSize(HEAD_BYTES, false)} of {formatSize(head.bytes, false)}
        </div>
      )}
    </>
  );
}
