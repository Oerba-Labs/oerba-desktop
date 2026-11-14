import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceAllowed, DEVICE_EVENTS, permissionAllowed } from "../src/policy/permissions";

const O = "https://app.oerba.dev";
const top = { origin: O, isMainFrame: true };

test("every kind of permission is refused, for Oerba's own top frame too", () => {
  const kinds = [
    "serial", "usb", "hid", "bluetooth", "media", "mediaKeySystem", "audioCapture", "videoCapture", "notifications", "geolocation",
    "clipboard-read", "deprecated-sync-clipboard-read", "midi", "midiSysex", "camera", "microphone", "display-capture", "fullscreen",
    "pointerLock", "openExternal", "idle-detection", "window-management", "fileSystem", "unknown", "", "future-kind",
  ];
  for (const k of kinds) {
    assert.equal(permissionAllowed(k, top, O), false, k);
    assert.equal(permissionAllowed(k, { origin: "https://x.oerba.dev", isMainFrame: false }, O), false, k);
  }
});

test("writing to the clipboard is allowed for Oerba's top frame alone", () => {
  assert.equal(permissionAllowed("clipboard-sanitized-write", top, O), true);
  assert.equal(permissionAllowed("clipboard-sanitized-write", { origin: O, isMainFrame: false }, O), false);
  assert.equal(permissionAllowed("clipboard-sanitized-write", { origin: "https://ws.oerba.dev", isMainFrame: true }, O), false);
  assert.equal(permissionAllowed("clipboard-sanitized-write", { origin: "https://evil.example", isMainFrame: true }, O), false);
  assert.equal(permissionAllowed("clipboard-sanitized-write", { origin: "file://", isMainFrame: true }, O), false);
  assert.equal(permissionAllowed("clipboard-sanitized-write", { origin: "", isMainFrame: true }, O), false);
});

test("no device is ever handed over, and every chooser has its refusal", () => {
  assert.equal(deviceAllowed(), false);
  assert.deepEqual([...DEVICE_EVENTS].sort(), ["select-bluetooth-device", "select-hid-device", "select-serial-port", "select-usb-device"]);
});
