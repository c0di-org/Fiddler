import { useEffect, useRef, useState } from "react";

import { PRESETS, type Tint } from "../tint";

/**
 * Accent colour control, parked in the status bar's spare left cell. Follows the
 * system accent unless told otherwise — the swatch shows what's actually in use
 * either way, so "Match System" isn't a mystery setting.
 */

interface Props {
  tint: Tint;
  /** False when the OS has no accent to follow — then "Match System" is a no-op. */
  systemAvailable: boolean;
  onPick: (tint: Tint) => void;
}

export function TintPicker({ tint, systemAvailable, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const following = tint === "system";

  return (
    <div className="tint" ref={hostRef}>
      <button
        className="tint-btn"
        onClick={() => setOpen((v) => !v)}
        title={following ? "Accent colour — matching system" : "Accent colour"}
        aria-label="Accent colour"
      >
        <span className="tint-swatch" />
      </button>

      {open && (
        <div className="tint-pop">
          <button
            className={`tint-system ${following ? "on" : ""}`}
            onClick={() => {
              onPick("system");
              setOpen(false);
            }}
            disabled={!systemAvailable}
          >
            <span className="tint-dot system" />
            Match System
          </button>

          <div className="tint-grid">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                className={`tint-dot ${tint === p.value ? "on" : ""}`}
                style={{ background: p.value }}
                title={p.name}
                aria-label={p.name}
                onClick={() => {
                  onPick(p.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
