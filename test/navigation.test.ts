import { test } from "node:test";
import assert from "node:assert/strict";
import { externalTarget, isSetupSender, isUpdateSender, navigationAllowed, openDecision, type NavPolicy, type Role } from "../src/policy/navigation";

const policy: NavPolicy = { oerbaOrigin: "https://app.oerba.dev", setupUrl: "oerba-app://app/setup/setup.html", updateUrl: "oerba-app://app/update/update.html" };
const main = (url: string, role: Role = "oerba") => navigationAllowed(url, true, role, policy);
const sub = (url: string, role: Role = "oerba") => navigationAllowed(url, false, role, policy);

test("Oerba's view may go to app.oerba.dev only, in its main frame", () => {
  assert.equal(main("https://app.oerba.dev/"), true);
  assert.equal(main("https://app.oerba.dev/apps/x?y=1#z"), true);
  for (const bad of [
    "https://oerba.dev/", "https://other.oerba.dev/", "https://app.oerba.dev.evil.example/", "https://evil.example/app.oerba.dev",
    "http://app.oerba.dev/", "https://app.oerba.dev:8443/", "https://user:pw@app.oerba.dev/", "file:///etc/passwd", "oerba-app://app/setup/setup.html", "oerba-app://other/setup/setup.html",
    "javascript:alert(1)", "data:text/html,hi", "about:blank", "not a url", "",
  ]) assert.equal(main(bad), false, bad);
});

test("the setup view may be the bundled page and nothing else, and Oerba's view may not be it", () => {
  assert.equal(main("oerba-app://app/setup/setup.html", "setup"), true);
  assert.equal(main("oerba-app://app/setup/setup.html?x=1", "setup"), true);
  assert.equal(main("oerba-app://app/setup/other.html", "setup"), false);
  assert.equal(main("https://app.oerba.dev/", "setup"), false);
  assert.equal(main("oerba-app://app/setup/setup.html", "oerba"), false);
});

test("a stranger's contents may go nowhere", () => {
  assert.equal(main("https://app.oerba.dev/", "other"), false);
  assert.equal(sub("https://x.oerba.dev/", "other"), false);
});

test("subframes of Oerba's view may be names under oerba.dev over https", () => {
  assert.equal(sub("https://app.oerba.dev/frame"), true);
  assert.equal(sub("https://ws-1.oerba.dev/"), true);
  assert.equal(sub("https://a.b.oerba.dev/x"), true);
  for (const bad of [
    "https://oerba.dev/", "https://evil.example/", "https://oerba.dev.evil.example/", "https://xoerba.dev/", "https://.oerba.dev/",
    "http://ws.oerba.dev/", "https://ws.oerba.dev:8443/", "https://u:p@ws.oerba.dev/", "file:///x", "javascript:1",
  ]) assert.equal(sub(bad), false, bad);
  assert.equal(sub("https://ws.oerba.dev/", "setup"), false);
});

test("under a self-test origin the stand-in is Oerba, and https names under oerba.dev still count for frames", () => {
  const p: NavPolicy = { ...policy, oerbaOrigin: "http://127.0.0.1:4010" };
  assert.equal(navigationAllowed("http://127.0.0.1:4010/", true, "oerba", p), true);
  assert.equal(navigationAllowed("http://127.0.0.1:4011/", true, "oerba", p), false);
  assert.equal(navigationAllowed("https://app.oerba.dev/", true, "oerba", p), false);
});

test("only https addresses with a host and no credentials go to the system browser", () => {
  assert.equal(externalTarget("https://tailscale.com/download"), "https://tailscale.com/download");
  for (const bad of ["http://example.com/", "file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "ssh://host", "x-apple.systempreferences:", "https://u:p@example.com/", "https:///x", "nonsense", ""])
    assert.equal(externalTarget(bad), null, bad);
});

test("window.open never makes a window, and names the browser only for https", () => {
  assert.deepEqual(openDecision("https://example.com/a"), { action: "deny", external: "https://example.com/a" });
  assert.deepEqual(openDecision("http://example.com/a"), { action: "deny", external: null });
  assert.deepEqual(openDecision("javascript:1"), { action: "deny", external: null });
});

test("an IPC message counts only from the setup page's top frame", () => {
  assert.equal(isSetupSender("oerba-app://app/setup/setup.html", true, policy), true);
  assert.equal(isSetupSender("oerba-app://app/setup/setup.html", false, policy), false);
  assert.equal(isSetupSender("https://app.oerba.dev/", true, policy), false);
  assert.equal(isSetupSender(undefined, true, policy), false);
});

test("the update window may be its bundled page and nothing else, and no other view may be it", () => {
  assert.equal(main("oerba-app://app/update/update.html", "update"), true);
  assert.equal(main("oerba-app://app/setup/setup.html", "update"), false);
  assert.equal(main("https://app.oerba.dev/", "update"), false);
  assert.equal(main("oerba-app://app/update/update.html", "setup"), false);
  assert.equal(main("oerba-app://app/update/update.html", "oerba"), false);
  assert.equal(sub("https://x.oerba.dev/", "update"), false);
  assert.equal(isUpdateSender("oerba-app://app/update/update.html", true, policy), true);
  assert.equal(isUpdateSender("oerba-app://app/update/update.html", false, policy), false);
  assert.equal(isUpdateSender("oerba-app://app/setup/setup.html", true, policy), false);
});
