/** Hitting a file size on the nose.
 *
 * This is the thing every other editor makes you guess at. You need a photo
 * under 2 MB because something on the other end refuses anything larger, and
 * what you are given is a quality slider with no numbers on it and a dimensions
 * box, so you export, look at the size, sigh, and export again. Three or four
 * times. The information needed to do it properly — how big does *this* picture
 * come out at *this* quality — is only ever a re-encode away, and a computer
 * can do a re-encode faster than a person can read the number off the last one.
 *
 * So: name the size you need, and the search below finds the settings that hit
 * it. Two rules decide what it trades away, in this order:
 *
 * 1. **Keep the pixels, spend the quality — down to a floor.** Between a
 *    full-size photo at good quality and a small one at perfect quality, the
 *    full-size one is what people actually wanted.
 * 2. **Below the floor, stop and shrink instead.** Past roughly q=0.55 a JPEG
 *    stops being a slightly worse photograph and starts being a photograph with
 *    visible blocks in the sky. A smaller picture that still looks like a
 *    photograph beats a large one that doesn't.
 *
 * Every probe is a real encode of the real image, so nothing here is a model of
 * how JPEG behaves — which is fortunate, because file size against quality has
 * no useful closed form and depends entirely on what is in the frame. The cost
 * of that honesty is wall-clock, and the whole design below is about spending
 * as few probes as possible: a ratio-seeded scale search rather than a blind
 * bisection, a band around the target that counts as a hit, memoised probes,
 * and a hard cap.
 */

/** Ask the host to encode at this scale and quality, and say how many bytes it
 * came to. Injected rather than imported so this file has no opinion about
 * canvases, and so its tests can run in a second rather than an hour. */
export type Probe = (scale: number, quality: number) => Promise<number>;

export interface Plan {
  /** Multiplier on the source's pixel dimensions. */
  scale: number;
  quality: number;
  width: number;
  height: number;
  /** What the winning probe actually measured. Not an estimate. */
  bytes: number;
  /** False when even the smallest settings allowed could not get under the
   * target — a 20 KB budget for a photograph. The caller shows the best it
   * managed and says so, rather than pretending. */
  met: boolean;
  /** True when the picture already fitted and nothing was traded away.
   *
   * Separate from `met` because the two get conflated and the conflation is
   * visible: ask for 2 MB from a photo that encodes to 829 KB at full quality
   * and the honest report is "already under — nothing to do", not "hit your
   * target", which claims credit for a number this search had no part in and
   * invites the reasonable question of why it isn't nearer 2 MB. */
  unchanged: boolean;
  /** How many encodes this cost. Surfaced because it is the whole latency. */
  probes: number;
}

export interface BudgetOptions {
  /** Best quality worth trying. Above this JPEG mostly stores noise. */
  maxQuality?: number;
  /** Where the picture stops looking like a photograph. */
  floorQuality?: number;
  /** The quality held while dimensions are traded away instead. */
  scaleQuality?: number;
  /** Anything this close under the target is a hit, and the search stops.
   * 0.9 means "within 10% under" — the difference between three encodes and
   * seven, for a result nobody could tell apart. */
  band?: number;
  /** Never shrink past this multiplier; a thumbnail is not what was asked for. */
  minScale?: number;
  /** Hard cap on encodes, whatever the search would like. */
  maxProbes?: number;
}

const DEFAULTS = {
  maxQuality: 0.92,
  floorQuality: 0.55,
  scaleQuality: 0.78,
  band: 0.9,
  minScale: 0.05,
  maxProbes: 12,
} satisfies Required<BudgetOptions>;

export async function planForTarget(
  source: { width: number; height: number },
  targetBytes: number,
  probe: Probe,
  options: BudgetOptions = {}
): Promise<Plan> {
  const o = { ...DEFAULTS, ...options };
  let probes = 0;
  const seen = new Map<string, number>();

  // Scale and quality are both snapped before they reach the encoder, which is
  // what makes the memo hit: a bisection converges on values that differ in the
  // fourteenth decimal place and would otherwise re-encode the same picture.
  const measure = async (scale: number, quality: number) => {
    const s = Math.round(Math.max(o.minScale, Math.min(1, scale)) * 1000) / 1000;
    const q = Math.round(Math.max(0.05, Math.min(1, quality)) * 100) / 100;
    const key = `${s}:${q}`;
    const hit = seen.get(key);
    if (hit !== undefined) return { scale: s, quality: q, bytes: hit };
    if (probes >= o.maxProbes) return null;
    probes++;
    const bytes = await probe(s, q);
    seen.set(key, bytes);
    return { scale: s, quality: q, bytes };
  };

  const dims = (scale: number) => ({
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  });
  const done = (
    r: { scale: number; quality: number; bytes: number },
    met: boolean,
    unchanged = false
  ): Plan => ({
    ...r,
    ...dims(r.scale),
    met,
    unchanged,
    probes,
  });

  // Under budget at full size and full quality: there is nothing to trade, and
  // the worst thing this function could do is degrade a picture that fit.
  const best = await measure(1, o.maxQuality);
  if (!best) return done({ scale: 1, quality: o.maxQuality, bytes: 0 }, false);
  if (best.bytes <= targetBytes) return done(best, true, true);

  // Quality, at full size. Monotonic in bytes, with no useful closed form, so
  // this one really is a bisection — but it stops the moment a probe lands
  // inside the band rather than chasing the last percent.
  let lo = o.floorQuality;
  let hi = o.maxQuality;
  let fit: { scale: number; quality: number; bytes: number } | null = null;
  const floor = await measure(1, o.floorQuality);
  if (!floor) return done(best, false);

  if (floor.bytes <= targetBytes) {
    fit = floor;
    if (floor.bytes >= targetBytes * o.band) return done(floor, true);
    while (hi - lo > 0.01) {
      const mid = (lo + hi) / 2;
      const r = await measure(1, mid);
      if (!r) break;
      if (r.bytes <= targetBytes) {
        fit = r;
        lo = r.quality;
        if (r.bytes >= targetBytes * o.band) break;
      } else {
        hi = r.quality;
      }
    }
    return done(fit, true);
  }

  // Even the floor overshoots, so the picture has to get smaller. Bytes track
  // pixel count closely enough at a fixed quality that one measurement gives a
  // good first guess: scale ≈ √(target / measured). Two or three refinements
  // land it, where a blind bisection on scale would take six.
  const anchor = await measure(1, o.scaleQuality);
  if (!anchor) return done(floor, false);

  let scale = Math.sqrt(targetBytes / anchor.bytes);
  let under: { scale: number; quality: number; bytes: number } | null = null;
  let overScale = 1;

  for (let i = 0; i < 6; i++) {
    const r = await measure(scale, o.scaleQuality);
    if (!r) break;
    if (r.bytes <= targetBytes) {
      if (!under || r.scale > under.scale) under = r;
      if (r.bytes >= targetBytes * o.band) break;
      // Room left: step back up, but never past a scale already known to
      // overshoot, so the search cannot oscillate.
      const next = Math.min(overScale - 0.001, r.scale * Math.sqrt(targetBytes / r.bytes));
      if (next <= r.scale) break;
      scale = next;
    } else {
      overScale = Math.min(overScale, r.scale);
      const next = r.scale * Math.sqrt(targetBytes / r.bytes);
      // A guess that didn't move is a guess that won't; bisect toward what is
      // known to fit instead.
      scale = next < r.scale * 0.99 ? next : (under ? (under.scale + r.scale) / 2 : r.scale * 0.7);
    }
    if (scale <= o.minScale) {
      scale = o.minScale;
      const last = await measure(scale, o.scaleQuality);
      if (last && last.bytes <= targetBytes) under = last;
      break;
    }
  }

  if (under) return done(under, true);
  // Nothing fit. Hand back the smallest thing tried, honestly labelled.
  const smallest = await measure(o.minScale, o.floorQuality);
  return done(smallest ?? floor, false);
}
