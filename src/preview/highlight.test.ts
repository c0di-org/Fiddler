import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { State, grammarFor, grammarNamed, scan, tokenize } from "./highlight.ts";

/** Run with `npm test`. See the note in `markdown.test.ts`. */

const ts = grammarFor("x.ts");
const kindOf = (line: string, state: State = State.Normal, g = ts) =>
  tokenize(line, state, g).map((t) => t.k);

test("grammars are found by extension, by filename, and by fence label", () => {
  assert.ok(grammarFor("src/main.rs"));
  assert.ok(grammarFor("Makefile"));
  assert.ok(grammarFor("/a/b/.gitignore"));
  assert.ok(grammarNamed("rust"));
  assert.ok(grammarNamed("ts"));
  assert.equal(grammarFor("notes.txt"), null, "prose gets no grammar");
  assert.equal(grammarFor("mystery"), null);
  assert.equal(grammarNamed(""), null);
});

test("block comment state carries across lines of a real source file", () => {
  const src = readFileSync(new URL("./markdown.ts", import.meta.url), "utf8").split("\n");
  const states = scan(src, ts);
  assert.equal(states.length, src.length, "one state per line");
  assert.equal(states[1], State.Block, "the file opens with a block comment");

  const firstCode = src.findIndex((l) => l.startsWith("export type Inline"));
  assert.ok(firstCode > 0);
  assert.equal(states[firstCode], State.Normal, "and the state clears when it closes");
});

test("a line inside a block comment is comment all the way to the close", () => {
  assert.deepEqual(kindOf("still inside", State.Block), ["cmt"]);
  const closing = tokenize("*/ after();", State.Block, ts);
  assert.equal(closing[0].k, "cmt");
  assert.ok(closing.some((t) => t.k !== "cmt"), "the code after the close is not comment");
});

test("keywords, types and numbers", () => {
  const tokens = tokenize("export const n: number = 0x1f;", State.Normal, ts);
  assert.ok(tokens.some((t) => t.k === "kw" && t.v === "export"));
  assert.ok(tokens.some((t) => t.k === "typ" && t.v === "number"));
  assert.ok(tokens.some((t) => t.k === "num" && t.v === "0x1f"));
});

test("a comment marker inside a string is part of the string", () => {
  const tokens = tokenize('const s = "hi // not a comment";', State.Normal, ts);
  assert.ok(tokens.some((t) => t.k === "str" && t.v === '"hi // not a comment"'));
  assert.ok(!tokens.some((t) => t.k === "cmt"));
});

test("an unterminated string ends at the end of its line", () => {
  const tokens = tokenize('const s = "never closed', State.Normal, ts);
  assert.equal(tokens.at(-1)?.k, "str");
});

test("config formats tell keys apart from values", () => {
  const json = tokenize('  "name": "fiddler",', State.Normal, grammarFor("package.json"));
  assert.ok(json.some((t) => t.k === "key" && t.v === '"name"'));
  assert.ok(json.some((t) => t.k === "str" && t.v === '"fiddler"'));

  const yaml = tokenize("version: 2", State.Normal, grammarFor("a.yml"));
  assert.equal(yaml[0].k, "key");
  const nested = tokenize("  indented: 2", State.Normal, grammarFor("a.yml"));
  assert.ok(nested.some((t) => t.k === "key" && t.v === "indented"), "nested mappings are keys too");
  const mid = tokenize("key: word here", State.Normal, grammarFor("a.yml"));
  assert.equal(mid.filter((t) => t.k === "key").length, 1, "only the head of a line is a key");
});

test("without a grammar the line comes back whole", () => {
  assert.deepEqual(tokenize("anything at all", State.Normal, null), [
    { k: "txt", v: "anything at all" },
  ]);
  assert.deepEqual(tokenize("", State.Normal, null), []);
});

test("tokens always reconstruct the line exactly", () => {
  const lines = [
    "fn main() { /* x */ println!(\"hi\"); } // done",
    "  const re = /a\\/b/g; // slash inside a regex",
    "\tif (a && b) return c ?? d;",
    "",
    "   ",
    "élan = 'ünïcode' // ok",
  ];
  for (const line of lines) {
    for (const state of [State.Normal, State.Block] as const) {
      const joined = tokenize(line, state, ts)
        .map((t) => t.v)
        .join("");
      assert.equal(joined, line, `lossless for ${JSON.stringify(line)} in state ${state}`);
    }
  }
});

test("the whole-file pass stays linear", () => {
  // The scan is the only thing that touches every line, so a regression to
  // anything worse than linear here is what would make a huge file hurt.
  const lines = new Array(200_000).fill("const a = 1; /* x */");
  const started = performance.now();
  const states = scan(lines, ts);
  const elapsed = performance.now() - started;

  assert.equal(states.length, lines.length);
  // Measured at roughly 10ms; the bound is loose enough to survive a slow
  // machine and tight enough to catch an accidental quadratic.
  assert.ok(elapsed < 1000, `scan took ${elapsed.toFixed(0)}ms`);
});
