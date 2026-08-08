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

## Keys

| | |
|---|---|
| `⌘1` / `⌘2` | Icon / List view |
| `⌘[` `⌘]` `⌘↑` | Back, forward, enclosing folder |
| `⇧⌘P` | Preview pane |
| `⇧⌘.` | Show hidden files |
| type letters | Jump to the first matching name |
| `↵` / `⌘↵` | Rename / open |
| `⌘⌫` | Move to Trash |
| `⇧⌘N` | New folder |

## How it stays fast

Performance work concentrated in four places:

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
  generated off the critical path, capped at 6 concurrent decodes, and cached on
  disk by (path, mtime, size).

Thumbnails come from the `image` crate for raster formats and fall back to
`qlmanage` for everything macOS can preview but Rust can't decode — PDF, HEIC,
video, Sketch.

## Layout

```
src-tauri/src/
  git/discover.rs   repo + worktree discovery, straight off disk, no subprocess
  git/status.rs     porcelain-v2 parser, rollups        (13 unit tests)
  git/mod.rs        the caches
  fs_scan.rs        directory listing, natural sort
  thumb.rs          thumbnail cache
  watcher.rs        fsevents, filtered and debounced
  commands.rs       the IPC surface
src/
  store/tree.ts     navigation, sorting, list flattening
  components/       IconGrid, DetailList, PreviewPane, Thumb, FileGlyph, GitDot
```

## Known gaps

Not built yet: drag and drop, copy/paste/duplicate, Quick Look on space, tabs,
column view, multi-select rename, custom sidebar favourites.
