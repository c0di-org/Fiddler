import assert from "node:assert/strict";
import test from "node:test";

import {
  lastPlayed,
  MARK_CAP,
  markFor,
  noteProgress,
  parseMarks,
  progressOf,
  resumeAt,
  rewindFor,
  WORTH_REMEMBERING,
} from "./positions.ts";

const HOUR = 3600;

test("nothing stored means nothing remembered", () => {
  assert.deepEqual(parseMarks(null), []);
  assert.deepEqual(parseMarks("garbage"), []);
  assert.deepEqual(parseMarks({}), []);
});

test("entries that aren't a path and a position are dropped", () => {
  const marks = parseMarks([
    { path: "/a.mp3", at: 120, duration: 3600, updated: 5, done: false },
    { path: "", at: 3 },
    { path: "/b.mp3", at: -1 },
    { path: "/c.mp3", at: "seven" },
    { path: "/d.mp3" },
    null,
  ]);
  assert.deepEqual(marks, [
    { path: "/a.mp3", at: 120, duration: 3600, updated: 5, done: false },
  ]);
});

test("a position past the end is a file that changed, and is not trusted", () => {
  assert.deepEqual(parseMarks([{ path: "/a.mp3", at: 4000, duration: 3600 }]), []);
});

test("a missing duration or timestamp reads back as zero rather than dropping the mark", () => {
  assert.deepEqual(parseMarks([{ path: "/a.mp3", at: 200 }]), [
    { path: "/a.mp3", at: 200, duration: 0, updated: 0, done: false },
  ]);
});

test("the same recording twice keeps only the first, most recent, entry", () => {
  const marks = parseMarks([
    { path: "/a.mp3", at: 900, duration: 3600 },
    { path: "/a.mp3", at: 60, duration: 3600 },
  ]);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].at, 900);
});

// ------------------------------------------------------------------ rewinding

test("a pause of a few seconds gets no run-up at all", () => {
  assert.equal(rewindFor(0), 0);
  assert.equal(rewindFor(20_000), 0);
});

test("the longer you were away the further back it starts you", () => {
  const away = [60_000, 30 * 60_000, 2 * 86_400_000, 30 * 86_400_000];
  const backs = away.map(rewindFor);
  assert.deepEqual(
    backs,
    [...backs].sort((a, b) => a - b),
    "run-up must never shrink as time away grows"
  );
  assert.ok(backs[0] > 0);
  assert.ok(backs[3] >= 30);
});

test("a nonsense interval asks for no rewind rather than NaN seconds", () => {
  assert.equal(rewindFor(Number.NaN), 0);
  assert.equal(rewindFor(-5), 0);
});

// ------------------------------------------------------------------ recording

test("a long recording partway through is remembered", () => {
  const marks = noteProgress([], "/book/ch1.mp3", 1200, 4 * HOUR, 1000);
  assert.deepEqual(marks, [
    { path: "/book/ch1.mp3", at: 1200, duration: 4 * HOUR, updated: 1000, done: false },
  ]);
});

test("a short recording is not worth a bookmark", () => {
  assert.deepEqual(noteProgress([], "/beep.wav", 5, 12, 1000), []);
  assert.deepEqual(noteProgress([], "/jingle.mp3", 40, WORTH_REMEMBERING - 1, 1000), []);
});

test("the first few seconds of a long recording are not somewhere you got to", () => {
  assert.deepEqual(noteProgress([], "/book/ch1.mp3", 4, 4 * HOUR, 1000), []);
});

test("playing a file again from the top clears the mark it used to have", () => {
  const had = noteProgress([], "/book/ch1.mp3", 1200, 4 * HOUR, 1000);
  const now = noteProgress(had, "/book/ch1.mp3", 2, 4 * HOUR, 2000);
  assert.deepEqual(now, []);
});

test("near the end counts as finished, and finished is kept", () => {
  const marks = noteProgress([], "/book/ch1.mp3", 3595, 3600, 1000);
  assert.equal(marks[0].done, true);
  assert.equal(marks[0].at, 3600, "a finished recording is stored at its full length");
});

test("a fresh mark goes to the front and the oldest falls off the end", () => {
  let marks: ReturnType<typeof noteProgress> = [];
  for (let i = 0; i < MARK_CAP + 5; i++) {
    marks = noteProgress(marks, `/book/ch${i}.mp3`, 1200, 4 * HOUR, i);
  }
  assert.equal(marks.length, MARK_CAP);
  assert.equal(marks[0].path, `/book/ch${MARK_CAP + 4}.mp3`);
  assert.equal(markFor(marks, "/book/ch0.mp3"), null);
});

// -------------------------------------------------------------------- resuming

test("a recording never played starts at the beginning", () => {
  assert.equal(resumeAt([], "/book/ch1.mp3", 4 * HOUR, 1000), 0);
});

test("a recording resumed straight away carries on where it stopped", () => {
  const marks = noteProgress([], "/book/ch1.mp3", 1200, 4 * HOUR, 1000);
  assert.equal(resumeAt(marks, "/book/ch1.mp3", 4 * HOUR, 1000), 1200);
});

test("a recording resumed the next day gets its run-up", () => {
  const marks = noteProgress([], "/book/ch1.mp3", 1200, 4 * HOUR, 0);
  const at = resumeAt(marks, "/book/ch1.mp3", 4 * HOUR, 86_400_000);
  assert.ok(at < 1200 && at >= 1200 - 30, `expected a short run-up, got ${1200 - at}s`);
});

test("a finished recording starts again from the beginning", () => {
  const marks = noteProgress([], "/book/ch1.mp3", 3595, 3600, 1000);
  assert.equal(resumeAt(marks, "/book/ch1.mp3", 3600, 1000), 0);
});

test("a file replaced by a shorter one resumes inside the file that exists now", () => {
  const marks = noteProgress([], "/book/ch1.mp3", 3000, 4 * HOUR, 1000);
  const at = resumeAt(marks, "/book/ch1.mp3", 4 * HOUR, 1000);
  assert.equal(at, 3000);
  // Same mark, but the file now says it is fifty minutes long.
  const shorter = resumeAt(marks, "/book/ch1.mp3", 3000, 1000);
  assert.ok(shorter <= 3000 - 25, "must not resume inside the tail we call finished");
});

test("a mark left when the file was long stops applying once it is known to be short", () => {
  const marks = noteProgress([], "/book/ch1.mp3", 1200, 4 * HOUR, 1000);
  assert.equal(resumeAt(marks, "/book/ch1.mp3", 30, 1000), 0);
});

// ---------------------------------------------------------------------- books

test("a book reopens on the chapter you were in", () => {
  const paths = ["/b/01.mp3", "/b/02.mp3", "/b/03.mp3"];
  let marks: ReturnType<typeof noteProgress> = [];
  marks = noteProgress(marks, "/b/01.mp3", 1200, HOUR, 1000);
  marks = noteProgress(marks, "/b/02.mp3", 900, HOUR, 2000);
  assert.equal(lastPlayed(marks, paths), "/b/02.mp3");
});

test("a book whose last chapter you finished reopens on the next one", () => {
  const paths = ["/b/01.mp3", "/b/02.mp3", "/b/03.mp3"];
  let marks: ReturnType<typeof noteProgress> = [];
  marks = noteProgress(marks, "/b/01.mp3", HOUR - 2, HOUR, 1000);
  assert.equal(lastPlayed(marks, paths), "/b/02.mp3");
});

test("finishing the last chapter leaves you on it rather than nowhere", () => {
  const paths = ["/b/01.mp3", "/b/02.mp3"];
  const marks = noteProgress([], "/b/02.mp3", HOUR - 2, HOUR, 1000);
  assert.equal(lastPlayed(marks, paths), "/b/02.mp3");
});

test("marks from other folders never name this book's chapter", () => {
  const marks = noteProgress([], "/other/x.mp3", 1200, HOUR, 9000);
  assert.equal(lastPlayed(marks, ["/b/01.mp3"]), null);
});

// ------------------------------------------------------------------- progress

test("progress is a fraction, or nothing when the length was never learned", () => {
  assert.equal(progressOf(null), null);
  assert.equal(progressOf({ path: "/a", at: 100, duration: 0, updated: 0, done: false }), null);
  assert.equal(progressOf({ path: "/a", at: 900, duration: 3600, updated: 0, done: false }), 0.25);
  assert.equal(progressOf({ path: "/a", at: 10, duration: 3600, updated: 0, done: true }), 1);
});
