import assert from "node:assert/strict";
import test from "node:test";

import { parseShortcut } from "./link.ts";

const url = (body: string) => `[InternetShortcut]\n${body}\n`;

test("reads the destination out of a Windows .url file", () => {
  const shortcut = parseShortcut(url("URL=https://example.com/docs?a=1"));
  assert.equal(shortcut?.url, "https://example.com/docs?a=1");
});

test("reads the destination out of a macOS .webloc plist", () => {
  const webloc = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>URL</key>
	<string>https://example.com/a&amp;b</string>
</dict>
</plist>`;
  assert.equal(parseShortcut(webloc)?.url, "https://example.com/a&b");
});

test("a file with no destination is not a shortcut", () => {
  assert.equal(parseShortcut(""), null);
  assert.equal(parseShortcut("[InternetShortcut]\nIconIndex=0\n"), null);
  assert.equal(parseShortcut(url("URL=not a url at all")), null);
});

// The reason this module exists as its own file with its own tests: a shortcut
// is arbitrary bytes whose entire purpose is to be clicked.
test("schemes that can run code or read the disk are refused", () => {
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(parseShortcut(url(`URL=${bad}`)), null, `should refuse ${bad}`);
  }
});

test("http, https and mailto are allowed", () => {
  assert.ok(parseShortcut(url("URL=http://example.com")));
  assert.ok(parseShortcut(url("URL=https://example.com")));
  assert.ok(parseShortcut(url("URL=mailto:someone@example.com")));
});

test("the destination decides the mark when the file doesn't say", () => {
  assert.equal(parseShortcut(url("URL=https://github.com/a/b"))?.kind, "repo");
  assert.equal(parseShortcut(url("URL=https://x.com/a/Fiddler.dmg"))?.kind, "macos");
  assert.equal(parseShortcut(url("URL=https://x.com/a/Fiddler.apk"))?.kind, "android");
  assert.equal(parseShortcut(url("URL=https://example.com/"))?.kind, "web");
});

test("a file may declare its own platform, since one page can serve two builds", () => {
  const mac = parseShortcut(url("URL=https://github.com/a/b/releases\nIcon=macos"));
  const android = parseShortcut(url("URL=https://github.com/a/b/releases\nIcon=android"));
  assert.equal(mac?.kind, "macos");
  assert.equal(android?.kind, "android");
  // Same URL, so without the hint both would have been the repo mark.
  assert.equal(parseShortcut(url("URL=https://github.com/a/b/releases"))?.kind, "repo");
});

test("an unrecognised icon hint is ignored rather than trusted", () => {
  const shortcut = parseShortcut(url("URL=https://example.com/\nIcon=../../etc"));
  assert.equal(shortcut?.kind, "web");
});
