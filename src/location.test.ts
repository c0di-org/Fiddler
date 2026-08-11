import assert from "node:assert/strict";
import test from "node:test";

import { locationCaps, transferNote } from "./location.ts";

test("a real path can do everything", () => {
  const at = locationCaps("/Users/codi/Developer");
  assert.deepEqual(at, { paste: true, create: true, modify: true, copy: true, shell: true, where: null });
  // A file whose name happens to mention a scheme is still a file.
  assert.equal(locationCaps("/Users/codi/notes on mtp://.txt").create, true);
});

test("a device takes a paste and nothing else", () => {
  for (const path of ["mtp://RFCY71NMVTA/", "mtp://RFCY71NMVTA/65537/DCIM/Camera"]) {
    const at = locationCaps(path);
    // `copy_paths` learned an MTP destination; the rest of the write commands
    // are still `std::fs`.
    assert.equal(at.paste, true, path);
    assert.equal(at.create, false, path);
    assert.equal(at.modify, false, path);
    assert.equal(at.copy, false, path);
    assert.equal(at.shell, false, path);
    assert.equal(at.where, "a device on a cable");
  }
});

test("a nearby Fiddler can be copied from but not written to", () => {
  const at = locationCaps("fiddler://abc123/Documents");
  assert.equal(at.copy, true);
  assert.equal(at.paste, false);
  assert.equal(at.create, false);
  assert.equal(at.modify, false);
  assert.equal(at.shell, false);
  assert.equal(at.where, "a device over Wi-Fi");
});

test("the transfer note points the opposite way in each device space", () => {
  const cable = transferNote("mtp://RFCY71NMVTA/65537/DCIM");
  const wifi = transferNote("fiddler://abc123/Documents");
  assert.ok(cable && wifi);
  // The whole point of the note: the two spaces are inverses, and saying so is
  // only useful if the wording actually differs between them.
  assert.notEqual(cable.title, wifi.title);
  assert.match(cable.title, /onto this device, not off/);
  assert.match(wifi.title, /off this device, not onto/);
});

test("a local folder has no transfer note to make", () => {
  // Nothing to warn about, so nothing is drawn — the banner must not become
  // furniture that appears above every listing.
  assert.equal(transferNote("/Users/codi/Developer"), null);
  assert.equal(transferNote(""), null);
});
