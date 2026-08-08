import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { formatSize, formatStamp } from "../format";
import * as ipc from "../ipc";
import { kindOf } from "../kind";
import type { Entry, Inspect, WorktreeInfo } from "../types";
import { FileGlyph, FolderGlyph } from "./FileGlyph";
import { GitDot } from "./GitDot";

/**
 * Finder's preview pane: a large look at whatever is selected, plus the details
 * you'd otherwise open Get Info for. Text files show their opening lines, which
 * is the thing a plain file browser can never do for you.
 */

const ART = 232;

interface Props {
  entry?: Entry;
  worktree?: WorktreeInfo;
  /** How many things are selected — the pane only previews a single item. */
  count: number;
}

export function PreviewPane({ entry, worktree, count }: Props) {
  const path = entry?.path ?? worktree?.path ?? null;
  const [thumb, setThumb] = useState<string | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);

  useEffect(() => {
    setThumb(null);
    setInfo(null);
    if (!path || count !== 1) return;

    let alive = true;
    if (entry?.thumbable) {
      void ipc
        .thumbnail(path, 512)
        .then((r) => alive && setThumb(r))
        .catch(() => {});
    }
    void ipc
      .inspect(path)
      .then((r) => alive && setInfo(r))
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [path, count, entry?.thumbable]);

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
      <div className="preview-art">
        {thumb ? (
          <img src={convertFileSrc(thumb)} alt="" draggable={false} />
        ) : entry ? (
          <FileGlyph entry={entry} size={ART} />
        ) : (
          <FolderGlyph size={ART} repo />
        )}
      </div>

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

      {info?.text && (
        <pre className="preview-text">{info.text}</pre>
      )}

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
