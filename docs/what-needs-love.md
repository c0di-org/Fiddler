# What needs love

Everything found in a read of the whole tree that wasn't a plain bug. The bugs
from that pass are already fixed; these are the ones that need a decision first,
so each entry says what's wrong, why it matters, and what fixing it would take.

Ordered by what a person would notice, not by effort.

## Product gaps

### Dragging in and out of Finder

Dragging *within* Fiddler is done: any selection drags from either view onto a
folder cell, a folder row, a sidebar place or a breadcrumb, and the target says
`Copy` or `Move` on itself before the button comes up. Copy is the default and
⌘ or ⌥ asks for a move — the reverse of Finder, on purpose, so nothing leaves
where it was put because a pointer wobbled on the way past. `dropPlan` in
`drag.ts` holds every rule about what a drop means and is where to add one.

What's still absent is the OS: nothing drags out to Finder, and nothing dropped
from Finder is accepted. These are two separate pieces of work, and neither is
free. Drag-out isn't HTML5 at all and needs a native drag plugin. Drop-in needs
`dragDropEnabled: true` in `tauri.conf.json`, and that is the same switch whose
being `false` is what lets HTML5 drag work inside the webview — documented for
Windows, unverified on macOS. Prototype whether the two can coexist before
promising drop-in, because the answer decides whether internal drag survives it.

### Undo doesn't reach everything

⌘Z now walks back a rename, a paste, a drag, and a trip to the Trash, with an
`Undo <thing>` item in the background menu saying which. `undo.ts` holds the
stack — twenty deep, in memory, gone on quit, like Finder's — and `invert` is a
pure function from a recorded operation to the steps that reverse it, so adding
an operation means adding a case there rather than a closure at the call site.

Deletion is undoable because `trash_paths` now goes through `NSFileManager`'s
`trashItemAtURL:resultingItemURL:` and reports back where each item landed. The
`trash` crate couldn't: it deletes and says nothing, which is why the two other
targets report an empty list and get no undo rather than a broken one.

What's left out: New Folder and New Text File aren't recorded, and there is no
redo. Both were deliberate — a new folder is created straight into a rename, so
undoing it means reasoning about two stacked entries for one gesture, and redo
doubles the state for a case that comes up far less often than ⌘Z does.

### The session survives a quit now

`session.ts` persists the six view preferences and the folder you were last in,
in `localStorage` next to favourites, the accent and the list's columns. Every
field is validated on the way back in, because the stored value comes from a
previous version of Fiddler as often as from this one.

Two decisions worth knowing about. A device path is never remembered — `mtp://`
and `fiddler://` only exist while the cable is in or the other machine is awake,
so standing in one at quit leaves the last real folder in place instead. And a
folder that has *gone* is separated from one that can't be *read*: the remembered
path gets one cheap `inspect` first, and a failure falls back to the usual
starting place with the reason in the status bar, while a folder that exists but
is unreadable simply opens, because its empty state already names the permission
to grant. Falling back there would hide something fixable.

What's not restored: back/forward history, and which folders were twisted open
in list view. Both were deliberate — expanding a saved subtree means re-listing
every level on launch, for continuity nobody has asked for.

### Open With

↵ now hands a file to the OS where there is one, and falls back to Fiddler's
editor only where nothing is registered for the type — a `LICENSE`, a
`Makefile`, a `.env`. `has_open_handler` asks LaunchServices *in advance* rather
than trying and catching, because the opener plugin launches detached: a refusal
never comes back to us, it becomes a system dialog. The 2 MB identifying read is
down to 8 KB, and the full read now only happens for a file that is actually
going to be edited. "Edit Text File" is the way into the editor, and does
something different from Open for the first time.

What's left is the other half of what people expect from ↵: an **Open With**
submenu. That needs a Rust command to enumerate handlers — LaunchServices'
`LSCopyApplicationURLsForURL`, next door to the call `has_open_handler` already
makes — and it needs `ContextMenu` to learn to nest, which nothing has needed
until now.

### Nearby access is now visible and revocable

The padlock beside the Devices heading opens a panel with both directions in it:
devices allowed to browse this one, with Withdraw, and devices this one holds a
key to, with Forget. They are kept apart on purpose — one is about your files,
the other about a saved token, and a merged list would invite the belief that one
button did both.

`clients` in `PeerService` stored nothing but the token, which was enough to
*check* access and useless for *showing* it, so the grant now records the name,
the platform and the day. `peers.json` reads both shapes, and there is a test for
that: getting the migration wrong would silently revoke every device already
allowed, and nobody would know to grant it again.

Withdrawing drops the remembered answer along with the token, so a device that
asks again is a stranger putting a fresh card on screen.

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
