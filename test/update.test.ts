import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AWAY_IDLE_S, canDownload, canRestart, CHECK_EVERY_MS, mayCheck, mayDownloadAlone, mayRestartAlone, newer, noUpdate, READY_GRACE_MS, RETRY_AFTER_MS, step, updateZipRefusal, VERSION, type UpdateState } from "../src/update/decide";
import { notesToText } from "../src/update/notes";
import { appSettings, Updater, type Engine } from "../src/update/updater";
import { checkUpdateZip } from "../src/update/zip";
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
  // A prerelease tail is not taken: electron-updater's allowPrerelease only chooses which GitHub release it reads.
  for (const bad of ["", "0.4", "latest", "1.2.3; rm", "1.2.3\n", "<b>1.0.0</b>", 4, null, undefined, "1.2.3-beta.1", "99.0.0-x", "1.2.3-" + "x".repeat(40)]) assert.equal(found(bad).phase, "none", String(bad));
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

test("electron-updater is set never to download or hand a download on by itself, go back or take a prerelease", () => {
  const u = appSettings({ autoDownload: true, autoInstallOnAppQuit: true, autoRunAppAfterInstall: false, allowDowngrade: true, allowPrerelease: true, logger: console as unknown });
  // The hand-off to macOS's installer is the app's own (stage), after its checks; electron-updater's would come before them.
  assert.deepEqual({ ...u }, { autoDownload: false, autoInstallOnAppQuit: false, autoRunAppAfterInstall: true, allowDowngrade: false, allowPrerelease: false, logger: null });
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

test("a version is newer only by its three numbers", () => {
  assert.equal(newer("0.5.2", "0.5.1"), true);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("1.0.0", "0.99.99"), true);
  for (const [a, b] of [["0.5.1", "0.5.1"], ["0.5.0", "0.5.1"], ["0.5.2-x", "0.5.1"], ["0.5.2", "x"], ["", "0.5.1"]]) assert.equal(newer(a!, b!), false, `${a} ${b}`);
});

const expect = { bundle: "Oerba.app", id: "dev.oerba.desktop", version: "0.5.2", current: "0.5.1" };
const good = { entries: ["Oerba.app/", "Oerba.app/Contents/Info.plist", "Oerba.app/Contents/MacOS/Oerba"], version: "0.5.2", id: "dev.oerba.desktop" };

test("an update is handed to the installer only if it is this app's bundle alone, at the version offered, newer than this one", () => {
  assert.equal(updateZipRefusal(good, expect), null);
  assert.match(updateZipRefusal({ ...good, entries: [...good.entries, "Other.app/Contents/Info.plist"] }, expect) ?? "", /more than this app/);
  assert.match(updateZipRefusal({ ...good, entries: ["Oerba.application/x"] }, expect) ?? "", /more than this app/);
  assert.match(updateZipRefusal({ ...good, entries: [] }, expect) ?? "", /nothing/);
  assert.match(updateZipRefusal({ ...good, id: "dev.oerba.other" }, expect) ?? "", /another app/);
  assert.match(updateZipRefusal({ ...good, id: null }, expect) ?? "", /another app/);
  // A validly signed older build sent as a newer version is refused, and so is the version running.
  assert.match(updateZipRefusal({ ...good, version: "0.4.3" }, expect) ?? "", /not the one offered/);
  assert.match(updateZipRefusal({ ...good, version: "0.5.1" }, { ...expect, version: "0.5.1" }) ?? "", /not newer/);
  assert.match(updateZipRefusal({ ...good, version: null }, expect) ?? "", /not the one offered/);
});

test("the zip's check reads real zips with macOS's unzip and plutil", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oerba-update-zip-"));
  try {
    const plist = (id: string, v: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>\n`;
    const make = (name: string, files: Record<string, string>, binary = false): string => {
      const root = path.join(dir, name);
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        writeFileSync(path.join(root, f), text);
        if (binary && f.endsWith("Info.plist")) execFileSync("/usr/bin/plutil", ["-convert", "binary1", path.join(root, f)]);
      }
      const zip = path.join(dir, `${name}.zip`);
      execFileSync("/usr/bin/zip", ["-q", "-r", zip, ...Object.keys(files).map((f) => f.split("/")[0]!).filter((v, i, a) => a.indexOf(v) === i)], { cwd: root });
      return zip;
    };
    const app = (v: string, id = "dev.oerba.desktop"): Record<string, string> => ({ "Oerba.app/Contents/Info.plist": plist(id, v), "Oerba.app/Contents/MacOS/Oerba": "x" });
    assert.equal(await checkUpdateZip(make("good", app("0.5.2")), expect), null);
    assert.equal(await checkUpdateZip(make("binary", app("0.5.2"), true), expect), null);
    assert.match(await checkUpdateZip(make("older", app("0.4.3")), expect) ?? "", /not the one offered/);
    assert.match(await checkUpdateZip(make("other", app("0.5.2", "dev.oerba.other")), expect) ?? "", /another app/);
    assert.match(await checkUpdateZip(make("extra", { ...app("0.5.2"), "Evil.app/Contents/Info.plist": plist("dev.oerba.desktop", "0.5.2") }), expect) ?? "", /more than this app/);
    assert.match(await checkUpdateZip(make("noplist", { "Oerba.app/Contents/MacOS/Oerba": "x" }), expect) ?? "", /another app/);
    assert.match(await checkUpdateZip(path.join(dir, "missing.zip"), expect) ?? "", /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a version that failed is not downloaded again by itself for a day; a press, or another version, goes at once", () => {
  const now = 1_000_000_000_000;
  assert.equal(mayDownloadAlone({ version: "0.5.2", failed: null, now }), true);
  assert.equal(mayDownloadAlone({ version: "0.5.2", failed: { version: "0.5.2", at: now - 3600_000 }, now }), false);
  assert.equal(mayDownloadAlone({ version: "0.5.2", failed: { version: "0.5.2", at: now - RETRY_AFTER_MS }, now }), true);
  assert.equal(mayDownloadAlone({ version: "0.5.3", failed: { version: "0.5.2", at: now - 3600_000 }, now }), true);
});

/** An engine that offers 0.5.2, downloads it, and whose installer takes it or refuses it, as told. */
function standIn(refuse: () => boolean): { engine: Engine; calls: string[] } {
  const calls: string[] = [];
  const handlers: Record<string, (x?: unknown) => void> = {};
  const engine: Engine = {
    checkForUpdates: async () => { calls.push("check"); handlers["update-available"]?.({ version: "0.5.2", releaseNotes: "" }); },
    downloadUpdate: async () => { calls.push("download"); handlers["update-downloaded"]?.(); },
    quitAndInstall: () => { calls.push("install"); },
    stage: async () => { calls.push("stage"); if (refuse()) throw new Error("the installer refused it"); },
    on: ((event: string, cb: (x?: unknown) => void) => { handlers[event] = cb; }) as Engine["on"],
  };
  return { engine, calls };
}

test("an update the installer refuses is not ready, offers no restart, and is tried again by itself only a day later", async () => {
  let clock = 1_000_000_000_000;
  let refusing = true;
  const { engine, calls } = standIn(() => refusing);
  const u = new Updater(async () => engine, () => ({ packaged: true, selftest: false, inOerba: true }), () => {}, { now: () => clock, idle: () => "locked", panelOpen: () => false, before: async () => {} });
  await u.check();
  assert.equal(u.state.phase, "failed");
  assert.equal(u.readyAt, null);
  assert.equal(canRestart(u.state), false);
  await u.restart();
  assert.deepEqual(calls, ["check", "download", "stage"]);   // no install: Restart is not offered, and does nothing
  clock += 3600_000;
  await u.check();
  assert.deepEqual(calls, ["check", "download", "stage", "check"]);   // an hour on: found again, not downloaded again
  assert.equal(u.state.phase, "available");
  refusing = false;
  await u.download();   // a press of Download does not wait
  assert.equal(u.state.phase, "ready");
  assert.equal(u.readyAt, clock);
});

test("an update is ready only once the installer has taken it, and the restart by itself follows the day's rule", async () => {
  let clock = 1_000_000_000_000;
  const { engine, calls } = standIn(() => false);
  const u = new Updater(async () => engine, () => ({ packaged: true, selftest: false, inOerba: true }), () => {}, { now: () => clock, idle: () => "locked", panelOpen: () => false, before: async () => {} });
  await u.check();
  assert.deepEqual(calls, ["check", "download", "stage"]);
  assert.equal(u.state.phase, "ready");
  assert.equal(await u.restartIfAway(), false);
  clock += READY_GRACE_MS;
  assert.equal(await u.restartIfAway(), true);
  assert.equal(calls.at(-1), "install");
  assert.equal(await u.restartIfAway(), false);   // tried; the next try is a day on
});

test("no check is made while a download is under way or one is ready, so a check's error cannot mark either failed", async () => {
  const { engine, calls } = standIn(() => false);
  const u = new Updater(async () => engine, () => ({ packaged: true, selftest: false, inOerba: true }), () => {});
  await u.check();
  assert.equal(u.state.phase, "ready");
  await u.check();
  assert.deepEqual(calls, ["check", "download", "stage"]);
});
