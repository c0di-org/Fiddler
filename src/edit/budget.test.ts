import assert from "node:assert/strict";
import { test } from "node:test";

import { planForTarget, type Probe } from "./budget.ts";

const MB = 1024 * 1024;

/**
 * A stand-in for a JPEG encoder. Not a claim about JPEG — the shape only has to
 * be monotonic in both knobs and steeply nonlinear in quality, which is what the
 * search has to survive. `grain` is how much detail the frame holds: a noisy
 * photograph compresses far worse than a flat screenshot, and the search has to
 * work for both without knowing which it has.
 */
function encoder(width: number, height: number, grain: number) {
  const calls: Array<{ scale: number; quality: number }> = [];
  const probe: Probe = async (scale, quality) => {
    calls.push({ scale, quality });
    const pixels = width * scale * (height * scale);
    const perPixel = grain * (0.05 + Math.pow(quality, 3.2) * 2.4);
    return Math.round(pixels * perPixel + 900); // + header
  };
  return { probe, calls };
}

test("a picture already under budget is left completely alone", async () => {
  const { probe, calls } = encoder(800, 600, 0.02);
  const plan = await planForTarget({ width: 800, height: 600 }, 5 * MB, probe);
  assert.equal(plan.met, true);
  assert.equal(plan.unchanged, true, "and says it did nothing, rather than claiming a hit");
  assert.equal(plan.scale, 1);
  assert.equal(plan.quality, 0.92);
  assert.equal(plan.width, 800);
  assert.equal(calls.length, 1, "one probe is enough to learn it already fits");
});

test("quality is spent before pixels are", async () => {
  // Grain chosen so the floor quality genuinely fits: this is the case where
  // trading pixels would be the wrong answer, and the test is that it doesn't.
  const { probe } = encoder(4000, 3000, 0.35);
  const plan = await planForTarget({ width: 4000, height: 3000 }, 2 * MB, probe);
  assert.equal(plan.met, true);
  assert.equal(plan.scale, 1, "the full 12 megapixels survive");
  assert.ok(plan.quality < 0.92 && plan.quality >= 0.55);
  assert.ok(plan.bytes <= 2 * MB);
  assert.ok(plan.bytes >= 2 * MB * 0.9, `landed at ${plan.bytes}, wanted within 10% of the target`);
});

test("once quality hits the floor the picture shrinks instead", async () => {
  const { probe } = encoder(6000, 4000, 1.6);
  const plan = await planForTarget({ width: 6000, height: 4000 }, 1 * MB, probe);
  assert.equal(plan.met, true);
  assert.ok(plan.scale < 1, "it had to give up pixels");
  assert.ok(plan.quality >= 0.55, "and did not also wreck the quality doing it");
  assert.ok(plan.bytes <= 1 * MB);
  assert.ok(plan.bytes >= 1 * MB * 0.9, `landed at ${plan.bytes}`);
  assert.equal(plan.width, Math.round(6000 * plan.scale));
});

test("an impossible budget says so rather than lying", async () => {
  const { probe } = encoder(6000, 4000, 4);
  const plan = await planForTarget({ width: 6000, height: 4000 }, 1024, probe);
  assert.equal(plan.met, false);
  assert.ok(plan.width >= 1 && plan.height >= 1);
});

test("the search stays inside its probe budget on every shape of picture", async () => {
  for (const grain of [0.01, 0.08, 0.3, 0.9, 2.5, 7]) {
    for (const [w, h] of [
      [640, 480],
      [1920, 1080],
      [4032, 3024],
      [8000, 6000],
    ]) {
      for (const target of [0.2 * MB, 1 * MB, 2 * MB, 8 * MB]) {
        const { probe, calls } = encoder(w, h, grain);
        const plan = await planForTarget({ width: w, height: h }, target, probe);
        const where = `${w}x${h} grain ${grain} target ${(target / MB).toFixed(1)}MB`;
        assert.ok(calls.length <= 12, `${where}: ${calls.length} probes`);
        if (plan.met) {
          assert.ok(plan.bytes <= target, `${where}: overshot at ${plan.bytes}`);
          assert.ok(plan.scale > 0 && plan.scale <= 1, where);
          assert.ok(plan.quality >= 0.05 && plan.quality <= 1, where);
        }
      }
    }
  }
});

test("a bigger budget never produces a worse picture", async () => {
  // The property that matters most and is easiest to break with a bad bracket:
  // asking for more room must never come back with fewer pixels or less quality.
  let prev = { scale: 0, quality: 0 };
  for (const target of [0.25, 0.5, 1, 2, 4, 8].map((n) => n * MB)) {
    const { probe } = encoder(4032, 3024, 1.2);
    const plan = await planForTarget({ width: 4032, height: 3024 }, target, probe);
    assert.ok(
      plan.scale >= prev.scale && (plan.scale > prev.scale || plan.quality >= prev.quality),
      `${(target / MB).toFixed(2)}MB went backwards: ${JSON.stringify(plan)} after ${JSON.stringify(prev)}`
    );
    prev = { scale: plan.scale, quality: plan.quality };
  }
});

test("repeated settings are never re-encoded", async () => {
  const { probe, calls } = encoder(4000, 3000, 1.1);
  await planForTarget({ width: 4000, height: 3000 }, 1.5 * MB, probe);
  const keys = calls.map((c) => `${c.scale}:${c.quality}`);
  assert.equal(new Set(keys).size, keys.length, `re-encoded the same settings: ${keys.join(", ")}`);
});

test("a generous budget reports that it changed nothing, not that it hit the mark", async () => {
  // The case that exposed this: a photo encoding to 829 KB at full quality,
  // asked to fit 2 MB. It fits, at 41% of the target — and reporting that as a
  // hit invites the question of why it is not nearer 2 MB. There is no answer
  // to that question, because the honest report is "nothing to do".
  const { probe } = encoder(2048, 1536, 0.28);
  const plan = await planForTarget({ width: 2048, height: 1536 }, 2 * MB, probe);
  assert.equal(plan.met, true);
  assert.equal(plan.unchanged, true);
  assert.ok(plan.bytes < 2 * MB * 0.9, "and it really is well under, which is the point");
});

test("a budget that had to be worked for is not reported as unchanged", async () => {
  const { probe } = encoder(4000, 3000, 0.35);
  const plan = await planForTarget({ width: 4000, height: 3000 }, 2 * MB, probe);
  assert.equal(plan.met, true);
  assert.equal(plan.unchanged, false);
});
