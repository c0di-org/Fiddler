/**
 * A small, dependency-free classifier for well-known folder names.
 *
 * Folder names are matched once against a normalised form (lowercase, without
 * accents or punctuation). Exact names take priority; the token rules are a
 * deliberately conservative fallback for names such as "Ben's Music" and
 * "2025 Family Photos". This avoids expensive fuzzy matching, and keeps false
 * positives out of ordinary project directories.
 */

export type FolderIcon =
  | "android"
  | "apps"
  | "archive"
  | "audiobooks"
  | "backup"
  | "books"
  | "cloud"
  | "code"
  | "database"
  | "design"
  | "documents"
  | "downloads"
  | "fonts"
  | "games"
  | "images"
  | "media"
  | "music"
  | "notes"
  | "notifications"
  | "phone"
  | "photos"
  | "podcasts"
  | "recordings"
  | "ringtones"
  | "settings"
  | "videos"
  | "work";

interface Rule {
  icon: FolderIcon;
  /** Names which should only match as the complete folder name. */
  exact: readonly string[];
  /** Safe whole-word matches for descriptive names. */
  tokens?: readonly string[];
}

const RULES: readonly Rule[] = [
  { icon: "android", exact: ["android", "apk", "apks"], tokens: ["android", "apk"] },
  {
    icon: "audiobooks",
    exact: ["audiobook", "audiobooks", "audio books", "spoken word"],
    tokens: ["audiobook"],
  },
  { icon: "music", exact: ["music", "audio", "songs", "albums", "playlists", "itunes"], tokens: ["music", "songs", "albums", "playlists"] },
  { icon: "podcasts", exact: ["podcast", "podcasts"], tokens: ["podcast"] },
  {
    icon: "recordings",
    exact: ["recordings", "recording", "voice memos", "voice recordings", "dictation"],
    tokens: ["recordings", "recording", "dictation"],
  },
  { icon: "ringtones", exact: ["ringtone", "ringtones", "sounds"], tokens: ["ringtones"] },
  { icon: "videos", exact: ["movies", "movie", "films", "film", "videos", "video", "tv shows", "television"], tokens: ["movies", "films", "videos"] },
  { icon: "media", exact: ["media", "clips", "footage"], tokens: ["footage"] },
  {
    icon: "photos",
    exact: ["photos", "photo", "pictures", "picture", "camera", "camera roll", "dcim", "screenshots"],
    tokens: ["photos", "pictures", "screenshots"],
  },
  { icon: "images", exact: ["images", "image", "wallpapers", "wallpaper", "artwork"], tokens: ["images", "wallpapers"] },
  // "Downlods" is common enough in hand-created folder structures to be worth
  // treating as an intentional alias, without turning on fuzzy matching.
  { icon: "downloads", exact: ["downloads", "download", "downlods", "incoming", "received files"], tokens: ["downloads"] },
  { icon: "documents", exact: ["documents", "document", "docs", "paperwork", "receipts", "invoices", "forms"], tokens: ["documents", "receipts", "invoices"] },
  { icon: "notes", exact: ["notes", "note", "samsung notes", "samsungnotes", "keep notes"], tokens: ["notes"] },
  { icon: "books", exact: ["books", "book", "ebooks", "e books", "kindle", "reading"], tokens: ["ebooks"] },
  { icon: "apps", exact: ["applications", "application", "apps", "app", "utilities", "tools"], tokens: ["applications", "utilities"] },
  { icon: "games", exact: ["games", "game", "steam games", "roms", "emulators"], tokens: ["games", "roms"] },
  { icon: "code", exact: ["code", "projects", "project", "development", "dev", "source", "src", "repositories", "repos", "git"], tokens: ["projects", "repositories", "repos"] },
  { icon: "design", exact: ["design", "designs", "creative", "assets", "ui", "ux", "mockups", "branding"], tokens: ["designs", "mockups", "branding"] },
  { icon: "archive", exact: ["archives", "archive", "compressed", "zips", "packages"], tokens: ["archives"] },
  { icon: "backup", exact: ["backup", "backups", "time machine", "restore"], tokens: ["backups"] },
  { icon: "cloud", exact: ["icloud drive", "cloud", "dropbox", "onedrive", "google drive", "drive", "shared", "sharing"], tokens: ["dropbox", "onedrive"] },
  { icon: "database", exact: ["data", "database", "databases", "datasets", "exports"], tokens: ["datasets", "databases"] },
  { icon: "fonts", exact: ["fonts", "font", "typefaces"], tokens: ["fonts", "typefaces"] },
  { icon: "settings", exact: ["settings", "config", "configuration", "preferences", "configs"], tokens: ["settings", "configs"] },
  { icon: "notifications", exact: ["notifications", "notification", "alerts"], tokens: ["notifications"] },
  { icon: "phone", exact: ["iphone data", "iphonedata", "iphone", "mobile", "phone", "phones"], tokens: ["iphonedata"] },
  { icon: "work", exact: ["work", "school", "university", "college", "classes", "coursework", "business", "clients"], tokens: ["coursework", "clients"] },
];

function normalise(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const exactMatches = new Map<string, FolderIcon>();
const tokenMatches = new Map<string, FolderIcon>();

for (const rule of RULES) {
  for (const name of rule.exact) exactMatches.set(normalise(name), rule.icon);
  for (const token of rule.tokens ?? []) tokenMatches.set(token, rule.icon);
}

/** Returns the first intentional match, or null for an ordinary folder. */
export function folderIconForName(name: string): FolderIcon | null {
  const normalised = normalise(name);
  if (!normalised) return null;

  const exact = exactMatches.get(normalised);
  if (exact) return exact;

  // Tokenising is linear in the short folder name and uses a prebuilt Map.
  // Checking each token (rather than every rule) makes the fallback cheap even
  // in a virtualised view of tens of thousands of entries.
  for (const token of normalised.split(" ")) {
    const match = tokenMatches.get(token);
    if (match) return match;
  }
  return null;
}
