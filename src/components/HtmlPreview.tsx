import { useEffect, useState } from "react";

import { formatSize } from "../format";
import * as ipc from "../ipc";
import type { Entry, TextHead } from "../types";
import { CodeView } from "./CodeView";

/** Source is optional; the rendered page is the default view. Keep both reads
 * bounded so asking to see source never turns Quick Look into an editor-sized
 * file load. */
const SOURCE_BYTES = 512 * 1024;
const DENSE_SOURCE_BYTES = 24 * 1024;

type Mode = "rendered" | "source";

interface Props {
  entry: Entry;
  /** The compact presentation used by the side preview pane. */
  dense?: boolean;
}

/**
 * Render an HTML file as a page, with source one tap away.
 *
 * The iframe uses the same file URL as audio/video previews, which matters for
 * native builds: relative CSS, images and other sibling assets keep resolving
 * from the HTML file's real folder. It is sandboxed without script privileges
 * because Quick Look is a viewer, and opening an arbitrary file from Downloads
 * must not execute code just because it was selected.
 */
export function HtmlPreview({ entry, dense = false }: Props) {
  const [mode, setMode] = useState<Mode>("rendered");
  const [url, setUrl] = useState<string | null>(null);
  const [head, setHead] = useState<TextHead | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMode("rendered");
    setUrl(null);
    setHead(null);
    setFailed(false);
  }, [entry.path]);

  useEffect(() => {
    if (mode !== "rendered" || url || failed) return;
    let alive = true;
    void ipc
      .htmlUrl(entry.path)
      .then((resolved) => {
        if (alive) setUrl(resolved);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [entry.path, failed, mode, url]);

  useEffect(() => {
    if (mode !== "source" || head || failed) return;
    let alive = true;
    void ipc
      .readText(entry.path, dense ? DENSE_SOURCE_BYTES : SOURCE_BYTES)
      .then((text) => {
        if (alive) setHead(text);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [dense, entry.path, failed, head, mode]);

  return (
    <div className={`html-preview${dense ? " dense" : ""}`}>
      <div className="html-preview-switch" role="group" aria-label="HTML preview mode">
        <button
          className={mode === "rendered" ? "active" : undefined}
          aria-pressed={mode === "rendered"}
          onClick={() => {
            setFailed(false);
            setMode("rendered");
          }}
        >
          Rendered
        </button>
        <button
          className={mode === "source" ? "active" : undefined}
          aria-pressed={mode === "source"}
          onClick={() => {
            setFailed(false);
            setMode("source");
          }}
        >
          Source
        </button>
      </div>

      {failed ? (
        <div className="html-preview-status">This HTML file couldn’t be previewed</div>
      ) : mode === "rendered" ? (
        url ? (
          <iframe
            className="html-preview-frame"
            src={url}
            title={`Rendered preview of ${entry.name}`}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="html-preview-status" />
        )
      ) : head ? (
        head.binary ? (
          <div className="html-preview-status">This file isn’t text</div>
        ) : (
          <>
            <CodeView name={entry.name} text={head.text} dense={dense} gutter={!dense} />
            {head.truncated && (
              <div className="html-preview-truncated">
                Showing the first {formatSize(dense ? DENSE_SOURCE_BYTES : SOURCE_BYTES, false)} of{" "}
                {formatSize(head.bytes, false)}
              </div>
            )}
          </>
        )
      ) : (
        <div className="html-preview-status" />
      )}
    </div>
  );
}
