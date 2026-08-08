import type { Entry } from "../types";

/**
 * The icon shown when there's no image preview. Scales from a 20px list row up to
 * a 256px preview: the document sheet gains a coloured type band as it grows, the
 * way Finder's own generic icons do.
 *
 * Every gradient lives once in <GlyphDefs>, rendered at the app root, so a folder
 * of 40,000 files doesn't ship 40,000 copies of the same <linearGradient>.
 */

type Category = "code" | "image" | "media" | "doc" | "archive" | "config" | "plain";

const CATEGORY: Record<string, Category> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  rs: "code", go: "code", py: "code", rb: "code", swift: "code", java: "code",
  kt: "code", c: "code", h: "code", cpp: "code", hpp: "code", cs: "code",
  php: "code", lua: "code", sh: "code", zsh: "code", bash: "code", sql: "code",
  html: "code", css: "code", scss: "code", vue: "code", svelte: "code",

  json: "config", jsonc: "config", toml: "config", yaml: "config", yml: "config",
  xml: "config", ini: "config", conf: "config", lock: "config", env: "config",

  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  svg: "image", heic: "image", ico: "image", icns: "image", bmp: "image", tiff: "image",

  mp4: "media", mov: "media", webm: "media", avi: "media", mkv: "media",
  mp3: "media", wav: "media", m4a: "media", flac: "media", aac: "media",

  pdf: "doc", md: "doc", mdx: "doc", txt: "doc", rtf: "doc", doc: "doc",
  docx: "doc", pages: "doc", key: "doc", csv: "doc", xlsx: "doc",

  zip: "archive", gz: "archive", tar: "archive", rar: "archive", "7z": "archive",
  dmg: "archive", pkg: "archive",
};

/** Below this the glyph is a list-row icon; above it, artwork worth a shadow. */
const LARGE = 40;

export function FileGlyph({ entry, size }: { entry: Entry; size: number }) {
  const isDir = entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir);

  if (isDir) return <FolderGlyph size={size} repo={entry.isRepo} />;

  const dot = entry.name.lastIndexOf(".");
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  const category = CATEGORY[ext] ?? "plain";
  // The band is the only thing telling one file from another in a list row, so
  // it survives all the way down; only its lettering needs room to be legible.
  const showBand = ext.length > 0 && ext.length <= 6;
  const showText = showBand && size >= 44;
  // Shrink the type text rather than truncating it — "SWIF" reads as a typo.
  const labelSize = ext.length <= 3 ? 9.4 : ext.length === 4 ? 8 : 6.6;

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={`glyph glyph-file cat-${category} ${size >= LARGE ? "glyph-lg" : ""}`}
      aria-hidden="true"
    >
      {/* Sheet: rounded on three corners, folded on the fourth. */}
      <path
        d="M12 4h17.5L39 13.5V41a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"
        className="sheet-face"
      />
      <path d="M29.5 4 39 13.5h-6.5a3 3 0 0 1-3-3Z" className="fold" />

      {/* A colour band tucked into the sheet's bottom corners: readable at a
          glance across a grid, and the thing carrying the file's type. */}
      {showBand && <path d="M9 29h30v12a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3Z" className="band" />}

      {showText && (
        <>
          <path d="M15 17h18M15 23h12" className="lines" />
          <text
            x="24"
            y="39.4"
            textAnchor="middle"
            className="band-text"
            style={{ fontSize: labelSize }}
          >
            {ext.toUpperCase()}
          </text>
        </>
      )}

      {!showBand && size >= 44 && <path d="M15 22h18M15 29h18M15 36h11" className="lines" />}
    </svg>
  );
}

export function FolderGlyph({ size, repo }: { size: number; repo?: boolean }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={`glyph glyph-folder ${size >= LARGE ? "glyph-lg" : ""}`}
      aria-hidden="true"
    >
      {/* Back panel peeking above the front, which is what reads as "folder".
          The body runs y=13→43 against a x=3→45 width: a squatter box than that
          reads as an envelope. */}
      <path
        d="M3 11.5A4.5 4.5 0 0 1 7.5 7h10.2a3 3 0 0 1 2.2.96l3.9 4.29H40.5A4.5 4.5 0 0 1 45 16.75V20H3Z"
        fill="url(#g-folder-back)"
      />
      <path
        d="M3 17.5A4.5 4.5 0 0 1 7.5 13h33a4.5 4.5 0 0 1 4.5 4.5v21a4.5 4.5 0 0 1-4.5 4.5h-33A4.5 4.5 0 0 1 3 38.5Z"
        fill="url(#g-folder-front)"
      />
      {/* Light catching the front panel's top edge — the whole illusion of depth. */}
      <path
        d="M3.9 17.5A3.6 3.6 0 0 1 7.5 13.9h33a3.6 3.6 0 0 1 3.6 3.6"
        fill="none"
        stroke="rgba(255,255,255,0.45)"
        strokeWidth="1.1"
      />
      {repo && size >= 28 && (
        // A quiet branch mark on the folder face — present, never the subject.
        <g className="folder-repo-mark" transform="translate(30.5 21.5) scale(0.66)">
          <circle cx="3" cy="3" r="2.6" />
          <circle cx="3" cy="16" r="2.6" />
          <circle cx="15" cy="3" r="2.6" />
          <path d="M3 5.6v7.8" strokeWidth="2.4" />
          <path d="M12.4 3H8a5 5 0 0 0-5 5v1.6" strokeWidth="2.4" fill="none" />
        </g>
      )}
    </svg>
  );
}

/**
 * Every gradient the glyphs reference, emitted once per document. SVG paint
 * servers resolve document-wide, so `fill="url(#g-code)"` finds these from any
 * other <svg> on the page.
 */
export function GlyphDefs() {
  return (
    <svg className="glyph-defs" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="g-folder-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--folder-2)" />
          <stop offset="1" stopColor="var(--folder-3)" />
        </linearGradient>
        <linearGradient id="g-folder-front" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="var(--folder-1)" />
          <stop offset="1" stopColor="var(--folder-2)" />
        </linearGradient>
        <linearGradient id="g-sheet" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="var(--sheet-1)" />
          <stop offset="1" stopColor="var(--sheet-2)" />
        </linearGradient>

        <CatGradient id="g-code" from="#a78bfa" to="#6d28d9" />
        <CatGradient id="g-config" from="#a1a1aa" to="#5f5f68" />
        <CatGradient id="g-image" from="#4ade80" to="#16a34a" />
        <CatGradient id="g-media" from="#fb7185" to="#d61f60" />
        <CatGradient id="g-doc" from="#4facff" to="#0060df" />
        <CatGradient id="g-archive" from="#fbbf4d" to="#e07b00" />
        <CatGradient id="g-plain" from="#b4b4bb" to="#84848c" />
      </defs>
    </svg>
  );
}

function CatGradient({ id, from, to }: { id: string; from: string; to: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stopColor={from} />
      <stop offset="1" stopColor={to} />
    </linearGradient>
  );
}
