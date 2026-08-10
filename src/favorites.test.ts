import assert from "node:assert/strict";
import test from "node:test";

import { addFavorite, moveFavorite } from "./favorites.ts";

const one = { name: "One", path: "/one" };
const two = { name: "Two", path: "/two" };
const three = { name: "Three", path: "/three" };

test("adds a favorite at the requested position without duplicates", () => {
  assert.deepEqual(addFavorite([one, three], two, 1), [one, two, three]);
  assert.deepEqual(addFavorite([one, two, three], one, 3), [two, three, one]);
});

test("moves favorites using the original list's insertion point", () => {
  assert.deepEqual(moveFavorite([one, two, three], one.path, 3), [two, three, one]);
  assert.deepEqual(moveFavorite([one, two, three], three.path, 0), [three, one, two]);
});
