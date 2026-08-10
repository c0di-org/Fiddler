/** The folder the web build opens into.
 *
 * It has two jobs and they pull in the same direction: show what Fiddler is
 * good at — dense listings, real thumbnails, rendered markdown, highlighted
 * source, type-to-jump, search that reaches into file contents — and be a
 * genuinely usable scratch space while doing it. Everything here is editable;
 * the edits just don't outlive the tab.
 *
 * Folder names are chosen to land on the rules in `folder-icon.ts`, which is
 * why they read as `Projects`, `Documents`, `Pictures`, `Music` and `Downloads`
 * rather than anything more imaginative. */

import { architectureDiagram, chord, PALETTES, wallpaper } from "./demo-art";
import { MemoryProvider } from "./memory-fs";

export const DEMO_MOUNT = "Fiddler Demo";

const REPO = "https://github.com/garfbargle/Fiddler";

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
/** Relative rather than fixed, so the demo never looks abandoned. */
const daysAgo = (days: number, hours = 0) => now() - days * DAY - hours * 3600;

export function buildDemo(): MemoryProvider {
  const fs = new MemoryProvider();

  const text = (path: string, body: string, mtime: number) =>
    fs.seedFile(path, new Blob([body], { type: "text/plain" }), mtime);

  const svg = (path: string, body: string, mtime: number) =>
    fs.seedFile(path, new Blob([body], { type: "image/svg+xml" }), mtime);

  // ------------------------------------------------------------- the pitch

  text("Start Here.md", START_HERE, daysAgo(0, 2));

  // Shortcuts, sitting in the folder like anything else. Fiddler understands
  // `.url` files, so the way out of the demo is the same gesture as everything
  // else in it: select, then open.
  const link = (name: string, url: string, icon: string) =>
    text(name, `[InternetShortcut]\nURL=${url}\nIcon=${icon}\n`, daysAgo(0, 3));

  // Short names on purpose: the tile carries the platform, and a grid cell
  // truncates past roughly twenty characters.
  link("Source on GitHub.url", REPO, "repo");
  link("Mac app.url", `${REPO}/releases`, "macos");
  link("Android app.url", `${REPO}/releases`, "android");

  // ------------------------------------------------------------- Pictures

  svg("Pictures/Architecture.svg", architectureDiagram(), daysAgo(4));
  PALETTES.forEach((palette, i) => {
    svg(`Pictures/${palette.name}.svg`, wallpaper(palette, 9973 + i * 7919), daysAgo(6 + i, i * 3));
  });

  // -------------------------------------------------------------- Projects

  text("Projects/aurora/README.md", AURORA_README, daysAgo(2));
  text("Projects/aurora/Cargo.toml", AURORA_CARGO, daysAgo(11));
  text("Projects/aurora/src/main.rs", AURORA_MAIN, daysAgo(2, 5));
  text("Projects/aurora/src/parser.rs", AURORA_PARSER, daysAgo(3));
  text("Projects/aurora/.gitignore", "/target\n**/*.rs.bk\n.env\n", daysAgo(40));
  text("Projects/aurora/notes.md", AURORA_NOTES, daysAgo(1, 6));

  text("Projects/fiddler-web/package.json", WEB_PACKAGE, daysAgo(1));
  text("Projects/fiddler-web/tsconfig.json", WEB_TSCONFIG, daysAgo(9));
  text("Projects/fiddler-web/src/backend.ts", WEB_BACKEND, daysAgo(0, 6));
  text("Projects/fiddler-web/src/styles.css", WEB_STYLES, daysAgo(5));
  text("Projects/fiddler-web/.env", "API_BASE=https://localhost:8787\nLOG_LEVEL=debug\n", daysAgo(5));

  // ------------------------------------------------------------- Documents

  text("Documents/Release Notes.md", RELEASE_NOTES, daysAgo(1));
  text("Documents/Field Notes.md", FIELD_NOTES, daysAgo(7));
  text("Documents/todo.txt", TODO, daysAgo(0, 9));

  // ------------------------------------------------------------------ Data

  text("Data/metrics.csv", METRICS, daysAgo(1, 3));
  text("Data/config.yaml", CONFIG, daysAgo(8));
  text("Data/users.json", USERS, daysAgo(3, 7));
  text("Data/rollup.sql", ROLLUP_SQL, daysAgo(14));

  // ----------------------------------------------------------------- Music

  fs.seedFile("Music/A major.wav", chord(), daysAgo(20));

  // ------------------------------------------------------------- Downloads

  text("Downloads/receipt.txt", RECEIPT, daysAgo(12));
  text("Downloads/notes from the call.md", CALL_NOTES, daysAgo(2, 8));

  return fs;
}

// ---------------------------------------------------------------- contents

const START_HERE = `# Fiddler, running in your browser

This is the real app. Not a video, not a screenshot tour — the same React front
end that ships in the Mac and Android builds, with a filesystem that lives in
this tab instead of a Rust process.

![How Fiddler is put together](Pictures/Architecture.svg)

## Try these

| | |
|---|---|
| \`⌘1\` / \`⌘2\` | Switch between icon and list view |
| \`space\` | Quick Look — this file renders, source highlights, PDFs page |
| \`⇧⌘P\` | Open the preview pane |
| \`⇧⌘.\` | Show hidden files — there are two in here |
| type letters | Jump to the first matching name |
| \`↵\` | Rename · \`⌘↵\` opens |
| \`⌘N\` | New text file, with a live markdown preview beside it |

Start in **Pictures** to see thumbnails fill in as you scroll, then **Projects**
for syntax highlighting across Rust, TypeScript, JSON and CSS.

Search does two things beyond matching names. In **Projects/aurora**, search
\`backpressure\` — no filename contains it, so Fiddler reads the folder's text
files and shows you the line. And from **Projects**, search \`parser\` — nothing
there is called that, so it widens to two levels down and finds the file.

## This is editable

Everything here is writable. Rename things, make folders, open a \`.md\` file and
edit it. Nothing is uploaded anywhere — there is no server behind this page — and
nothing survives a reload, which is the honest trade for never asking for your
disk.

> If you want Fiddler pointed at real files, use **Open Folder…** in the
> sidebar. That grants this tab access to exactly one folder, through the
> browser's own permission prompt, and edits there are real. You can also drag a
> folder from your desktop straight onto this window.

## What the desktop build adds

The web build is a file browser. The Mac app is a file browser that understands
git — and specifically, one that can see the worktrees Finder can't:

\`\`\`
~/Developer/n64/Mine64/.claude/worktrees/pause-tabs   ← hidden dotfolder in the repo
~/.codex/worktrees/e217/world_of_warblox              ← nowhere near the repo
/private/tmp/gitto-icon-deploy.9IbjSw                 ← ephemeral, already prunable
\`\`\`

Fiddler reads \`.git/worktrees/*\` directly and hangs them off their repo, tagged
with their branch, \`elsewhere\` when they live outside the repo tree, and
\`missing\` when \`git worktree prune\` would clean them up. It also puts a quiet
status dot next to anything that changed, from one \`git status\` pass per repo
rather than one per folder.

None of that is here, because none of it can be — a browser tab has no git.

## Getting out of here

The three shortcuts in this folder are real \`.url\` files, and Fiddler reads
them the way it reads anything else — select one and press \`space\` to see where
it goes before you follow it, or open it to go straight there.

The signed Mac build isn't out yet, so both download shortcuts currently land on
the releases page. The repo builds today with \`npm run tauri dev\`.
`;

const AURORA_README = `# aurora

A streaming log parser that keeps one pass over the file and never allocates per
line. Written to sit behind a dashboard that tails a few hundred megabytes an
hour without the box noticing.

## Why one pass

The obvious shape — read lines, parse each into a struct, collect — spends most
of its time allocating strings it throws away. \`aurora\` borrows out of the read
buffer instead and only copies at the point something is actually kept.

\`\`\`rust
let mut counts = Counts::default();
for record in Reader::new(file).records() {
    counts.observe(record?);
}
\`\`\`

## Status

- [x] Line splitting that survives a chunk boundary
- [x] Level and timestamp extraction
- [x] Rollup by minute
- [ ] Structured (JSON) lines
- [ ] Backpressure when the sink is slower than the source

## Numbers

| Input | Lines | Wall | Peak RSS |
|------:|------:|-----:|---------:|
| 12 MB | 84 k | 41 ms | 3.1 MB |
| 240 MB | 1.7 M | 780 ms | 3.4 MB |
| 2.1 GB | 15 M | 6.9 s | 3.4 MB |

Peak memory is flat because nothing is retained but the rollup.
`;

const AURORA_CARGO = `[package]
name = "aurora"
version = "0.4.2"
edition = "2021"
rust-version = "1.76"

[dependencies]
memchr = "2.7"
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
criterion = "0.5"

[profile.release]
lto = "thin"
codegen-units = 1
panic = "abort"
`;

const AURORA_MAIN = `use std::io::{self, BufWriter, Write};
use std::path::PathBuf;

mod parser;

use parser::{Level, Reader};

/// Roll a log up by minute and print the result as TSV.
fn main() -> io::Result<()> {
    let path = std::env::args_os().nth(1).map(PathBuf::from);
    let source: Box<dyn io::Read> = match path {
        Some(p) => Box::new(std::fs::File::open(p)?),
        None => Box::new(io::stdin().lock()),
    };

    let mut buckets: Vec<Bucket> = Vec::new();
    for record in Reader::new(source).records() {
        let record = record?;
        let minute = record.timestamp / 60;

        // The log is very nearly sorted, so the bucket we want is almost always
        // the last one. Scanning backwards beats a hash map by a wide margin.
        match buckets.iter_mut().rev().find(|b| b.minute == minute) {
            Some(bucket) => bucket.observe(record.level),
            None => buckets.push(Bucket::new(minute, record.level)),
        }
    }

    let mut out = BufWriter::new(io::stdout().lock());
    writeln!(out, "minute\\terror\\twarn\\tinfo")?;
    for bucket in &buckets {
        writeln!(
            out,
            "{}\\t{}\\t{}\\t{}",
            bucket.minute * 60,
            bucket.errors,
            bucket.warnings,
            bucket.infos
        )?;
    }
    out.flush()
}

#[derive(Debug)]
struct Bucket {
    minute: u64,
    errors: u32,
    warnings: u32,
    infos: u32,
}

impl Bucket {
    fn new(minute: u64, level: Level) -> Self {
        let mut bucket = Self { minute, errors: 0, warnings: 0, infos: 0 };
        bucket.observe(level);
        bucket
    }

    fn observe(&mut self, level: Level) {
        match level {
            Level::Error => self.errors += 1,
            Level::Warn => self.warnings += 1,
            Level::Info => self.infos += 1,
        }
    }
}
`;

const AURORA_PARSER = `use std::io::{self, Read};

const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Error,
    Warn,
    Info,
}

impl Level {
    /// Levels are matched on their first byte after the opening bracket, which
    /// is unambiguous for every level this parser accepts.
    fn from_tag(tag: &[u8]) -> Option<Self> {
        match tag.first()? {
            b'E' | b'e' => Some(Level::Error),
            b'W' | b'w' => Some(Level::Warn),
            b'I' | b'i' => Some(Level::Info),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct Record<'a> {
    pub timestamp: u64,
    pub level: Level,
    pub message: &'a str,
}

pub struct Reader<R> {
    source: R,
    buffer: Vec<u8>,
    /// Where the unconsumed tail of the last chunk begins.
    carry: usize,
}

impl<R: Read> Reader<R> {
    pub fn new(source: R) -> Self {
        Self { source, buffer: Vec::with_capacity(CHUNK * 2), carry: 0 }
    }

    /// Refills from the source, keeping whatever partial line was left over.
    /// Returns false at end of input.
    fn refill(&mut self) -> io::Result<bool> {
        self.buffer.drain(..self.carry);
        self.carry = 0;

        let start = self.buffer.len();
        self.buffer.resize(start + CHUNK, 0);
        let read = self.source.read(&mut self.buffer[start..])?;
        self.buffer.truncate(start + read);
        Ok(read > 0)
    }
}
`;

const AURORA_NOTES = `# Working notes

Rough, unsorted. Not documentation.

- The backwards bucket scan is the whole trick. Tried a \`HashMap<u64, Bucket>\`
  first and it was 3× slower on the 240 MB file — hashing a \`u64\` per line is
  more work than walking back an average of 1.2 entries.
- \`memchr\` for the newline scan is worth about 20% over a naive loop. Worth the
  dependency; would not be worth writing by hand.
- Chunk boundary bug, fixed on Tuesday: a line split across two reads was being
  emitted twice, once truncated. The carry index now moves before the drain, not
  after.
- Still undecided on backpressure. The clean answer is a bounded channel, but
  that means a thread, and right now this thing is a single \`for\` loop anyone
  can read in a sitting. Leaning towards leaving it.

## Next

Structured lines. The format is already \`{"ts":...,"level":...}\` half the time
in production, and parsing that as unstructured text is silly.
`;

const WEB_PACKAGE = `{
  "name": "fiddler-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --mode web",
    "build": "tsc && vite build --mode web",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "pdfjs-dist": "^6.2.108",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "typescript": "~5.8.3",
    "vite": "^7.0.4",
    "wrangler": "^4"
  }
}
`;

const WEB_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true
  },
  "include": ["src"]
}
`;

const WEB_BACKEND = `import type { DirListing, Entry } from "./types";

/**
 * The seam. Everything above this file is the same code on every platform;
 * everything below it is whichever host we happen to be running on.
 */
export interface Backend {
  listDir(path: string, showHidden: boolean): Promise<DirListing>;
  readText(path: string, maxBytes: number): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
}

const HIDDEN = /^\\./;

export function visible(entries: Entry[], showHidden: boolean): Entry[] {
  if (showHidden) return entries;
  return entries.filter((entry) => !HIDDEN.test(entry.name));
}

/**
 * Folders sort above files regardless of the active sort key. In a developer's
 * tree that beats interleaving, and it keeps the first row of the grid
 * scannable.
 */
export function order(entries: Entry[], compare: (a: Entry, b: Entry) => number): Entry[] {
  const dirs = entries.filter((e) => e.kind === "dir").sort(compare);
  const files = entries.filter((e) => e.kind !== "dir").sort(compare);
  return [...dirs, ...files];
}
`;

const WEB_STYLES = `:root {
  --tint: #0a84ff;
  --ink: #12141a;
  --ink-dim: #6b7280;
  --paper: #ffffff;
  --line: rgb(0 0 0 / 0.08);
  --radius: 10px;
  --row-height: 26px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8ecf6;
    --ink-dim: #93a0bd;
    --paper: #16181d;
    --line: rgb(255 255 255 / 0.1);
  }
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--tile, 112px), 1fr));
  gap: 6px 2px;
  padding: 12px;
  /* The grid is virtualized, so this only ever holds a few screenfuls. */
  contain: layout paint;
}

.tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  border-radius: var(--radius);
  padding: 8px 4px 6px;
}

.tile[data-selected="true"] {
  background: color-mix(in oklab, var(--tint) 88%, transparent);
  color: #fff;
}

.tile img {
  /* Never let a wide thumbnail push its neighbours around. */
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
`;

const RELEASE_NOTES = `# Release notes

## 0.1.0 — web

Fiddler runs in a browser now. The React front end is unchanged; what's new is a
second implementation of the one interface it talks to.

**What works**

- Browsing, sorting, both views, type-to-jump, the preview pane and Quick Look
- Markdown rendering and syntax highlighting for around ninety file types
- Image thumbnails, text thumbnails, and PDF pages
- Creating, renaming, editing, copying and deleting
- Name search, the bounded nearby-folder fallback, and content search
- Opening a real folder from your disk, in browsers that support it
- Dropping files and folders onto the window

**What doesn't, and won't**

- Git status, branches and worktrees. A tab has no git.
- Reveal in Finder, Open in Terminal, nearby devices.
- HEIC, PSD and camera raw thumbnails — those are macOS decoding the file.

## 0.0.9 — android

Nearby devices, permanent-delete confirmation, safe-area layout, APK install.

## 0.0.8

One git pass per repo rather than per folder. Navigation became a hash lookup.
`;

const FIELD_NOTES = `# Field notes: what a file browser is actually for

Kept meaning to write this down.

The thing every file browser gets wrong is treating the file list as the
product. It isn't. The list is a means of *recognising* something you already
half-remember — its name, roughly; where it sat; what it looked like; when you
last touched it. Recognition is visual and it is fast, and almost every design
decision follows from taking that seriously.

Which is why:

**Thumbnails are not decoration.** A folder of twenty photographs with generic
icons is twenty identical rows. The same folder with real previews is instantly
navigable. Same for text: you cannot read a thumbnail of a README, but you can
tell it from a JSON blob without stopping to think.

**Density is a feature.** Every row that doesn't fit is a row you have to scroll
to find, and scrolling breaks recognition — you lose the shape of the folder.

**Sorting must be stable and obvious.** "Name" that puts \`file10\` before
\`file2\` isn't sorting, it's a lexicographic accident.

**Latency is the whole game.** A folder that paints in 16 ms and one that paints
in 200 ms are different tools. The second one you brace for.

> The corollary nobody likes: most of the work is in not doing things. One git
> pass, not one per folder. One intersection observer, not one per tile. One
> listing request, not one per row.
`;

const TODO = `today
  [x] carry index before the drain, not after
  [x] write up the bucket-scan reasoning while it's fresh
  [ ] structured line parsing — start with the reader, not the schema
  [ ] decide about backpressure (leaning: leave it)

this week
  [ ] criterion bench for the 2 GB case, on the slow box not the fast one
  [ ] look at whether the rollup should be by second under load
  [ ] reply to the thread about the log format

someday
  [ ] a proper man page
  [ ] figure out if anyone else is actually using this
`;

const METRICS = `date,requests,p50_ms,p95_ms,p99_ms,errors,cache_hit_rate
2026-07-28,1284301,11,48,142,318,0.912
2026-07-29,1310774,11,47,138,290,0.917
2026-07-30,1298455,12,51,151,402,0.908
2026-07-31,1355019,11,46,133,271,0.921
2026-08-01,1102387,10,42,121,188,0.934
2026-08-02,986114,10,41,118,164,0.938
2026-08-03,1341902,12,53,167,455,0.903
2026-08-04,1372558,11,49,144,331,0.914
2026-08-05,1364117,11,48,139,309,0.918
2026-08-06,1389240,12,52,158,388,0.907
2026-08-07,1401883,11,47,136,296,0.919
2026-08-08,1156042,10,43,124,201,0.931
2026-08-09,1023775,10,41,117,159,0.939
`;

const CONFIG = `# aurora — deployment configuration
name: aurora
region: iad

reader:
  chunk_bytes: 65536
  # Anything past this is almost certainly a runaway line rather than a record.
  max_line_bytes: 1048576
  follow: true

rollup:
  window: minute
  retain: 14d
  levels:
    - error
    - warn
    - info

sink:
  kind: clickhouse
  endpoint: https://metrics.internal:8443
  batch:
    rows: 10000
    flush_after: 2s
  # Dropping is better than blocking here: the dashboard is advisory, and a
  # stalled reader backs pressure all the way up into the log writer.
  on_full: drop_oldest

observability:
  log_level: info
  metrics_port: 9100
`;

const USERS = `{
  "generated": "2026-08-09T04:12:00Z",
  "count": 6,
  "users": [
    { "id": 1041, "handle": "wren", "role": "owner", "active": true, "repos": 34 },
    { "id": 1128, "handle": "okonkwo", "role": "admin", "active": true, "repos": 12 },
    { "id": 1203, "handle": "silva", "role": "member", "active": true, "repos": 7 },
    { "id": 1247, "handle": "tam", "role": "member", "active": false, "repos": 2 },
    { "id": 1310, "handle": "bex", "role": "member", "active": true, "repos": 19 },
    { "id": 1355, "handle": "ari", "role": "readonly", "active": true, "repos": 0 }
  ],
  "roles": {
    "owner": { "billing": true, "destroy": true },
    "admin": { "billing": false, "destroy": true },
    "member": { "billing": false, "destroy": false },
    "readonly": { "billing": false, "destroy": false }
  }
}
`;

const ROLLUP_SQL = `-- Minute rollups, collapsed to hours for anything older than two days.
-- Run nightly; the source table is partitioned by day so this only ever touches
-- two partitions.

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_hourly
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (service, hour)
AS
SELECT
    service,
    toStartOfHour(minute)          AS hour,
    sum(errors)                    AS errors,
    sum(warnings)                  AS warnings,
    sum(infos)                     AS infos,
    quantileState(0.95)(latency_ms) AS p95_state
FROM metrics_minute
WHERE minute < now() - INTERVAL 2 DAY
GROUP BY service, hour;

-- Reading it back: the quantile has to be merged, not summed.
SELECT
    service,
    hour,
    errors,
    quantileMerge(0.95)(p95_state) AS p95
FROM metrics_hourly
WHERE hour >= now() - INTERVAL 7 DAY
GROUP BY service, hour, errors
ORDER BY hour DESC
LIMIT 100;
`;

const RECEIPT = `ORDER CONFIRMATION
------------------------------------------------
Order            #A-3391-22
Placed           14 days ago
Ship to          — collection —

  1 × Mechanical keyboard, 65%          129.00
  1 × Keycap set, PBT                    48.00
  2 × USB-C cable, 1m                    18.00
                                      --------
  Subtotal                              195.00
  Tax                                    17.55
                                      ========
  Total                                 212.55

Collection code sent separately.
`;

const CALL_NOTES = `# Notes from the call

Three things came out of it.

1. **The seam holds.** Nobody had to touch a component to get the web build
   running — it was one interface and two implementations, exactly as hoped.
   The audit beforehand was worth the hour it cost.
2. **Skip git on the web.** Tempting to fake status dots for the demo, but a
   file browser that shows fake git state is a file browser you can't trust.
   The demo sells the desktop app on the strength of what it really does.
3. **The picker is the feature.** "Open a folder and it just works" is a
   better pitch than any amount of demo content. Demo content is what you look
   at for eight seconds before you try it on something real.

Open question: whether dropped folders should be writable in Chromium (they can
be — the handle is real) or deliberately read-only for consistency with Safari.
Leaning towards real, with the read-only case clearly labelled.
`;
