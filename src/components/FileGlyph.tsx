import type { Entry } from "../types";

/**
 * The icon shown when there's no image preview. Scales from a 16px list row up to
 * a 128px grid tile: the document sheet gains a type label as it grows, the way
 * Finder's own generic icons do.
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

export function FileGlyph({ entry, size }: { entry: Entry; size: number }) {
  const isDir = entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir);

  if (isDir) return <FolderGlyph size={size} repo={entry.isRepo} />;

  const dot = entry.name.lastIndexOf(".");
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  const category = CATEGORY[ext] ?? "plain";
  const showLabel = size >= 44 && ext.length > 0 && ext.length <= 6;
  // Shrink the type text rather than truncating it — "SWIF" reads as a typo.
  const labelSize = ext.length <= 3 ? 8.6 : ext.length === 4 ? 7.4 : 6.2;

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={`glyph glyph-file cat-${category}`}
      aria-hidden="true"
    >
      {/* Sheet with a folded corner. */}
      <path
        d="M11 4.5h20L38.5 12v31a1.5 1.5 0 0 1-1.5 1.5H11A1.5 1.5 0 0 1 9.5 43V6A1.5 1.5 0 0 1 11 4.5Z"
        className="sheet"
      />
      <path d="M31 4.5V12h7.5" className="fold" />
      {showLabel ? (
        <>
          <rect x="9.5" y="26" width="29" height="12" rx="2.5" className="tag" />
          <text
            x="24"
            y="34.4"
            textAnchor="middle"
            className="tag-text"
            style={{ fontSize: labelSize }}
          >
            {ext.toUpperCase()}
          </text>
        </>
      ) : (
        <>
          <path d="M15 21h18M15 27h18M15 33h11" className="lines" />
        </>
      )}
    </svg>
  );
}

export function FolderGlyph({ size, repo }: { size: number; repo?: boolean }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className="glyph glyph-folder" aria-hidden="true">
      <defs>
        <linearGradient id="fld-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--folder-2)" />
          <stop offset="1" stopColor="var(--folder-1)" />
        </linearGradient>
        <linearGradient id="fld-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--folder-1)" />
          <stop offset="1" stopColor="var(--folder-2)" />
        </linearGradient>
      </defs>
      {/* Back panel peeking above the front, which is what reads as "folder". */}
      <path
        d="M4 13.5A3.5 3.5 0 0 1 7.5 10h11l4.2 4.6H40.5a3.5 3.5 0 0 1 3.5 3.5v3H4Z"
        fill="url(#fld-back)"
      />
      <path
        d="M4 19.5A3.5 3.5 0 0 1 7.5 16h33a3.5 3.5 0 0 1 3.5 3.5v15A3.5 3.5 0 0 1 40.5 38h-33A3.5 3.5 0 0 1 4 34.5Z"
        fill="url(#fld-front)"
      />
      {repo && size >= 28 && (
        // A quiet branch mark on the folder face — present, never the subject.
        <g className="folder-repo-mark" transform="translate(30.5 21.5) scale(0.62)">
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
