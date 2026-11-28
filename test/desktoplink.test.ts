import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopLink, desktopToken, devPanelStateJs, newDesktopKey } from "../src/policy/desktoplink";

const K = "0123456789abcdef0123456789abcdef";
const ask = (q: string): string => `oerba-desktop:dev-panel?${q}`;

test("the app's own scheme asks for the dev panel, carrying the key, with at most a workspace of On-Demand's shape", () => {
  assert.deepEqual(desktopLink(ask(`key=${K}`)), { action: "dev-panel", workspace: null, key: K });
  assert.deepEqual(desktopLink(ask(`workspace=alice%2Fdemo&key=${K}`)), { action: "dev-panel", workspace: { owner: "alice", name: "demo" }, key: K });
  assert.deepEqual(desktopLink(ask(`key=${K}&workspace=alice/ios-test`)), { action: "dev-panel", workspace: { owner: "alice", name: "ios-test" }, key: K });
  assert.deepEqual(desktopLink(`OERBA-DESKTOP:dev-panel?key=${K}`), { action: "dev-panel", workspace: null, key: K }, "a scheme's case does not matter");
});

test("an address of another scheme is not the app's, and is left to the link-out rules", () => {
  for (const url of ["https://app.oerba.dev/", "http://localhost:8081/", "about:blank", "oerba:dev-panel", "javascript:alert(1)", ""]) assert.equal(desktopLink(url), null, url);
});

test("anything else of the app's scheme is refused, and an ask without a key of the key's shape", () => {
  for (const url of [
    "oerba-desktop:dev-panel",                                    // no key
    ask("workspace=alice%2Fdemo"),
    ask("key="),
    ask(`key=${K.toUpperCase()}`),
    ask(`key=${K}0`),
    ask(`key=${K}&key=${K}`),
    `oerba-desktop://dev-panel?key=${K}`,                          // a host, not the path
    `oerba-desktop:dev-panel/x?key=${K}`,
    `oerba-desktop:Dev-Panel?key=${K}`,
    `oerba-desktop:settings?key=${K}`,
    `oerba-desktop:dev-panel?key=${K}#x`,
    ask(`key=${K}&workspace=alice%2Fdemo&port=8081`),               // nothing but the workspace and the key
    ask(`key=${K}&workspace=alice%2Fdemo&workspace=bob%2Fx`),
    ask(`key=${K}&port=8081`),
    ask(`key=${K}&workspace=alice`),
    ask(`key=${K}&workspace=`),
    ask(`key=${K}&workspace=alice%2Fde%2Fmo`),
    ask(`key=${K}&workspace=..%2Fx`),
    ask(`key=${K}&workspace=alice%2Fa.b`),
    ask(`key=${K}&workspace=al%20ice%2Fdemo`),
    ask(`key=${K}&workspace=%E2%84%AAelvin%2Fdemo`),                // the Kelvin sign, which lowercases to k
    ask(`key=${K}&workspace=${"a".repeat(150)}%2Fdemo`),
  ]) assert.equal(desktopLink(url), "refused", url);
});

test("the page is told the panel's state and the key, and nothing else; the app names itself by a fixed token", () => {
  assert.equal(devPanelStateJs(true, K), `window.dispatchEvent(new CustomEvent("oerba-desktop", { detail: { devPanel: true, key: "${K}" } }))`);
  assert.equal(devPanelStateJs(false, K), `window.dispatchEvent(new CustomEvent("oerba-desktop", { detail: { devPanel: false, key: "${K}" } }))`);
  for (const bad of ["", "x", `${K}"`, `${K.slice(0, 31)}"`, "\"); alert(1); (\"0123456789abcdef"]) assert.throws(() => devPanelStateJs(true, bad), /not a key/, bad);
  assert.equal(desktopToken("0.6.2"), "OerbaDesktop/0.6.2");
});

test("a key is 128 random bits, as hex, a new one each time", () => {
  const a = newDesktopKey();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newDesktopKey());
});
