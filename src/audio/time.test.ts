import assert from "node:assert/strict";
import test from "node:test";

import { clock, rateLabel, realRemaining, span } from "./time.ts";

test("a clock only shows hours when there are some", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(9), "0:09");
  assert.equal(clock(249), "4:09");
  assert.equal(clock(3849), "1:04:09");
  assert.equal(clock(36_000), "10:00:00");
});

test("a clock never shows a negative or a fraction", () => {
  assert.equal(clock(-5), "0:00");
  assert.equal(clock(Number.NaN), "0:00");
  assert.equal(clock(9.9), "0:09");
});

test("a span rounds up, so something still playing never reads as zero", () => {
  assert.equal(span(59), "59 sec");
  assert.equal(span(61), "2 min");
  assert.equal(span(3600), "1 hr");
  assert.equal(span(15_120), "4 hr 12 min");
  assert.equal(span(0), "0 sec");
});

test("time left is real time, not recording time", () => {
  assert.equal(realRemaining(0, 3600, 1), 3600);
  assert.equal(realRemaining(0, 3600, 2), 1800);
  assert.equal(realRemaining(1800, 3600, 1.5), 1200);
});

test("a nonsense speed is treated as normal rather than dividing by zero", () => {
  assert.equal(realRemaining(0, 3600, 0), 3600);
  assert.equal(realRemaining(0, 3600, Number.NaN), 3600);
  assert.equal(realRemaining(0, 0, 1), 0);
});

test("speeds are labelled without trailing zeros", () => {
  assert.equal(rateLabel(1), "1×");
  assert.equal(rateLabel(1.5), "1.5×");
  assert.equal(rateLabel(1.25), "1.25×");
  assert.equal(rateLabel(2), "2×");
});
