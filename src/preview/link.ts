/**
 * Shortcut files — the two formats people actually have on disk.
 *
 * `.url` is the Windows INI-ish one, `.webloc` is macOS's XML plist. Both exist
 * to hold a single destination, which makes them the one file type a browser is
 * unambiguously better at opening than anything else.
 *
 * Nothing here trusts the file. A shortcut is arbitrary bytes that arrived from
 * somewhere, and the whole point of it is to be clicked, so the scheme check
 * below is the load-bearing part of this module: `javascript:` and `file:`
 * destinations are rejected outright rather than rendered as something inviting.
 */

export type LinkKind = "repo" | "macos" | "android" | "web";

export interface Shortcut {
  url: string;
  kind: LinkKind;
}

/** Only schemes that mean "somewhere else on the web". Everything else — most
 * importantly `javascript:`, `data:` and `file:` — is not a link we will offer
 * to follow. */
const SAFE_SCHEME = /^(https?|mailto):/i;

const KINDS = new Set<string>(["repo", "macos", "android", "web"]);

export function parseShortcut(source: string): Shortcut | null {
  const url = extractUrl(source);
  if (!url) return null;

  const trimmed = url.trim();
  if (!SAFE_SCHEME.test(trimmed)) return null;

  // A second parse, so something that passes the scheme test but isn't a URL at
  // all can't reach an `href`.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // `Icon=` is our own optional key, in the spirit of the format's `IconFile`.
  // A URL alone can't always say what it is for — two builds of the same app
  // often live behind the same releases page — so a file may state its own
  // platform. Anything unrecognised is ignored rather than trusted.
  const declared = /^\s*Icon\s*=\s*([a-z]+)\s*$/im.exec(source.slice(0, 8192))?.[1]?.toLowerCase();
  const kind = declared && KINDS.has(declared) ? (declared as LinkKind) : kindOf(parsed);

  return { url: parsed.href, kind };
}

function extractUrl(source: string): string | null {
  // Only the front of the file matters, and a "shortcut" that isn't small is
  // not a shortcut.
  const head = source.slice(0, 8192);

  // .webloc — a plist whose <key>URL</key> is followed by its <string>.
  const plist = /<key>\s*URL\s*<\/key>\s*<string>([^<]*)<\/string>/i.exec(head);
  if (plist) return decodeEntities(plist[1]);

  // .url — the first `URL=` line, which is what every writer of this format
  // emits regardless of which section it claims to be in.
  for (const line of head.split(/\r?\n/)) {
    const match = /^\s*URL\s*=\s*(.+)$/i.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** The five entities XML requires; a URL in a plist rarely needs more. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** What to draw when the file hasn't said. Derived from the destination rather
 * than the filename, so renaming a shortcut can't change what it claims to be. */
function kindOf(url: URL): LinkKind {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  if (host === "github.com" || host.endsWith(".github.com") || host === "gitlab.com") {
    return "repo";
  }
  if (/\.apk($|\?)/.test(path) || host === "play.google.com" || /android/.test(path)) {
    return "android";
  }
  if (/\.(dmg|pkg)($|\?)/.test(path) || host === "apps.apple.com" || /macos|darwin/.test(path)) {
    return "macos";
  }
  return "web";
}

/**
 * Marks for each destination, as bare path data so the same geometry can be
 * drawn by React in a glyph and rasterised into a thumbnail by the web backend.
 * Drawn on a 16×16 grid, stroked, to sit alongside the rest of `icons.tsx`.
 */
export const LINK_MARKS: Record<LinkKind, readonly string[]> = {
  repo: [
    "M4.5 2.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2",
    "M11.5 2.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2",
    "M8 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2",
    "M4.5 5.6v.9a2.1 2.1 0 0 0 2.1 2.1h2.8a2.1 2.1 0 0 0 2.1-2.1v-.9",
    "M8 8.6v1.8",
  ],
  macos: [
    "M3 3.75h10a.75.75 0 0 1 .75.75v5.75a.75.75 0 0 1-.75.75H3a.75.75 0 0 1-.75-.75V4.5A.75.75 0 0 1 3 3.75Z",
    "M1.25 12.75h13.5",
  ],
  android: [
    "M5.25 1.75h5.5a1.25 1.25 0 0 1 1.25 1.25v10a1.25 1.25 0 0 1-1.25 1.25h-5.5A1.25 1.25 0 0 1 4 13V3a1.25 1.25 0 0 1 1.25-1.25Z",
    "M7 12.1h2",
  ],
  web: [
    "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5",
    "M1.75 8h12.5",
    "M8 1.75c1.75 1.7 2.6 3.85 2.6 6.25S9.75 12.55 8 14.25C6.25 12.55 5.4 10.4 5.4 8S6.25 3.45 8 1.75",
  ],
};

/** What the destination is called in a sentence. */
export const LINK_LABEL: Record<LinkKind, string> = {
  repo: "Source repository",
  macos: "macOS download",
  android: "Android download",
  web: "Web link",
};
