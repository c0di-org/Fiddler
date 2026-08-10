import assert from "node:assert/strict";
import test from "node:test";

import { forgetAll, invert, pending, remember, take, undoStore, UNDO_LIMIT } from "./undo.ts";

test("undoing a rename puts the old name back on the item's new path", () => {
  const steps = invert({
    label: "Rename",
    action: { kind: "rename", from: "/Users/codi/notes.md", to: "/Users/codi/Field Notes.md" },
  });
  assert.deepEqual(steps, [{ do: "rename", path: "/Users/codi/Field Notes.md", name: "notes.md" }]);
});

test("undoing a paste trashes what it made rather than deleting it", () => {
  const steps = invert({ label: "Paste", action: { kind: "create", paths: ["/a/one.md", "/a/two.md"] } });
  assert.deepEqual(steps, [{ do: "trash", paths: ["/a/one.md", "/a/two.md"] }]);
});

test("undoing a move sends every item back to its own folder", () => {
  // One drag can gather items from several folders, because a search listing
  // spans the tree. Each has to go home, not to wherever the first came from.
  const steps = invert({
    label: "Move",
    action: {
      kind: "move",
      moves: [
        { from: "/a/one.md", to: "/dest/one.md" },
        { from: "/b/two.md", to: "/dest/two.md" },
        { from: "/a/three.md", to: "/dest/three.md" },
      ],
    },
  });
  assert.deepEqual(steps, [
    { do: "move", paths: ["/dest/one.md", "/dest/three.md"], into: "/a" },
    { do: "move", paths: ["/dest/two.md"], into: "/b" },
  ]);
});

test("undoing a delete restores exactly what the Trash reported", () => {
  const items = [{ trashed: "/Users/codi/.Trash/one.md", original: "/a/one.md" }];
  assert.deepEqual(invert({ label: "Move to Trash", action: { kind: "trash", items } }), [
    { do: "restore", items },
  ]);
});

test("an operation that touched nothing has nothing to undo", () => {
  assert.deepEqual(invert({ label: "Paste", action: { kind: "create", paths: [] } }), []);
  assert.deepEqual(invert({ label: "Move to Trash", action: { kind: "trash", items: [] } }), []);
});

test("the stack is last-in first-out and forgets its oldest entries", () => {
  forgetAll();
  for (let n = 0; n < UNDO_LIMIT + 5; n++) {
    remember({ label: `op ${n}`, action: { kind: "create", paths: [`/a/${n}`] } });
  }
  assert.equal(pending()?.label, `op ${UNDO_LIMIT + 4}`);
  assert.equal(take()?.label, `op ${UNDO_LIMIT + 4}`);
  assert.equal(take()?.label, `op ${UNDO_LIMIT + 3}`);

  // The oldest five fell off the bottom, so the stack bottoms out at op 5.
  const rest = [];
  for (let entry = take(); entry; entry = take()) rest.push(entry.label);
  assert.equal(rest.length, UNDO_LIMIT - 2);
  assert.equal(rest[rest.length - 1], "op 5");
  assert.equal(pending(), null);
  assert.equal(take(), null);
});

test("the snapshot changes identity on a push, and stops after unsubscribing", () => {
  forgetAll();
  let heard = 0;
  const stop = undoStore.subscribe(() => heard++);
  const before = undoStore.getSnapshot();

  remember({ label: "Paste", action: { kind: "create", paths: ["/a"] } });
  // `useSyncExternalStore` re-renders on identity, so a push has to make a new
  // array rather than mutating the one it already handed out.
  assert.notEqual(undoStore.getSnapshot(), before);
  take();
  assert.equal(heard, 2);

  stop();
  remember({ label: "Paste", action: { kind: "create", paths: ["/b"] } });
  assert.equal(heard, 2);
});
