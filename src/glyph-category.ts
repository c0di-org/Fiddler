/**
 * The colour a file wears wherever it's drawn: the band across its own glyph,
 * and the card fanned out of a folder holding it. One table, so a `.rs` file is
 * the same purple in both places.
 */

export type Category = "code" | "image" | "media" | "doc" | "archive" | "config" | "link" | "plain";

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

  // Shortcuts. The band is all a list row can say — which destination one points
  // at needs the file read, so that lives in the preview and the thumbnail.
  url: "link", webloc: "link",
};

export function categoryOf(name: string): Category {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? CATEGORY[name.slice(dot + 1).toLowerCase()] : undefined) ?? "plain";
}
