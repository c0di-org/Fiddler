import assert from "node:assert/strict";
import test from "node:test";

import { detectPlatform } from "./platform";

test("detects Ubuntu/Linux desktop builds", () => {
  assert.equal(
    detectPlatform(false, "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36"),
    "linux",
  );
});

test("checks Android before Linux in the user agent", () => {
  assert.equal(
    detectPlatform(false, "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36"),
    "android",
  );
});

test("keeps browser builds separate from the host OS", () => {
  assert.equal(detectPlatform(true, "Mozilla/5.0 (X11; Linux x86_64)"), "web");
});

test("keeps the existing macOS fallback", () => {
  assert.equal(
    detectPlatform(false, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    "macos",
  );
});
