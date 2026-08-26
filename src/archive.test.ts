import assert from "node:assert/strict";
import test from "node:test";

import { isZip } from "./archive.ts";

test("only a zip is offered as something to unpack", () => {
  assert.equal(isZip("photos.zip"), true);
  // Off a Windows machine, and out of an old download folder.
  assert.equal(isZip("PHOTOS.ZIP"), true);
  assert.equal(isZip("holiday.tar.gz"), false);
  assert.equal(isZip("backup.7z"), false);
  // The extension is the whole of the claim: a folder called `zip`, or a file
  // whose name merely contains it, is not an archive.
  assert.equal(isZip("zip"), false);
  assert.equal(isZip("zipped-notes.md"), false);
});
