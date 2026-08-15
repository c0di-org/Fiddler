import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { itemDomId } from "../a11y";
import { formatSize, formatStamp } from "../format";
import { kindOf } from "../kind";
import type { Row, SortKey } from "../store/tree";
import { Thumb } from "./Thumb";
import { GitDot } from "./GitDot";
import { EmptyState } from "./EmptyState";
import { Chevron, ForkIcon, GripIcon, LockIcon, WarnIcon } from "./icons";
import { beginFolderDrag, endFolderDrag, FOLDER_DRAG_TYPE } from "../favorites";
import { beginItemDrag, endItemDrag, ITEM_DRAG_TYPE, type DragItems } from "../drag.ts";
import { type FolderTouchDragHandlers, useTouchPress } from "./touch-press";
import { dropProps, useDropTarget, type DropItems } from "./use-drop-target.ts";

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

/**
 * The five columns' minimums come to 596px, so on a phone they cannot all be
 * on screen — and a fixed track that doesn't fit is worse than one that isn't
 * there, because the overflow is simply clipped and unreachable. Below this the
 * list keeps the two columns worth having and drops the rest; the name column
 * still carries the badges, so what is lost is only the dates and the kind.
 *
 * Name leads regardless of the saved order: a phone reads a row from its left
 * edge, and a lone "Size" out in front of the name reads as noise.
 */
const NARROW = 560;
const NARROW_COLUMNS: ColumnKey[] = ["name", "size"];
const NARROW_SIZE_W = 76;
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
  onSelect: (id: string, e: React.MouseEvent, touch?: boolean) => void;
  onToggle: (row: Row) => void;
  onOpen: (row: Row) => void;
  onContextMenu: (row: Row | null, x: number, y: number) => void;
  onRenameCommit: (row: Row, name: string) => void;
  onRenameCancel: () => void;
  onBackgroundClick: () => void;
  /** Navigation and selection keys, handled here rather than on `window` so
   * they only fire when this view actually holds focus. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Names the list for a screen reader — the folder being looked at. */
  label: string;
  emptyMessage: string;
  /** Suppresses the empty state while a listing is still in flight. */
  loaded: boolean;
  /** Android's WebView needs a touch implementation for folder drops. */
  touchFolderDrag?: FolderTouchDragHandlers;
  /** A long press landed on this row: it is now taken. */
  onPress?: (id: string) => void;
  /** Touch gets direct open/preview actions; mouse keeps selection behavior. */
  directTouch?: boolean;
  /** What a drag starting on this row carries — the whole selection when the
   * row is part of it. Null where the row isn't a drag source. */
  dragItems?: (id: string) => DragItems | null;
  /** Where a drop landed and what it should do. */
  onDropItems?: DropItems;
}

export function DetailList(props: Props) {
  const { rows, selection, renamingId, revealSelection, searching } = props;
  const viewRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pointerType = useRef<string | null>(null);
  const revealed = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [width, setWidth] = useState(900);
  const [columnPrefs, setColumnPrefs] = useState(savedColumnPrefs);
  const draggedColumn = useRef<ColumnKey | null>(null);
  const suppressSort = useRef(false);
  const resizeCleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(columnPrefs));
  }, [columnPrefs]);

  const narrow = width < NARROW;

  const columns = useMemo(
    () =>
      (narrow ? NARROW_COLUMNS : columnPrefs.order)
        .map((key) => COLUMNS.find((column) => column.key === key)!)
        .filter(Boolean),
    [columnPrefs.order, narrow],
  );
  /**
   * A column's visual place, 1-based. It is both what `order` needs (less one)
   * and what `aria-colindex` counts, and deriving them from the same number is
   * what stops a reordered list from being described in the saved order.
   */
  const columnPlace = useMemo(
    () => new Map(columns.map((column, i) => [column.key, i + 1])),
    [columns],
  );
  const columnStyle = useMemo<CSSProperties>(() => ({
    gridTemplateColumns: narrow
      ? `minmax(0, 1fr) ${NARROW_SIZE_W}px`
      : columns
          .map((column) =>
            column.key === "name"
              ? `minmax(${columnPrefs.widths[column.key]}px, 1fr)`
              : `${columnPrefs.widths[column.key]}px`,
          )
          .join(" "),
  }), [columns, columnPrefs.widths, narrow]);

  const resizeColumn = useCallback((key: ColumnKey, clientX: number) => {
    const column = COLUMNS.find((candidate) => candidate.key === key)!;
    setColumnPrefs((current) => ({
      ...current,
      widths: { ...current.widths, [key]: Math.max(column.min, Math.round(clientX)) },
    }));
  }, []);

  const beginResize = useCallback((key: ColumnKey, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanup.current?.();
    suppressSort.current = true;

    const resizer = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = columnPrefs.widths[key];
    let stopped = false;

    // Capturing the active pointer keeps the resize alive when it crosses into
    // a neighbouring header, whose reorder grip is also draggable.
    resizer.setPointerCapture(pointerId);
    document.body.classList.add("column-resizing");

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      resizeColumn(key, startWidth + moveEvent.clientX - startX);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", stop);
      resizer.removeEventListener("lostpointercapture", stop);
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      if (resizeCleanup.current === stop) resizeCleanup.current = null;
      document.body.classList.remove("column-resizing");
      window.setTimeout(() => {
        suppressSort.current = false;
      }, 0);
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) stop();
    };

    resizeCleanup.current = stop;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", stop);
    resizer.addEventListener("lostpointercapture", stop);
  }, [columnPrefs.widths, resizeColumn]);

  useEffect(() => () => resizeCleanup.current?.(), []);

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
    const ro = new ResizeObserver(() => {
      setViewport(el.clientHeight);
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    setViewport(el.clientHeight);
    setWidth(el.clientWidth);
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

  // The keyboard lives on this element now, so something has to put focus here
  // to begin with. Only when nothing else has claimed it: switching views with
  // ⌘2 while typing in the filter field must not pull the caret out of it.
  useEffect(() => {
    if (document.activeElement === document.body) {
      viewRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const rowFrom = (e: React.MouseEvent): Row | null => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    return host ? (byId.get(host.dataset.rowId!) ?? null) : null;
  };

  return (
    <div
      className="list-view"
      ref={viewRef}
      role="treegrid"
      aria-label={props.label}
      aria-multiselectable="true"
      // Both counts describe the whole folder rather than the mounted slice —
      // and the header is a row too, which is what shifts every other one by one.
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      aria-activedescendant={lead ? itemDomId("lr", lead) : undefined}
      tabIndex={0}
      data-view-focus
      onKeyDown={props.onKeyDown}
    >
      <div className="list-header" role="row" aria-rowindex={1} style={columnStyle}>
        {columns.map((c) => (
          <div
            key={c.key}
            className={`column-header column-${c.key}`}
            role="columnheader"
            aria-colindex={columnPlace.get(c.key)}
            aria-sort={props.sortKey === c.key ? (props.sortAsc ? "ascending" : "descending") : "none"}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              reorderColumn(c.key);
            }}
          >
            <button
              className={`lh ${props.sortKey === c.key ? "sorted" : ""}`}
              onClick={() => {
                if (suppressSort.current) return;
                props.onSort(c.key);
                // Sorting is a thing you do *to* the list, so the arrows should
                // still work afterwards; left alone, focus stays on the button.
                viewRef.current?.focus({ preventScroll: true });
              }}
            >
              {c.label}
              {props.sortKey === c.key && <i className={props.sortAsc ? "asc" : "desc"} />}
            </button>
            {/* Reordering and resizing both assume there is width to spend.
                Narrow mode picks the columns itself, so neither applies. */}
            {!narrow && (
              <>
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
                  title="Drag to resize column"
                  onDragStart={(event) => event.preventDefault()}
                  onPointerDown={(event) => beginResize(c.key, event)}
                />
              </>
            )}
          </div>
        ))}
      </div>

      <div
        className="list-scroller"
        ref={scrollerRef}
        role="rowgroup"
        onPointerDown={(e) => {
          pointerType.current = e.pointerType;
        }}
        onScroll={onScroll}
        onClick={(e) => {
          const row = rowFrom(e);
          if (!row) {
            props.onBackgroundClick();
            return;
          }
          if ((e.target as HTMLElement).closest("[data-twisty]")) props.onToggle(row);
          else props.onSelect(row.id, e, props.directTouch && pointerType.current === "touch");
        }}
        onDoubleClick={(e) => {
          if (props.directTouch && pointerType.current === "touch") return;
          const row = rowFrom(e);
          if (row) props.onOpen(row);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // See IconGrid: on touch the long press has already answered this.
          if (pointerType.current === "touch") return;
          const row = rowFrom(e);
          // See IconGrid: a right-click inside a selection must not collapse it.
          if (row && !props.selection.has(row.id)) props.onSelect(row.id, e);
          props.onContextMenu(row, e.clientX, e.clientY);
        }}
      >
        {/* Neither of these carries meaning — one sizes the scrollbar, the other
            is the sliding window — so neither may stand between rowgroup and row. */}
        <div className="list-sizer" role="presentation" style={{ height: rows.length * ROW_H }}>
          <div
            className="list-window"
            role="presentation"
            style={{ transform: `translateY(${first * ROW_H}px)` }}
          >
            {slice.map((row, i) => (
              <RowView
                key={row.id}
                row={row}
                // Header row first, then the rows above the window that aren't
                // mounted: both have to be counted or the position is a fiction.
                rowIndex={first + i + 2}
                selected={selection.has(row.id)}
                renaming={row.id === renamingId}
                searching={searching}
                columnStyle={columnStyle}
                columnPlace={columnPlace}
                narrow={narrow}
                onRenameCommit={props.onRenameCommit}
                onRenameCancel={props.onRenameCancel}
                touchFolderDrag={props.touchFolderDrag}
                onPress={props.onPress}
                dragItems={props.dragItems}
                onDropItems={props.onDropItems}
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
  rowIndex,
  selected,
  renaming,
  searching,
  onRenameCommit,
  onRenameCancel,
  columnStyle,
  columnPlace,
  narrow,
  touchFolderDrag,
  onPress,
  dragItems,
  onDropItems,
}: {
  row: Row;
  /** Place in the whole list, header included — what `aria-rowindex` counts. */
  rowIndex: number;
  selected: boolean;
  renaming: boolean;
  searching: boolean;
  onRenameCommit: (row: Row, name: string) => void;
  onRenameCancel: () => void;
  columnStyle: CSSProperties;
  columnPlace: Map<ColumnKey, number>;
  /** Two grid tracks instead of five; the cells that have no track must not be
   *  rendered at all, or they wrap onto an implicit row and break the fixed
   *  row height the virtual scroller measures with. */
  narrow: boolean;
  touchFolderDrag?: FolderTouchDragHandlers;
  onPress?: (id: string) => void;
  dragItems?: (id: string) => DragItems | null;
  onDropItems?: DropItems;
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
  const touchDrag = useTouchPress({
    // A worktree group heading is a twisty, not a thing to take.
    onPress: onPress && path ? () => onPress(row.id) : undefined,
    folder: isFolder && path ? { name, path } : null,
    drag: touchFolderDrag,
  });
  const drop = useDropTarget(row.dirPath, onDropItems);
  const { className: dropClass, ...dropHandlers } = dropProps(drop);

  return (
    <div
      className={`lrow ${selected ? "selected" : ""} ${muted ? "muted" : ""} ${touchDrag.dragging ? "touch-dragging" : ""} ${
        row.kind === "wt-group" ? "section" : ""
      } ${dropClass}`}
      id={itemDomId("lr", row.id)}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={selected}
      aria-level={row.depth + 1}
      aria-expanded={expandable ? row.expanded : undefined}
      data-row-id={row.id}
      style={{ height: ROW_H, ...columnStyle }}
      {...dropHandlers}
      draggable={!!path}
      onDragStart={(event) => {
        if (!path) return;
        // A folder keeps its own drag type so Favorites, which is the one drop
        // target that wants a bookmark rather than the bytes, still works.
        if (isFolder) {
          beginFolderDrag({ name, path });
          event.dataTransfer.setData(FOLDER_DRAG_TYPE, JSON.stringify({ name, path }));
        }
        const items = dragItems?.(row.id) ?? null;
        if (items) {
          beginItemDrag(items);
          event.dataTransfer.setData(ITEM_DRAG_TYPE, JSON.stringify(items.paths));
        }
        event.dataTransfer.effectAllowed = items ? "copyMove" : "copy";
        event.dataTransfer.setData("text/plain", path);
      }}
      onDragEnd={() => {
        endFolderDrag();
        endItemDrag();
      }}
      onPointerDown={touchDrag.onPointerDown}
      onPointerMove={touchDrag.onPointerMove}
      onPointerUp={touchDrag.onPointerUp}
      onPointerCancel={touchDrag.onPointerCancel}
    >
      <div
        className="c-name"
        role="gridcell"
        aria-colindex={columnPlace.get("name")}
        // The other four cells are a single string each and name themselves.
        // This one is a triangle, an icon, the name and up to four pills, and
        // is left nameless unless it says which of those it goes by.
        aria-label={name}
        style={{ paddingLeft: 6 + row.depth * 17, order: columnPlace.get("name")! - 1 }}
      >
        {/* The row carries aria-expanded, so the triangle is decoration on top
            of it rather than a second, separately announced control. */}
        <span
          className={`twisty ${expandable ? "" : "hidden"} ${row.expanded ? "open" : ""}`}
          aria-hidden="true"
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

      {!narrow && (
        <>
          <div
            className="c-added"
            role="gridcell"
            aria-colindex={columnPlace.get("added")}
            style={{ order: columnPlace.get("added")! - 1 }}
          >
            {e && !e.nearby ? formatStamp(e.added) : ""}
          </div>
          <div
            className="c-when"
            role="gridcell"
            aria-colindex={columnPlace.get("modified")}
            style={{ order: columnPlace.get("modified")! - 1 }}
          >
            {e && !e.nearby ? formatStamp(e.mtime) : ""}
          </div>
        </>
      )}
      <div
        className="c-size"
        role="gridcell"
        aria-colindex={columnPlace.get("size")}
        style={{ order: columnPlace.get("size")! - 1 }}
      >
        {e && !e.nearby ? formatSize(e.size, e.kind === "dir") : ""}
      </div>
      {!narrow && (
        <div
          className="c-kind"
          role="gridcell"
          aria-colindex={columnPlace.get("kind")}
          style={{ order: columnPlace.get("kind")! - 1 }}
        >
          {e ? kindOf(e) : row.kind === "worktree" ? "Worktree" : ""}
        </div>
      )}
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
