import assert from "node:assert/strict";
import { test } from "node:test";

import { routeOf } from "./route.ts";

test("routes Android-native media to streaming players", () => {
  assert.equal(routeOf("recording.M4A"), "audio");
  assert.equal(routeOf("clip.mp4"), "video");
  assert.equal(routeOf("scan.pdf"), "pdf");
});

test("routes HTML to the rendered preview instead of source code", () => {
  assert.equal(routeOf("index.html"), "html");
  assert.equal(routeOf("legacy.HTM"), "html");
});

test("keeps useful but unrecognised suffixes eligible for the text fallback", () => {
  assert.equal(routeOf("notes.company-format"), "none");
});
