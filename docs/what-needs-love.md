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

### A transfer says how far it has got, and can be called off

The status bar holds a bar, what is moving, how many of how many and how much of
how much, and a Cancel button — in the middle track the item count usually has,
so nothing shifts when it appears. `transfer.rs` is the engine, used by a paste,
a drop, and the one kind of move that is really a copy.

`std::fs::copy` was kept rather than replaced with a chunked loop. On APFS it
lands on `fclonefileat`, so a same-volume copy of forty gigabytes is near-instant
whatever the size, and a read/write loop would trade that away for progress
nobody would live long enough to read. The loop is kept for the case that is
genuinely slow — a large file arriving on a *different* volume, compared by
`st_dev` — where there is no clone to be had and Cancel has to be able to land
mid-file. Below 8 MB even a cross-volume file goes whole.

That same fact decides **what the bar counts**, which is not a matter of taste
and was got wrong twice before it was got right. A clone costs a syscall per file
and no time per byte, so within one volume the wait tracks the number of files
and a byte bar lurches; across volumes every byte travels, so the wait tracks
bytes and a file bar stalls through one big file. `by_bytes` is decided in the
engine, where the answer is known, and carried out to the status bar rather than
guessed at there. Both numbers are always in the text; only the bar has to pick.

Cancel means cancelled, not stopped: everything the transfer wrote is removed.
That is safe precisely because every target is a path invented a moment
beforehand, so nothing being deleted existed before the transfer did — and in a
move, the originals are never among them. The same rollback runs on a failure,
which is what closes the other half of this entry: a five-item paste that failed
on the fourth used to leave three copies, a half-built tree and no way to tell
which was which.

A **cross-volume move** now goes through the same engine, and deletes its sources
only once every copy is whole. Until then the source is the only copy there is,
so a cancelled move leaves everything exactly where it was. A move within one
volume is still a rename and never enters any of this — there is nothing to
watch and nothing to stop.

Cancelling says nothing. The status bar going quiet is the acknowledgement; a
toast reading "cancelled" after you have just cancelled something is the app
explaining your own decision back to you.

Two things this changed on the way, both the same bug in two places. Targets are
now planned before any bytes move, which the rollback needs — and that
invalidates the "does it exist yet?" question both `copy_name` and the move's
own planner were built on. Two files called `notes.md` from two folders would be
planned onto one path, and the second would land on the first: a paste now
renames around it, a move refuses, and there is a test for each. The move half
of that was a pre-existing bug, not one this work introduced.

The work is surveyed before it starts so the bar has a total. The tree is read
twice and that is the price of a bar that means anything.

What's left: an upload to a device over USB is still one toast and a wait. It
runs through the MTP worker and its own cancel token rather than this engine.

### Zip, in both directions

Compress puts a selection into a zip beside it and Extract takes one apart in
place, both on the two native targets. `archive.rs` is the engine and borrows
`transfer.rs`'s vocabulary — the same `Progress`, the same `Stopped`, the same
flag read between chunks — because from the status bar's side an archive and a
copy are the same event. What it does not borrow is the question of what the bar
counts: a copy has to decide, because a same-volume clone costs nothing per
byte, and an archive never does. Every byte is read and deflated, so both
directions report `by_bytes` and mean it.

Four decisions worth knowing about.

**Only zip.** `.tar.gz` reads on a Mac and is a mystery on a phone, `.7z` and
`.rar` are neither, and every one of them would be a C library behind a `-sys`
crate and an NDK build. The `zip` crate is pure Rust with only deflate enabled,
so it cross-compiles with everything else. The other formats deliberately keep
their archive icons: being able to see what something is and being able to open
it are different questions.

**Already-compressed bytes are stored, not deflated.** A JPEG through deflate is
the whole file's worth of CPU to save a fraction of a percent, on the platform
least able to spend it — and photographs are exactly what people zip.

**Coming out of an archive assumes the archive is hostile.** Every entry name
goes through `enclosed_name`, so `../../.ssh/authorized_keys` is refused rather
than followed, and a symlink is only recreated when what it points at stays
inside the folder being extracted into. Both refuse the *whole* extraction
rather than skipping the entry: an archive containing either is broken or
malicious, and quietly unpacking the other ninety-nine files is how someone ends
up trusting the result.

**Where it lands is Archive Utility's rule.** Everything under a single
top-level name is unpacked as that item; a spray of loose files gets a folder
named after the archive. The alternative is `foo/foo/…` half the time and forty
loose files in Downloads the other half. `__MACOSX` is skipped before the roots
are counted, or every zip Finder ever made would look like it had two.

What's left. Nothing reads *into* an archive: Quick Look shows a zip as a file
rather than as a list of what's in it, which is the next obvious thing and needs
no new engine — `contents` already walks the central directory. Encrypted zips
are refused with a message rather than prompting for a password; on macOS Open
still hands those to the system, which does prompt. Nothing streams an archive
onto a device or a nearby machine — both are copies of a finished file. And
there is no "compress to N MB", though `edit/budget.ts` shows the shape that
would take.

## Accessibility

### The grid and the list can be heard now

Each view's scroller is the focusable thing: `role="grid"` over the cells,
`role="treegrid"` over the list, both with `aria-rowcount` and per-row
`aria-rowindex` describing the whole folder rather than the dozen rows that
happen to be mounted. List rows carry `aria-level` and `aria-expanded`, the
column headers carry `aria-sort` and an `aria-colindex` that follows a
reordering, and every cell names itself — the name cell says so outright,
because the `title` that gives it its hover tooltip otherwise wins the name and
each item is announced as its whole path.

Two decisions worth knowing about. The keyboard cursor is
`aria-activedescendant` on the container rather than a roving `tabIndex` on the
lead item: both views are virtualized, so scrolling past the lead unmounts it,
and a roving `tabIndex` drops focus on the body when that happens — dead arrow
keys until the next click. And the one `window` listener is now two. Navigation
(arrows, Space, ↵, ⌘A, type-to-jump) belongs to whichever view has focus; the ⌘
commands stay on `window`, so ⌘Z and ⌘V still work from the sidebar.

That split is what fixed the live oddity, which was worse than the swallowed
letter this entry used to describe: the listener only ever stepped aside for an
`<input>`, so Space on *any* focused button opened Quick Look and ↵ started a
rename on the selected file. The cost is that focus now has to be handed back —
after a rename, after Quick Look or the editor closes, after Escape, after
⌘1/⌘2 — or the arrows go dead where they used to work. `focusView` does that,
and each view claims focus on mount when nothing else holds it.

← and → in list view now work the triangles: closed opens, open steps in, left
collapses or climbs to the parent. Declaring `aria-expanded` while leaving the
only way to act on it a mouse click would have been a lie.

What's left: nothing *announces* a change. The status bar's count, the note
about a folder that couldn't be reopened and every toast are written into the
page with no live region, so they reach only someone who goes looking. That is
one `role="status"` and a decision about which of the three earns it. The
sidebar is also still a column of plain buttons with no list semantics.

And the verification was against the accessibility tree Chrome builds, driven
from the browser build — the roles, names, counts and levels are right, and the
keyboard was exercised end to end. How VoiceOver reads that tree aloud is
untested.

## Craft

### App.tsx is doing five jobs

1,300 lines holding search orchestration, keyboard routing, context menus, drag
state, USB, pairing and the render. Three pieces come out cleanly, in this order:

- **`useSearchResults`** — roughly lines 190–360: the local search, the bounded
  nearby fallback, the content-search pass and the merge into `nameEntries` /
  `listRows`. It's the largest and most self-contained unit, it's pure data in
  and data out, and it's the part most worth having tests around.
- **`useKeyboard`** — the two key handlers and the `kb` ref that feeds them.
  Waiting on the accessibility work was the right call: the split into a view
  half and a `window` half is what this hook now has to hold, and extracting it
  first would have meant extracting the wrong shape. It's ready to come out.
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

`transfer.rs` arrived with nine, against a real temp filesystem rather than a
fake one, which is the shape the rest of this list wants.
