import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatSize, formatStamp } from "../format";
import { kindOf } from "../kind";
import type { Row, SortKey } from "../store/tree";
import { Thumb } from "./Thumb";
import { GitDot } from "./GitDot";
import { EmptyState } from "./EmptyState";
import { Chevron, ForkIcon, LockIcon, WarnIcon } from "./icons";

/** Finder's list view: dense, sortable, with disclosure triangles. */

export const ROW_H = 34;
const OVERSCAN = 12;

const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
  { key: "name", label: "Name", cls: "c-name" },
  { key: "modified", label: "Date Modified", cls: "c-when" },
  { key: "size", label: "Size", cls: "c-size" },
  { key: "kind", label: "Kind", cls: "c-kind" },
];

interface Props {
  rows: Row[];
  selection: Set<string>;
  renamingId: string | null;
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onToggle: (row: Row) => void;
  onOpen: (row: Row) => void;
  onContextMenu: (row: Row | null, x: number, y: number) => void;
  onRenameCommit: (row: Row, name: string) => void;
  onRenameCancel: () => void;
  onBackgroundClick: () => void;
  emptyMessage: string;
  /** Suppresses the empty state while a listing is still in flight. */
  loaded: boolean;
}

export function DetailList(props: Props) {
  const { rows, selection, renamingId } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);
  const slice = useMemo(() => rows.slice(first, last), [rows, first, last]);

  const byId = useMemo(() => {
    const m = new Map<string, Row>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  // Keep the keyboard cursor in view.
  const lead = useMemo(() => [...selection].pop() ?? null, [selection]);
  useEffect(() => {
    if (!lead) return;
    const idx = rows.findIndex((r) => r.id === lead);
    const el = scrollerRef.current;
    if (idx < 0 || !el) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_H - el.clientHeight;
    }
  }, [lead, rows]);

  const rowFrom = (e: React.MouseEvent): Row | null => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    return host ? (byId.get(host.dataset.rowId!) ?? null) : null;
  };

  return (
    <div className="list-view">
      <div className="list-header">
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            className={`lh ${c.cls} ${props.sortKey === c.key ? "sorted" : ""}`}
            onClick={() => props.onSort(c.key)}
          >
            {c.label}
            {props.sortKey === c.key && <i className={props.sortAsc ? "asc" : "desc"} />}
          </button>
        ))}
      </div>

      <div
        className="list-scroller"
        ref={scrollerRef}
        onScroll={onScroll}
        onClick={(e) => {
          const row = rowFrom(e);
          if (!row) {
            props.onBackgroundClick();
            return;
          }
          if ((e.target as HTMLElement).closest("[data-twisty]")) props.onToggle(row);
          else props.onSelect(row.id, e);
        }}
        onDoubleClick={(e) => {
          const row = rowFrom(e);
          if (row) props.onOpen(row);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const row = rowFrom(e);
          if (row) props.onSelect(row.id, e);
          props.onContextMenu(row, e.clientX, e.clientY);
        }}
      >
        <div className="list-sizer" style={{ height: rows.length * ROW_H }}>
          <div className="list-window" style={{ transform: `translateY(${first * ROW_H}px)` }}>
            {slice.map((row) => (
              <RowView
                key={row.id}
                row={row}
                selected={selection.has(row.id)}
                renaming={row.id === renamingId}
                onRenameCommit={props.onRenameCommit}
                onRenameCancel={props.onRenameCancel}
              />
            ))}
          </div>
        </div>
        {rows.length === 0 && props.loaded && <EmptyState message={props.emptyMessage} />}
      </div>
    </div>
  );
}

function RowView({
  row,
  selected,
  renaming,
  onRenameCommit,
  onRenameCancel,
}: {
  row: Row;
  selected: boolean;
  renaming: boolean;
  onRenameCommit: (row: Row, name: string) => void;
  onRenameCancel: () => void;
}) {
  const expandable = row.kind === "wt-group" || row.dirPath !== null;
  const e = row.kind === "entry" ? row.entry : null;

  const name =
    row.kind === "entry"
      ? row.entry.name
      : row.kind === "wt-group"
        ? `Worktrees (${row.count})`
        : row.wt.name;

  const muted = e ? e.code?.index === "!" || e.hidden : row.kind === "worktree" && row.wt.prunable;

  return (
    <div
      className={`lrow ${selected ? "selected" : ""} ${muted ? "muted" : ""} ${
        row.kind === "wt-group" ? "section" : ""
      }`}
      data-row-id={row.id}
      style={{ height: ROW_H }}
    >
      <div className="c-name" style={{ paddingLeft: 6 + row.depth * 17 }}>
        <span
          className={`twisty ${expandable ? "" : "hidden"} ${row.expanded ? "open" : ""}`}
          data-twisty
        >
          <Chevron size={11} />
        </span>

        <span className="lrow-icon">
          {e ? <Thumb entry={e} size={22} /> : <ForkIcon size={18} />}
        </span>

        {renaming ? (
          <RenameInput initial={name} onCommit={(v) => onRenameCommit(row, v)} onCancel={onRenameCancel} />
        ) : (
          <span className="lrow-name">{name}</span>
        )}

        <GitDot code={e?.code} rollup={e?.rollup} withCount />

        {e?.isRepo && e.branch && (
          <span className="tag tag-branch" title={e.branch}>
            <span>{e.branch}</span>
          </span>
        )}
        {row.kind === "worktree" && (
          <>
            <span className="tag tag-branch">
              <span>{row.wt.detached ? (row.wt.head ?? "detached") : row.wt.branch}</span>
            </span>
            {row.wt.external && (
              <span className="tag alt" title={row.wt.path}>
                elsewhere
              </span>
            )}
            {row.wt.locked && (
              <span className="tag" title={row.wt.lockReason ?? "Locked"}>
                <LockIcon size={10} />
              </span>
            )}
            {row.wt.prunable && (
              <span className="tag warn" title="This folder no longer exists on disk">
                <WarnIcon size={10} />
                missing
              </span>
            )}
          </>
        )}
      </div>

      <div className="c-when">{e ? formatStamp(e.mtime) : ""}</div>
      <div className="c-size">{e ? formatSize(e.size, e.kind === "dir") : ""}</div>
      <div className="c-kind">{e ? kindOf(e) : row.kind === "worktree" ? "Worktree" : ""}</div>
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
      }}
    />
  );
}
