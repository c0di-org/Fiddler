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
  listDir,
  parentOf,
  rename,
  resolve,
  segments,
  surveyCopy,
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

test("a device address keeps its scheme through a split and a rejoin", () => {
  // The whole point: `mtp://SERIAL` is one segment, so a child path stays an
  // address the rest of the app recognises rather than becoming `/mtp:/SERIAL`.
  assert.deepEqual(segments("mtp://RFCY71NMVTA/65537/DCIM"), ["mtp://RFCY71NMVTA", "65537", "DCIM"]);
  assert.equal(joinSegments(["mtp://RFCY71NMVTA", "65537", "DCIM"]), "mtp://RFCY71NMVTA/65537/DCIM");
  assert.equal(childPath("mtp://RFCY71NMVTA/65537", "DCIM"), "mtp://RFCY71NMVTA/65537/DCIM");
  assert.equal(parentOf("mtp://RFCY71NMVTA/65537/DCIM"), "mtp://RFCY71NMVTA/65537");
  assert.equal(basename("mtp://RFCY71NMVTA/65537/DCIM"), "DCIM");
  // A trailing slash is how the sidebar addresses a device root, and it must
  // not produce an empty last segment.
  assert.deepEqual(segments("mtp://RFCY71NMVTA/"), ["mtp://RFCY71NMVTA"]);
  assert.equal(parentOf("mtp://RFCY71NMVTA"), "");

  assert.deepEqual(segments("fiddler://abc123/Documents"), ["fiddler://abc123", "Documents"]);
  assert.equal(joinSegments(["fiddler://abc123", "Documents"]), "fiddler://abc123/Documents");

  // A local file whose *name* mentions a scheme is still a local file — the
  // pattern is anchored, so it can only match at the front of an address.
  assert.deepEqual(segments("/Demo/notes on mtp://.txt"), ["Demo", "notes on mtp:", ".txt"]);
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
  assert.deepEqual(created, { paths: ["/To/landing/project"], cancelled: false });
  assert.equal(
    await new Response(await to.read(["landing", "project", "src", "main.rs"])).text(),
    "fn main() {}"
  );
});

test("a cancelled copy takes back what it had already written", async () => {
  const from = new MemoryProvider();
  from.seedFile("project/src/main.rs", new Blob(["fn main() {}"]));
  from.seedFile("project/README.md", new Blob(["# hi"]));
  addMount({ id: "Src", name: "Src", icon: "folder", listed: true, provider: from });

  const to = new MemoryProvider();
  to.seedDir("landing");
  addMount({ id: "Dst", name: "Dst", icon: "folder", listed: true, provider: to });

  // Cancel the moment anything has landed, which is what pressing the button
  // part-way through a real copy amounts to.
  let cancelled = false;
  const outcome = await copyInto(["/Src/project"], "/Dst/landing", {
    cancelled: () => cancelled,
    report: () => {
      cancelled = true;
    },
  });

  assert.deepEqual(outcome, { paths: [], cancelled: true });
  assert.deepEqual(await listDir("/Dst/landing"), []);
});

test("a survey counts every item and every byte before any of it moves", async () => {
  const provider = new MemoryProvider();
  provider.seedFile("tree/a.txt", new Blob(["aaaa"]));
  provider.seedFile("tree/inner/b.txt", new Blob(["bb"]));
  addMount({ id: "Count", name: "Count", icon: "folder", listed: true, provider });

  // The folder, a.txt, inner, inner/b.txt.
  assert.deepEqual(await surveyCopy(["/Count/tree"]), { items: 4, bytes: 6 });
});

test("a read-only mount refuses writes rather than failing halfway", async () => {
  const provider = new MemoryProvider(true);
  provider.seedFile("locked.txt", new Blob(["x"]));
  addMount({ id: "Locked", name: "Locked", icon: "folder", listed: true, provider });

  await assert.rejects(() => rename("/Locked/locked.txt", "other.txt"), /read-only/);
});
