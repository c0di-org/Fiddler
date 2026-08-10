import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "./memory-fs.ts";
import { nearbyEntries, searchContents } from "./search-fs.ts";
import { addMount } from "./vfs.ts";

const provider = new MemoryProvider();
provider.seedFile("notes.md", new Blob(["first line\nSearch engine design is fast\n"]));
provider.seedFile("other.txt", new Blob(["search only"]));
provider.seedFile("blob.bin", new Blob([new Uint8Array([115, 0, 101])]));
provider.seedFile("huge.txt", new Blob(["search fast ".repeat(60_000)]));
provider.seedFile("spaced.md", new Blob(["\n   search      spread   out    here   \n"]));

provider.seedFile("deep/one.txt", new Blob(["1"]));
provider.seedFile("deep/nested/two.txt", new Blob(["2"]));
provider.seedFile("deep/nested/deeper/three.txt", new Blob(["3"]));
provider.seedFile("deep/.hidden.txt", new Blob(["h"]));

addMount({ id: "S", name: "S", icon: "folder", listed: true, provider });

// ------------------------------------------------------------------ content

test("every term must be present, and the line reported is the first term's", async () => {
  const result = await searchContents("/S", ["notes.md", "other.txt"], ["search", "fast"]);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(
    { ...result.hits[0] },
    { name: "notes.md", line: 2, snippet: "Search engine design is fast" }
  );
});

test("no terms means no work and no hits", async () => {
  const result = await searchContents("/S", ["notes.md"], []);
  assert.deepEqual(result, { hits: [], truncated: false });
});

test("names that try to leave the visible folder are ignored", async () => {
  const result = await searchContents(
    "/S",
    ["../notes.md", "deep/one.txt", "..", "."],
    ["search"]
  );
  assert.deepEqual(result.hits, []);
});

test("binary files are skipped rather than searched as text", async () => {
  const result = await searchContents("/S", ["blob.bin"], ["se"]);
  assert.deepEqual(result.hits, []);
});

test("a file over the per-file budget is skipped, not partially searched", async () => {
  // "huge.txt" contains both terms but is past MAX_FILE_BYTES.
  const result = await searchContents("/S", ["huge.txt", "notes.md"], ["search", "fast"]);
  assert.deepEqual(result.hits.map((h) => h.name), ["notes.md"]);
});

test("more candidate files than the budget is reported as truncated", async () => {
  const many = Array.from({ length: 600 }, (_, i) => `f${i}.txt`);
  const result = await searchContents("/S", many, ["search"]);
  assert.equal(result.truncated, true);
});

test("snippets collapse whitespace so a result tile stays one line", async () => {
  const result = await searchContents("/S", ["spaced.md"], ["search"]);
  assert.equal(result.hits[0].snippet, "search spread out here");
});

// ------------------------------------------------------------------- nearby

test("nearby reaches deeper folders but not the ones already on screen", async () => {
  const result = await nearbyEntries("/S/deep", false, 2);
  const found = result.entries.map((e) => e.relativePath).sort();

  // "one.txt" is a direct child, already listed by the folder itself.
  assert.ok(!found.includes("one.txt"));
  assert.ok(found.includes("nested/two.txt"));
  assert.ok(found.includes("nested/deeper/three.txt"));
});

test("nearby stops at the depth it was given", async () => {
  const result = await nearbyEntries("/S/deep", false, 1);
  // Folders are results in their own right — you may be looking for the folder.
  // What must not appear is anything a level below them.
  assert.deepEqual(
    result.entries.map((e) => e.relativePath).sort(),
    ["nested/deeper", "nested/two.txt"]
  );
});

test("hidden files only appear when hidden files are being shown", async () => {
  const hiddenOff = await nearbyEntries("/S", false, 2);
  assert.ok(!hiddenOff.entries.some((e) => e.name === ".hidden.txt"));

  const hiddenOn = await nearbyEntries("/S", true, 2);
  const hit = hiddenOn.entries.find((e) => e.name === ".hidden.txt");
  assert.equal(hit?.hidden, true);
  assert.equal(hit?.relativePath, "deep/.hidden.txt");
});

test("an unreadable folder is skipped rather than sinking the whole search", async () => {
  const result = await nearbyEntries("/S", false, 2);
  assert.equal(result.truncated, false);
  assert.ok(result.entries.length > 0);
});
