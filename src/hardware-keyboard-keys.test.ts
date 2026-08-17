import assert from "node:assert/strict";
import test from "node:test";

import { androidHardwareIntent } from "./hardware-keyboard-keys.ts";

test("plain Enter opens, including the numpad Enter used by some keyboards", () => {
  assert.equal(androidHardwareIntent({ key: "Enter", code: "Enter" }), "open");
  assert.equal(androidHardwareIntent({ key: "Enter", code: "NumpadEnter" }), "open");
});

test("forward-delete variants all mean delete", () => {
  assert.equal(androidHardwareIntent({ key: "Delete" }), "delete");
  assert.equal(androidHardwareIntent({ key: "Del" }), "delete");
  assert.equal(androidHardwareIntent({ key: "Unidentified", code: "Delete" }), "delete");
  assert.equal(androidHardwareIntent({ key: "Unidentified", keyCode: 46 }), "delete");
});

test("F2 is rename", () => {
  assert.equal(androidHardwareIntent({ key: "F2" }), "rename");
});

test("the hardware menu key and Shift+F10 open the context menu", () => {
  assert.equal(androidHardwareIntent({ key: "ContextMenu" }), "context-menu");
  assert.equal(androidHardwareIntent({ key: "F10", shiftKey: true }), "context-menu");
});

test("modified keys are left to Fiddler's existing shortcut layer", () => {
  assert.equal(androidHardwareIntent({ key: "Enter", ctrlKey: true }), null);
  assert.equal(androidHardwareIntent({ key: "Delete", metaKey: true }), null);
  assert.equal(androidHardwareIntent({ key: "F2", altKey: true }), null);
  assert.equal(androidHardwareIntent({ key: "Enter", shiftKey: true }), null);
});
