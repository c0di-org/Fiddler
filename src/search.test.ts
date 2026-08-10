import assert from "node:assert/strict";
import test from "node:test";

import { prepareSearch, search, type SearchRecord } from "./search.ts";

const records = [
  item("App.tsx", "/repo/src/App.tsx", "file"),
  item("application.config.ts", "/repo/config/application.config.ts", "file"),
  item("my-app.config.ts", "/repo/config/my-app.config.ts", "file"),
  item("RepoPanel.tsx", "/repo/src/components/RepoPanel.tsx", "file"),
  item("components", "/repo/src/components", "dir"),
  item("notes.md", "/repo/docs/architecture-notes.md", "file"),
];

function item(name: string, path: string, kind: "file" | "dir"): SearchRecord<string> {
  return prepareSearch({ value: name, name, path, kind });
}

test("prioritizes exact and prefix filename matches", () => {
  assert.deepEqual(
    search(records, "app").map((record) => record.value),
    ["App.tsx", "application.config.ts", "my-app.config.ts"]
  );
});

test("matches separators, CamelCase initials, and paths", () => {
  assert.equal(search(records, "config")[0].value, "my-app.config.ts");
  assert.equal(search(records, "rp")[0].value, "RepoPanel.tsx");
  assert.deepEqual(search(records, "architecture").map((record) => record.value), ["notes.md"]);
});

test("requires every text term and applies metadata filters", () => {
  assert.deepEqual(search(records, "app ext:ts").map((record) => record.value), ["application.config.ts", "my-app.config.ts"]);
  assert.deepEqual(search(records, "kind:dir").map((record) => record.value), ["components"]);
  assert.deepEqual(search(records, "ext:ts,tsx").map((record) => record.value), ["App.tsx", "application.config.ts", "my-app.config.ts", "RepoPanel.tsx"]);
});
