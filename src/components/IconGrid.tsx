import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { itemDomId } from "../a11y";
import type { Entry, WorktreeInfo } from "../types";
import { EmptyState } from "./EmptyState";
import { FolderGlyph } from "./FileGlyph";
import { GitDot } from "./GitDot";
import { Thumb } from "./Thumb";
import { beginFolderDrag, endFolderDrag, FOLDER_DRAG_TYPE } from "../favorites";
import { beginItemDrag, endItemDrag, ITEM_DRAG_TYPE, type DragItems } from "../drag.ts";
import { type FolderTouchDragHandlers, useTouchPress } from "./touch-press";
import { dropProps, useDropTarget, type DropItems } from "./use-drop-target.ts";

/**
 * The default view: big previews in a grid. Virtualized by row, so a folder with
 * 40,000 photos costs the same as one with twenty.
 */

export interface GridCell {
  id: string;
  name: string;
  path: string;
  entry?: Entry;
  wt?: WorktreeInfo;
}

/** Rows are either a section heading or a run of cells. */
type GridRow = { kind: "header"; label: string } | { kind: "cells"; cells: GridCell[] };

/**
 * The spacing decision that makes the grid read: a cell's own label is tucked
 * right under its thumbnail (8px, set in CSS), while whole cells are pushed well
 * apart. Proximity does the grouping, so nothing needs a box around it.
 */
const GAP = 24;
/** Left/right/top breathing room around the whole grid. */
const EDGE = 20;
/** Slack around each icon inside its cell, so names have somewhere to run. */
const GUTTER = 44;
/**
 * Below this the desktop's generous spacing costs a whole column: at a phone's
 * width, 20px margins and a 44px gutter turn two comfortable icons into one
 * enormous one. Tightening all three is what buys the second column back.
 */
const NARROW = 520;
const NARROW_GAP = 14;
const NARROW_EDGE = 12;
const NARROW_GUTTER = 20;
/** Room under the icon for the name. Cells that also carry a branch pill run a
 *  little taller and lean into the gap, which is why the gap is generous. */
const LABEL_H = 50;
const HEADER_H = 46;

interface Props {
  entries: Entry[];
  /** Local-file content matches, shown after filename/path matches. */
  contentEntries?: Entry[];
  worktrees: WorktreeInfo[];
  iconSize: number;
  selection: Set<string>;
  /** Advances when keyboard navigation asks us to reveal the lead selection. */
  revealSelection: number;
  onSelect: (id: string, e: React.MouseEvent, touch?: boolean) => void;
  onOpen: (cell: GridCell) => void;
  onContextMenu: (cell: GridCell | null, x: number, y: number) => void;
  onBackgroundClick: () => void;
  /** Navigation and selection keys, handled here rather than on `window` so
   * they only fire when this view actually holds focus. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** Names the grid for a screen reader — the folder being looked at. */
  label: string;
  emptyMessage: string;
  /** Suppresses the empty state while a listing is still in flight. */
  loaded: boolean;
  /** Android's WebView needs a touch implementation for folder drops. */
  touchFolderDrag?: FolderTouchDragHandlers;
  /** Touch gets direct open/preview actions; mouse keeps selection behavior. */
  directTouch?: boolean;
  /** A long press landed on this item: it is now taken. The host decides what
   * that means — see `pressTarget` in App. */
  onPress?: (id: string) => void;
  /** What a drag starting on this item carries — the whole selection when the
   * item is part of it. Null where the item isn't a drag source. */
  dragItems?: (id: string) => DragItems | null;
  /** Where a drop landed and what it should do. */
  onDropItems?: DropItems;
}

export function IconGrid(props: Props) {
  const { entries, contentEntries = [], worktrees, iconSize } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pointerType = useRef<string | null>(null);
  const revealed = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [box, setBox] = useState({ w: 900, h: 600 });

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const narrow = box.w < NARROW;
  const gap = narrow ? NARROW_GAP : GAP;
  const edge = narrow ? NARROW_EDGE : EDGE;

  const cellH = iconSize + LABEL_H;
  const minW = iconSize + (narrow ? NARROW_GUTTER : GUTTER);
  const avail = Math.max(minW, box.w - edge * 2);
  const cols = Math.max(1, Math.floor((avail + gap) / (minW + gap)));
  /**
   * Share the leftover width out over the columns instead of leaving a ragged
   * strip on the right — capped, so a wide window doesn't end up with a small
   * icon marooned in an enormous tile.
   */
  const cellW = Math.min(minW + 64, Math.floor((avail - gap * (cols - 1)) / cols));

  const rows = useMemo<GridRow[]>(() => {
    const out: GridRow[] = [];
    const push = (cells: GridCell[]) => {
      for (let i = 0; i < cells.length; i += cols) {
        out.push({ kind: "cells", cells: cells.slice(i, i + cols) });
      }
    };

    push(entries.map((e) => ({ id: e.path, name: e.name, path: e.path, entry: e })));

    if (contentEntries.length > 0) {
      out.push({ kind: "header", label: `Contents (${contentEntries.length})` });
      push(contentEntries.map((e) => ({ id: e.path, name: e.name, path: e.path, entry: e })));
    }

    if (worktrees.length > 0) {
      out.push({ kind: "header", label: `Worktrees (${worktrees.length})` });
      push(worktrees.map((w) => ({ id: `wt:${w.path}`, name: w.name, path: w.path, wt: w })));
    }
    return out;
  }, [entries, contentEntries, worktrees, cols]);

  const offsets = useMemo(() => {
    const tops: number[] = [];
    let y = edge;
    for (const r of rows) {
      tops.push(y);
      y += r.kind === "header" ? HEADER_H : cellH + gap;
    }
    tops.push(y);
    return tops;
  }, [rows, cellH, edge, gap]);

  const totalH = offsets[offsets.length - 1] ?? 0;

  // Binary search the first visible row — offsets vary because headers are shorter.
  const firstRow = useMemo(() => {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 2);
  }, [offsets, rows.length, scrollTop]);

  const lastRow = useMemo(() => {
    let i = firstRow;
    while (i < rows.length && offsets[i] < scrollTop + box.h) i++;
    return Math.min(rows.length, i + 2);
  }, [firstRow, offsets, rows.length, scrollTop, box.h]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // Scroll the lead selection into view only for keyboard navigation. Ordinary
  // list refreshes during a touch scroll must not write scrollTop and snap the
  // viewport back to an older selection.
  const lead = useMemo(() => [...props.selection].pop() ?? null, [props.selection]);
  useEffect(() => {
    if (props.revealSelection === revealed.current) return;
    revealed.current = props.revealSelection;
    const el = scrollerRef.current;
    if (!lead || !el) return;
    const at = rows.findIndex((r) => r.kind === "cells" && r.cells.some((c) => c.id === lead));
    if (at < 0) return;
    const top = offsets[at];
    const bottom = offsets[at + 1] ?? top + cellH;
    if (top < el.scrollTop) el.scrollTop = top - gap;
    else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight + gap;
    }
  }, [props.revealSelection, lead, rows, offsets, cellH, gap]);

  // The keyboard lives on this element now, so something has to put focus here
  // to begin with. Only when nothing else has claimed it: switching views with
  // ⌘1 while typing in the filter field must not pull the caret out of it.
  useEffect(() => {
    if (document.activeElement === document.body) {
      scrollerRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const cellFrom = (e: React.MouseEvent): GridCell | null => {
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-cell-id]");
    if (!host) return null;
    const id = host.dataset.cellId!;
    for (const r of rows) {
      if (r.kind !== "cells") continue;
      const hit = r.cells.find((c) => c.id === id);
      if (hit) return hit;
    }
    return null;
  };

  return (
    <div
      className="grid-scroller"
      ref={scrollerRef}
      role="grid"
      aria-label={props.label}
      aria-multiselectable="true"
      // Both counts describe the whole folder, not the handful of rows that are
      // mounted: a virtualized grid that reports what it rendered tells a screen
      // reader there are eleven items in a folder of forty thousand.
      aria-rowcount={rows.length}
      aria-colcount={cols}
      aria-activedescendant={lead ? itemDomId("gc", lead) : undefined}
      tabIndex={0}
      data-view-focus
      onKeyDown={props.onKeyDown}
      onPointerDown={(e) => {
        pointerType.current = e.pointerType;
      }}
      onScroll={onScroll}
      onClick={(e) => {
        const c = cellFrom(e);
        if (c) props.onSelect(c.id, e, props.directTouch && pointerType.current === "touch");
        else props.onBackgroundClick();
      }}
      onDoubleClick={(e) => {
        if (props.directTouch && pointerType.current === "touch") return;
        const c = cellFrom(e);
        if (c) props.onOpen(c);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // A mobile WebView fires this on long press too, which would put a
        // pointer-shaped popover under a fingertip on top of the press
        // gesture's own answer. Touch has its own route now; this is the
        // pointer's.
        if (pointerType.current === "touch") return;
        const c = cellFrom(e);
        // Finder's rule, which was being broken here: right-clicking something
        // already selected keeps the whole selection. Selecting unconditionally
        // meant picking five files and right-clicking one of them collapsed the
        // five, so "Copy 5 Items" could never appear.
        if (c && !props.selection.has(c.id)) props.onSelect(c.id, e);
        props.onContextMenu(c, e.clientX, e.clientY);
      }}
    >
      {/* The sizer only exists to give the scrollbar something to measure, so
          it must not sit between the grid and its rows in the a11y tree. */}
      <div className="grid-sizer" role="presentation" style={{ height: totalH }}>
        {rows.slice(firstRow, lastRow).map((row, i) => {
          const index = firstRow + i;
          const top = offsets[index];
          if (row.kind === "header") {
            return (
              <div
                key={`h${index}`}
                className="grid-section"
                role="row"
                aria-rowindex={index + 1}
                style={{ top }}
              >
                <span role="gridcell" aria-colindex={1}>
                  {row.label}
                </span>
              </div>
            );
          }
          return (
            <div
              key={index}
              className="grid-row"
              role="row"
              aria-rowindex={index + 1}
              style={{ top, gap, paddingLeft: edge }}
            >
              {row.cells.map((cell, col) => (
                <Cell
                  key={cell.id}
                  cell={cell}
                  column={col + 1}
                  width={cellW}
                  iconSize={iconSize}
                  selected={props.selection.has(cell.id)}
                  touchFolderDrag={props.touchFolderDrag}
                  onPress={props.onPress}
                  dragItems={props.dragItems}
                  onDropItems={props.onDropItems}
                />
              ))}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && props.loaded && <EmptyState message={props.emptyMessage} />}
    </div>
  );
}

function Cell({
  cell,
  column,
  width,
  iconSize,
  selected,
  touchFolderDrag,
  onPress,
  dragItems,
  onDropItems,
}: {
  cell: GridCell;
  /** 1-based position in its row, which is what `aria-colindex` counts. */
  column: number;
  width: number;
  iconSize: number;
  selected: boolean;
  touchFolderDrag?: FolderTouchDragHandlers;
  onPress?: (id: string) => void;
  dragItems?: (id: string) => DragItems | null;
  onDropItems?: DropItems;
}) {
  const e = cell.entry;
  const ignored = e?.code?.index === "!";
  const isFolder = !!cell.wt || e?.kind === "dir" || (e?.kind === "symlink" && e.linkToDir);
  const touchDrag = useTouchPress({
    onPress: onPress && (() => onPress(cell.id)),
    folder: isFolder ? { name: cell.name, path: cell.path } : null,
    drag: touchFolderDrag,
  });
  const drop = useDropTarget(isFolder ? cell.path : null, onDropItems);
  const { className: dropClass, ...dropHandlers } = dropProps(drop);

  return (
    <div
      className={`cell ${selected ? "selected" : ""} ${ignored || e?.hidden ? "muted" : ""} ${
        touchDrag.dragging ? "touch-dragging" : ""
      } ${dropClass}`}
      id={itemDomId("gc", cell.id)}
      role="gridcell"
      aria-colindex={column}
      aria-selected={selected}
      // Named outright, because the `title` that gives the cell its hover
      // tooltip otherwise wins the name and every item is announced as its
      // whole path. Said this way the path stays, as the description.
      aria-label={cell.name}
      data-cell-id={cell.id}
      style={{ width }}
      title={cell.path}
      {...dropHandlers}
      draggable={isFolder || !!cell.entry}
      onDragStart={(event) => {
        // A folder keeps its own drag type so Favorites, which is the one drop
        // target that wants a bookmark rather than the bytes, still works.
        if (isFolder) {
          beginFolderDrag({ name: cell.name, path: cell.path });
          event.dataTransfer.setData(FOLDER_DRAG_TYPE, JSON.stringify({ name: cell.name, path: cell.path }));
        }
        const items = dragItems?.(cell.id) ?? null;
        if (items) {
          beginItemDrag(items);
          event.dataTransfer.setData(ITEM_DRAG_TYPE, JSON.stringify(items.paths));
        }
        event.dataTransfer.effectAllowed = items ? "copyMove" : "copy";
        event.dataTransfer.setData("text/plain", cell.path);
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
      <div className="cell-art" style={{ height: iconSize }}>
        {e ? (
          <Thumb entry={e} size={iconSize} />
        ) : (
          <FolderGlyph size={iconSize} repo name={cell.name} path={cell.path} />
        )}
        <span className="cell-badge">
          <GitDot code={e?.code} rollup={e?.rollup} />
        </span>
      </div>
      <div className="cell-label">
        <span className="cell-name">{cell.name}</span>
        {e?.searchLocation && (
          <span className="cell-sub" title={cell.path}>
            {e.searchLocation}
          </span>
        )}
        {cell.wt && (
          <span className="cell-sub">
            {cell.wt.detached ? cell.wt.head ?? "detached" : cell.wt.branch}
          </span>
        )}
        {e?.isRepo && e.branch && <span className="cell-sub">{e.branch}</span>}
      </div>
    </div>
  );
}
