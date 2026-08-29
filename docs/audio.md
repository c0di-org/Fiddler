# Listening to a book in Fiddler

A file browser that plays audio has an obvious version of the feature and a
useful one, and they are almost unrelated. The obvious version is an `<audio>`
element in the preview — a few lines, and it can only play while you are
looking at the file. The useful version is a player that outlives the folder,
because listening to a book is something people do while doing something else,
and "something else" starts with walking out of the folder the book is in.

This is what got built, and why each piece is the shape it is. Android is the
target platform, and Android is where most of the difficulty lives.

## What is there now

- A **bar along the bottom of the window** whenever something is loaded. Cover,
  chapter, book, how long is left, a scrubber, skip back and play. It is a row
  of the window rather than something floating over the folder, so it never
  covers a file.
- A **full-screen player** — tap the bar — with the cover, the timeline, five
  transport controls, and three settings that a book needs and a song does not:
  speed, a sleep timer, and the chapter list.
- **The folder is the queue.** Tapping one chapter queues the whole folder in
  `natural` order from there, and the end of chapter four is the start of
  chapter five.
- **Where you were, remembered** — per file, with a run-up scaled to how long
  you were away, and a book that reopens on the chapter you were in.
- **Progress on the icons**: a bar under every audio file you are partway
  through, and a green one for the ones you finished.
- On Android, a **notification and lock-screen controls**, headphone and
  Bluetooth buttons, pausing for calls and for headphones being pulled out —
  and playback that survives the screen going off.

## Remembering the place

`src/audio/positions.ts` is `reading.ts` for audio, and the differences between
them are the whole point.

A page number is a place. A position in a recording is not: it is a fractional
second on a timeline nobody can see, and being approximately right is worse
here than in a book, because landing thirty seconds late means missing a
paragraph and never knowing it happened. So a mark keeps three things a page
number doesn't need:

- **The duration**, because "97% of the way through" is the only way to tell a
  recording that was *finished* from one that was abandoned, and a finished one
  has to open at the start next time. Within `NEARLY_DONE` (25 s) of the end
  counts as finished — recordings end in credits and "end of chapter", and
  stopping there is finishing.
- **A timestamp**, because how long you were away is the best available
  predictor of how much you need to hear again. `rewindFor` turns that into a
  run-up: nothing under half a minute, three seconds within ten minutes, ten
  within the day, thirty after a few days. Coarse tiers rather than a curve,
  because this happens on every single resume and being predictable matters
  more than being precise — and nobody knows the right answer to the second
  anyway.
- **A `done` flag**, kept rather than deleted, because the folder draws it.

Two floors keep the store from filling with noise. Nothing under
`WORTH_REMEMBERING` (90 s) is bookmarked at all — an alert tone is not something
you are partway through — and nothing under `WORTH_STORING` (20 s) into a long
recording, because that isn't somewhere you got to. Both *remove* any previous
mark rather than leaving it: playing a file again from the top means the old
position is gone.

The order of those two checks is load-bearing. A twelve-second tone is inside
`NEARLY_DONE` of its own end from the moment it starts, so asking "did it
finish?" before "is it long enough to care?" would put a green tick on every
sound effect in a folder.

**Which chapter** is derived rather than stored. `lastPlayed` takes the folder's
own file list and the marks, and returns the most recently touched file in that
folder — or, if you finished it, the one after. Two records of the same fact
are two records that can disagree, and the way these would disagree is a book
that reopens on a chapter you finished last month.

## The player is not a component

`src/audio/player.ts` owns one `HTMLAudioElement` at module scope, outside
React, with a hand-rolled `subscribe`/`snapshot` pair for
`useSyncExternalStore`. Everything about that is a consequence of the first
paragraph of this document: an element inside the preview pane dies when the
preview closes, and one inside a route dies when you walk into another folder.
Navigating cannot stop the book because navigating does not touch the element.

There are two stores, not one. The player's own state changes several times a
second while playing; the marks change every ten seconds at most. Folder tiles
want the marks, and would be repainting four times a second if taking the marks
meant taking the player.

Two traps that are worth knowing about, because both are silent:

- **`loadedPath`.** Changing chapter sets the new track and *then* pauses the
  element, and the pause fires an event whose handler writes `currentTime`
  down. Without a guard that the element is actually holding the current
  track's bytes, opening chapter five files chapter four's position under
  chapter five's name.
- **Effect dependencies on a host's arrow function.** `NowPlaying` reads its
  `onClose` through a ref and keeps it out of the dependency array. The host
  passes a fresh arrow on every render, so depending on it re-runs the
  close-signal effect whenever anything at all changes in the folder behind —
  which closes a sheet, or the whole player, that nobody asked to close. This
  one was found by driving the real app in a headless browser; it is invisible
  in a unit test and intermittent by hand.

## Android, which is the hard part

Three separate problems, and none of them is solved by the other two.

### The webview gets paused

`WryActivity.onPause` calls `WebView.onPause`, which is documented as pausing
"extra processing associated with this WebView and its associated DOM" — and in
practice that includes an `<audio>` element mid-sentence. Locking the phone
stopped the book, every time, with no way for the front end to know.

`mWebView` is private in `WryActivity` and Kotlin gives no way to skip a link in
a superclass chain, so `MainActivity.onPause` *undoes* the pause rather than
preventing it: `super.onPause()`, then `webView.onResume()` if a book is loaded.
The webview is off screen either way; what is being resumed is the DOM, not any
drawing. It is conditional on `Playback.active` so that a Fiddler backgrounded
with nothing playing pauses exactly as it always did.

### The process gets reaped

A backgrounded webview is a background app. `PlaybackService` is a foreground
service of type `mediaPlayback` — the platform's own answer to "this app is
doing something the user can hear" — started by `playback.rs` on the first state
push and stopped when the player is closed. Without it the book stops partway
through a chapter, at a time that depends on what else the phone is doing.

### There is nothing to press

Nobody unlocks a phone to skip back fifteen seconds. The service holds a
`MediaSessionCompat` and posts a `MediaStyle` notification with three
buttons — skip back, play/pause, skip forward. Not the chapter skips: pressing
one of those by accident costs an hour, and pressing skip-back by accident costs
fifteen seconds. The chapter skips are still on the lock screen, because they
ride in the session's advertised actions.

Every press is forwarded to the front end (`NativeBridge.transport` → an event →
`player.transport`) rather than acted on locally. The session is a mirror, never
a source of truth; two things that both think they know the position is the bug
this shape rules out.

Audio focus is handled in the same place: pause for a call, pause rather than
duck for a navigation prompt (a book quietened is a book you have to rewind),
resume afterwards only if *we* were the ones who stopped it, and pause when the
headphones come out.

Some smaller decisions that each cost time to find:

- **The payload crosses JNI as JSON**, not as twelve arguments. A twelve-slot
  signature string is a thing that gets edited wrong once and then fails at run
  time on a device, with `NoSuchMethodError` in a log nobody is reading.
- **`applyState` never bails.** Android's contract for a service started with
  `startForegroundService` is that it *will* call `startForeground`, and
  breaking it is not an error message, it is the system killing the process. So
  unreadable JSON becomes an empty object and every field falls back to a
  default.
- **`JSONObject.optString` on a JSON null returns the four characters `"null"`**,
  which would then be handed to `BitmapFactory` as a cover path. `isNull` first.
- **No `MediaButtonReceiver`.** Since Lollipop the framework routes media
  buttons to the most recently active session directly, and the receiver's job —
  waking a stopped service to handle one — is the exact shape that gets a
  process killed for starting a foreground service it then has nothing to show.
- **One `OnAudioFocusChangeListener` instance.** `AudioManager` matches
  registrations by identity and a method reference is a fresh wrapper each time
  it is written, so on API 24–25 abandoning focus would quietly match nothing.

## What isn't here

- **No tags.** The chapter is the filename without its extension and the book is
  the folder's name, which is what an audiobook on disk looks like anyway. The
  cover is `cover.*`/`folder.*`/`front.*` beside the chapters, or the folder's
  only picture. Reading ID3 and MP4 metadata would give better titles and
  embedded art; it is the obvious next thing.
- **No chapter marks inside one long file.** An `.m4b` with forty chapters in a
  single file plays as one long recording. The `chpl` atom is where they live,
  and `queue`/`goTo` already have the shape a chapter list needs.
- **Speed is global, not per book.** A fast narrator and a slow one want
  different numbers, and today they share one.
- **No playlist beyond the folder**, no shuffle, no equaliser, no volume
  boost — a book does not want any of them.
