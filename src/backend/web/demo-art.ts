/** The demo tree's pictures and sounds, generated rather than shipped.
 *
 * A folder of real photographs would be the most convincing thing to put in
 * front of someone, and also a few megabytes of payload for a page whose whole
 * pitch is that it opens instantly. These are built from a seed instead: a
 * handful of blurred colour fields under a noise filter, which is enough to
 * fill a grid with something worth looking at, at a few hundred bytes each. */

/** Small, fast, and stable across reloads — the demo folder should look the
 * same every time someone shows it to a colleague. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export interface Palette {
  name: string;
  base: string;
  colors: [string, string, string, string];
}

export const PALETTES: Palette[] = [
  { name: "Aurora", base: "#050b1a", colors: ["#31d0aa", "#3f7cf0", "#8d5cf6", "#1b3b8f"] },
  { name: "Dunes", base: "#2a1608", colors: ["#f2a63b", "#e2653c", "#f5d199", "#8a3b1e"] },
  { name: "Harbour", base: "#03151c", colors: ["#28c8d8", "#1f6f8f", "#9ee8d6", "#0b3948"] },
  { name: "Orchard", base: "#12200c", colors: ["#a3d945", "#4d9e4a", "#e8f0a8", "#2b5f2c"] },
  { name: "Ember", base: "#1a0510", colors: ["#ff5f6d", "#ffc371", "#c13584", "#5c1042"] },
  { name: "Quartz", base: "#101018", colors: ["#d5d8e8", "#8f94b8", "#5a5f85", "#22243a"] },
];

const W = 1600;
const H = 1000;

/** One abstract wallpaper as an SVG document. */
export function wallpaper(palette: Palette, seed: number): string {
  const rand = seeded(seed);
  const blobs: string[] = [];

  for (let i = 0; i < 7; i++) {
    const color = palette.colors[i % palette.colors.length];
    const cx = Math.round(rand() * W);
    const cy = Math.round(rand() * H);
    const rx = Math.round(220 + rand() * 520);
    const ry = Math.round(180 + rand() * 420);
    const rotate = Math.round(rand() * 180);
    const opacity = (0.35 + rand() * 0.45).toFixed(2);
    blobs.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" ` +
        `opacity="${opacity}" transform="rotate(${rotate} ${cx} ${cy})"/>`
    );
  }

  // The grain layer is what stops these reading as flat vector shapes at full
  // size; without it a 1600px preview looks like a gradient, not a picture.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs>`,
    `<filter id="soft" x="-25%" y="-25%" width="150%" height="150%">`,
    `<feGaussianBlur stdDeviation="130"/></filter>`,
    `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="${seed}"/>`,
    `<feColorMatrix type="saturate" values="0"/></filter>`,
    `</defs>`,
    `<rect width="${W}" height="${H}" fill="${palette.base}"/>`,
    `<g filter="url(#soft)">${blobs.join("")}</g>`,
    `<rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.16"/>`,
    `</svg>`,
  ].join("");
}

/** A hand-drawn diagram, so the demo has one picture that means something as
 * well as several that are merely nice. */
export function architectureDiagram(): string {
  const box = (x: number, y: number, w: number, label: string, sub: string, fill: string) =>
    `<g><rect x="${x}" y="${y}" width="${w}" height="86" rx="12" fill="${fill}" stroke="#3a4358"/>` +
    `<text x="${x + w / 2}" y="${y + 36}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" ` +
    `font-size="21" font-weight="600" fill="#e8ecf6">${label}</text>` +
    `<text x="${x + w / 2}" y="${y + 62}" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" ` +
    `font-size="15" fill="#93a0bd">${sub}</text></g>`;

  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#5b6784" stroke-width="2" marker-end="url(#tip)"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520">`,
    `<defs><marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">`,
    `<path d="M0 0 L10 5 L0 10 z" fill="#5b6784"/></marker></defs>`,
    `<rect width="900" height="520" fill="#0e1219"/>`,
    `<text x="450" y="52" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" `,
    `font-size="24" font-weight="600" fill="#e8ecf6">How Fiddler is put together</text>`,
    box(310, 92, 280, "React front end", "one codebase", "#1a2130"),
    arrow(450, 178, 450, 214),
    box(310, 214, 280, "src/ipc.ts", "the whole seam", "#1d2739"),
    arrow(400, 300, 220, 342),
    arrow(500, 300, 680, 342),
    box(80, 342, 280, "Rust over Tauri IPC", "macOS · Android", "#16202c"),
    box(540, 342, 280, "Virtual filesystem", "the browser", "#16202c"),
    `<text x="450" y="486" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" `,
    `font-size="16" fill="#7c89a6">Everything above the seam is the same code.</text>`,
    `</svg>`,
  ].join("");
}

/** A few seconds of a major chord, so the audio player has something to play.
 * Written straight into a WAV container because that keeps the whole demo tree
 * synchronous to build — no encoder, no await, no loading state. */
export function chord(): Blob {
  const rate = 22050;
  const seconds = 4;
  const frames = rate * seconds;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);

  const voices = [220, 277.18, 329.63, 440]; // A3 major, plus the octave
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    // A slow attack and a long decay; a square-edged start would just click.
    const envelope = Math.min(1, t * 3) * Math.exp(-t * 0.7);
    let sample = 0;
    for (const hz of voices) sample += Math.sin(2 * Math.PI * hz * t) / voices.length;
    view.setInt16(44 + i * 2, Math.round(sample * envelope * 26000), true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/* ------------------------------------------------------------------ pdf --
 *
 * A PDF, written out by hand for the same reason the chord above is: the demo
 * tree has to be there the moment the page is, and a shipped document would be
 * a megabyte of payload for a folder whose whole pitch is that it opens
 * instantly. This is a few kilobytes of ASCII.
 *
 * It is also the only way the browser build can show the reader at all — page
 * turns, the spread, remembering where you were — so the booklet's text is the
 * reader's own documentation, which is a thing worth having eight pages of
 * anyway. */

/** US Letter, which is the aspect the reader assumes before the first page
 * lands. Keeping the demo on it means the very first frame is the right shape. */
const PAGE_W = 612;
const PAGE_H = 792;

interface Leaf {
  title: string;
  body: string[];
}

const BOOKLET: Leaf[] = [
  {
    title: "The Reader",
    body: [
      "A PDF, read as a book rather than opened as a file.",
      "",
      "Turn the page with the arrow keys, the space bar, a swipe,",
      "a scroll, or a tap near either edge.",
      "",
      "Tap the top of the page for the controls, and again to send",
      "them away. Everything else gets out of the way while you",
      "read.",
    ],
  },
  {
    title: "Turning",
    body: [
      "The page after this one is already rasterised by the time",
      "you ask for it: it was fetched while you were reading this",
      "one. That is the whole reason a turn lands like paper",
      "rather than like a request going somewhere.",
      "",
      "Left and right, up and down, PageUp and PageDown, and the",
      "space bar all turn. So does a scroll wheel, a trackpad",
      "swipe, and a thumb dragged across the page.",
      "",
      "The outer thirds of the page turn it when tapped. The band",
      "along the top brings the controls back, wherever along it",
      "you land — so getting out of a book never means hunting for",
      "a target you can't see.",
      "",
      "Home goes to the cover. End goes to the last page.",
    ],
  },
  {
    title: "Two pages, when there is room",
    body: [
      "Past about nine hundred pixels of width, on a window wider",
      "than it is tall, the reader opens the book out into a",
      "spread — with the cover standing alone the way a real",
      "book's does, so that the odd page stays on the right.",
      "",
      "Press d, or use the button in the bar, to go back to one",
      "page at a time.",
    ],
  },
  {
    title: "Where you left off",
    body: [
      "Close this on page six and it opens on page six — next",
      "week, in a different window, after a reload.",
      "",
      "The position is written on every turn rather than when the",
      "book is closed, because a reader that only remembers a",
      "tidy exit forgets every book you closed by quitting.",
    ],
  },
  {
    title: "Full screen",
    body: [
      "Press f. The window goes, the desktop goes, and what is",
      "left is the page and a two-pixel line along the bottom",
      "telling you how far through you are.",
      "",
      "Escape leaves full screen. Escape again closes the book.",
      "One press never does both: losing your place should take",
      "more than a keystroke you meant for something else.",
    ],
  },
  {
    title: "Fitting",
    body: [
      "Press w to fill the width instead of the page. Small type",
      "on a large screen becomes readable, and the page scrolls",
      "rather than turning until you press w again.",
      "",
      "Each page is rasterised at the size it will actually",
      "occupy, snapped to a handful of shared sizes so that",
      "resizing the window mostly reuses what was already drawn.",
    ],
  },
  {
    title: "What it costs",
    body: [
      "About fourteen pages are held as images at once — a couple",
      "of spreads either side of the one being read. Nothing else",
      "stays in memory, and nothing is decoded twice.",
      "",
      "On a Mac the rasteriser is Core Graphics; on Android it is",
      "the platform PdfRenderer; in this tab it is pdf.js, in a",
      "chunk that is only fetched when someone opens a PDF.",
    ],
  },
  {
    title: "Still to come",
    body: [
      "An edit mode: text laid onto the page, and a signature",
      "you can put where the line is.",
      "",
      "The reader was built with that in mind — the page is a",
      "known rectangle at a known scale, which is the hard half",
      "of putting anything onto it.",
    ],
  },
];

/** The demo's PDF: eight pages of US Letter, Helvetica, no images.
 *
 * PDF's cross-reference table is a list of byte offsets into the file, so the
 * objects are emitted in order and measured as they go. Everything written is
 * ASCII, which is what makes a character count a byte count. */
export function booklet(): Blob {
  const offsets: number[] = [];
  let out = "%PDF-1.4\n";

  const put = (id: number, body: string) => {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${body}\nendobj\n`;
  };

  // 1 catalog, 2 the page tree, 3 and 4 the two fonts; each leaf then takes a
  // page object and a content stream, in that order.
  const pageId = (i: number) => 5 + i * 2;
  const contentId = (i: number) => 6 + i * 2;
  const total = 4 + BOOKLET.length * 2;

  put(1, "<< /Type /Catalog /Pages 2 0 R >>");
  put(
    2,
    `<< /Type /Pages /Count ${BOOKLET.length} /Kids [${BOOKLET.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>`
  );
  put(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  put(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  BOOKLET.forEach((leaf, i) => {
    put(
      pageId(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}]` +
        ` /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId(i)} 0 R >>`
    );
    const stream = draw(leaf, i);
    put(contentId(i), `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  const xref = out.length;
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return new Blob([out], { type: "application/pdf" });
}

/** One page's content stream. */
function draw(leaf: Leaf, index: number): string {
  const margin = 72;
  const cover = index === 0;
  const ops: string[] = [];

  // A rule across the top, and a wash of accent behind the cover's title, so
  // the pages read as a designed document rather than as a text dump.
  ops.push("0.82 0.84 0.88 rg");
  ops.push(`${margin} ${PAGE_H - 96} ${PAGE_W - margin * 2} 1 re f`);
  if (cover) {
    ops.push("0.04 0.52 1 rg");
    ops.push(`${margin} ${PAGE_H - 210} 96 6 re f`);
  }

  ops.push("0.11 0.11 0.12 rg");
  ops.push("BT");
  ops.push(`/F2 ${cover ? 34 : 19} Tf`);
  ops.push(`${margin} ${PAGE_H - (cover ? 260 : 140)} Td`);
  ops.push(`(${escape(leaf.title)}) Tj`);
  ops.push("ET");

  ops.push("0.24 0.24 0.27 rg");
  ops.push("BT");
  ops.push("/F1 12.5 Tf");
  ops.push("19 TL");
  ops.push(`${margin} ${PAGE_H - (cover ? 320 : 190)} Td`);
  for (const line of leaf.body) ops.push(`(${escape(line)}) Tj T*`);
  ops.push("ET");

  // The folio, centred, in the same grey as the rule.
  ops.push("0.55 0.55 0.58 rg");
  ops.push("BT");
  ops.push("/F1 9.5 Tf");
  ops.push(`${PAGE_W / 2 - 10} 54 Td`);
  ops.push(`(${index + 1}) Tj`);
  ops.push("ET");

  return ops.join("\n");
}

/** Anything in a PDF string that isn't a plain ASCII character.
 *
 * Two jobs. The three characters that mean something else inside a string get
 * a backslash; everything above ASCII becomes a WinAnsi octal escape, which is
 * what keeps the *file* pure ASCII — and a file that is pure ASCII is one where
 * a character count is a byte count, which is the assumption the cross-
 * reference table above is built on. */
const WIN_ANSI: Record<string, string> = {
  "\u2014": "\\227",
  "\u2013": "\\226",
  "\u2018": "\\221",
  "\u2019": "\\222",
  "\u201c": "\\223",
  "\u201d": "\\224",
  "\u2026": "\\205",
};

function escape(text: string): string {
  return text
    .replace(/[\\()]/g, (c) => `\\${c}`)
    .replace(/[^\x20-\x7e]/g, (c) => WIN_ANSI[c] ?? "?");
}
