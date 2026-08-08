const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (bytes < 1000) return `${bytes} B`;
  let n = bytes;
  let u = 0;
  while (n >= 1000 && u < UNITS.length - 1) {
    n /= 1000;
    u++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${UNITS[u]}`;
}

/** Collapse `/Users/<me>/…` to `~/…` for display. */
export function tildify(path: string, home: string): string {
  if (home && path.startsWith(home)) return "~" + path.slice(home.length);
  return path;
}

/**
 * Absolute, Finder-style timestamp for the list view's Date Modified column.
 * Relative phrasing ("2h ago") is fine in prose but makes a sortable column
 * impossible to scan, so only today and yesterday get names.
 */
export function formatStamp(unixSecs: number): string {
  if (!unixSecs) return "—";
  const d = new Date(unixSecs * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;

  if (d.getTime() >= startOfToday.getTime()) return `Today ${time}`;
  if (d.getTime() >= startOfToday.getTime() - dayMs) return `Yesterday ${time}`;

  const sameYear = d.getFullYear() === startOfToday.getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} ${time}`;
}
