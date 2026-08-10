import assert from "node:assert/strict";
import test from "node:test";

import { folderIconForName } from "./folder-icon.ts";

test("matches standard folders and sensible aliases", () => {
  assert.equal(folderIconForName("Music"), "music");
  assert.equal(folderIconForName("Movies"), "videos");
  assert.equal(folderIconForName("Downlods"), "downloads");
  assert.equal(folderIconForName("Downloads"), "downloads");
  assert.equal(folderIconForName("Android"), "android");
  assert.equal(folderIconForName("Audiobooks"), "audiobooks");
  assert.equal(folderIconForName("Camera Roll"), "photos");
  assert.equal(folderIconForName("Google Drive"), "cloud");
  assert.equal(folderIconForName("iPhoneData"), "phone");
  assert.equal(folderIconForName("Notifications"), "notifications");
  assert.equal(folderIconForName("Ringtones"), "ringtones");
  assert.equal(folderIconForName("SamsungNotes"), "notes");
});

test("normalises punctuation and matches descriptive folder names by word", () => {
  assert.equal(folderIconForName("2026 Family Photos"), "photos");
  assert.equal(folderIconForName("Beyonc\u00e9's Music"), "music");
  assert.equal(folderIconForName("Client Projects"), "code");
});

test("does not fuzzy-match arbitrary names", () => {
  assert.equal(folderIconForName("downloaded-notebook"), null);
  assert.equal(folderIconForName("musical-instruments"), null);
  assert.equal(folderIconForName("videogames"), null);
  assert.equal(folderIconForName("unrelated"), null);
});
