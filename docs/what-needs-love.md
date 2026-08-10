# What needs love

Everything found in a read of the whole tree that wasn't a plain bug. The bugs
from that pass are already fixed; these are the ones that need a decision first,
so each entry says what's wrong, why it matters, and what fixing it would take.

Ordered by what a person would notice, not by effort.

## Product gaps

### Dragging doesn't move anything

Files can't be dragged at all, and folders drag only to Favorites
(`IconGrid.tsx`, `beginFolderDrag`). Nothing drags out to Finder either —
`dragDropEnabled` is `false` in `tauri.conf.json`. For most people dragging *is*
the file manager, so this is the biggest single absence.

Move already exists in the backend in every sense that matters: `copy_paths` is
the transfer primitive, `rename_path` is a move within a volume. What's missing
is the drag layer — a drag source on entry rows and cells, a drop target on
folder rows, the sidebar and the breadcrumb, and the copy-vs-move decision
(same volume moves, different volume copies, ⌥ forces copy).

Do this one before tabs or column view.

### There is no undo

Rename, paste and Move to Trash are all one-way. ⌘Z is the first thing a hand
reaches for after a mis-drop, and its absence is what makes drag-to-move feel
risky to ship.

The three operations that need it are all reversible without new backend work:
a rename is a rename back, a paste is a trash of what was created, a trash is a
restore. Only the last needs anything new — `trash` (the crate) can delete but
not put back, so restoring means either shelling out to Finder or keeping the
trashed paths and moving them home from `~/.Trash`. A stack of the last ~20
operations in the store, and a toast that says what was undone.

### The session doesn't survive a quit

View mode, sort key and direction, icon size, show-hidden and the preview pane
all live as plain fields on `TreeStore` and reset on every launch: icon view,
112 px, `~/Developer`. Favorites and the accent already persist, so the machinery
and the taste for it are both there.

The straightforward part is the view state — it's five fields and a
`localStorage` write next to the existing `saveFavorites` effect. The part
needing a decision is the last folder: restoring it is what people expect, but
it can be missing, unreadable, or on an unmounted volume by the time it's
restored, and falling back silently to `~/Developer` looks like the setting was
ignored. Suggest: restore it, and if the listing errors, fall back *and say so*
in the status bar.

### The desktop build opens text files in its own editor

`openTarget` reads up to 2 MB of any file over IPC to decide what it is, then
opens anything that decodes as text in Fiddler's editor rather than handing it
to the OS. On Android that's right — it's why the editor exists. On a Mac it
means double-clicking `main.rs` gets a bare textarea instead of the editor the
person actually uses, and it spends a 2 MB IPC round trip finding that out.

The capability seam already has the right question in it: `caps.handOff`. Route
on it, keep the editor as an explicit "Edit Text File" (already in the context
menu), and drop the probe read to a few KB — deciding text-or-binary needs the
first block, not the whole file. An **Open With** submenu is the natural
follow-on and is the other half of what people expect from ↵.

### A paired device can't be un-paired

Allow is now an explicit tap, but there's still no list of devices that have
been allowed and no way to withdraw one. Tokens live in `peers.json` forever.

The state is already there (`clients` and `known` in `PeerService`); this is a
command to list them, a command to drop one, and a small section in the sidebar
or a settings sheet. Worth doing before anyone relies on nearby devices in a
shared space.

### Copying is silent and can't be stopped

`copy_paths` has no progress and no cancel, and a failure part-way leaves what
it had already written. Pasting a 40 GB folder is one toast and a long wait.

Needs the copy to run against a cancellation flag and emit progress events —
the thumbnail pool is the model for both. The status bar is the right home for
the progress; the toast can't hold it.

## Accessibility

The two main views have no roles, no focusable items and no selection semantics.
`IconGrid` and `DetailList` render plain `div`s, and every key is handled by one
`window` listener in `App.tsx`, so a screen reader is told nothing at all: not
what's selected, not how many items there are, not that a list exists.

`TextEditor` and `TintPicker` show the standard is understood — this just never
reached the grid and the list. What it takes: `role="grid"`/`role="listbox"` on
the scroller with `aria-rowcount`, `role="option"` and `aria-selected` per item,
a real roving `tabIndex` so the lead item holds focus, and moving the keyboard
handler onto the focused container so it composes with focus instead of
competing with it. That last change also fixes a live oddity — type-to-jump
currently swallows printable keys aimed at any custom control that isn't an
`<input>`.

## Craft

### App.tsx is doing five jobs

1,300 lines holding search orchestration, keyboard routing, context menus, drag
state, USB, pairing and the render. Three pieces come out cleanly, in this order:

- **`useSearchResults`** — roughly lines 190–360: the local search, the bounded
  nearby fallback, the content-search pass and the merge into `nameEntries` /
  `listRows`. It's the largest and most self-contained unit, it's pure data in
  and data out, and it's the part most worth having tests around.
- **`useKeyboard`** — the `window` listener and the `kb` ref that feeds it. This
  one should be extracted *as part of* the accessibility work above rather than
  before it, since the fix moves where the listener lives.
- **`useNearbyDevices`** — the discovery poll, the ask loop, and the incoming
  requests. Self-contained now that pairing is a real handshake.

What's left is the view, the selection model and the menus, which belong
together and read fine at that size.

### styles.css is one 3,200-line file

It's well organised internally and the section banners are genuinely useful, so
this is not urgent. If it gets split, split by surface — sidebar, grid, list,
preview, overlays — and keep the variable block and the reset in one root file.

### The thumbnail cache never shrinks

Keyed by `(path, mtime, size, px)` and nothing prunes it, so every edit to a file
and every zoom level leaves a PNG behind in `~/Library/Caches` forever. macOS
will evict a cache directory under pressure, which is the only reason this
hasn't bitten. A sweep on startup — oldest-first down to a byte budget, on the
thumbnail pool's own threads — is about forty lines.

### The watcher's debounce loop polls

`debounce_loop` wakes every 50 ms forever waiting on two channels, because
`std::sync::mpsc` can't select across them. Twenty wakeups a second on an idle
app is small but it's not nothing on a laptop battery. One channel carrying an
enum, or `crossbeam-channel`'s `select!`, removes it.

### Tests are shaped oddly

The pure parsers are well covered — 22 tests around markdown and highlighting —
while the concurrency and network surfaces have almost none. `peers.rs` had zero
before this pass, `watcher.rs` had zero, `git/discover.rs` still does, and so
does `store/tree.ts`, which is the navigation core. Not a crisis, but if a test
is going to be written, write it there rather than adding a 23rd parser case.
