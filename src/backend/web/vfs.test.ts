import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "./memory-fs.ts";
import {
  addMount,
  basename,
  childPath,
  copyInto,
  freshPath,
  joinSegments,
  parentOf,
  rename,
  resolve,
  segments,
  uniqueMountId,
  validName,
} from "./vfs.ts";

test("paths split and rejoin without gaining or losing separators", () => {
  assert.deepEqual(segments("/Demo/Projects/a.md"), ["Demo", "Projects", "a.md"]);
  assert.deepEqual(segments("//Demo//a.md//"), ["Demo", "a.md"]);
  assert.equal(joinSegments(["Demo", "a.md"]), "/Demo/a.md");
  assert.equal(basename("/Demo/Projects/a.md"), "a.md");
  assert.equal(parentOf("/Demo/Projects/a.md"), "/Demo/Projects");
  assert.equal(childPath("/Demo", "a.md"), "/Demo/a.md");
  // A mount root's parent is the empty root, not itself.
  assert.equal(parentOf("/Demo"), "");
});

test("names that could escape their folder are refused", () => {
  assert.equal(validName("  notes.md  "), "notes.md");
  assert.throws(() => validName(""), /can’t be empty/);
  assert.throws(() => validName("   "), /can’t be empty/);
  assert.throws(() => validName(".."), /isn’t a usable name/);
  assert.throws(() => validName("."), /isn’t a usable name/);
  assert.throws(() => validName("a/b"), /can’t contain/);
  assert.throws(() => validName("../../etc/passwd"), /can’t contain/);
});

test("an unknown first segment is an error, not an empty folder", () => {
  assert.throws(() => resolve("/Nowhere/a.md"), /No such location/);
  assert.throws(() => resolve(""), /No such location/);
});

test("mount ids are made unique so two folders called src stay apart", () => {
  addMount({ id: "src", name: "src", icon: "folder", listed: true, provider: new MemoryProvider() });
  assert.equal(uniqueMountId("src"), "src 2");
  addMount({ id: "src 2", name: "src 2", icon: "folder", listed: true, provider: new MemoryProvider() });
  assert.equal(uniqueMountId("src"), "src 3");
  assert.equal(uniqueMountId("untouched"), "untouched");
});

test("a paste beside an identical name becomes a copy rather than an overwrite", async () => {
  const provider = new MemoryProvider();
  provider.seedFile("notes.md", new Blob(["one"]));
  provider.seedFile("notes copy.md", new Blob(["two"]));
  provider.seedFile("plain", new Blob(["three"]));
  addMount({ id: "Fresh", name: "Fresh", icon: "folder", listed: true, provider });

  assert.equal(await freshPath("/Fresh", "other.md"), "/Fresh/other.md");
  // The extension is preserved, so "notes copy.md" stays a markdown file.
  assert.equal(await freshPath("/Fresh", "notes.md"), "/Fresh/notes copy 2.md");
  assert.equal(await freshPath("/Fresh", "plain"), "/Fresh/plain copy");
});

test("copy carries a folder's whole subtree across mounts", async () => {
  const from = new MemoryProvider();
  from.seedFile("project/src/main.rs", new Blob(["fn main() {}"]));
  from.seedFile("project/README.md", new Blob(["# hi"]));
  addMount({ id: "From", name: "From", icon: "folder", listed: true, provider: from });

  const to = new MemoryProvider();
  to.seedDir("landing");
  addMount({ id: "To", name: "To", icon: "folder", listed: true, provider: to });

  const created = await copyInto(["/From/project"], "/To/landing");
  assert.deepEqual(created, ["/To/landing/project"]);
  assert.equal(
    await new Response(await to.read(["landing", "project", "src", "main.rs"])).text(),
    "fn main() {}"
  );
});

test("a read-only mount refuses writes rather than failing halfway", async () => {
  const provider = new MemoryProvider(true);
  provider.seedFile("locked.txt", new Blob(["x"]));
  addMount({ id: "Locked", name: "Locked", icon: "folder", listed: true, provider });

  await assert.rejects(() => rename("/Locked/locked.txt", "other.txt"), /read-only/);
});
