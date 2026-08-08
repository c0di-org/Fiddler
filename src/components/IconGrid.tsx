import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Entry, WorktreeInfo } from "../types";
import { FolderGlyph } from "./FileGlyph";
import { GitDot } from "./GitDot";
import { Thumb } from "./Thumb";

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

const GAP = 8;
const LABEL_H = 34;
const HEADER_H = 30;

interface Props {
  entries: Entry[];
  worktrees: WorktreeInfo[];
  iconSize: number;
  selection: Set<string>;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onOpen: (cell: GridCell) => void;
  onContextMenu: (cell: GridCell | null, x: number, y: number) => void;
  onBackgroundClick: () => void;
  emptyMessage: string;
  /** Suppresses the empty state while a listing is still in flight. */
  loaded: boolean;
}

export function IconGrid(props: Props) {
  const { entries, worktrees, iconSize } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
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

  const cellW = iconSize + 34;
  const cellH = iconSize + LABEL_H;
  const cols = Math.max(1, Math.floor((box.w - GAP) / (cellW + GAP)));

  const rows = useMemo<GridRow[]>(() => {
    const out: GridRow[] = [];
    const push = (cells: GridCell[]) => {
      for (let i = 0; i < cells.length; i += cols) {
        out.push({ kind: "cells", cells: cells.slice(i, i + cols) });
      }
    };

    push(entries.map((e) => ({ id: e.path, name: e.name, path: e.path, entry: e })));

    if (worktrees.length > 0) {
      out.push({ kind: "header", label: `Worktrees (${worktrees.length})` });
      push(worktrees.map((w) => ({ id: `wt:${w.path}`, name: w.name, path: w.path, wt: w })));
    }
    return out;
  }, [entries, worktrees, cols]);

  const offsets = useMemo(() => {
    const tops: number[] = [];
    let y = GAP;
    for (const r of rows) {
      tops.push(y);
      y += r.kind === "header" ? HEADER_H : cellH + GAP;
    }
    tops.push(y);
    return tops;
  }, [rows, cellH]);

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

  // Scroll the lead selection into view so arrow keys and type-to-jump both land
  // somewhere visible.
  const lead = useMemo(() => [...props.selection].pop() ?? null, [props.selection]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!lead || !el) return;
    const at = rows.findIndex((r) => r.kind === "cells" && r.cells.some((c) => c.id === lead));
    if (at < 0) return;
    const top = offsets[at];
    const bottom = offsets[at + 1] ?? top + cellH;
    if (top < el.scrollTop) el.scrollTop = top - GAP;
    else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight + GAP;
    }
  }, [lead, rows, offsets, cellH]);

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
      onScroll={onScroll}
      onClick={(e) => {
        const c = cellFrom(e);
        if (c) props.onSelect(c.id, e);
        else props.onBackgroundClick();
      }}
      onDoubleClick={(e) => {
        const c = cellFrom(e);
        if (c) props.onOpen(c);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const c = cellFrom(e);
        if (c) props.onSelect(c.id, e);
        props.onContextMenu(c, e.clientX, e.clientY);
      }}
    >
      <div className="grid-sizer" style={{ height: totalH }}>
        {rows.slice(firstRow, lastRow).map((row, i) => {
          const index = firstRow + i;
          const top = offsets[index];
          if (row.kind === "header") {
            return (
              <div key={`h${index}`} className="grid-section" style={{ top }}>
                {row.label}
              </div>
            );
          }
          return (
            <div key={index} className="grid-row" style={{ top, gap: GAP, paddingLeft: GAP }}>
              {row.cells.map((cell) => (
                <Cell
                  key={cell.id}
                  cell={cell}
                  width={cellW}
                  iconSize={iconSize}
                  selected={props.selection.has(cell.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && props.loaded && (
        <div className="view-empty">{props.emptyMessage}</div>
      )}
    </div>
  );
}

function Cell({
  cell,
  width,
  iconSize,
  selected,
}: {
  cell: GridCell;
  width: number;
  iconSize: number;
  selected: boolean;
}) {
  const e = cell.entry;
  const ignored = e?.code?.index === "!";

  return (
    <div
      className={`cell ${selected ? "selected" : ""} ${ignored || e?.hidden ? "muted" : ""}`}
      data-cell-id={cell.id}
      style={{ width }}
      title={cell.path}
    >
      <div className="cell-art" style={{ height: iconSize }}>
        {e ? <Thumb entry={e} size={iconSize} /> : <FolderGlyph size={iconSize} repo />}
        <span className="cell-badge">
          <GitDot code={e?.code} rollup={e?.rollup} />
        </span>
      </div>
      <div className="cell-label">
        <span className="cell-name">{cell.name}</span>
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
