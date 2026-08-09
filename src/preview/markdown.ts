/**
 * A markdown parser sized for previewing, not publishing.
 *
 * It covers the CommonMark that actually turns up in the files a developer
 * browses — headings, fences, lists, tables, quotes, links, emphasis — and
 * ignores the rest. That trade buys two things worth more here than
 * completeness: it stays a few hundred lines with no dependency to pull in, and
 * it produces a plain data tree rather than a string of HTML, so nothing a file
 * contains can ever be interpreted as markup. A README is untrusted input like
 * any other file on disk.
 *
 * Parsing is linear in the input and allocation-light: blocks are cut by index
 * over the line array, and inline spans are scanned once with no backtracking.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; k: Inline[] }
  | { t: "em"; k: Inline[] }
  | { t: "del"; k: Inline[] }
  | { t: "link"; href: string; k: Inline[] }
  | { t: "img"; src: string; alt: string };

export type Align = "left" | "center" | "right";

export interface Item {
  blocks: Block[];
  /** `- [ ]` / `- [x]`, which readers expect to see as a real checkbox. */
  task?: boolean;
  done?: boolean;
}

export type Block =
  | { t: "h"; level: number; k: Inline[] }
  | { t: "p"; k: Inline[] }
  | { t: "pre"; lang: string; v: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Item[] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][]; align: Align[] };

/**
 * Past this many blocks a preview has long since stopped being a preview, and
 * every further block is React reconciliation nobody will scroll to. Callers
 * report the cut rather than hiding it.
 */
export const BLOCK_LIMIT = 1500;

export interface Doc {
  blocks: Block[];
  /** The document had more blocks than we chose to build. */
  clipped: boolean;
}

export function parse(source: string): Doc {
  const lines = source.split("\n");
  const blocks = parseBlocks(lines, BLOCK_LIMIT);
  return { blocks, clipped: blocks.length >= BLOCK_LIMIT };
}

// ------------------------------------------------------------------- blocks

function parseBlocks(lines: string[], limit: number): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length && out.length < limit) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // A fence runs to its matching close, or to the end of the file — an
    // unterminated fence is common in a half-written README and must not eat
    // the parser.
    const fence = fenceAt(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], fence.marker)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push({ t: "pre", lang: fence.lang, v: body.join("\n") });
      continue;
    }

    if (/^ {0,3}(?:[-*_] *){3,}$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    const atx = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      out.push({ t: "h", level: atx[1].length, k: inline(atx[2]) });
      i++;
      continue;
    }

    // Setext: the underline is what makes the line above a heading.
    const next = lines[i + 1];
    if (next && /^ {0,3}(=+|-+)\s*$/.test(next) && line.trim()) {
      out.push({ t: "h", level: next.trim()[0] === "=" ? 1 : 2, k: inline(line.trim()) });
      i += 2;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]) || (body.length > 0 && lines[i].trim()))) {
        body.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      out.push({ t: "quote", blocks: parseBlocks(body, limit) });
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      out.push(table.block);
      i = table.next;
      continue;
    }

    const list = listAt(lines, i, limit);
    if (list) {
      out.push(list.block);
      i = list.next;
      continue;
    }

    // Everything else is a paragraph, running until a blank line or the start
    // of a block that outranks it.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !interrupts(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push({ t: "p", k: inline(para.join(" ")) });
    else i++;
  }

  return out;
}

/** Block starts that end a paragraph without a blank line between them. */
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i];
  if (i === 0) return false;
  return (
    fenceAt(line) !== null ||
    /^ {0,3}#{1,6}\s/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}(?:[-*_] *){3,}$/.test(line) ||
    markerAt(line) !== null
  );
}

interface Fence {
  marker: string;
  lang: string;
}

function fenceAt(line: string): Fence | null {
  const m = /^ {0,3}(```+|~~~+)\s*([^\s`]*)/.exec(line);
  return m ? { marker: m[1][0].repeat(3), lang: m[2].toLowerCase() } : null;
}

function closesFence(line: string, marker: string): boolean {
  return new RegExp(`^ {0,3}${marker[0] === "`" ? "```" : "~~~"}+\\s*$`).test(line);
}

// -------------------------------------------------------------------- lists

interface Marker {
  indent: number;
  ordered: boolean;
  start: number;
  /** Where the item's own content begins, which sets the nesting indent. */
  content: number;
}

function markerAt(line: string): Marker | null {
  const bullet = /^( {0,3})([-*+])(\s+)/.exec(line);
  if (bullet) {
    return {
      indent: bullet[1].length,
      ordered: false,
      start: 1,
      content: bullet[0].length,
    };
  }
  const ordered = /^( {0,3})(\d{1,9})[.)](\s+)/.exec(line);
  if (ordered) {
    return {
      indent: ordered[1].length,
      ordered: true,
      start: Number(ordered[2]),
      content: ordered[0].length,
    };
  }
  return null;
}

function listAt(lines: string[], from: number, limit: number): { block: Block; next: number } | null {
  const first = markerAt(lines[from]);
  if (!first) return null;

  const items: Item[] = [];
  let i = from;

  while (i < lines.length) {
    const marker = markerAt(lines[i]);
    // A different marker style starts a different list, which is what keeps a
    // bulleted list from swallowing the numbered one below it.
    if (!marker || marker.ordered !== first.ordered || marker.indent > first.indent + 3) break;

    const body = [lines[i].slice(marker.content)];
    i++;
    // Continuation lines belong to this item: either indented under it, or a
    // plain "lazy" line carrying the paragraph on.
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line only continues the item if indented content follows.
        const after = lines[i + 1];
        if (after && after.trim() && leading(after) >= marker.content) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      if (leading(line) >= marker.content) {
        body.push(line.slice(marker.content));
        i++;
        continue;
      }
      if (markerAt(line) || interrupts(lines, i)) break;
      body.push(line.trim());
      i++;
    }

    items.push(item(body, limit));
  }

  if (items.length === 0) return null;
  return {
    block: { t: "list", ordered: first.ordered, start: first.start, items },
    next: i,
  };
}

function item(body: string[], limit: number): Item {
  const task = /^\[([ xX])\]\s+/.exec(body[0]);
  if (task) body = [body[0].slice(task[0].length), ...body.slice(1)];
  const blocks = parseBlocks(body, limit);
  return task ? { blocks, task: true, done: task[1] !== " " } : { blocks };
}

function leading(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

// ------------------------------------------------------------------- tables

function tableAt(lines: string[], from: number): { block: Block; next: number } | null {
  const header = lines[from];
  const rule = lines[from + 1];
  if (!header?.includes("|") || !rule) return null;
  if (!/^ {0,3}\|?[\s:|-]+\|[\s:|-]*$/.test(rule) || !/-/.test(rule)) return null;

  const align = cells(rule).map<Align>((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
  const head = cells(header).map(inline);
  if (head.length === 0) return null;

  const rows: Inline[][][] = [];
  let i = from + 2;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(cells(lines[i]).map(inline));
    i++;
  }
  return { block: { t: "table", head, rows, align }, next: i };
}

function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

// ------------------------------------------------------------------- inline

/**
 * One left-to-right scan. Code spans win over everything — inside backticks,
 * markdown syntax is just characters — and each delimiter is only treated as one
 * if its partner actually exists, so a stray asterisk stays an asterisk.
 */
export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;

  const flush = () => {
    if (text) {
      out.push({ t: "text", v: text });
      text = "";
    }
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const ticks = run(src, i, "`");
      const close = src.indexOf("`".repeat(ticks), i + ticks);
      if (close > 0) {
        flush();
        out.push({ t: "code", v: src.slice(i + ticks, close).trim() });
        i = close + ticks;
        continue;
      }
    }

    if (c === "!" && src[i + 1] === "[") {
      const link = linkAt(src, i + 1);
      if (link) {
        flush();
        out.push({ t: "img", src: link.href, alt: plain(link.label) });
        i = link.next;
        continue;
      }
    }

    if (c === "[") {
      const link = linkAt(src, i);
      if (link) {
        flush();
        out.push({ t: "link", href: link.href, k: inline(link.label) });
        i = link.next;
        continue;
      }
    }

    if (c === "<") {
      const auto = /^<((?:https?|mailto):[^\s>]+)>/.exec(src.slice(i));
      if (auto) {
        flush();
        out.push({ t: "link", href: auto[1], k: [{ t: "text", v: auto[1] }] });
        i += auto[0].length;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const n = run(src, i, c);
      const wanted = c === "~" ? 2 : Math.min(n, 2);
      if (!(c === "~" && n < 2) && opens(src, i, n, c)) {
        const delim = c.repeat(wanted);
        const close = findClose(src, i + n, delim, c);
        if (close > 0) {
          flush();
          const kids = inline(src.slice(i + wanted, close));
          out.push(
            c === "~"
              ? { t: "del", k: kids }
              : wanted === 2
                ? { t: "strong", k: kids }
                : { t: "em", k: kids }
          );
          i = close + wanted;
          continue;
        }
      }
    }

    text += c;
    i++;
  }

  flush();
  return out;
}

function run(src: string, at: number, ch: string): number {
  let n = 0;
  while (src[at + n] === ch) n++;
  return n;
}

const WORD_CHAR = /[\w]/;

/**
 * Whether a delimiter run can open emphasis — CommonMark's flanking rule, cut
 * down to the two cases that matter in the wild. Without it `2 * 3 * 4` comes
 * out italic, and `snake_case_name` comes out half-italic, both of which are
 * everyday text in the files this previews.
 */
function opens(src: string, at: number, n: number, ch: string): boolean {
  const after = src[at + n];
  if (after === undefined || /\s/.test(after)) return false;
  if (ch === "_") {
    const before = src[at - 1];
    if (before !== undefined && WORD_CHAR.test(before)) return false;
  }
  return true;
}

/** The next unescaped `delim` that can actually close the run, or -1. */
function findClose(src: string, from: number, delim: string, ch: string): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (!src.startsWith(delim, i)) continue;
    // The mirror of the opening rule: a closer can't follow a space, and `_`
    // can't be closed from inside a word.
    const before = src[i - 1];
    if (before === undefined || /\s/.test(before)) continue;
    if (ch === "_") {
      const after = src[i + delim.length];
      if (after !== undefined && WORD_CHAR.test(after)) continue;
    }
    return i;
  }
  return -1;
}

interface Link {
  label: string;
  href: string;
  next: number;
}

/** `[label](href)`, with balanced brackets in the label and parens in the URL. */
function linkAt(src: string, at: number): Link | null {
  if (src[at] !== "[") return null;
  let depth = 0;
  let i = at;
  for (; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) break;
  }
  if (depth !== 0 || src[i + 1] !== "(") return null;

  const label = src.slice(at + 1, i);
  let j = i + 2;
  let parens = 1;
  for (; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "(") parens++;
    else if (src[j] === ")" && --parens === 0) break;
  }
  if (parens !== 0) return null;

  // A title after the URL is dropped; nothing in a preview shows it.
  const href = src.slice(i + 2, j).trim().split(/\s+/)[0] ?? "";
  return { label, href, next: j + 1 };
}

/** Inline tree back to bare text, for image alts and heading anchors. */
export function plain(src: string): string {
  return src.replace(/[*_`~]/g, "");
}
