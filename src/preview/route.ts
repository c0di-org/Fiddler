/**
 * Which preview a file gets. Mirrors the lanes in `src-tauri/src/thumb.rs` —
 * keep the two in step.
 */

/** The routes that are read rather than looked at. */
export type TextRoute = "markdown" | "code" | "text";

export type Route = TextRoute | "pdf" | "image" | "audio" | "video" | "art" | "link" | "none";

/** Shortcut files, which hold one destination and nothing else. Ahead of
 * `CODE` deliberately: a `.webloc` is XML and a `.url` is INI, and showing
 * either as source would be technically true and completely useless. */
const LINK = new Set(["url", "webloc"]);

const IMAGE = new Set([
  "png", "jpg", "jpeg", "jpe", "gif", "bmp", "ico", "tif", "tiff", "webp", "avif", "heic", "heif",
  "jp2", "psd", "tga", "exr", "icns", "raw", "cr2", "cr3", "nef", "arw", "dng", "raf", "orf",
  "rw2", "srw", "pef", "svg",
]);

const MARKDOWN = new Set(["md", "mdx", "markdown"]);

/**
 * Prose: wrapped to a measure, no grammar. Records — logs, CSVs — deliberately
 * aren't here. They're line-oriented and often enormous, and both of those want
 * the virtualized, unwrapped view that `code` gets.
 */
const PLAIN = new Set(["txt", "text", "rst", "srt", "vtt"]);

const CODE = new Set([
  "log", "csv", "tsv",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
  "xml", "plist", "html", "htm", "css", "scss", "sass", "less", "sql", "graphql", "diff", "patch",
  "sh", "zsh", "bash", "fish", "ps1", "bat", "rs", "go", "py", "rb", "swift", "java", "kt", "kts",
  "gradle", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "m", "mm", "php", "lua", "pl", "r",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "dart", "ex", "exs", "erl", "hs",
  "scala", "clj", "zig", "nim", "sol", "proto", "cmake", "mk", "lock", "tex",
]);

/** Things macOS can picture but we can only show as a still. */
const ART = new Set([
  "avi", "mkv", "ai", "sketch", "key", "pages", "numbers", "ppt",
  "pptx", "doc", "docx", "xls", "xlsx", "epub", "usdz", "obj", "stl",
]);

// The audio route is a door rather than a preview: Quick Look shows what the
// file is and where you got to, and Play hands it to `audio/player.ts`, which
// lives outside the view tree and so outlives the folder. See `docs/audio.md`.
// Opening one of these never asks the system first — Fiddler is the only thing
// that knows the position, and handing an audiobook to another player means
// starting chapter nine from the top, every time.
const AUDIO = new Set(["mp3", "m4a", "m4b", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"]);
const VIDEO = new Set(["mp4", "m4v", "mov", "webm", "3gp", "3g2"]);

const NAMED: Record<string, Route> = {
  Makefile: "code",
  Dockerfile: "code",
  Justfile: "code",
  Rakefile: "code",
  Gemfile: "code",
  Procfile: "code",
  Brewfile: "code",
  CODEOWNERS: "code",
  LICENSE: "text",
  LICENCE: "text",
  README: "text",
  CHANGELOG: "text",
  AUTHORS: "text",
  NOTICE: "text",
  ".gitignore": "code",
  ".gitattributes": "code",
  ".gitmodules": "code",
  ".env": "code",
  ".zshrc": "code",
  ".bashrc": "code",
  ".profile": "code",
  ".editorconfig": "code",
  ".prettierrc": "code",
  ".eslintrc": "code",
  ".npmrc": "code",
};

export function routeOf(nameOrPath: string): Route {
  const name = nameOrPath.split("/").pop() ?? nameOrPath;
  const named = NAMED[name];
  if (named) return named;

  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "none";
  const ext = name.slice(dot + 1).toLowerCase();

  if (LINK.has(ext)) return "link";
  if (MARKDOWN.has(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  if (IMAGE.has(ext)) return "image";
  if (AUDIO.has(ext)) return "audio";
  if (VIDEO.has(ext)) return "video";
  if (PLAIN.has(ext)) return "text";
  if (CODE.has(ext)) return "code";
  if (ART.has(ext)) return "art";
  return "none";
}

/** Whether this route is read as text rather than looked at as a picture. */
export function isTextual(route: Route): route is TextRoute {
  return route === "markdown" || route === "code" || route === "text";
}
