import assert from "node:assert/strict";
import test from "node:test";

import { pageFor, parseMarks, READING_CAP, remember } from "./reading.ts";

test("nothing stored means nothing remembered", () => {
  assert.deepEqual(parseMarks(null), []);
  assert.deepEqual(parseMarks("garbage"), []);
  assert.deepEqual(parseMarks({}), []);
});

test("entries that aren't a path and a page are dropped, not trusted", () => {
  const marks = parseMarks([
    { path: "/a.pdf", page: 12 },
    { path: "", page: 3 },
    { path: "/b.pdf", page: 0 },
    { path: "/c.pdf", page: "seven" },
    { path: "/d.pdf" },
    null,
    { path: "/e.pdf", page: 4.7 },
  ]);
  assert.deepEqual(marks, [
    { path: "/a.pdf", page: 12 },
    { path: "/e.pdf", page: 4 },
  ]);
});

test("the same document twice keeps only the first, most recent, entry", () => {
  const marks = parseMarks([
    { path: "/a.pdf", page: 9 },
    { path: "/a.pdf", page: 2 },
  ]);
  assert.deepEqual(marks, [{ path: "/a.pdf", page: 9 }]);
});

test("remembering moves a document to the front", () => {
  const marks = remember(remember([], "/a.pdf", 5), "/b.pdf", 3);
  assert.deepEqual(marks.map((m) => m.path), ["/b.pdf", "/a.pdf"]);

  const again = remember(marks, "/a.pdf", 6);
  assert.deepEqual(again, [
    { path: "/a.pdf", page: 6 },
    { path: "/b.pdf", page: 3 },
  ]);
});

test("page one is not a position worth keeping", () => {
  // Closing a short document on its only page must not evict something the
  // reader is actually part-way through.
  const marks = remember(remember([], "/a.pdf", 5), "/a.pdf", 1);
  assert.deepEqual(marks, []);
});

test("the list is capped, oldest first out", () => {
  let marks: ReturnType<typeof remember> = [];
  for (let i = 0; i < READING_CAP + 10; i++) marks = remember(marks, `/doc-${i}.pdf`, 4);
  assert.equal(marks.length, READING_CAP);
  assert.equal(marks[0].path, `/doc-${READING_CAP + 9}.pdf`);
  assert.ok(!marks.some((m) => m.path === "/doc-0.pdf"));
});

test("a remembered page is clamped to the document that comes back", () => {
  // The file may have been replaced by a shorter one since it was last read.
  const marks = remember([], "/a.pdf", 40);
  assert.equal(pageFor(marks, "/a.pdf", 100), 40);
  assert.equal(pageFor(marks, "/a.pdf", 12), 12);
  assert.equal(pageFor(marks, "/a.pdf", 0), 1);
  assert.equal(pageFor(marks, "/unknown.pdf", 100), 1);
});
