import assert from "node:assert/strict";
import test from "node:test";

import type { Volume } from "./types.ts";
import { ejectNotice, volumeFor, volumeNotice } from "./volumes.ts";

/** A drive as the backend reports it. */
function volume(over: Partial<Volume> = {}): Volume {
  return {
    id: "disk6s1",
    name: "TestDrive",
    path: "/Volumes/TestDrive",
    kind: "removable",
    stage: "ready",
    readOnly: false,
    freeSpace: 50_000_000,
    totalCapacity: 100_000_000,
    ejectable: true,
    ...over,
  } as Volume;
}

test("a path on the startup disk is on no volume", () => {
  const volumes = [volume()];
  assert.equal(volumeFor("/Users/codi/Developer", volumes), null);
  assert.equal(volumeFor("/", volumes), null);
  // The trap this whole design is arranged around: `/` is genuinely a
  // read-only mount, and if the startup disk were ever in this list, every
  // path on the machine would inherit its rules.
  assert.equal(volumeFor("/Users/codi/notes.txt", []), null);
});

test("a path on a volume finds it, at the mount point and below", () => {
  const volumes = [volume()];
  assert.equal(volumeFor("/Volumes/TestDrive", volumes)?.name, "TestDrive");
  assert.equal(volumeFor("/Volumes/TestDrive/", volumes)?.name, "TestDrive");
  assert.equal(volumeFor("/Volumes/TestDrive/photos/raw", volumes)?.name, "TestDrive");
});

test("a name that merely starts the same is a different disk", () => {
  // Plugging in a second drive gets you `Archive 1` next to `Archive`, so this
  // is the ordinary case rather than a contrived one — and getting it wrong
  // would apply one disk's read-only flag to the other.
  const volumes = [
    volume({ id: "a", name: "Archive", path: "/Volumes/Archive", readOnly: true }),
    volume({ id: "b", name: "Archive 1", path: "/Volumes/Archive 1" }),
  ];
  assert.equal(volumeFor("/Volumes/Archive 1/notes.txt", volumes)?.name, "Archive 1");
  assert.equal(volumeFor("/Volumes/Archives", volumes), null);
});

test("the innermost mount wins when volumes nest", () => {
  const volumes = [
    volume({ id: "outer", name: "Outer", path: "/Volumes/Outer" }),
    volume({ id: "inner", name: "Inner", path: "/Volumes/Outer/mnt/Inner", readOnly: true }),
  ];
  const found = volumeFor("/Volumes/Outer/mnt/Inner/file.txt", volumes);
  assert.equal(found?.name, "Inner");
  assert.equal(found?.readOnly, true);
});

test("a readable volume has nothing to explain", () => {
  assert.equal(volumeNotice(volume({ stage: "ready" })), null);
});

test("a volume that is mounted but unreadable says which permission is missing", () => {
  const notice = volumeNotice(volume({ stage: "locked" }))!;
  assert.match(notice.title, /TestDrive/);
  // The disk is there and the fix is a setting — so this resolves on its own,
  // exactly like a phone waiting to be unlocked.
  assert.equal(notice.resolves, true);
  assert.ok(notice.detail.length > 0);
});

test("a volume that failed for another reason repeats the reason rather than guessing", () => {
  const notice = volumeNotice(
    volume({ stage: "unreadable", message: "Input/output error (os error 5)" } as Partial<Volume>)
  )!;
  assert.match(notice.detail, /Input\/output error/);
  assert.equal(notice.resolves, false);
});

test("a successful eject has nothing to say", () => {
  assert.equal(ejectNotice(volume(), { outcome: "ejected" }), null);
});

test("a refused eject names who is holding it and says the disk is untouched", () => {
  const notice = ejectNotice(volume(), {
    outcome: "busy",
    holders: [{ name: "Preview", pid: 501 }],
  })!;
  assert.match(notice.title, /Preview is still using TestDrive/);
  // The part people actually need: nothing has happened to the disk.
  assert.match(notice.detail, /still mounted/);
});

test("several holders are listed as a person would say them", () => {
  const notice = ejectNotice(volume(), {
    outcome: "busy",
    holders: [
      { name: "Preview", pid: 1 },
      { name: "zsh", pid: 2 },
      // The same command twice is one thing to close, not two.
      { name: "zsh", pid: 3 },
    ],
  })!;
  assert.match(notice.title, /Preview and zsh are still using/);
});

test("a refusal nobody could be named for still says what happened", () => {
  const notice = ejectNotice(volume(), { outcome: "busy", holders: [] })!;
  assert.match(notice.title, /Something is still using TestDrive/);
  assert.match(notice.detail, /still mounted/);
  // Never claims to know who. The refusal comes from the kernel and naming the
  // cause is a separate question that can genuinely go unanswered.
  assert.doesNotMatch(notice.detail, /undefined/);
});
