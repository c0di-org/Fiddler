import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProvider } from "./memory-fs.ts";
import { countLines, decodeUtf8, inspect, looksBinary, readText } from "./text.ts";
import { addMount } from "./vfs.ts";

const provider = new MemoryProvider();
provider.seedFile("hello.txt", new Blob(["one\ntwo\nthree\n"]));
provider.seedFile("long.txt", new Blob(["x".repeat(5000)]));
provider.seedFile("binary.bin", new Blob([new Uint8Array([1, 2, 0, 3, 4])]));
provider.seedFile("accented.txt", new Blob(["café ☕ déjà vu"]));
provider.seedDir("folder");
provider.seedFile("folder/a.txt", new Blob(["a"]));
provider.seedFile("folder/.DS_Store", new Blob(["junk"]));
addMount({ id: "T", name: "T", icon: "folder", listed: true, provider });

test("line counting matches Rust's lines(): a trailing newline opens nothing", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one"), 1);
  assert.equal(countLines("one\n"), 1);
  assert.equal(countLines("one\ntwo"), 2);
  assert.equal(countLines("one\ntwo\n"), 2);
  assert.equal(countLines("\n\n"), 2);
});

test("a NUL byte in the head is what makes a file binary", () => {
  assert.equal(looksBinary(new Uint8Array([104, 105])), false);
  assert.equal(looksBinary(new Uint8Array([104, 0, 105])), true);
});

test("a character split by the read boundary is dropped, not mangled", () => {
  const whole = new TextEncoder().encode("café");
  // "é" is two bytes; cutting between them must not produce a replacement char.
  const cut = whole.slice(0, whole.length - 1);
  assert.equal(decodeUtf8(cut), "caf");
  assert.equal(decodeUtf8(whole), "café");
});

test("readText reports the whole file's size even when it only read the front", async () => {
  const head = await readText("/T/long.txt", 1024);
  assert.equal(head.truncated, true);
  assert.equal(head.bytes, 5000);
  assert.equal(head.text.length, 1024);
  assert.equal(head.binary, false);
});

test("readText leaves a short file untruncated", async () => {
  const head = await readText("/T/hello.txt", 1024);
  assert.equal(head.truncated, false);
  assert.equal(head.bytes, 14);
  assert.equal(head.lines, 3);
  assert.equal(head.text, "one\ntwo\nthree\n");
});

test("a tiny maxBytes is still floored, so a preview is never a single byte", async () => {
  const head = await readText("/T/long.txt", 1);
  assert.equal(head.text.length, 1024);
});

test("binary files come back flagged and empty rather than as mojibake", async () => {
  const head = await readText("/T/binary.bin", 1024);
  assert.deepEqual(
    { text: head.text, binary: head.binary, lines: head.lines, bytes: head.bytes },
    { text: "", binary: true, lines: 0, bytes: 5 }
  );
});

test("readText refuses a folder the way the Rust command does", async () => {
  await assert.rejects(() => readText("/T/folder", 1024), /that is a folder/);
});

test("inspect counts children but not .DS_Store", async () => {
  const info = await inspect("/T/folder");
  assert.equal(info.childCount, 1);
  assert.equal(info.text, null);
  assert.equal(info.binary, false);
});

test("inspect peeks at text and stays quiet about binaries", async () => {
  const text = await inspect("/T/accented.txt");
  assert.equal(text.text, "café ☕ déjà vu");
  assert.equal(text.childCount, null);

  const binary = await inspect("/T/binary.bin");
  assert.equal(binary.binary, true);
  assert.equal(binary.text, null);
});
