import * as ipc from "./ipc";

/**
 * The app's accent colour.
 *
 * By default it follows the macOS accent (System Settings › Appearance), which
 * the backend reads from AppKit — CSS's `AccentColor` keyword reports support in
 * this WebView but always answers the default blue, so it can't be trusted.
 *
 * Everything else is derived from that one colour rather than hard-coded, which
 * is what makes an arbitrary accent safe: text placed *on* the accent picks
 * whichever of black or white it can actually be read against, and
 * accent-coloured text on a surface is pushed darker or lighter until it clears
 * a contrast floor. A yellow accent stays legible.
 */

export type Tint = "system" | string;

const STORAGE_KEY = "fiddler.tint";

/** The cool silver-grey Fiddler is meant to arrive in — quiet enough that the
 * files are the only coloured thing on screen. It is what the app opens as
 * everywhere the system has no accent to lend: Android, the web, and a Mac
 * that answers "no colour". */
const DEFAULT_TINT = "#AEB4C0";

/** Used when the system accent can't be read (older WebKit, or "no colour"). */
const FALLBACK = DEFAULT_TINT;

/** Text on an accent fill must clear this; 4.5 is unreachable for mid tones. */
const ON_ACCENT_MIN = 3.2;
/** Accent-coloured text sitting on a surface. */
const ON_SURFACE_MIN = 4;
/** A folder face only has to read as a shape against the window behind it. */
const FOLDER_MIN = 1.6;

/** macOS's own accent palette, for people who want something else. */
export const PRESETS: { name: string; value: string }[] = [
  { name: "Blue", value: "#007aff" },
  { name: "Purple", value: "#953d96" },
  { name: "Pink", value: "#f74f9e" },
  { name: "Red", value: "#e0383e" },
  { name: "Orange", value: "#f7821b" },
  { name: "Yellow", value: "#ffc409" },
  { name: "Green", value: "#62ba46" },
  { name: "Graphite", value: "#8c8c8c" },
];

type RGB = [number, number, number];

// ------------------------------------------------------------------ colour

function parse(css: string): RGB | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(css.trim());
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return null;
}

const rgb = ([r, g, b]: RGB) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
const rgba = ([r, g, b]: RGB, a: number) =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [28, 28, 30];

/** Whichever of white or near-black can be read on this fill. */
function inkOn(fill: RGB): RGB {
  const onWhite = contrast(WHITE, fill);
  return onWhite >= ON_ACCENT_MIN || onWhite >= contrast(BLACK, fill) ? WHITE : BLACK;
}

/**
 * Accent-coloured *text*, darkened (or lightened, in dark mode) just far enough
 * to clear the contrast floor against the surface behind it.
 */
function inkFor(accent: RGB, surface: RGB, toward: RGB): RGB {
  let out = accent;
  for (let t = 0; t <= 1.001; t += 0.05) {
    out = mix(accent, toward, t);
    if (contrast(out, surface) >= ON_SURFACE_MIN) return out;
  }
  return out;
}

/**
 * The three stops a folder icon is painted from — its lit front, the body, and
 * the back panel — as one family around the accent.
 *
 * Dark mode sits the folder a little deeper so it doesn't glow against a dark
 * window. Either way the body is then pushed away from the surface until it
 * clears a floor, which is what keeps a pale accent (yellow) a folder rather
 * than a smudge.
 */
function folderRamp(accent: RGB, surface: RGB, dark: boolean) {
  const start = dark ? mix(accent, BLACK, 0.12) : accent;

  let body = start;
  for (let t = 0.05; contrast(body, surface) < FOLDER_MIN && t <= 1.001; t += 0.05) {
    body = mix(start, dark ? WHITE : BLACK, t);
  }

  return {
    front: mix(body, WHITE, dark ? 0.42 : 0.4),
    body,
    back: mix(body, BLACK, dark ? 0.26 : 0.22),
    /** The debossed mark on a familiar folder's face, and the shadow under it. */
    mark: mix(body, BLACK, 0.48),
    markShade: mix(body, BLACK, 0.66),
  };
}

// ------------------------------------------------------------------- probe

/** Last value read from the OS; null until the first read, or if there is none. */
let systemRgb: RGB | null = null;

export const hasSystemAccent = () => systemRgb !== null;

/**
 * Re-read the OS accent. macOS emits no notification the WebView can see, so
 * callers poll this at moments where a change is likely — startup, and whenever
 * the window is focused again after a trip to System Settings.
 *
 * Returns true when the value moved, so the caller knows to re-apply.
 */
export async function refreshSystemAccent(): Promise<boolean> {
  let next: RGB | null = null;
  try {
    const raw = await ipc.systemAccent();
    if (raw) next = [raw[0], raw[1], raw[2]];
  } catch {
    // No backend (or an older build): stay with whatever we already had.
    return false;
  }

  const changed = String(next) !== String(systemRgb);
  systemRgb = next;
  return changed;
}

// ------------------------------------------------------------------- apply

function isDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTint(tint: Tint) {
  const base = (tint === "system" ? systemRgb : parse(tint)) ?? parse(FALLBACK)!;

  const dark = isDark();
  // Roughly what --surface resolves to over a mid-tone desktop.
  const surface: RGB = dark ? [40, 40, 43] : [246, 246, 248];

  const root = document.documentElement.style;
  root.setProperty("--accent", rgb(base));
  // A lighter tint of the same hue, so accent gradients stay in one family
  // whatever colour the accent is.
  root.setProperty("--accent-2", rgb(mix(base, WHITE, 0.22)));
  root.setProperty("--accent-ink", rgb(inkFor(base, surface, dark ? WHITE : BLACK)));
  root.setProperty("--sel-fg", rgb(inkOn(base)));
  root.setProperty("--sel-cell", rgba(base, dark ? 0.26 : 0.15));
  root.setProperty("--sel-ring", rgba(base, dark ? 0.55 : 0.38));
  root.setProperty("--focus-ring", rgba(base, 0.28));

  const folder = folderRamp(base, surface, dark);
  root.setProperty("--folder-1", rgb(folder.front));
  root.setProperty("--folder-2", rgb(folder.body));
  root.setProperty("--folder-3", rgb(folder.back));
  root.setProperty("--folder-mark", rgba(folder.mark, 0.58));
  root.setProperty("--folder-mark-shade", rgba(folder.markShade, 0.5));
  // Marks drawn *on* the folder face rather than into it — the branch dot on a
  // repository — take whichever of white or near-black the face can carry.
  root.setProperty("--folder-ink", rgba(inkOn(folder.body), 0.92));
}

// ------------------------------------------------------------------- store

export function loadTint(): Tint {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "system" || (saved && parse(saved))) return saved;
  } catch {
    // Private mode or a locked-down profile — fall through to the default.
  }
  return "system";
}

export function saveTint(tint: Tint) {
  try {
    localStorage.setItem(STORAGE_KEY, tint);
  } catch {
    // Not being able to remember the choice shouldn't break setting it.
  }
}

/**
 * Keeps the derived shades correct as things change underneath: the OS accent
 * (re-read whenever the window comes back, since there's no event for it) and
 * the light/dark appearance, which moves the contrast targets.
 */
export function watchTint(current: () => Tint, onSystemRead?: () => void) {
  const reapply = () => applyTint(current());
  const resync = async () => {
    await refreshSystemAccent();
    onSystemRead?.();
    reapply();
  };

  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", reapply);
  window.addEventListener("focus", resync);

  void resync();

  return () => {
    scheme.removeEventListener("change", reapply);
    window.removeEventListener("focus", resync);
  };
}
