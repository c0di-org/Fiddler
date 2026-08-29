import type { Entry } from "./types";

/** Extension -> the human label Finder would show in its Kind column. */
const KINDS: Record<string, string> = {
  ts: "TypeScript source",
  tsx: "TypeScript source",
  js: "JavaScript source",
  jsx: "JavaScript source",
  mjs: "JavaScript source",
  cjs: "JavaScript source",
  rs: "Rust source",
  go: "Go source",
  py: "Python source",
  rb: "Ruby source",
  swift: "Swift source",
  java: "Java source",
  kt: "Kotlin source",
  c: "C source",
  h: "C header",
  cpp: "C++ source",
  cc: "C++ source",
  hpp: "C++ header",
  cs: "C# source",
  php: "PHP source",
  lua: "Lua source",
  sh: "Shell script",
  zsh: "Shell script",
  bash: "Shell script",
  fish: "Shell script",

  json: "JSON document",
  jsonc: "JSON document",
  toml: "TOML document",
  yaml: "YAML document",
  yml: "YAML document",
  xml: "XML document",
  html: "HTML document",
  css: "Stylesheet",
  scss: "Stylesheet",
  sass: "Stylesheet",
  sql: "SQL script",

  md: "Markdown text",
  mdx: "Markdown text",
  txt: "Plain text",
  pdf: "PDF document",
  csv: "CSV document",
  rtf: "Rich text",

  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  gif: "GIF image",
  webp: "WebP image",
  svg: "SVG image",
  ico: "Icon",
  icns: "Icon",
  heic: "HEIC image",

  mp4: "MPEG-4 movie",
  mov: "QuickTime movie",
  webm: "WebM movie",
  mp3: "MP3 audio",
  wav: "WAV audio",
  m4a: "AAC audio",
  // The audiobook container: an MP4 holding AAC, distinguished from `.m4a`
  // only by the extension and by carrying chapters. Naming it is worth a line
  // — a folder of these is the thing the player was written for.
  m4b: "Audiobook",
  aac: "AAC audio",
  flac: "FLAC audio",
  ogg: "Ogg audio",
  opus: "Opus audio",

  zip: "ZIP archive",
  gz: "Gzip archive",
  tar: "Tar archive",
  dmg: "Disk image",
  app: "Application",
  lock: "Lock file",
  log: "Log file",
};

/** Files with no extension that everyone recognises anyway. */
const BY_NAME: Record<string, string> = {
  Makefile: "Makefile",
  Dockerfile: "Dockerfile",
  LICENSE: "Plain text",
  README: "Plain text",
  ".gitignore": "Git ignore list",
  ".gitattributes": "Git attributes",
  ".env": "Environment file",
};

export function kindOf(entry: Entry): string {
  if (entry.kind === "dir") return entry.isRepo ? "Repository folder" : "Folder";
  if (entry.kind === "symlink") return entry.linkToDir ? "Folder alias" : "Alias";

  const byName = BY_NAME[entry.name];
  if (byName) return byName;

  const dot = entry.name.lastIndexOf(".");
  if (dot <= 0) return "Document";

  const ext = entry.name.slice(dot + 1).toLowerCase();
  return KINDS[ext] ?? `${ext.toUpperCase()} file`;
}
