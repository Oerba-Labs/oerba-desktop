import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopLink, desktopToken, devPanelStateJs } from "../src/policy/desktoplink";

test("the app's own scheme asks for the dev panel, with at most a workspace of On-Demand's shape", () => {
  assert.deepEqual(desktopLink("oerba-desktop:dev-panel"), { action: "dev-panel", workspace: null });
  assert.deepEqual(desktopLink("oerba-desktop:dev-panel?workspace=alice%2Fdemo"), { action: "dev-panel", workspace: { owner: "alice", name: "demo" } });
  assert.deepEqual(desktopLink("oerba-desktop:dev-panel?workspace=alice/ios-test"), { action: "dev-panel", workspace: { owner: "alice", name: "ios-test" } });
  assert.deepEqual(desktopLink("OERBA-DESKTOP:dev-panel"), { action: "dev-panel", workspace: null }, "a scheme's case does not matter");
});

test("an address of another scheme is not the app's, and is left to the link-out rules", () => {
  for (const url of ["https://app.oerba.dev/", "http://localhost:8081/", "about:blank", "oerba:dev-panel", "javascript:alert(1)", ""]) assert.equal(desktopLink(url), null, url);
});

test("anything else of the app's scheme is refused", () => {
  for (const url of [
    "oerba-desktop://dev-panel",                                  // a host, not the path
    "oerba-desktop:dev-panel/x",
    "oerba-desktop:Dev-Panel",
    "oerba-desktop:settings",
    "oerba-desktop:dev-panel#x",
    "oerba-desktop:dev-panel?workspace=alice%2Fdemo&port=8081",   // nothing but the workspace
    "oerba-desktop:dev-panel?workspace=alice%2Fdemo&workspace=bob%2Fx",
    "oerba-desktop:dev-panel?port=8081",
    "oerba-desktop:dev-panel?workspace=alice",
    "oerba-desktop:dev-panel?workspace=alice%2Fde%2Fmo",
    "oerba-desktop:dev-panel?workspace=..%2Fx",
    "oerba-desktop:dev-panel?workspace=alice%2Fa.b",
    "oerba-desktop:dev-panel?workspace=al%20ice%2Fdemo",
    "oerba-desktop:dev-panel?workspace=%E2%84%AAelvin%2Fdemo",      // the Kelvin sign, which lowercases to k
    `oerba-desktop:dev-panel?workspace=${"a".repeat(200)}%2Fdemo`,
  ]) assert.equal(desktopLink(url), "refused", url);
});

test("the page is told the panel's state by one of two fixed scripts, and the app names itself by a fixed token", () => {
  assert.equal(devPanelStateJs(true), 'window.dispatchEvent(new CustomEvent("oerba-desktop", { detail: { devPanel: true } }))');
  assert.equal(devPanelStateJs(false), 'window.dispatchEvent(new CustomEvent("oerba-desktop", { detail: { devPanel: false } }))');
  assert.equal(desktopToken("0.6.2"), "OerbaDesktop/0.6.2");
});
