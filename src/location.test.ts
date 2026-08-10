import assert from "node:assert/strict";
import test from "node:test";

import { locationCaps } from "./location.ts";

test("a real path can do everything", () => {
  const at = locationCaps("/Users/codi/Developer");
  assert.deepEqual(at, { write: true, copy: true, shell: true, where: null });
  // A file whose name happens to mention a scheme is still a file.
  assert.equal(locationCaps("/Users/codi/notes on mtp://.txt").write, true);
});

test("a device is readable and nothing more", () => {
  for (const path of ["mtp://RFCY71NMVTA/", "mtp://RFCY71NMVTA/65537/DCIM/Camera"]) {
    const at = locationCaps(path);
    assert.equal(at.write, false, path);
    assert.equal(at.copy, false, path);
    assert.equal(at.shell, false, path);
    assert.equal(at.where, "a connected device");
  }
});

test("a nearby Fiddler can be copied from but not written to", () => {
  const at = locationCaps("fiddler://abc123/Documents");
  assert.equal(at.copy, true);
  assert.equal(at.write, false);
  assert.equal(at.shell, false);
  assert.equal(at.where, "a nearby device");
});
