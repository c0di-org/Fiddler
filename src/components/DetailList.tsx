import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { formatSize, formatStamp } from "../format";
import { kindOf } from "../kind";
import type { Row, SortKey } from "../store/tree";
import { Thumb } from "./Thumb";
import { GitDot } from "./GitDot";
import { EmptyState } from "./EmptyState";
import { Chevron, ForkIcon, GripIcon, LockIcon, WarnIcon } from "./icons";
import { beginFolderDrag, endFolderDrag, FOLDER_DRAG_TYPE } from "../favorites";
import { type FolderTouchDragHandlers, useFolderTouchDrag } from "./folder-touch-drag";

/** Finder's list view: dense, sortable, with disclosure triangles. */

export const ROW_H = 34;
const OVERSCAN = 12;

const COLUMNS: { key: SortKey; label: string; min: number; width: number }[] = [
  { key: "name", label: "Name", min: 180, width: 300 },
  { key: "added", label: "Date Added", min: 130, width: 150 },
  { key: "modified", label: "Date Modified", min: 130, width: 150 },
  { key: "size", label: "Size", min: 64, width: 82 },
  { key: "kind", label: "Kind", min: 92, width: 132 },
];

type ColumnKey = (typeof COLUMNS)[number]["key"];
type ColumnWidths = Record<ColumnKey, number>;
const COLUMN_PREFS_KEY = "fiddler:list-columns:v1";

function defaultWidths(): ColumnWidths {
  return Object.fromEntries(COLUMNS.map((column) => [column.key, column.width])) as ColumnWidths;
}

function savedColumnPrefs(): { order: ColumnKey[]; widths: ColumnWidths } {
  const widths = defaultWidths();
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_KEY);
    if (!raw) return { order: COLUMNS.map((column) => column.key), widths };
    const saved = JSON.parse(raw) as { order?: unknown; widths?: Record<string, unknown> };
    const order = Array.isArray(saved.order)
      ? saved.order.filter((key): key is ColumnKey => COLUMNS.some((column) => column.key === key))
      : [];
    for (const column of COLUMNS) {
      const width = saved.widths?.[column.key];
      if (typeof width === "number" && Number.isFinite(width)) widths[column.key] = Math.max(column.min, width);
      if (!order.includes(column.key)) order.push(column.key);
    }
    return { order, widths };
  } catch {
    return { order: COLUMNS.map((column) => column.key), widths };
  }
}

interface Props {
  rows: Row[];
  /** Search results are ranked and flat, rather than an expandable tree. */
  searching: boolean;
  selection: Set<string>;
  /** Advances when keyboard navigation asks us to reveal the lead selection. */
  revealSelection: number;
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
  /** Android's WebView needs a touch implementation for folder drops. */
  touchFolderDrag?: FolderTouchDragHandlers;
}

export function DetailList(props: Props) {
  const { rows, selection, renamingId, revealSelection, searching } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [columnPrefs, setColumnPrefs] = useState(savedColumnPrefs);
  const draggedColumn = useRef<ColumnKey | null>(null);
  const suppressSort = useRef(false);

  useEffect(() => {
    localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(columnPrefs));
  }, [columnPrefs]);

  const columns = useMemo(
    () => columnPrefs.order.map((key) => COLUMNS.find((column) => column.key === key)!).filter(Boolean),
    [columnPrefs.order],
  );
  const columnStyle = useMemo<CSSProperties>(() => ({
    gridTemplateColumns: columns
      .map((column) =>
        column.key === "name"
          ? `minmax(${columnPrefs.widths[column.key]}px, 1fr)`
          : `${columnPrefs.widths[column.key]}px`,
      )
      .join(" "),
  }), [columns, columnPrefs.widths]);

  const resizeColumn = useCallback((key: ColumnKey, clientX: number) => {
    const column = COLUMNS.find((candidate) => candidate.key === key)!;
    setColumnPrefs((current) => ({
      ...current,
      widths: { ...current.widths, [key]: Math.max(column.min, Math.round(clientX)) },
    }));
  }, []);

  const beginResize = useCallback((key: ColumnKey, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    suppressSort.current = true;
    const startX = event.clientX;
    const startWidth = columnPrefs.widths[key];
    const move = (moveEvent: PointerEvent) => resizeColumn(key, startWidth + moveEvent.clientX - startX);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.setTimeout(() => {
        suppressSort.current = false;
      }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [columnPrefs.widths, resizeColumn]);

  const reorderColumn = useCallback((target: ColumnKey) => {
    const source = draggedColumn.current;
    if (!source || source === target) return;
    suppressSort.current = true;
    setColumnPrefs((current) => {
      const order = current.order.filter((key) => key !== source);
      order.splice(order.indexOf(target), 0, source);
      return { ...current, order };
    });
  }, []);

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

  // Keep the keyboard cursor in view. This must be an explicit request rather
  // than a reaction to every render: list data can refresh while the user is
  // touch-scrolling, and writing scrollTop then pulls the list back to the
  // selected row.
  const lead = useMemo(() => [...selection].pop() ?? null, [selection]);
  useEffect(() => {
    if (revealSelection === revealed.current) return;
    revealed.current = revealSelection;
    if (!lead) return;
    const idx = rows.findIndex((r) => r.id === lead);
    const el = scrollerRef.current;
    if (idx < 0 || !el) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_H - el.clientHeight;
    }
  }, [revealSelection, lead, rows]);

  const rowFrom = (e: React.MouseEvent): Row | null => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    return host ? (byId.get(host.dataset.rowId!) ?? null) : null;
  };

  return (
    <div className="list-view">
      <div className="list-header" style={columnStyle}>
        {columns.map((c) => (
          <div
            key={c.key}
            className={`column-header column-${c.key}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              reorderColumn(c.key);
            }}
          >
            <button
              className={`lh ${props.sortKey === c.key ? "sorted" : ""}`}
              onClick={() => {
                if (!suppressSort.current) props.onSort(c.key);
              }}
            >
              {c.label}
              {props.sortKey === c.key && <i className={props.sortAsc ? "asc" : "desc"} />}
            </button>
            <button
              className="column-drag"
              draggable
              aria-label={`Reorder ${c.label} column`}
              title="Drag to reorder column"
              onDragStart={(event) => {
                draggedColumn.current = c.key;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", c.key);
              }}
              onDragEnd={() => {
                draggedColumn.current = null;
                window.setTimeout(() => {
                  suppressSort.current = false;
                }, 0);
              }}
            >
              <GripIcon size={12} />
            </button>
            <div
              className="column-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${c.label} column`}
              onPointerDown={(event) => beginResize(c.key, event)}
            />
          </div>
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
                searching={searching}
                columnStyle={columnStyle}
                columnOrder={columnPrefs.order}
                onRenameCommit={props.onRenameCommit}
                onRenameCancel={props.onRenameCancel}
                touchFolderDrag={props.touchFolderDrag}
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
  searching,
  onRenameCommit,
  onRenameCancel,
  columnStyle,
  columnOrder,
  touchFolderDrag,
}: {
  row: Row;
  selected: boolean;
  renaming: boolean;
  searching: boolean;
  onRenameCommit: (row: Row, name: string) => void;
  onRenameCancel: () => void;
  columnStyle: CSSProperties;
  columnOrder: ColumnKey[];
  touchFolderDrag?: FolderTouchDragHandlers;
}) {
  const expandable = !searching && (row.kind === "wt-group" || row.dirPath !== null);
  const e = row.kind === "entry" ? row.entry : null;

  const name =
    row.kind === "entry"
      ? row.entry.name
      : row.kind === "wt-group"
        ? `Worktrees (${row.count})`
        : row.wt.name;

  const muted = e ? e.code?.index === "!" || e.hidden : row.kind === "worktree" && row.wt.prunable;
  const path = row.kind === "entry" ? row.entry.path : row.kind === "worktree" ? row.wt.path : null;
  const isFolder = row.dirPath !== null;
  const touchDrag = useFolderTouchDrag(isFolder && path ? { name, path } : null, touchFolderDrag);

  return (
    <div
      className={`lrow ${selected ? "selected" : ""} ${muted ? "muted" : ""} ${touchDrag.dragging ? "touch-dragging" : ""} ${
        row.kind === "wt-group" ? "section" : ""
      }`}
      data-row-id={row.id}
      style={{ height: ROW_H, ...columnStyle }}
      draggable={isFolder}
      onDragStart={(event) => {
        if (!isFolder || !path) return;
        beginFolderDrag({ name, path });
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(FOLDER_DRAG_TYPE, JSON.stringify({ name, path }));
        event.dataTransfer.setData("text/plain", path);
      }}
      onDragEnd={endFolderDrag}
      onPointerDown={touchDrag.onPointerDown}
      onPointerMove={touchDrag.onPointerMove}
      onPointerUp={touchDrag.onPointerUp}
      onPointerCancel={touchDrag.onPointerCancel}
    >
      <div className="c-name" style={{ paddingLeft: 6 + row.depth * 17, order: columnOrder.indexOf("name") }}>
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

        {e?.searchLocation && (
          <span className="tag alt" title={path ?? undefined}>
            {e.searchLocation}
          </span>
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

      <div className="c-added" style={{ order: columnOrder.indexOf("added") }}>
        {e && !e.nearby ? formatStamp(e.added) : ""}
      </div>
      <div className="c-when" style={{ order: columnOrder.indexOf("modified") }}>
        {e && !e.nearby ? formatStamp(e.mtime) : ""}
      </div>
      <div className="c-size" style={{ order: columnOrder.indexOf("size") }}>
        {e && !e.nearby ? formatSize(e.size, e.kind === "dir") : ""}
      </div>
      <div className="c-kind" style={{ order: columnOrder.indexOf("kind") }}>
        {e ? kindOf(e) : row.kind === "worktree" ? "Worktree" : ""}
      </div>
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
