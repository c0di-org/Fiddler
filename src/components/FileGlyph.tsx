import type { Entry } from "../types";
import { folderIconForName, type FolderIcon } from "../folder-icon";

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

  if (isDir) return <FolderGlyph size={size} repo={entry.isRepo} name={entry.name} />;

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

export function FolderGlyph({
  size,
  repo,
  name,
}: {
  size: number;
  repo?: boolean;
  /** The folder's leaf name, used for familiar system-folder marks. */
  name?: string;
}) {
  const icon = name ? folderIconForName(name) : null;
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
      {icon && size >= 16 && <FolderNameMark icon={icon} />}
      {repo && size >= 28 && (
        // A quiet branch mark on the folder face — present, never the subject.
        <g
          className="folder-repo-mark"
          transform={icon ? "translate(34 18) scale(0.46)" : "translate(30.5 21.5) scale(0.66)"}
        >
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

/** A familiar, debossed mark on the face of named folders. */
function FolderNameMark({ icon }: { icon: FolderIcon }) {
  return (
    <g className="folder-name-mark" transform="translate(13.2 18.3) scale(1.35)">
      {icon === "android" && (
        <>
          <path d="M3 6.5h10v6.25a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M3.5 6.25a4.5 4.5 0 0 1 9 0ZM5 3 3.75 1.5M10.5 3l1.25-1.5" />
          <circle cx="6" cy="8.5" r=".7" className="folder-name-fill" />
          <circle cx="9.5" cy="8.5" r=".7" className="folder-name-fill" />
        </>
      )}
      {icon === "apps" && <><rect x="2.5" y="2.5" width="4" height="4" rx=".8" /><rect x="9.5" y="2.5" width="4" height="4" rx=".8" /><rect x="2.5" y="9.5" width="4" height="4" rx=".8" /><rect x="9.5" y="9.5" width="4" height="4" rx=".8" /></>}
      {icon === "archive" && <><path d="M2.5 5h11v9h-11z" /><path d="M2 2.5h12v2.5H2zM6 8.5h4" /></>}
      {icon === "audiobooks" && <><path d="M2.75 3.25h4.5A2.75 2.75 0 0 1 10 6v7.25a2.5 2.5 0 0 0-2.75-1.5h-4.5Z" /><path d="M13.25 3.25h-2.5M12.5 7v3M10.75 8.5h3.5" /></>}
      {icon === "backup" && <><path d="M4.25 5.75V2.5L2 4.75" /><path d="M4 4.5a5.5 5.5 0 1 1-1 6" /><path d="M8 5.5v3l2 1.5" /></>}
      {icon === "books" && <><path d="M2.5 3h4.75A2.75 2.75 0 0 1 10 5.75v7.75A2.75 2.75 0 0 0 7.25 12H2.5Z" /><path d="M13.5 3H12a2 2 0 0 0-2 2v8.5A2.75 2.75 0 0 1 12.75 12h.75Z" /></>}
      {icon === "cloud" && <path d="M4.75 12.5h7a3 3 0 0 0 .4-5.97A4.25 4.25 0 0 0 4 7.75a2.4 2.4 0 0 0 .75 4.75Z" />}
      {icon === "code" && <><path d="m6 4-3.5 4L6 12M10 4l3.5 4-3.5 4M9 2.75 7 13.25" /></>}
      {icon === "database" && <><ellipse cx="8" cy="3.75" rx="5" ry="2.25" /><path d="M3 3.75v8.5c0 1.25 2.25 2.25 5 2.25s5-1 5-2.25v-8.5M3 8c0 1.25 2.25 2.25 5 2.25S13 9.25 13 8" /></>}
      {icon === "design" && <><path d="m3 11.5-.75 2.25 2.25-.75 8.25-8.25-1.5-1.5Z" /><path d="m10.5 3.25 1.5 1.5M2.5 13.5h5" /></>}
      {icon === "documents" && <><path d="M4 2.25h5l3 3v8.5H4Z" /><path d="M9 2.25v3h3M6 8h4M6 10.5h4" /></>}
      {icon === "downloads" && <><path d="M8 2.5v7.25M5 7.5 8 10.5l3-3M3 13h10" /></>}
      {icon === "fonts" && <path d="m3 13 3.5-10h3L13 13M4.75 9.25h6.5" />}
      {icon === "games" && <><path d="M5.25 7h5.5c1.2 0 2.05.73 2.4 1.8l.45 1.45c.45 1.5-1.5 2.25-2.4 1.1l-.8-1.1H5.6l-.8 1.1c-.9 1.15-2.85.4-2.4-1.1l.45-1.45C3.2 7.73 4.05 7 5.25 7Z" /><path d="M5.25 8.5v2M4.25 9.5h2M11.5 9h.01M12.5 10h.01" /></>}
      {icon === "images" && <><rect x="2.25" y="3" width="11.5" height="10" rx="1.25" /><circle cx="5.25" cy="6" r="1" /><path d="m3.5 11 3.25-3 2.25 2 1.5-1.5 2 2" /></>}
      {icon === "media" && <><rect x="2.5" y="3" width="11" height="10" rx="1" /><path d="m6.5 5.5 3.5 2.5-3.5 2.5Z" /><path d="M4 3v10M12 3v10" /></>}
      {icon === "music" && <><path d="M10.5 3v7.5a2 2 0 1 1-1-1.73V5l-5 1v6a2 2 0 1 1-1-1.73V4.5Z" /></>}
      {icon === "notes" && <><path d="M3 2.5h9.5v11H3Z" /><path d="M5.25 5.5h5M5.25 8h5M5.25 10.5h3.25" /></>}
      {icon === "notifications" && <><path d="M4.25 10.75h7.5l-1.1-1.6V6.5a2.65 2.65 0 0 0-5.3 0v2.65Z" /><path d="M6.5 12a1.65 1.65 0 0 0 3 0M7.25 2.75h1.5" /></>}
      {icon === "phone" && <><rect x="4.5" y="2" width="7" height="12" rx="1.25" /><path d="M7 4h2M7.4 11.5h1.2" /></>}
      {icon === "photos" && <><rect x="2.25" y="5" width="11.5" height="8" rx="1.25" /><path d="M5.25 5 6.5 3.25h3L10.75 5" /><circle cx="8" cy="9" r="2" /></>}
      {icon === "podcasts" && <><circle cx="8" cy="8" r="5.25" /><circle cx="8" cy="8" r="1" className="folder-name-fill" /><path d="M8 5.25v-1M8 11.75v-1M5.25 8h-1M11.75 8h-1" /></>}
      {icon === "recordings" && <path d="M3 9v-2M5.5 12V4M8 14V2M10.5 12V4M13 9v-2" />}
      {icon === "ringtones" && <><path d="M3 9.75h2.25L8.5 12.5v-9L5.25 6.25H3Z" /><path d="M10.5 6.25a2.5 2.5 0 0 1 0 3.5M12.25 4.5a5 5 0 0 1 0 7" /></>}
      {icon === "settings" && <><circle cx="8" cy="8" r="2.25" /><path d="M8 2.5v1.25M8 12.25v1.25M2.5 8h1.25M12.25 8h1.25M4.1 4.1l.9.9M11 11l.9.9M11.9 4.1l-.9.9M5 11l-.9.9" /></>}
      {icon === "videos" && <><rect x="2.25" y="4" width="8.5" height="8" rx="1" /><path d="m10.75 6 3-1.5v7l-3-1.5ZM5.75 6.5l2.5 1.5-2.5 1.5Z" /></>}
      {icon === "work" && <><rect x="2.25" y="5.5" width="11.5" height="8" rx="1.25" /><path d="M6 5.5V4.25c0-.7.55-1.25 1.25-1.25h1.5c.7 0 1.25.55 1.25 1.25V5.5M2.25 8.5h11.5M6.75 8.5v1h2.5v-1" /></>}
    </g>
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
