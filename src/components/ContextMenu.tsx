import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onPick: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  /**
   * Render as a sheet from the bottom rather than a popover at a point.
   *
   * The list is identical either way — the same `MenuItem[]` a right-click
   * builds — because it is the same menu. Only the hand is different, and a
   * fingertip cannot aim at a 30px row it is currently covering.
   */
  sheet?: boolean;
  /** What the sheet is acting on. A popover needs no such line: it is already
   * touching the thing it belongs to, while a sheet is at the far end of the
   * screen from it. */
  title?: string;
  onClose: () => void;
}

export function ContextMenu({ x, y, items, sheet, title, onClose }: Props) {
  return sheet ? (
    <Sheet items={items} title={title} onClose={onClose} />
  ) : (
    <Popover x={x} y={y} items={items} onClose={onClose} />
  );
}

function Popover({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Flip the menu back inside the window if it would hang off an edge.
  // `visualViewport` rather than the raw window size: with the layout drawn
  // edge-to-edge (`viewport-fit=cover`) a fixed element clamped to
  // `innerHeight` can still sit under a gesture bar or beside a cutout, and
  // the visual viewport is also the honest answer while a keyboard is up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const left = vv?.offsetLeft ?? 0;
    const top = vv?.offsetTop ?? 0;
    const width = vv?.width ?? window.innerWidth;
    const height = vv?.height ?? window.innerHeight;
    setPos({
      x: x + r.width > left + width ? Math.max(left + 4, left + width - r.width - 4) : x,
      y: y + r.height > top + height ? Math.max(top + 4, top + height - r.height - 4) : y,
    });
  }, [x, y]);

  useDismiss(onClose, true);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <Row key={i} item={it} first={i === 0} className="ctx-item" onClose={onClose} />
      ))}
    </div>
  );
}

function Sheet({ items, title, onClose }: { items: MenuItem[]; title?: string; onClose: () => void }) {
  useDismiss(onClose, false);

  return (
    <div className="ctx-scrim" onClick={onClose}>
      <div
        className="ctx-sheet"
        role="menu"
        aria-label={title ?? "Actions"}
        onClick={(e) => e.stopPropagation()}
      >
        {/* The grab bar says "this came from the bottom and goes back there"
            before anything is read, which is most of what makes a sheet
            dismissible without a visible close button. */}
        <div className="ctx-grip" aria-hidden="true" />
        {title && <div className="ctx-sheet-title">{title}</div>}
        <div className="ctx-sheet-items">
          {items.map((it, i) => (
            <Row key={i} item={it} first={i === 0} className="ctx-sheet-item" onClose={onClose} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  item,
  first,
  className,
  onClose,
}: {
  item: MenuItem;
  first: boolean;
  className: string;
  onClose: () => void;
}) {
  return (
    <>
      {/* Never as the first thing in the menu: whichever item a separator
          was meant to follow can now be absent. */}
      {item.separatorBefore && !first && <div className="ctx-sep" />}
      <button
        className={`${className} ${item.danger ? "danger" : ""}`}
        role="menuitem"
        onClick={() => {
          onClose();
          item.onPick();
        }}
      >
        {item.label}
      </button>
    </>
  );
}

/**
 * Escape, a click away, and losing the window all close a menu.
 *
 * The popover also closes on `mousedown`, which is what makes a right-click
 * elsewhere dismiss this one and open the next in a single press. A sheet must
 * not: it is dismissed by a tap on its own scrim, and closing on the pointer
 * going *down* would mean a tap that starts on the scrim and ends on an item
 * runs the item of a menu that is already gone.
 */
function useDismiss(onClose: () => void, onPointerDown: boolean) {
  useEffect(() => {
    const dismiss = () => onClose();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (onPointerDown) window.addEventListener("mousedown", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", esc);
    return () => {
      if (onPointerDown) window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose, onPointerDown]);
}
