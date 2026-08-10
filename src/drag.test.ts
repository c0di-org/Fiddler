import assert from "node:assert/strict";
import test from "node:test";

import { dropPlan, parentOf, wantsMove } from "./drag.ts";

test("copy is the default and a modifier asks for a move", () => {
  const paths = ["/Users/codi/Developer/notes.md"];
  assert.equal(dropPlan(paths, "/Users/codi/Documents", false), "copy");
  assert.equal(dropPlan(paths, "/Users/codi/Documents", true), "move");
});

test("⌘ and ⌥ both ask for a move; nothing else does", () => {
  assert.equal(wantsMove({ metaKey: true, altKey: false }), true);
  assert.equal(wantsMove({ metaKey: false, altKey: true }), true);
  assert.equal(wantsMove({ metaKey: false, altKey: false }), false);
});

test("a folder cannot be dropped into itself or anywhere below it", () => {
  const project = ["/Users/codi/Developer/project"];
  assert.equal(dropPlan(project, "/Users/codi/Developer/project", false), null);
  assert.equal(dropPlan(project, "/Users/codi/Developer/project/src", false), null);
  // A sibling that merely starts with the same characters is a real target.
  assert.equal(dropPlan(project, "/Users/codi/Developer/project-notes", false), "copy");
});

test("the folder an item already sits in refuses the drop", () => {
  const paths = ["/Users/codi/Developer/notes.md"];
  assert.equal(dropPlan(paths, "/Users/codi/Developer", false), null);
  assert.equal(dropPlan(paths, "/Users/codi", false), "copy");
});

test("a connected device takes a copy however the drop was asked for", () => {
  // `copy_paths` learned an MTP destination; nothing can be made there under a
  // name of our choosing, so a move would leave the original behind anyway.
  const paths = ["/Users/codi/Developer/clip.mp4"];
  assert.equal(dropPlan(paths, "mtp://RFCY71NMVTA/65537/DCIM", true), "copy");
});

test("items that cannot be read off their device refuse the drop entirely", () => {
  assert.equal(dropPlan(["mtp://RFCY71NMVTA/65537/DCIM/a.jpg"], "/Users/codi", false), null);
  // A nearby device can be read from but not written to.
  assert.equal(dropPlan(["fiddler://abc123/Documents/a.md"], "/Users/codi", true), "copy");
  assert.equal(dropPlan(["/Users/codi/a.md"], "fiddler://abc123/Documents", false), null);
});

test("a drop with nothing in it, or nowhere to land, is not a drop", () => {
  assert.equal(dropPlan([], "/Users/codi", false), null);
  assert.equal(dropPlan(["/Users/codi/a.md"], "", false), null);
});

test("parentOf stops at the root of each address space", () => {
  assert.equal(parentOf("/Users/codi/notes.md"), "/Users/codi");
  assert.equal(parentOf("mtp://serial/65537/DCIM"), "mtp://serial/65537");
  assert.equal(parentOf("mtp://serial"), "");
  assert.equal(parentOf("fiddler://abc123/"), "");
  assert.equal(parentOf("Demo"), "");
});
