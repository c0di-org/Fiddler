import { strict as assert } from "node:assert";
import { test } from "node:test";

import { itemDomId } from "./a11y.ts";

test("an id survives the characters that real paths are full of", () => {
  // A space would end an aria-activedescendant reference, and a "#" would be
  // read as a fragment by anything that later puts one of these in a selector.
  const id = itemDomId("lr", "/Users/x/My Notes/#1 draft.md");
  assert.equal(/[\s#]/.test(id), false);
  assert.equal(id, "lr-%2FUsers%2Fx%2FMy%20Notes%2F%231%20draft.md");
});

test("two items only share an id if they are the same item", () => {
  assert.notEqual(itemDomId("gc", "/a/b c"), itemDomId("gc", "/a/b/c"));
  assert.equal(itemDomId("gc", "/a/b"), itemDomId("gc", "/a/b"));
});
