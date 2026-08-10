/**
 * The file browser's search deliberately indexes metadata only. A record is
 * prepared when a directory listing changes, leaving a query as a small amount
 * of string work with no disk or IPC activity.
 */

export type SearchKind = "file" | "dir" | "worktree";

export interface SearchSource<T> {
  // Local directory rows, bounded nearby candidates, and future recent-file
  // records all share this small contract and therefore this exact scorer.
  value: T;
  name: string;
  path: string;
  kind: SearchKind;
}

export interface SearchRecord<T> extends SearchSource<T> {
  /** Lower-cased once, when the listing changes rather than on every keypress. */
  nameKey: string;
  pathKey: string;
  extension: string;
  initials: string;
}

interface Query {
  terms: string[];
  extensions: string[];
  kinds: SearchKind[];
}

/** Precompute the immutable fields used by every subsequent query. */
export function prepareSearch<T>(source: SearchSource<T>): SearchRecord<T> {
  return {
    ...source,
    nameKey: source.name.toLocaleLowerCase(),
    pathKey: source.path.toLocaleLowerCase(),
    extension: extensionOf(source.name),
    initials: initialsOf(source.name),
  };
}

/**
 * Return records in relevance order. Ties preserve the browser's existing
 * natural order, so typing and clearing a query never makes the view jump.
 */
export function search<T>(records: readonly SearchRecord<T>[], input: string): SearchRecord<T>[] {
  const query = parse(input);
  if (query.terms.length === 0 && query.extensions.length === 0 && query.kinds.length === 0) {
    return [...records];
  }

  const hits: { record: SearchRecord<T>; score: number; at: number }[] = [];
  records.forEach((record, at) => {
    if (!matchesFilters(record, query)) return;

    let score = 0;
    for (const term of query.terms) {
      const termScore = scoreTerm(record, term);
      if (termScore === null) return;
      score += termScore;
    }
    hits.push({ record, score, at });
  });

  hits.sort((a, b) => a.score - b.score || a.at - b.at);
  return hits.map((hit) => hit.record);
}

function parse(input: string): Query {
  const query: Query = { terms: [], extensions: [], kinds: [] };
  // Quoted phrases matter for names such as "New Document". The syntax stays
  // intentionally small: unknown `key:value` words are regular search terms.
  for (const raw of input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const token = raw.replace(/^"|"$/g, "");
    const [key, ...rest] = token.split(":");
    const value = rest.join(":").toLocaleLowerCase();
    if (key.toLocaleLowerCase() === "ext" && value) {
      query.extensions.push(...value.split(",").map((part) => part.replace(/^\./, "")).filter(Boolean));
    } else if (key.toLocaleLowerCase() === "kind" && isKind(value)) {
      query.kinds.push(value);
    } else if (token) {
      query.terms.push(token.toLocaleLowerCase());
    }
  }
  return query;
}

function matchesFilters<T>(record: SearchRecord<T>, query: Query) {
  // Multiple values in one filter are alternatives: `ext:ts,tsx`. Different
  // filter types compose, so `ext:ts kind:file` narrows the result.
  if (query.extensions.length > 0 && !query.extensions.includes(record.extension)) return false;
  if (query.kinds.length > 0 && !query.kinds.includes(record.kind)) return false;
  return true;
}

function scoreTerm<T>(record: SearchRecord<T>, term: string): number | null {
  const name = scoreText(record.nameKey, term, record.initials);
  if (name !== null) return name;

  // A path hit remains useful, but a name hit always outranks it.
  const path = scoreText(record.pathKey, term, "");
  return path === null ? null : 200 + path;
}

/** Lower scores are better. The constants establish product priority, not math. */
function scoreText(text: string, term: string, initials: string): number | null {
  if (text === term) return 0;
  if (text.startsWith(term)) return 10 + text.length - term.length;

  const at = text.indexOf(term);
  if (at >= 0) return (isBoundary(text, at) ? 30 : 60) + at;

  if (initials && isSubsequence(initials, term)) return 90 + initials.length - term.length;

  const fuzzy = fuzzyCost(text, term);
  return fuzzy === null ? null : 120 + fuzzy;
}

function isBoundary(text: string, at: number) {
  return at === 0 || /[\s_./\\-]/.test(text[at - 1]);
}

/** A compact, deterministic fuzzy scorer. It rewards contiguous matches. */
function fuzzyCost(text: string, term: string): number | null {
  let found = 0;
  let last = -1;
  let gaps = 0;
  for (let i = 0; i < text.length && found < term.length; i++) {
    if (text[i] !== term[found]) continue;
    if (last >= 0) gaps += i - last - 1;
    last = i;
    found++;
  }
  return found === term.length ? gaps + (last < 0 ? 0 : last - term.length + 1) : null;
}

function isSubsequence(text: string, term: string) {
  let at = 0;
  for (const c of term) {
    at = text.indexOf(c, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

function initialsOf(name: string) {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    const prev = name[i - 1] ?? "";
    if (i === 0 || /[\s_./\\-]/.test(prev) || (isUpper(c) && !isUpper(prev))) out += c.toLocaleLowerCase();
  }
  return out;
}

function extensionOf(name: string) {
  const at = name.lastIndexOf(".");
  return at > 0 && at < name.length - 1 ? name.slice(at + 1).toLocaleLowerCase() : "";
}

function isKind(value: string): value is SearchKind {
  return value === "file" || value === "dir" || value === "worktree";
}

function isUpper(c: string) {
  return c >= "A" && c <= "Z";
}
