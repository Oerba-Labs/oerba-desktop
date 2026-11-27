import { test } from "node:test";
import assert from "node:assert/strict";
import { AWAY_IDLE_S, canDownload, canRestart, CHECK_EVERY_MS, mayCheck, mayRestartAlone, noUpdate, READY_GRACE_MS, step, VERSION, type UpdateState } from "../src/update/decide";
import { notesToText } from "../src/update/notes";
import { appSettings } from "../src/update/updater";
import { buildMenu } from "../src/present/menu";

test("updates are looked for by a packaged app, once the person is in, and never by a self-test or an unpackaged run", () => {
  assert.equal(mayCheck({ packaged: true, selftest: false, inOerba: true }), true);
  assert.equal(mayCheck({ packaged: false, selftest: false, inOerba: true }), false);
  assert.equal(mayCheck({ packaged: true, selftest: true, inOerba: true }), false);
  assert.equal(mayCheck({ packaged: true, selftest: false, inOerba: false }), false);
});

const found = (v: unknown): UpdateState => step(noUpdate(), { type: "found", version: v, notes: "n" });

test("a found update is offered only if its version is plain", () => {
  assert.equal(found("0.4.0").phase, "available");
  assert.equal(found("1.2.3-beta.1").phase, "available");
  for (const bad of ["", "0.4", "latest", "1.2.3; rm", "1.2.3\n", "<b>1.0.0</b>", 4, null, undefined, "1.2.3-" + "x".repeat(40)]) assert.equal(found(bad).phase, "none", String(bad));
});

test("found, then the download, then the restart, each on its own: a download nobody started, or a restart before one, changes nothing", () => {
  let s = found("0.4.0");
  assert.equal(canDownload(s), true);
  assert.equal(canRestart(s), false);
  s = step(s, { type: "downloaded" });          // a "downloaded" nobody asked for changes nothing
  assert.equal(s.phase, "available");
  s = step(s, { type: "download" });
  assert.equal(s.phase, "downloading");
  assert.equal(canDownload(s), false);
  s = step(s, { type: "progress", percent: 41.6 });
  assert.equal(s.percent, 42);
  s = step(s, { type: "downloaded" });
  assert.equal(s.phase, "ready");
  assert.equal(canRestart(s), true);
  assert.equal(canDownload(s), false);
});

test("a failed download can be tried again, and a second find does not disturb one under way", () => {
  let s = step(step(found("0.4.0"), { type: "download" }), { type: "error" });
  assert.equal(s.phase, "failed");
  assert.equal(canDownload(s), true);
  s = step(s, { type: "download" });
  assert.equal(step(s, { type: "found", version: "0.5.0", notes: "x" }).version, "0.4.0");
  assert.equal(step(noUpdate(), { type: "error" }).phase, "none");
  assert.equal(step(noUpdate(), { type: "download" }).phase, "none");
  assert.equal(VERSION.test("0.3.0"), true);
});

test("release notes become plain text: tags go, entities are read, lists keep their bullets", () => {
  assert.equal(notesToText("<h2>New</h2><ul><li>One &amp; two</li><li>Three</li></ul>"), "New\n\n• One & two\n• Three");
  assert.equal(notesToText("a<script>alert(1)</script>b<style>x{}</style>c"), "abc");
  assert.equal(notesToText('<img src=x onerror="alert(1)">hello<a href="https://evil">link</a>'), "hellolink");
  assert.equal(notesToText("&lt;b&gt; &amp;amp; &#39;x&#39; &unknown;"), "<b> &amp; 'x'");
  assert.equal(notesToText("line one\r\nline two\n\n\n\nline three"), "line one\nline two\n\nline three");
});

test("release notes: control and bidirectional characters go, the length is capped, odd input is empty", () => {
  assert.equal(notesToText("a\u0000b‮c⁦d"), "a b c d");
  assert.equal(Array.from(notesToText("x".repeat(10_000))).length, 3000);
  assert.equal(notesToText([{ version: "1", note: "<p>one</p>" }, { version: "2", note: "two" }, { note: 5 }, null]), "one\n\ntwo");
  for (const odd of [null, undefined, 5, {}, true]) assert.equal(notesToText(odd), "");
});

test("updates are looked for every hour, wait a day for the person, and count seven minutes without input as away", () => {
  assert.equal(CHECK_EVERY_MS, 3600_000);
  assert.equal(READY_GRACE_MS, 24 * 3600_000);
  assert.equal(AWAY_IDLE_S, 420);
});

test("the app restarts itself only for a ready update, a day after, with the person away and the iPhone panel closed", () => {
  const now = 1_000_000_000_000;
  const ok = { phase: "ready" as const, readyAt: now - READY_GRACE_MS, now, idle: "idle" as const, panelOpen: false };
  assert.equal(mayRestartAlone(ok), true);
  assert.equal(mayRestartAlone({ ...ok, idle: "locked" }), true);
  assert.equal(mayRestartAlone({ ...ok, idle: "active" }), false);
  assert.equal(mayRestartAlone({ ...ok, idle: "unknown" }), false);
  assert.equal(mayRestartAlone({ ...ok, readyAt: now - READY_GRACE_MS + 1 }), false);
  assert.equal(mayRestartAlone({ ...ok, readyAt: null }), false);
  assert.equal(mayRestartAlone({ ...ok, panelOpen: true }), false);
  for (const phase of ["none", "available", "downloading", "failed"] as const) assert.equal(mayRestartAlone({ ...ok, phase }), false, phase);
});

test("electron-updater is set to hand a download to macOS's installer, and never to download alone, go back or take a prerelease", () => {
  const u = appSettings({ autoDownload: true, autoInstallOnAppQuit: false, autoRunAppAfterInstall: false, allowDowngrade: true, allowPrerelease: true, logger: console as unknown });
  assert.deepEqual({ ...u }, { autoDownload: false, autoInstallOnAppQuit: true, autoRunAppAfterInstall: true, allowDowngrade: false, allowPrerelease: false, logger: null });
});

test("the menu offers an update still downloading by its window, and a ready one by Restart to Update", () => {
  const base = { inOerba: false, now: null, loginItem: false, paletteKey: true, chatKey: true };
  const going = buildMenu({ ...base, update: { version: "0.5.2", ready: false } });
  assert.equal(going[1]?.label, "Update to 0.5.2…");
  assert.deepEqual(going[1]?.action, { type: "update" });
  const ready = buildMenu({ ...base, update: { version: "0.5.2", ready: true } });
  assert.equal(ready[1]?.label, "Restart to Update to 0.5.2");
  assert.deepEqual(ready[1]?.action, { type: "restart" });
  assert.ok(!buildMenu({ ...base, update: null }).some((m) => /Update/.test(m.label)));
});
