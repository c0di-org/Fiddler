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
