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
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Flip the menu back inside the window if it would hang off an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: x + r.width > window.innerWidth ? Math.max(4, window.innerWidth - r.width - 4) : x,
      y: y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const dismiss = () => onClose();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && <div className="ctx-sep" />}
          <button
            className={`ctx-item ${it.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              it.onPick();
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}
