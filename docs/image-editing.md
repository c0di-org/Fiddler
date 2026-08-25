# Editing a picture in Fiddler

An investigation, not a promise. It covers what Preview's editing actually is,
which parts of it belong in a file browser, what the three targets can and can't
do, and what it would cost to build. Where a number appears it was measured on
this branch rather than estimated — the two spikes under `src/edit/` are real,
tested code, and the benchmarks below came out of them.

The short version: the pixel work is entirely feasible as plain TypeScript on a
canvas, which means one implementation serves macOS, Android and the web the
same way the markdown parser and the highlighter already do. The backend owes it
exactly one thing it doesn't have — a way to write bytes. And the overlap with
the PDF reader is real but much narrower than it looks: it is the markup layer
and nothing else.

---

## What Preview actually does

Stripping out what nobody uses, Preview's editing is six verbs:

| Verb | What it is |
| --- | --- |
| **Select** | A rectangle, or the magic wand — click a pixel, drag to widen the reach |
| **Crop** | Throw away everything outside the selection |
| **Delete** | Throw away everything *inside* it, to transparency |
| **Resize** | New dimensions, with the aspect ratio usually locked |
| **Markup** | Rectangles, ovals, lines, arrows, freehand, highlighter, text boxes |
| **Rotate / flip** | Four right angles and two mirrors |

Five of the six are pixel work on a bitmap. Markup is the odd one out: it is a
list of shapes drawn *over* the picture, and it is the only one that also
applies to a PDF. That split is the single most important fact in this document
and the rest of it follows from it.

Preview also has "Adjust Colour" and "Adjust Size"'s DPI field. Neither is worth
building. The colour panel is a curves editor that people open once, and DPI is
metadata that matters to a printer and to nothing else Fiddler talks to.

---

## Where the work goes

Fiddler already has the seam this needs. `src/ipc.ts` is the whole surface the UI
gets from the backend, and everything above it is plain TypeScript that never
learns which of the three targets it is running on. An editor built the same way
is one editor, not three.

So: **the editor is TypeScript over a canvas.** Not ImageIO on the Mac and
`android.graphics` on the phone and a canvas on the web — that is three
implementations of a magic wand, which is three magic wands that disagree at the
edges. The backend's job stays what it already is: hand over pixels, and take
bytes back.

### Getting pixels in — already done

`ipc.mediaUrl(path)` resolves a real file to something the webview can load, on
all three targets. `createImageBitmap` on the far end of it is the decode. That
covers PNG, JPEG, WebP, GIF, BMP and AVIF everywhere.

For the formats a webview can't decode — HEIC (which is what Samsung and iPhone
cameras actually shoot), camera raw, PSD — there is already `ipc.thumbnail(path,
px)`, which on macOS is ImageIO and on Android is `Thumbs.kt`'s `ImageDecoder`,
both of which handle them. Asking for a large render and treating the result as
the source is the whole HEIC story. One caveat, in `thumb_mobile.rs`:

```rust
match call_render(path, max_px.clamp(32, 4096)) {
```

4096 is the ceiling on Android today, so a HEIC opens for editing at 4096 on its
longest side. That is a one-constant change if it ever needs to be larger, and
as the memory budget below shows, it probably shouldn't be.

And `ipc.pdfPage(path, n, px)` already rasterises any page of any PDF at any
size, which makes "edit this page as a picture" free.

### Getting bytes out — the one real gap

`Backend` has `writeTextFile` and `createTextFile` and nothing that takes bytes.
That is the only missing capability in the whole investigation.

The web half is already built and just isn't exposed: `backend/web/vfs.ts`
has `writeBlob(path, data: Blob)` and `freshPath(parent, name)`, so the browser
build needs a line of wiring rather than an implementation.

The Tauri half is a near-copy of `write_text_file` in `commands.rs`, which
already does the thing that matters — write to a sibling temp file, `sync_all`,
then rename into place, all on `spawn_blocking` because Android's FUSE storage
makes `sync_all` unbounded wall-clock. Swap `text: String` for bytes and it is
done.

One thing not to get wrong: **do not send the bytes as JSON.** A 5 MB PNG
base64s to 6.7 MB of string, which on Android is a copy through the WebView
bridge, a copy in the JSON parser and a copy in the decoder, on a device that
will kill the process for less. Tauri 2 takes a raw request body
(`tauri::ipc::Request` / `InvokeBody::Raw`) and that is what this should use.

### What saving means

Preview saves in place and leans on macOS Versions to make that safe. Fiddler
has no Versions, and its undo stack is twenty operations in memory that die with
the app — `undo.ts` doesn't record file creation at all today.

So **Save a Copy is the default and Replace is the deliberate one.** `freshPath`
already produces the `photo 2.jpg` name for exactly this. Replacing stays
available, behind the same `confirmDialog` that deletion uses.

`locationCaps(path, volumes)` in `location.ts` already answers "can this be
written to" for read-only volumes, MTP devices and nearby machines, and
`TextEditor` already asks it *before* the edit rather than after. The image
editor asks the same question in the same place, for the same reason: finding
out at the end of twenty minutes of markup that the file lives on someone else's
phone is not an error message, it's a loss.

---

## The magic wand

This is the tool the request is really about, and it is the one with a genuine
engineering constraint, so it got built first: `src/edit/wand.ts`, with
`src/edit/mask.ts` for what it produces. Fourteen tests, all passing.

The interesting half is not the flood fill, it is **"drag to spread the reach"**.
A tolerance slider you have to leave the picture to touch is a tolerance slider
nobody tunes. Preview gets this right: you click, and keep dragging, and the
selection grows under your finger. Which turns the budget from "fast enough to
feel deliberate" into "fast enough to run every frame while a finger moves", and
that changes the design.

### It is fast, and it is still not fast enough at full resolution

Measured on this box (a NUC — a desktop-class x86), filling a noisy gradient sky
that covers about a third of the frame:

| Source | Contiguous fill | Non-contiguous | `boundsOf` alone |
| --- | --- | --- | --- |
| 512×384 (0.2 MP) | 5 ms | — | 0.7 ms |
| 1024×768 (0.8 MP) | 8 ms | — | 2.5 ms |
| 1440×1080 (1.6 MP) | 17 ms | — | 4.9 ms |
| 2048×1536 (3 MP) | 30 ms | 65 ms | 10 ms |
| 4000×3000 (12 MP) | 125 ms | 202 ms | 38 ms |
| 8000×6000 (48 MP) | 450 ms | 834 ms | — |

A phone is two to four times slower than this. So at the resolution a phone
camera actually produces, a live drag would run at something like three frames a
second — which is not a drag, it is a series of surprises.

**The design that follows: the drag runs on a proxy, the release runs on the
real thing.** Keep a downscaled copy of the picture capped at about 1 megapixel
alongside the working buffer; run the wand on the proxy on every animation frame
while the finger moves, drawing the result as a rough outline; run it once at
working resolution when the finger lifts. The proxy costs about 4 MB and one
downscale.

At 1024×768 the fill is 8 ms under Node and 12–23 ms inside headless Chrome on
the same box, working on pixels that came out of a real `getImageData` rather
than a synthetic array. Call it 25–40 ms on a mid-range phone: a live drag, with
room to spare.

Two smaller notes from the benchmark. `boundsOf` is a third of the total and is a
separate pass over the mask; folding it into the fill is easy and worth doing if
this ever gets tight. And the non-contiguous mode ("select every pixel in the
picture that looks like this", which is what you want for the white in a scan
that a staple interrupts) is *slower* than the contiguous one despite being a
single flat pass, because contiguous stops at the subject and this doesn't.

### Two decisions inside the fill

**The colour metric is "redmean", not RGB distance.** It costs one extra
multiply per channel and it is the difference between a tolerance that walks
evenly across a gradient sky and one that grabs half the frame the instant it
touches a blue that happened to be close in raw RGB. Skies and skin are exactly
where this tool gets used.

The constant that normalises it was written as a literal first, and it was wrong
by one — 584,970 where the metric's true maximum is 584,971. The only symptom
was that a tolerance of exactly 1 selected a single pixel instead of the whole
photograph, which is the kind of bug that survives a demo. It is derived from the
formula now, and there is a test that pins it.

**Alpha is compared separately, before colour.** A pixel that is 10% opaque is
not "nearly" the colour it claims to be, it is nearly not there — and without
this, wanding the hole left by a previous delete selects a checkerboard of
whatever the encoder left under the alpha. Two fully transparent pixels match
each other whatever their dead RGB says. Both have tests.

The fill itself is span-based rather than per-pixel: the stack holds horizontal
runs, so a flat sky costs one push per row instead of one per pixel. The
per-pixel version overflows the stack on a 12 MP sky, so this is not an
optimisation, it is the difference between working and not. It is the canonical
span-fill with the overhang cases, and there are two tests specifically for
those — a room reached through a neck, and a spiral where every span is entered
from exactly one direction. A fill with a broken overhang case passes the simple
tests and stops half way round the spiral.

### What the selection is, once you have one

A `Mask` is one byte per pixel: 0 outside, 255 inside, and the values between are
partial coverage. That last part is not decoration — feathering and anti-aliased
edges are the whole difference between a cut-out that looks made and one that
looks cut, and a boolean mask cannot express either.

Every tool that selects produces one, every verb that acts on a selection takes
one, and `combine()` holds the shift-adds / option-subtracts grammar once. Which
means "crop to the rectangle" and "crop to what the wand found" are the same
piece of code, and the lasso nobody has asked for yet is a new producer and
nothing else.

Drawing the selection is the remaining unbuilt piece: marching ants means tracing
the mask's contour into a `Path2D` and animating `lineDashOffset`. Not hard, but
it needs a reduced-motion answer, because a permanently crawling dashed line is a
genuine accessibility problem and Fiddler already respects the preference
elsewhere.

---

## "Resize to 2 MB"

This is the request's best idea and the thing no other editor does properly. It
is also, on inspection, the easiest of the hard features — so it belongs in the
first slice, not a later one.

The problem it solves is a guessing game: something on the other end refuses
anything over 2 MB, and what you are given is an unnumbered quality slider and a
dimensions box. So you export, read the size, sigh, and export again. The
information needed to do it properly is only ever a re-encode away, and a
computer can re-encode faster than a person can read the number off the last
attempt.

`src/edit/budget.ts` is the search, with the encoder injected so it has no
opinion about canvases and its tests run in a second instead of an hour. Seven
tests, all passing.

**What it trades away, in order.** Between a full-size photo at good quality and
a small one at perfect quality, the full-size one is what people wanted — so it
spends quality first, down to a floor around q=0.55, which is roughly where a
JPEG stops being a slightly worse photograph and starts being a photograph with
visible blocks in the sky. Below the floor it stops and shrinks the picture
instead, holding quality at 0.78. There is a test that a bigger budget can never
come back with a worse picture, which is the property easiest to break with a
bad bracket.

**Every probe is a real encode**, because file size against quality has no useful
closed form — it depends entirely on what is in the frame. A screenshot and a
photograph of leaves at the same dimensions and the same quality differ by an
order of magnitude. The cost of that honesty is wall-clock, so the search is
built around spending as few probes as possible: the scale search is ratio-seeded
(bytes track pixel count closely at fixed quality, so `scale ≈ √(target/measured)`
lands in two or three steps where a blind bisection takes six), anything within
10% under the target counts as a hit and stops the search, probes are memoised
after snapping so a bisection can't re-encode the same picture twice, and there
is a hard cap of twelve.

### It works, and running it against a real encoder found a bug

The tests above use a model of an encoder. Models are how a search gets a false
clean bill of health, so it was also run against Chrome's actual JPEG and WebP
encoders over CDP, on a 2048×1536 photograph that comes out at 829 KB / 400 KB /
223 KB at qualities 0.92 / 0.78 / 0.55:

| Asked for | Got | Dimensions | Quality | Probes | Wall clock |
| --- | --- | --- | --- | --- | --- |
| 300 KB JPEG | 276 KB — 91.9% of target | unchanged | 0.65 | 4 | 131 ms |
| 800 KB JPEG | 771 KB — 96.3% of target | unchanged | 0.91 | 7 | 267 ms |
| 2 MB JPEG | 829 KB — 41.4% of target | unchanged | 0.92 | 1 | 43 ms |
| 300 KB WebP | 279 KB — 92.9% of target | unchanged | 0.82 | 7 | 2.8 s |

Three things came out of that table, and only the first was expected.

**It lands where it should and it is fast.** Four to seven encodes, inside a
tenth of a second for JPEG at 3 megapixels, and within a few percent of the
number asked for. A 12 megapixel photo is four times the pixels, so budget
something under a second on a desktop and two or three on a phone — with a
progress line, because that is long enough to need one.

**The third row is a bug, and it is a reporting bug rather than a search bug.**
The picture already fits 2 MB at full quality, so the correct thing to do is
nothing — but the plan came back `met: true`, which reads as "hit your target"
and invites the entirely reasonable question of why 41% is a hit. There is no
good answer to that question, because the honest report is "already under
2 MB — nothing to do". `Plan` now carries `unchanged` alongside `met`, with a
test for each, and the UI has to say the two differently.

**WebP encodes about ten times slower than JPEG** — 314–520 ms a probe against
30–48 ms — which turns a seven-probe search from a quarter of a second into
nearly three, at only 3 megapixels. At 12 megapixels on a phone that is not a
search, it is a hang. So either the target-size feature defaults to JPEG, or the
search runs its probes on a downscaled proxy and confirms once at full size.
Worth knowing before the UI offers a format picker as though the two were
interchangeable.

There is a fourth finding that is purely an implementation note, and an
expensive one to rediscover: **allocate one scratch canvas and resize it, do not
make a new `OffscreenCanvas` per probe.** The first version of this spike did the
latter and each 12 megapixel encode took something like twelve seconds instead of
the ~150 ms the pixel count implies — and once it had run a while, `convertToBlob`
simply stopped resolving. No error, no rejection, a promise that never settled.

Two things the UI has to say out loud. **PNG has no quality knob**, so a target
size on a PNG can only trade pixels, and it will trade a lot of them. And when
the target is impossible — 20 KB for a photograph — the plan comes back
`met: false` with the best it managed, and the UI shows that rather than
pretending.

---

## Shapes, text and doodles

A vector overlay: a list of objects in coordinates normalised to the picture, not
in pixels. Rectangle, ellipse, line, arrow, freehand, highlighter, text box, each
with a fill and a stroke.

Normalised coordinates are what make this the shared piece. The same list drawn
over a 400-pixel-wide preview and over a 4000-pixel export is the same list, and
— this is the point — the same list drawn over a rasterised PDF page is *still*
the same list.

The highlighter is worth calling out as its own tool rather than a translucent
pen: it wants `multiply` blending and constant alpha along the stroke, so that
crossing your own line doesn't produce a dark blob where it crossed. That is one
line of canvas state and it is the difference between a highlighter and a
mistake.

For freehand on a touch screen, the raw pointer stream is too noisy to draw
directly. A Catmull-Rom pass over the points, with a minimum distance before a
point is even recorded, is the standard fix and is maybe thirty lines.

---

## The PDF question

There is real overlap, and it is narrower than it looks.

**Shared: the markup layer, completely.** The reader already draws each page as
an `<img class="reader-sheet">`. An absolutely-positioned overlay on top of that
image, drawing the same normalised objects with the same renderer and the same
tool UI, is the same code — not a port of it. Highlighting a sentence in a PDF
and circling something in a screenshot should be, and can be, one implementation.

**Not shared: everything pixel.** A PDF page is not a bitmap. Cropping one by
rasterising it turns a 200 KB vector document into a 4 MB image, and resizing one
is a meaningless operation. The wand, crop, delete and resize stay on the image
side. Forcing them across would be worse than not having them.

**The blocker is writing, not drawing.** pdf.js reads PDFs; it does not write
them. Three options:

1. **A sidecar**, keyed by path in `localStorage`, exactly as `reading.ts` already
   remembers which page you were on. Zero dependencies, works today, and the
   marks never leave the device — which is fine for reading and annotating your
   own documents and useless for sending one back.
2. **`pdf-lib`**, which writes real annotations into the file in a browser, so it
   works on all three targets at once. Around 350 KB, and it does not tree-shake
   well. It would want the same `await import()` treatment pdf.js already gets in
   `backend/web/pdf.ts`, so it is only fetched by someone who actually marks up
   a document.
3. Rasterising every page into a new PDF of images. Destructive, enormous, loses
   the text layer. No.

The recommendation is (1) now and (2) when marks need to leave the machine —
which is a decision better made once someone has used (1) for a fortnight.

**Two bridges worth building regardless**, because both are nearly free:

- **"Edit this page as a picture"**, from the reader. `pdfPage` already exists and
  already returns a rasterised page at any size. This is a menu item.
- **"Save as PDF"**, from the image editor — one page, one image. It needs
  `pdf-lib`, but if that dependency arrives for (2) anyway, this costs a
  screenful. "I need to send this photo as a PDF" is a real errand and Fiddler
  would be the only thing on an Android phone that does it without an upload.

---

## What Android makes hard

**Memory is the binding constraint, not speed.** Editing a 12 MP photo means the
decoded bitmap (48 MB as RGBA), the working `ImageData` (another 48 MB), the
1 MP proxy (4 MB), a mask (12 MB), a preview mask (12 MB), and whatever the
encoder allocates during a probe. That is comfortably past what an Android
WebView will tolerate before the system kills the process — and it gets killed,
it does not throw.

It is worth being precise about which ceiling actually binds, because the
obvious one doesn't. Desktop Chrome took a canvas 32,767 pixels wide without
complaint in the spike — the per-dimension limit is nowhere near where a
photograph lives. What the spike did *not* measure, because it needs a device to
mean anything, is the **area** limit, and that is the one that matters: Chrome
caps total canvas area, the cap is lower on Android than on the desktop, and
past it a canvas silently comes back blank rather than throwing. Anything built
here has to check `getImageData` returned real pixels rather than assume it.

So the working resolution has to be capped and the cap has to be stated. The
proposal: work at full resolution when the source fits a pixel budget, otherwise
downscale to it and **say so in the title bar** — "editing at 4000×3000 of
8000×6000" — rather than silently producing a smaller file than the person
thought they were editing.

There is a way to have both, and it is worth taking because it is nearly free:
crop, resize, rotate and markup are all resolution-independent. If the edit
contains none of the mask-based steps, the step list can be replayed against the
full-resolution source at export time and the working buffer is only ever a
preview. Only delete-and-fill force the compromise, because a mask upscaled 2×
has a soft edge. So: **full resolution unless a mask is involved.** Cropping a
48 MP photograph stays lossless, which is the common case.

That step list is also the undo story. Keeping previous buffers is 48 MB each and
obviously impossible; re-running a list of steps from the decoded source is cheap
for everything except the masks, and a background mask run-length-encodes to a
few tens of kilobytes because it is, by construction, enormous flat regions.

**One finger draws, two fingers pan.** The wand's tap-and-drag and the pan
gesture want the same finger. `ZoomableImage` already handles pinch-zoom and
`QuickLook` already has to distinguish a swipe from a pan on a zoomed picture, so
the precedent exists — but with a tool active the rule has to be explicit, and it
is the rule every touch editor uses.

**The toolbar goes at the bottom on a phone.** `styles.css` already has the
coarse-pointer touch-target pass and the rail-at-840 / shed-at-700 rungs from the
tablet work; this follows them rather than inventing a new breakpoint.

**DeX gets the keyboard.** Two pieces already exist and both apply. `App.tsx`
matches chords on a lowercased key because Chromium — and so every Android
WebView — reports `"N"` with Shift held where WKWebView reports `"n"`; a new
surface that reads `e.key` directly re-introduces that bug. And
`hardware-keyboard.ts` lists the overlays that own the keyboard while they are
up (`BLOCKING_OVERLAY`), which the editor has to join or DeX's Ctrl chords will
reach the file grid behind it.

---

## What this would look like, in order

Each stage is usable on its own, which is the test of whether the order is right.

**1 — The spine.** The editor surface (a full-screen sibling of `PdfReader`,
reached from Quick Look and the context menu), decode, rectangle select, crop,
rotate and flip, resize with a locked aspect ratio, **fit into N MB**, and save.
Needs the one new backend call. This alone covers most of a normal week: crop a
screenshot, straighten a photo, get it under the limit, save a copy.

**2 — The wand.** Already written and tested; needs the proxy-during-drag
plumbing, marching ants, and the delete and fill verbs. Delete goes to
transparency where the format has an alpha channel and offers to convert where it
doesn't, which is what Preview does and is the correct answer.

**3 — Markup on images.** Shapes, text, freehand, highlighter. The vector layer.

**4 — Markup in the reader.** The same layer over a PDF page, sidecar-stored.

**5 — Marks that travel.** `pdf-lib`, write-back, and image-to-PDF, if and only
if (4) proves people want their annotations to leave the device.

## Open questions

- **Does Replace ever get to be the default?** It is the thing people expect from
  every other editor, and it is the thing Fiddler currently has no safety net
  for. Recording file creation in `undo.ts` — noted as a deliberate omission in
  `what-needs-love.md` — would change the answer.
- **Does the editor own rotation, or does the file browser?** Rotating a JPEG
  losslessly is a metadata edit, not a re-encode, and it is a verb you want on a
  selection of forty photos from the context menu without opening anything. Those
  are two different features that look like one.
- **Should the wand's tolerance be remembered between pictures?** It is a per-photo
  property in principle and a per-person habit in practice.

---

## How the numbers here were got

Everything measured lives on this branch and can be re-run.

```
npm test                                    # the wand and the budget search, 23 tests
npx tsc --noEmit
```

The wand benchmark is the loop in the table above: build a noisy gradient photo
at each size and run five contiguous fills at the tolerances a drag sweeps
through. It runs under Node, which is the same V8 the Android WebView and the
macOS webview both use — a phone is slower because its CPU is slower, not
because the engine is different, so the numbers scale rather than being
meaningless.

The encoder numbers needed a real browser, because Node has no canvas. They come
from the established route on this box: `google-chrome --headless=new` driven
over raw CDP. Two traps in that, both of which cost time here and are worth
writing down for whoever does it next:

- **`/json/list` returns extension background pages.** The first target in the
  list was a `chrome-extension://` background page, not the tab. Every evaluate
  went to the wrong context and silently reported `undefined`. Filter on
  `type === "page"` and a non-`chrome-extension:` URL.
- **Chrome will not run `<script type="module">` from a `file://` URL.** The
  module is fetched with an opaque origin and blocked, and nothing is thrown —
  the script simply never executes. A classic `<script>` works; so does serving
  the page over HTTP.
- **`Runtime.evaluate` with `awaitPromise` hides a rejection if you are on the
  wrong target.** Both of the traps above presented identically: a promise that
  never settled and no diagnostic anywhere. Setting a progress variable the
  driver polls, rather than awaiting one long evaluate, turns twenty minutes of
  guessing into a line of output.

The encoder run deliberately uses a 3-megapixel source rather than 12. Headless
software rendering on this box is slow enough that the larger size adds nothing
but wall-clock: the search's behaviour — where it lands, how many probes, the
JPEG/WebP ratio — is what the run is for, and none of it depends on the pixel
count. The absolute timings scale with it, and the text above says so where it
extrapolates.
