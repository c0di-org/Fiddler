import assert from "node:assert/strict";
import test from "node:test";

import { defaultSession, MAX_ICON, MIN_ICON, parseSession, restorable } from "./session.ts";

test("nothing stored means the defaults", () => {
  assert.deepEqual(parseSession(null), defaultSession);
  assert.deepEqual(parseSession("garbage"), defaultSession);
  assert.deepEqual(parseSession({}), defaultSession);
});

test("a complete session comes back as it went in", () => {
  const saved = {
    view: "list",
    sortKey: "modified",
    sortAsc: false,
    iconSize: 168,
    showHidden: true,
    previewOpen: true,
    path: "/Users/codi/Developer",
  };
  assert.deepEqual(parseSession(saved), saved);
});

test("a value this version doesn't recognise falls back rather than sticking", () => {
  // The stored session comes from a previous Fiddler as often as this one, and a
  // sort key that no longer exists must not leave the list unsortable.
  const parsed = parseSession({ view: "columns", sortKey: "colour", sortAsc: "yes" });
  assert.equal(parsed.view, "icons");
  assert.equal(parsed.sortKey, "name");
  assert.equal(parsed.sortAsc, true);
});

test("the icon size is clamped to the zoom slider's range", () => {
  assert.equal(parseSession({ iconSize: 4000 }).iconSize, MAX_ICON);
  assert.equal(parseSession({ iconSize: 2 }).iconSize, MIN_ICON);
  assert.equal(parseSession({ iconSize: 96.4 }).iconSize, 96);
  assert.equal(parseSession({ iconSize: Number.NaN }).iconSize, defaultSession.iconSize);
  assert.equal(parseSession({ iconSize: "112" }).iconSize, defaultSession.iconSize);
});

test("a device folder is never the one reopened", () => {
  // The cable is unplugged and the other machine is asleep by then, so this
  // would mean starting inside a folder that can't be read.
  assert.equal(parseSession({ path: "mtp://RFCY71NMVTA/65537/DCIM" }).path, "");
  assert.equal(parseSession({ path: "fiddler://abc123/Documents" }).path, "");
  assert.equal(parseSession({ path: "/Users/codi" }).path, "/Users/codi");

  assert.equal(restorable("/Users/codi"), true);
  assert.equal(restorable(""), false);
  assert.equal(restorable("mtp://serial/1"), false);
});
