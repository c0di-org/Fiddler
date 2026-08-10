import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

import { formatSize } from "../format";
import * as ipc from "../ipc";
import { kindOf } from "../kind";
import { isTextual, routeOf } from "../preview/route";
import type { Entry, TextHead } from "../types";
import { CodeView } from "./CodeView";
import { FileGlyph, FolderGlyph } from "./FileGlyph";
import { MarkdownView } from "./MarkdownView";
import { PdfView } from "./PdfView";

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

interface Props {
  entry: Entry;
  /** Position in the folder, for the counter and the arrow keys. */
  index: number;
  total: number;
  onStep: (delta: number) => void;
  onClose: () => void;
}

export function QuickLook({ entry, index, total, onStep, onClose }: Props) {
  const route = routeOf(entry.name);
  const isDir = entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);

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
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void openPath(entry.path);
      }
    };
    // Capture, so the browser's own shortcuts see these last.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, step, entry.path]);

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
          <button className="ql-open" onClick={() => void openPath(entry.path)}>
            Open
          </button>
        </header>

        <div className="ql-body">
          <Body entry={entry} route={route} isDir={isDir} page={page} onPages={setPages} />
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
}: {
  entry: Entry;
  route: ReturnType<typeof routeOf>;
  isDir: boolean;
  page: number;
  onPages: (n: number) => void;
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

  if (route === "audio") return <Audio entry={entry} />;

  if (route === "video") return <Video entry={entry} />;

  if (isTextual(route)) {
    return <Text entry={entry} route={route} />;
  }

  // Extensions are only hints. A surprising number of useful files have an
  // in-house suffix (or none at all), so give any non-binary file the same
  // bounded reader as .txt rather than making Quick Look a dead end.
  return <Text entry={entry} route="text" />;
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
          <img src={convertFileSrc(cover)} alt="" draggable={false} />
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

  useEffect(() => {
    let alive = true;
    setSrc(null);
    void ipc
      .thumbnail(entry.path, PICTURE_PX)
      .then((p) => alive && setSrc(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [entry.path]);

  if (!src) {
    return (
      <div className="ql-plain">
        <FileGlyph entry={entry} size={200} />
        <p className="ql-note">This file has no image preview</p>
      </div>
    );
  }
  return (
    <div className="ql-picture">
      <img src={convertFileSrc(src)} alt="" draggable={false} />
    </div>
  );
}

function Audio({ entry }: { entry: Entry }) {
  return (
    <div className="ql-media ql-audio">
      <FileGlyph entry={entry} size={180} />
      <audio controls preload="metadata" src={convertFileSrc(entry.path)}>
        Your Android device can’t play this audio format.
      </audio>
    </div>
  );
}

function Video({ entry }: { entry: Entry }) {
  return (
    <div className="ql-media ql-video">
      <video controls preload="metadata" src={convertFileSrc(entry.path)}>
        Your Android device can’t play this video format.
      </video>
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
