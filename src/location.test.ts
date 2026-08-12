import assert from "node:assert/strict";
import test from "node:test";

import { locationCaps, refusal, transferNote } from "./location.ts";
import type { Volume } from "./types.ts";

/** A read-only disk image mounted at `/Volumes/ReadOnlyDisk`. */
const readOnlyDisk: Volume = {
  id: "disk8s1",
  name: "ReadOnlyDisk",
  path: "/Volumes/ReadOnlyDisk",
  kind: "diskImage",
  stage: "ready",
  readOnly: true,
  freeSpace: 20_262_912,
  totalCapacity: 20_930_560,
  ejectable: true,
};

const writableDrive: Volume = { ...readOnlyDisk, id: "disk6s1", name: "TestDrive", path: "/Volumes/TestDrive", kind: "removable", readOnly: false };

test("a real path can do everything", () => {
  const at = locationCaps("/Users/codi/Developer");
  assert.deepEqual(at, { paste: true, create: true, modify: true, copy: true, shell: true, where: null, readOnlyVolume: null });
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
  // Still nothing when there are volumes about, as long as none of them refuses
  // writes. A drive being plugged in is not news.
  assert.equal(transferNote("/Volumes/TestDrive/photos", [writableDrive]), null);
});

test("a read-only volume refuses every write and still gives things up", () => {
  const at = locationCaps("/Volumes/ReadOnlyDisk/notes.txt", [readOnlyDisk]);
  assert.equal(at.paste, false);
  assert.equal(at.create, false);
  assert.equal(at.modify, false);
  // Reading is the entire point of a read-only disk, and the shell is as happy
  // with the path as it ever was.
  assert.equal(at.copy, true);
  assert.equal(at.shell, true);
  assert.equal(at.readOnlyVolume, "ReadOnlyDisk");
});

test("a writable volume is an ordinary local path", () => {
  const at = locationCaps("/Volumes/TestDrive/photos", [writableDrive]);
  assert.equal(at.create, true);
  assert.equal(at.modify, true);
  assert.equal(at.readOnlyVolume, null);
});

test("nothing about a volume reaches paths that are not on it", () => {
  // The failure this guards against would make the whole machine read-only the
  // moment a locked card was inserted.
  const at = locationCaps("/Users/codi/Developer", [readOnlyDisk]);
  assert.equal(at.create, true);
  assert.equal(at.modify, true);
  assert.equal(at.readOnlyVolume, null);
});

test("a refusal says whether it is Fiddler's fault or the disk's", () => {
  const disk = locationCaps("/Volumes/ReadOnlyDisk", [readOnlyDisk]);
  const cable = locationCaps("mtp://RFCY71NMVTA/65537");

  // Not "yet": no version of Fiddler will ever write to a read-only disk, and
  // implying otherwise is a promise it cannot keep.
  assert.equal(refusal(disk, "rename items"), "ReadOnlyDisk is read-only — Fiddler can’t rename items there");
  assert.doesNotMatch(refusal(disk, "rename items"), /yet/);

  // The cable is the opposite: MTP has a rename and Fiddler hasn't called it.
  assert.match(refusal(cable, "rename items"), /a device on a cable yet$/);
});

test("a read-only volume gets the same warning ahead of time as a device does", () => {
  const note = transferNote("/Volumes/ReadOnlyDisk/photos", [readOnlyDisk])!;
  assert.match(note.title, /ReadOnlyDisk is read-only/);
  // Says whose refusal it is. "Fiddler can't" would be the wrong story, and the
  // person would go looking for a setting in the wrong app.
  assert.match(note.detail, /disk refusing rather than Fiddler/);
});
