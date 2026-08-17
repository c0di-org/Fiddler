import assert from "node:assert/strict";
import test from "node:test";

import { categoryOf, fileVisualKind } from "./glyph-category.ts";

test("visual kinds share the preview router's knowledge", () => {
  assert.equal(fileVisualKind("Makefile"), "code");
  assert.equal(fileVisualKind("photo.avif"), "image");
  assert.equal(fileVisualKind("song.opus"), "audio");
  assert.equal(fileVisualKind("movie.m4v"), "video");
  assert.equal(fileVisualKind("README"), "document");
});

test("config, data, archives, links and PDFs keep distinct silhouettes", () => {
  assert.equal(fileVisualKind("settings.plist"), "config");
  assert.equal(fileVisualKind("package.json"), "config");
  assert.equal(fileVisualKind("results.csv"), "data");
  assert.equal(fileVisualKind("source.tar.gz"), "archive");
  assert.equal(fileVisualKind("manual.pdf"), "pdf");
  assert.equal(fileVisualKind("docs.webloc"), "link");
});

test("colour families remain stable while silhouettes get richer", () => {
  assert.equal(categoryOf("main.ts"), "code");
  assert.equal(categoryOf("settings.yaml"), "config");
  assert.equal(categoryOf("clip.mp4"), "media");
  assert.equal(categoryOf("manual.pdf"), "doc");
  assert.equal(categoryOf("bundle.zip"), "archive");
  assert.equal(categoryOf("mystery.xyzzy"), "plain");
});
