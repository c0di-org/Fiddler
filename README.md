# Fiddler

A macOS file explorer that happens to understand git. Tauri 2 + React + Rust.

It's a file browser first: big icons and real thumbnails, a dense sortable list
view, type-to-jump, a preview pane. Git shows up as a quiet dot next to things
that changed — and as the answer to the problem Finder can't solve: **worktrees
you can't see**.

## The worktree problem

Linked worktrees live wherever the tool that made them decided to put them:

```
~/Developer/n64/Mine64/.claude/worktrees/pause-tabs   ← hidden dotfolder in the repo
~/.codex/worktrees/e217/world_of_warblox              ← nowhere near the repo
/private/tmp/gitto-icon-deploy.9IbjSw                 ← ephemeral, already prunable
```

Finder shows none of them. Fiddler reads `.git/worktrees/*` directly and hangs
them off their repo as a `Worktrees` section, tagged with branch, `elsewhere`
when they live outside the repo tree, and `missing` when the folder is gone and
`git worktree prune` would clean it up.

## Running it

```bash
npm install && npm run tauri dev
```

Computer-use screenshots need a registered `.app`, which `tauri dev` doesn't
produce — build a debug bundle instead:

```bash
npx tauri build --debug --bundles app && open src-tauri/target/debug/bundle/macos/Fiddler.app
```

## Web

Fiddler also runs in a browser, at [files.c0di.com](https://files.c0di.com).
It is the same React front end — the whole port is a second implementation of
one interface.

```bash
npm run dev:web      # vite, port 1420
npm run build:web    # → dist-web
npm run deploy       # build, then wrangler deploy
```

`src/ipc.ts` is the seam. `@backend` resolves at build time to
`src/backend/tauri.ts` (Rust over IPC) or `src/backend/web.ts` (a virtual
filesystem in the tab), and nothing above that line knows which it got. The
markdown parser, the highlighter, sort, search, and the thumbnail scheduler are
all plain TypeScript that never learns the difference.

The browser build opens on a demo folder, and can also browse **real** folders:
**Open Folder…** in the sidebar uses the File System Access API to mount one
with read/write access (Chromium only), and files or folders dragged onto the
window are read in every browser. Nothing is uploaded — there is no server
behind the page, which is also why edits to the demo folder don't survive a
reload.

What it does have: browsing, both views, sorting, type-to-jump, the preview
pane, Quick Look, markdown rendering, syntax highlighting, image and text
thumbnails, PDF pages via a lazily-loaded pdf.js chunk, creating, renaming,
editing, copying, deleting, name search, the nearby-folder fallback, and content
search.

What it deliberately doesn't: **git**. No status dots, no branches, no
worktrees. A tab has no git, and a file browser showing invented status is one
you can't trust the rest of. Reveal in Finder, Open in Terminal and nearby
devices are absent for the same reason. `src/platform.ts` holds the capability
flags that decide what each build offers.

## Android / Samsung DeX

Fiddler also has an Android target, designed primarily for the wide, keyboard-
and-pointer layout in Samsung DeX. Build an arm64 debug APK with:

```bash
npm run tauri -- android build --debug --target aarch64
```

The APK is written to
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
On its first launch, Android opens Fiddler's **All files access** setting. Enable
it so the app can browse shared storage, then use **Internal storage** or the
Downloads/Documents shortcuts. DeX keyboards accept both `Ctrl` and `⌘` for the
existing shortcuts.

The Android build keeps browsing, Git status, folder creation, rename, bounded
text previews, image previews, cached in-app PDF pages, and streaming audio/video
previews for formats Android can decode. It also has a full-screen text editor:
tap the new-file button, name a `.txt`, `.md`, `.json` (or any other) file, then
write and save it in place. Existing text files open in that editor; large or
binary files still open in their installed Android app; opening an APK launches
Android's package installer. Android deletions are permanent (with a
confirmation), because Android does not provide Fiddler with a general system
Trash. Terminal launching and macOS Quick Look thumbnails are not available on
Android.

## Nearby devices

When Fiddler is open on a Mac and Android device on the same Wi-Fi network, the
phone appears under **Devices** within a few seconds. The first time, enter the
six-digit code shown in Fiddler on the device being shared; later visits are
immediate. The paired Android device is a normal navigable Fiddler location,
using the same list/icon views, folder navigation, search, and bounded text
reading as a local folder. Discovery shares only a device name and temporary
LAN address; storage is never listed until the device is explicitly paired.

## Keys

| | |
|---|---|
| `⌘1` / `⌘2` | Icon / List view |
| `⌘[` `⌘]` `⌘↑` | Back, forward, enclosing folder |
| `space` | Quick Look — rendered markdown, highlighted source, paged PDFs |
| `⇧⌘P` | Preview pane |
| `⇧⌘.` | Show hidden files |
| type letters | Jump to the first matching name |
| `↵` / `⌘↵` | Rename / open |
| `⌘⌫` | Move to Trash (permanently delete on Android) |
| `↵` on a `.url` | Follow the shortcut |
| `⇧⌘N` | New folder |
| `⌘N` | New text file |

## How it stays fast

Performance work concentrated in five places:

- **One git pass per repo, not per folder.** `git status --porcelain=v2 -z` runs
  once per repo, is parsed into a path→code map plus per-directory rollups, and
  is cached until an fsevents watcher says otherwise. Navigation is then a hash
  lookup. `--ignored=traditional` and `-u normal` collapse `node_modules/` to a
  single entry instead of listing 40,000 files.
- **Repo discovery is memoized.** Walking up for `.git` costs one `stat` per
  ancestor on a miss and a hash lookup on a hit; every directory walked past is
  cached, including negative answers.
- **Watcher events are filtered and coalesced.** Writes inside ignored
  directories and git's own `*.lock` churn are dropped before they can trigger a
  refresh; the rest debounce into one status pass per burst.
- **Both views are virtualized** over fixed-height rows, and thumbnails are
  generated off the critical path in four lanes, ordered outward from the middle
  of the viewport, and cached on disk by (path, mtime, size, requested px).
- **Previews cost what you can see, not what the file is.** A source file is
  scanned once for a byte a line, and only the sixty lines on screen are ever
  tokenized — a 200,000-line lockfile scans in about 10ms and highlights the
  visible window in a third of a millisecond.

Each preview takes the cheapest route macOS offers. Raster formats go through
ImageIO, which decodes straight to thumbnail size and reuses an embedded EXIF
preview when there is one. Text is laid out as a page by Core Text, and PDF
pages are rasterised by Core Graphics at the size they'll be shown — both
in-process, both well under a millisecond, where Quick Look would cost tens and
a round trip to another process. Quick Look still handles what only it can:
video, Keynote, Sketch, Office.

That's why `main.rs` and `notes.md` get real thumbnails rather than the same
grey document glyph Finder gives them.

## Layout

```
src-tauri/src/
  git/discover.rs   repo + worktree discovery, straight off disk, no subprocess
  git/status.rs     porcelain-v2 parser, rollups        (13 unit tests)
  git/mod.rs        the caches
  fs_scan.rs        directory listing, natural sort
  thumb.rs          thumbnail cache, lane routing
  thumb_text.rs     text files drawn as a page, via Core Text
  thumb_pool.rs     four lanes, viewport-ordered              (9 unit tests)
  page.rs           PDF pages rasterised at any size          (5 unit tests)
  watcher.rs        fsevents, filtered and debounced
  commands.rs       the IPC surface
src/
  store/tree.ts     navigation, sorting, list flattening
  preview/          markdown parser + highlighter            (22 unit tests)
  components/       IconGrid, DetailList, PreviewPane, QuickLook, CodeView,
                    MarkdownView, PdfView, Thumb, FileGlyph, GitDot
```

Tests: `cargo test` in `src-tauri/`, and `npm test` for the parser and
highlighter — Node runs those TypeScript files directly, so there's no test
framework to install.

## Known gaps

Not built yet: copy/paste/duplicate, tabs, column view, and multi-select rename.
Folders can be dragged into Favorites in the sidebar, then reordered or removed;
Quick Look renders documents
itself rather than hosting the system's previews, so formats outside the list
above show a still image instead.

Shortcut files (`.url`, `.webloc`) are understood everywhere — Quick Look shows
the destination and offers to open it — but only the web build draws the
destination onto the tile. The desktop shows a generic shortcut glyph until
`thumb.rs` learns the lane.
