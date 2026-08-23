import { useEffect, useState } from "react";

import { formatSize, formatStamp } from "../format";
import * as ipc from "../ipc";
import { kindOf } from "../kind";
import { isTextual, routeOf } from "../preview/route";
import type { Entry, Inspect, TextHead, WorktreeInfo } from "../types";
import { CodeView } from "./CodeView";
import { FileGlyph, FolderGlyph } from "./FileGlyph";
import { BookIcon } from "./icons";
import { GitDot } from "./GitDot";
import { MarkdownView } from "./MarkdownView";

/**
 * Finder's preview pane: a large look at whatever is selected, plus the details
 * you'd otherwise open Get Info for. Text files show their opening lines — a
 * README rendered, a source file highlighted — which is the thing a plain file
 * browser can never do for you. Space opens the same content full size.
 */

const ART = 200;

/**
 * How much of a text file the pane reads. A column this narrow shows a screen or
 * two whatever we fetch, so fetching more would only cost the scroll a stall.
 */
const HEAD_BYTES = 24 * 1024;

interface Props {
  entry?: Entry;
  worktree?: WorktreeInfo;
  /** How many things are selected — the pane only previews a single item. */
  count: number;
  /** Open this file in the full reader. Passed only for the routes that have
   * one, which today means PDFs. */
  onRead?: () => void;
}

export function PreviewPane({ entry, worktree, count, onRead }: Props) {
  const path = entry?.path ?? worktree?.path ?? null;
  const route = entry ? routeOf(entry.name) : "none";
  // Text reads better as text than as a picture of text, so files that have
  // something to say skip the thumbnail entirely.
  const asText = !!entry && entry.kind !== "dir" && isTextual(route);

  const [thumb, setThumb] = useState<string | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [head, setHead] = useState<TextHead | null>(null);

  useEffect(() => {
    setThumb(null);
    setInfo(null);
    setHead(null);
    if (!path || count !== 1) return;

    let alive = true;
    if (entry?.thumbable && !asText) {
      void ipc
        .thumbnail(path, 512)
        .then((r) => alive && setThumb(r))
        .catch(() => {});
    }
    if (asText) {
      void ipc
        .readText(path, HEAD_BYTES)
        .then((r) => alive && setHead(r))
        .catch(() => {});
    }
    void ipc
      .inspect(path)
      .then((r) => alive && setInfo(r))
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [path, count, entry?.thumbable, asText]);

  if (count === 0) {
    return (
      <aside className="preview">
        <div className="preview-none">Nothing selected</div>
      </aside>
    );
  }

  if (count > 1) {
    return (
      <aside className="preview">
        <div className="preview-none">{count} items selected</div>
      </aside>
    );
  }

  const name = entry?.name ?? worktree?.name ?? "";
  const isDir = entry ? entry.kind === "dir" : true;

  return (
    <aside className="preview">
      {asText && entry && head && !head.binary ? (
        // Markdown scrolls as one flowed document; code keeps its own scroller
        // so the virtualization has a viewport it can measure.
        route === "markdown" ? (
          <div className="preview-doc">
            <MarkdownView path={entry.path} source={head.text} dense />
          </div>
        ) : (
          <div className="preview-code">
            <CodeView name={entry.name} text={head.text} wrap={route === "text"} dense />
          </div>
        )
      ) : (
        <div className="preview-art">
          {thumb ? (
            <img
              className={route === "link" ? "art-alpha" : undefined}
              src={ipc.fileSrc(thumb)}
              alt=""
              draggable={false}
            />
          ) : entry ? (
            <FileGlyph entry={entry} size={ART} />
          ) : (
            <FolderGlyph size={ART} repo name={worktree?.name} />
          )}
        </div>
      )}

      {/* The pane shows page one, which is the right answer to "what is this?"
          and no answer at all to "what's in it?". This is the door to the rest
          of the document, in the one place someone looking at page one is
          already looking. */}
      {route === "pdf" && onRead && (
        <button className="preview-read" onClick={onRead}>
          <BookIcon size={13} />
          Read
        </button>
      )}

      <div className="preview-name">{name}</div>
      <div className="preview-kind">
        {entry ? kindOf(entry) : "Worktree"}
        {info?.childCount != null && ` · ${info.childCount} item${info.childCount === 1 ? "" : "s"}`}
      </div>

      {entry && (entry.code || entry.rollup) && (
        <div className="preview-git">
          <GitDot code={entry.code} rollup={entry.rollup} withCount />
          <span>{gitWords(entry)}</span>
        </div>
      )}

      <dl className="preview-facts">
        {entry && !isDir && <Fact label="Size" value={formatSize(entry.size, false)} />}
        {entry && <Fact label="Modified" value={formatStamp(entry.mtime)} />}
        {entry?.isRepo && entry.branch && <Fact label="Branch" value={entry.branch} />}
        {worktree && (
          <>
            <Fact
              label="Branch"
              value={worktree.detached ? (worktree.head ?? "detached") : (worktree.branch ?? "—")}
            />
            <Fact label="Location" value={worktree.external ? "Outside the repo" : "Inside the repo"} />
            {worktree.locked && <Fact label="Locked" value={worktree.lockReason || "Yes"} />}
            {worktree.prunable && <Fact label="Status" value="Folder missing on disk" />}
          </>
        )}
      </dl>

      {/* Files with no route of their own still show their opening lines, which
          is how anything text-shaped but unrecognised stays readable. A PDF is
          excluded by name: an uncompressed one has no NUL bytes to be caught by
          the binary heuristic, and its object table is not its opening lines. */}
      {!asText && route !== "pdf" && info?.text && <pre className="preview-text">{info.text}</pre>}

      {path && <div className="preview-path">{path}</div>}
    </aside>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The same signal the dot carries, spelled out. */
function gitWords(e: Entry): string {
  if (e.code?.index === "!") return "Ignored by git";
  if (e.code?.index === "?") return "New — not tracked yet";
  if (e.code?.index === "u") return "Merge conflict";
  if (e.code) {
    const staged = e.code.index !== ".";
    const unstaged = e.code.worktree !== ".";
    if (staged && unstaged) return "Edited, partly staged";
    return staged ? "Staged" : "Edited";
  }
  if (e.rollup) {
    const bits: string[] = [];
    if (e.rollup.conflicted) bits.push(`${e.rollup.conflicted} conflicted`);
    if (e.rollup.modified) bits.push(`${e.rollup.modified} edited`);
    if (e.rollup.staged) bits.push(`${e.rollup.staged} staged`);
    if (e.rollup.deleted) bits.push(`${e.rollup.deleted} deleted`);
    if (e.rollup.untracked) bits.push(`${e.rollup.untracked} new`);
    return bits.join(", ");
  }
  return "";
}
