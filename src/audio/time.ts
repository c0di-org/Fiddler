/**
 * Times, said the way a listener thinks about them.
 *
 * Two different jobs, deliberately not one function. A scrubber wants a clock —
 * fixed shape, monospaced, changes every second, and nobody reads it so much as
 * glances at it. A book wants a sentence: "4 hr 12 min left" is the number
 * anyone actually cares about, and it is the one number a clock is bad at,
 * because `4:12:07` and `0:12:07` look the same at a glance in the dark.
 */

/** `1:04:09`, or `4:09` under an hour. Hours are only shown when there are
 * some: padding every chapter out to `0:04:09` makes the common case wider and
 * harder to read for the sake of the rare one. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** `4 hr 12 min`, `12 min`, `40 sec`. Rounded up rather than down: a book with
 * fifty-nine seconds to go has a minute left, and saying "0 min" of something
 * still playing reads as a bug. */
export function span(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 sec";
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/**
 * How much real time is left, which is not how much recording is left.
 *
 * At 1.8× an eleven-hour book is a six-hour book, and six hours is the answer
 * to the question anyone is asking when they look. Getting this wrong — showing
 * the untouched duration next to a speed control — is the single most common
 * way a player lies to the person using it.
 */
export function realRemaining(at: number, duration: number, rate: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const left = Math.max(0, duration - (Number.isFinite(at) ? at : 0));
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return left / speed;
}

/** `1.5×`, `1×`, `1.25×` — trailing zeros trimmed, because `1.50×` on a
 * button reads as a measurement rather than a setting. */
export function rateLabel(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  return `${String(rounded)}×`;
}
