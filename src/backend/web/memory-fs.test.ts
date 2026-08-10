import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "./memory-fs.ts";

const seeded = () => {
  const fs = new MemoryProvider();
  fs.seedFile("notes.md", new Blob(["# hello"]), 1_700_000_000);
  fs.seedFile("src/main.rs", new Blob(["fn main() {}"]), 1_700_000_100);
  fs.seedFile("src/lib.rs", new Blob(["pub fn go() {}"]), 1_700_000_200);
  return fs;
};

test("seeding a nested file creates the folders above it", async () => {
  const fs = seeded();
  const root = await fs.list([]);
  assert.deepEqual(
    root.map((n) => `${n.name}:${n.kind}`).sort(),
    ["notes.md:file", "src:dir"]
  );

  const src = await fs.list(["src"]);
  assert.deepEqual(src.map((n) => n.name).sort(), ["lib.rs", "main.rs"]);
});

test("sizes and times come from the seeded file, not from the clock", async () => {
  const fs = seeded();
  const listing = await fs.list([]);

  const notes = listing.find((n) => n.name === "notes.md")!;
  assert.equal(notes.size, 7);
  assert.equal(notes.mtime, 1_700_000_000);

  // Directories carry no size, whatever they contain.
  assert.equal(listing.find((n) => n.name === "src")!.size, 0);
});

test("reading rejects for folders and for what isn't there", async () => {
  const fs = seeded();
  assert.equal(await new Response(await fs.read(["notes.md"])).text(), "# hello");
  await assert.rejects(() => fs.read(["src"]), /Not a file/);
  await assert.rejects(() => fs.read(["nope.md"]), /No such file/);
});

test("writing replaces the contents and keeps the file's own creation time", async () => {
  const fs = seeded();
  const before = (await fs.stat(["notes.md"]))!;
  await fs.write(["notes.md"], new Blob(["# hello again"]));
  const after = (await fs.stat(["notes.md"]))!;

  assert.equal(after.size, 13);
  assert.equal(await new Response(await fs.read(["notes.md"])).text(), "# hello again");
  // Saving a file does not make it a newer file.
  assert.equal(after.added, before.added);
  assert.ok(after.mtime >= before.mtime);
});

test("a second New Folder of the same name is refused rather than silently merged", async () => {
  const fs = seeded();
  await fs.mkdir(["docs"]);
  await assert.rejects(() => fs.mkdir(["docs"]), /already exists/);
  await assert.rejects(() => fs.write(["src"], new Blob(["x"])), /is a folder/);
});

test("rename holds an item's position rather than moving it to the end", async () => {
  const fs = new MemoryProvider();
  fs.seedFile("a.txt", new Blob(["a"]));
  fs.seedFile("b.txt", new Blob(["b"]));
  fs.seedFile("c.txt", new Blob(["c"]));

  await fs.rename(["b.txt"], "bb.txt");
  assert.deepEqual((await fs.list([])).map((n) => n.name), ["a.txt", "bb.txt", "c.txt"]);
});

test("rename refuses to overwrite a sibling, but renaming to itself is allowed", async () => {
  const fs = seeded();
  fs.seedFile("other.md", new Blob(["x"]));
  await assert.rejects(() => fs.rename(["notes.md"], "other.md"), /already exists/);
  await fs.rename(["notes.md"], "notes.md");
  assert.ok(await fs.stat(["notes.md"]));
});

test("removing a folder takes its contents with it", async () => {
  const fs = seeded();
  await fs.remove(["src"]);
  assert.equal(await fs.stat(["src"]), null);
  assert.equal(await fs.stat(["src", "main.rs"]), null);
  await assert.rejects(() => fs.remove(["src"]), /No such item/);
});
