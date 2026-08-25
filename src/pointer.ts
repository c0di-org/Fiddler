/**
 * Which hand pressed last, answered globally.
 *
 * The views each keep their own `pointerType` ref for click semantics; this
 * exists for the places that get no pointer event of their own — HTML5
 * `dragstart`, which recent Chromium will synthesize from a touch long-press
 * and which then races the app's own touch-press gesture. Captured on
 * `window` so it is true before any component handler runs.
 */
let last: string | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => {
    last = e.pointerType;
  }, true);
}

export function lastPointerType(): string | null {
  return last;
}
