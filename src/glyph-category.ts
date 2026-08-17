import { routeOf } from "./preview/route";

/**
 * The broad colour family a file wears wherever it is drawn. Keep this small:
 * colour is the second cue after silhouette, not a logo system.
 */
export type Category = "code" | "image" | "media" | "doc" | "archive" | "config" | "link" | "plain";

/** The silhouette/mark used by the generic file glyph fallback. */
export type FileVisualKind =
  | "code"
  | "config"
  | "data"
  | "document"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "link"
  | "generic";

const CONFIG = new Set([
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "properties", "xml", "plist", "lock",
]);

const CONFIG_NAMES = new Set([
  ".env", ".editorconfig", ".prettierrc", ".eslintrc", ".npmrc", ".gitignore",
  ".gitattributes", ".gitmodules",
]);

const DATA = new Set(["csv", "tsv"]);

const ARCHIVE = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "tar", "rar", "7z", "dmg", "pkg", "apk", "ipa",
]);

const DOCUMENT_ART = new Set([
  "rtf", "doc", "docx", "pages", "key", "numbers", "ppt", "pptx", "xls", "xlsx", "epub", "tex",
]);

const DESIGN_ART = new Set(["ai", "sketch"]);
const VIDEO_ART = new Set(["avi", "mkv"]);

export function extensionOf(nameOrPath: string): string {
  const name = nameOrPath.split("/").pop() ?? nameOrPath;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Derive the glyph from the same preview router that decides how the file is
 * opened. The few extra sets below split code-like config/data and formats that
 * have no preview route (archives), so icon and preview knowledge cannot drift
 * into two competing extension encyclopedias again.
 */
export function fileVisualKind(nameOrPath: string): FileVisualKind {
  const name = nameOrPath.split("/").pop() ?? nameOrPath;
  const ext = extensionOf(name);
  const route = routeOf(name);

  if (ARCHIVE.has(ext)) return "archive";
  if (CONFIG_NAMES.has(name) || CONFIG.has(ext)) return "config";
  if (DATA.has(ext)) return "data";

  switch (route) {
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "pdf":
      return "pdf";
    case "link":
      return "link";
    case "markdown":
    case "text":
      return "document";
    case "code":
      return DOCUMENT_ART.has(ext) ? "document" : "code";
    case "art":
      if (VIDEO_ART.has(ext)) return "video";
      if (DESIGN_ART.has(ext)) return "image";
      if (DOCUMENT_ART.has(ext)) return "document";
      return "generic";
    case "none":
      return DOCUMENT_ART.has(ext) ? "document" : "generic";
  }
}

export function categoryOf(name: string): Category {
  switch (fileVisualKind(name)) {
    case "code":
      return "code";
    case "config":
    case "data":
      return "config";
    case "image":
      return "image";
    case "audio":
    case "video":
      return "media";
    case "document":
    case "pdf":
      return "doc";
    case "archive":
      return "archive";
    case "link":
      return "link";
    case "generic":
      return "plain";
  }
}
