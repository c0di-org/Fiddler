import assert from "node:assert/strict";
import test from "node:test";

import { bookTitle, coverIn, folderOf, isAudio, tracksIn, trackTitle } from "./book.ts";
import type { Entry } from "../types.ts";

function file(name: string, kind: Entry["kind"] = "file"): Entry {
  return {
    name,
    path: `/b/${name}`,
    kind,
    linkToDir: false,
    size: 1,
    mtime: 0,
    added: 0,
    hidden: false,
    thumbable: false,
    isRepo: false,
    worktreeCount: 0,
    branch: null,
    code: null,
    rollup: null,
  };
}

test("audio is recognised by the same table the preview uses", () => {
  assert.equal(isAudio("ch1.mp3"), true);
  assert.equal(isAudio("ch1.m4a"), true);
  assert.equal(isAudio("ch1.opus"), true);
  assert.equal(isAudio("cover.jpg"), false);
  assert.equal(isAudio("notes.txt"), false);
});

test("chapter ten comes after chapter nine", () => {
  const entries = [file("Chapter 10.mp3"), file("Chapter 2.mp3"), file("Chapter 1.mp3")];
  assert.deepEqual(
    tracksIn(entries, "/b").map((t) => t.name),
    ["Chapter 1.mp3", "Chapter 2.mp3", "Chapter 10.mp3"]
  );
});

test("the listing's own order is ignored, whatever the view was sorted by", () => {
  const entries = [file("03.mp3"), file("01.mp3"), file("02.mp3")];
  assert.deepEqual(
    tracksIn(entries, "/b").map((t) => t.name),
    ["01.mp3", "02.mp3", "03.mp3"]
  );
});

test("folders and non-audio files are not chapters", () => {
  const entries = [file("Extras", "dir"), file("cover.jpg"), file("01.mp3"), file("notes.txt")];
  assert.deepEqual(
    tracksIn(entries, "/b").map((t) => t.name),
    ["01.mp3"]
  );
});

test("a symlink to a folder is a folder", () => {
  const link = { ...file("Disc 2.mp3", "symlink"), linkToDir: true };
  assert.deepEqual(tracksIn([link], "/b"), []);
});

test("a named cover wins over any other picture", () => {
  const entries = [file("scan-of-the-back.png"), file("cover.jpg")];
  assert.equal(coverIn(entries), "/b/cover.jpg");
});

test("the conventional names are tried in order", () => {
  assert.equal(coverIn([file("folder.png"), file("cover.png")]), "/b/cover.png");
  assert.equal(coverIn([file("Folder.JPG")]), "/b/Folder.JPG");
});

test("one lone picture is the cover; several are a guess not worth making", () => {
  assert.equal(coverIn([file("some-photo.jpg")]), "/b/some-photo.jpg");
  assert.equal(coverIn([file("a.jpg"), file("b.jpg")]), null);
  assert.equal(coverIn([file("01.mp3")]), null);
});

test("a chapter is called what the file is called, without the extension", () => {
  assert.equal(trackTitle("01 - The Wind.mp3"), "01 - The Wind");
  assert.equal(trackTitle("noextension"), "noextension");
  assert.equal(trackTitle(".hidden"), ".hidden");
});

test("the book is named after its folder", () => {
  assert.equal(bookTitle("/Books/The Wind in the Willows"), "The Wind in the Willows");
  assert.equal(bookTitle("/Books/The Wind/"), "The Wind");
  assert.equal(bookTitle("/"), "");
});

test("the folder of a path is everything before the last slash", () => {
  assert.equal(folderOf("/Books/A/01.mp3"), "/Books/A");
  assert.equal(folderOf("/01.mp3"), "/");
  assert.equal(folderOf("01.mp3"), "");
});
